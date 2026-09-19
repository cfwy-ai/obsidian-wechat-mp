import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyVerifiedTemplates, digest, option, validateTemplates } from './template-files.mjs';
import { safeThemeRelativePath } from '../src/theme-package.mjs';

const PLUGIN_ID = 'changfeng-wechat-mp';
const artifacts = ['main.js', 'manifest.json', 'styles.css'];
const exists = async path => {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

/** Install only into an explicitly selected, existing Vault; keep user data. */
export async function installPlugin({ vault, source, configDir = '.obsidian', dryRun = false } = {}) {
  if (!vault) throw new Error('请先确认目标 Vault，再提供 --vault <完整路径>；不会猜测安装位置。');
  safeThemeRelativePath(configDir, 'Obsidian 配置目录');
  const vaultRoot = resolve(vault);
  const configPath = join(vaultRoot, configDir);
  if (!(await exists(configPath)) || !(await stat(configPath)).isDirectory()) {
    throw new Error(`这不是已初始化的 Obsidian Vault（缺少 ${configDir}）：${vaultRoot}`);
  }
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  if (manifest.id !== PLUGIN_ID) throw new Error(`插件 ID 错误：${manifest.id}`);
  for (const file of artifacts) if (!(await stat(join(source, file))).isFile()) throw new Error(`缺少 ${file}`);
  const templates = await validateTemplates(join(source, 'templates'));
  const target = join(configPath, 'plugins', PLUGIN_ID);
  const previousData = await exists(join(target, 'data.json')) ? await readFile(join(target, 'data.json')) : null;
  const result = { vault: vaultRoot, target, version: manifest.version, themes: templates.themes, preservesData: previousData !== null, dryRun };
  if (dryRun) return result;

  const nonce = randomUUID();
  const parent = dirname(target);
  const stage = join(parent, `.${PLUGIN_ID}-stage-${nonce}`);
  const backup = join(parent, `.${PLUGIN_ID}-backup-${nonce}`);
  let movedOldTarget = false;
  let installed = false;
  await mkdir(parent, { recursive: true });
  try {
    if (await exists(target)) await cp(target, stage, { recursive: true });
    else await mkdir(stage);
    // These directories contain release-managed templates, never article data.
    await rm(join(stage, 'templates'), { recursive: true, force: true });
    await rm(join(stage, 'themes'), { recursive: true, force: true });
    for (const file of artifacts) {
      await cp(join(source, file), join(stage, file));
      if (digest(await readFile(join(source, file))) !== digest(await readFile(join(stage, file)))) throw new Error(`${file} 复制校验失败`);
    }
    await copyVerifiedTemplates(join(source, 'templates'), join(stage, 'templates'));
    if (await exists(join(source, 'LICENSE'))) await cp(join(source, 'LICENSE'), join(stage, 'LICENSE'));
    await validateTemplates(join(stage, 'templates'));
    if (previousData && digest(await readFile(join(stage, 'data.json'))) !== digest(previousData)) throw new Error('用户配置保留校验失败');
    if (await exists(target)) { await rename(target, backup); movedOldTarget = true; }
    try { await rename(stage, target); installed = true; }
    catch (error) {
      if (movedOldTarget) {
        try { await rename(backup, target); movedOldTarget = false; }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], `安装和回滚失败；原插件保留在 ${backup}`); }
      }
      throw error;
    }
    if (movedOldTarget) {
      try { await rm(backup, { recursive: true, force: true }); }
      catch { result.backup = backup; }
    }
    return result;
  } finally {
    if (!installed) await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    const result = await installPlugin({
      vault: option('--vault', process.env.WECHAT_MP_VAULT || ''),
      source: resolve(option('--source', join(root, 'dist'))),
      configDir: option('--config-dir', '.obsidian'),
      dryRun: process.argv.includes('--dry-run'),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.dryRun) console.log('安装文件已校验。请在 Obsidian 中启用或重新加载插件，再核对运行时版本和文章预览。');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
