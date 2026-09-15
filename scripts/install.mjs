import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'dist');
// 作者本机默认目标；其他人请设 WECHAT_MP_VAULT，或改用 install-with-themes.mjs
const vault =
  process.env.WECHAT_MP_VAULT ??
  '/Users/cfwy/Library/Mobile Documents/com~apple~CloudDocs/Obsidian/人工智能 🧠';
const target = join(vault, '.obsidian/plugins/changfeng-wechat-mp');
const parent = dirname(target);
const nonce = randomUUID();
const stage = join(parent, `.changfeng-wechat-mp-stage-${nonce}`);
const backup = join(parent, `.changfeng-wechat-mp-backup-${nonce}`);
const artifacts = ['main.js', 'manifest.json', 'styles.css'];

const digest = async (path) =>
  createHash('sha256').update(await readFile(path)).digest('hex');

await mkdir(parent, { recursive: true });

try {
  await cp(target, stage, { recursive: true, errorOnExist: true });
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  await mkdir(stage, { recursive: true });
}

await Promise.all(
  artifacts.map((file) =>
    cp(join(source, file), join(stage, file)),
  ),
);

const manifest = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'));
if (manifest.id !== 'changfeng-wechat-mp') {
  throw new Error(`manifest.id 不正确：${manifest.id ?? '缺失'}`);
}

for (const file of artifacts) {
  const [expected, actual] = await Promise.all([
    digest(join(source, file)),
    digest(join(stage, file)),
  ]);
  if (expected !== actual) throw new Error(`${file} 暂存校验失败`);
}

let movedOldTarget = false;
try {
  try {
    await rename(target, backup);
    movedOldTarget = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await rename(stage, target);
} catch (error) {
  if (movedOldTarget) {
    try {
      await rename(backup, target);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], '安装失败，且回滚未完成');
    }
  }
  throw error;
}

if (movedOldTarget) {
  try {
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    console.warn(`旧版备份未能清理：${backup}\n${error.message}`);
  }
}

console.log(`已安装到：${target}`);
console.log('磁盘文件已更新；请在 Obsidian 中停用再启用「长风·公众号排版」，再做运行时验收。');
