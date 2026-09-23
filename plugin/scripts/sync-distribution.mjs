import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// 把三处正本同步进 distribution 快照，并对账无法字节比较的生成物。
// 正本：插件源码、共享 Skills、Obsidian 正式主题仓库。
// 本脚本随 plugin/ 进入公开仓库，因此不写入任何本机绝对路径；
// 主题仓库位置从项目根的 .sync-config.json 或环境变量读取。

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = dirname(root);
const apply = !process.argv.includes('--check');

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = async (path) => { try { await stat(path); return true; } catch { return false; } };

const ignored = new Set(['.DS_Store', 'node_modules', '__pycache__', 'dist', 'out', 'releases', '.git']);

async function walk(dir, base = dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    // 与发布仓库的 .gitignore 对齐：构建产物与依赖不进快照。
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, base, out);
    else out.push(relative(base, path));
  }
  return out;
}

async function resolveThemeSource() {
  const fromEnv = process.env.WECHAT_MP_VAULT_THEMES;
  if (fromEnv) return resolve(fromEnv);
  const configPath = join(projectRoot, '.sync-config.json');
  if (await exists(configPath)) {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (config.vaultThemes) return resolve(projectRoot, config.vaultThemes);
  }
  throw new Error(
    '找不到正式主题仓库。请设置 WECHAT_MP_VAULT_THEMES，'
    + `或在 ${configPath} 写入 {"vaultThemes": "<完整路径>"}。`,
  );
}

/** 逐文件比对；两边都有且不同才覆盖，不删除任何文件。 */
async function syncTree({ label, source, target, only }) {
  const report = { label, same: 0, updated: 0, sourceOnly: [], targetOnly: [], changed: [] };
  const targetFiles = await walk(target);
  for (const rel of targetFiles) {
    if (only && !only(rel)) continue;
    const from = join(source, rel);
    if (!(await exists(from))) { report.targetOnly.push(rel); continue; }
    const [a, b] = await Promise.all([readFile(from), readFile(join(target, rel))]);
    if (digest(a) === digest(b)) { report.same += 1; continue; }
    report.changed.push(rel);
    if (apply) {
      await mkdir(dirname(join(target, rel)), { recursive: true });
      await cp(from, join(target, rel));
      const written = await readFile(join(target, rel));
      if (digest(written) !== digest(a)) throw new Error(`复制校验失败：${rel}`);
    }
    report.updated += 1;
  }
  // 只关心「快照已经在发布的目录」里多出来的文件；
  // 正本里那些从来不发布的目录（别的 Skill、内部工具）不该每次刷屏。
  const known = new Set(targetFiles);
  const publishedDirs = new Set(targetFiles.map((rel) => dirname(rel)));
  for (const rel of await walk(source)) {
    if (only && !only(rel)) continue;
    if (known.has(rel) || !publishedDirs.has(dirname(rel))) continue;
    report.sourceOnly.push(rel);
  }
  return report;
}

/** 生成物无法按字节比较，只核对同名文件是否两边都在。 */
async function auditGenerated({ label, source, target, pick }) {
  const report = { label, paired: 0, missingInSource: [] };
  for (const rel of await walk(target)) {
    if (!pick(rel)) continue;
    if (await exists(join(source, rel))) report.paired += 1;
    else report.missingInSource.push(rel);
  }
  return report;
}

// 这些只在公开仓库维护，正本里本来就没有，不必每次提示。
const repoOnlyByDesign = new Set([
  '插件源码: README.md', '插件源码: docs/1. 安装.md',
  '插件源码: docs/2. 开发与发布.md', '插件源码: docs/3. 版本记录.md',
  '共享: README.md', '共享: snapshot.json',
]);

const themeDirName = (name) => name.replace(/^\d+\.\s*/, '').replace(/\s*✅️?$/u, '').trim();

async function main() {
  const repo = join(projectRoot, '4. 对外发布', 'GitHub 仓库');
  if (!(await exists(repo))) throw new Error(`找不到发布工作区：${repo}`);
  const skillsSource = join(process.env.HOME ?? '', '.agents', 'skills');
  const themeSource = await resolveThemeSource();

  const results = [];
  results.push(await syncTree({
    label: '插件源码  →  plugin/',
    source: root,
    target: join(repo, 'plugin'),
  }));
  results.push(await syncTree({
    label: '共享 Skills  →  skills/',
    source: skillsSource,
    target: join(repo, 'skills'),
  }));

  // 主题：素材可以字节同步，manifest 与各类 .md 是生成物。
  const vaultDirs = (await readdir(themeSource, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const catalog = JSON.parse(await readFile(join(repo, 'templates', 'catalog.json'), 'utf8'));
  const assetDirs = ['透明装饰素材', '正文组件结构', '配套字体资源'];
  let assets = { same: 0, updated: 0, targetOnly: [], changed: [] };
  let boards = { same: 0, updated: 0, targetOnly: [], changed: [] };
  const generated = [];
  for (const theme of catalog.themes) {
    const vaultName = vaultDirs.find((name) => themeDirName(name) === theme.name);
    if (!vaultName) { console.error(`  主题仓库里找不到「${theme.name}」，跳过`); continue; }
    const source = join(themeSource, vaultName);
    const target = join(repo, 'templates', theme.directory);
    const assetReport = await syncTree({
      label: '', source, target,
      only: (rel) => assetDirs.includes(rel.split(sep)[0]),
    });
    const boardReport = await syncTree({
      label: '', source, target,
      only: (rel) => (rel.split(sep)[0] === '主题展示案例' && !rel.endsWith('.md')) || rel === 'theme.css',
    });
    for (const key of ['same', 'updated']) { assets[key] += assetReport[key]; boards[key] += boardReport[key]; }
    assets.targetOnly.push(...assetReport.targetOnly.map((rel) => `${theme.directory}/${rel}`));
    assets.changed.push(...assetReport.changed.map((rel) => `${theme.directory}/${rel}`));
    boards.changed.push(...boardReport.changed.map((rel) => `${theme.directory}/${rel}`));
    generated.push(await auditGenerated({
      label: theme.directory, source, target,
      pick: (rel) => rel.endsWith('.md') || rel === 'manifest.json',
    }));
  }

  const line = (r) => `  ${r.label.padEnd(24)} 一致 ${String(r.same).padStart(4)}   ${apply ? '已更新' : '待更新'} ${String(r.updated).padStart(3)}   仅快照有 ${String(r.targetOnly.length).padStart(3)}`;
  console.log(apply ? '同步结果' : '对账结果（--check，未写入）');
  for (const r of results) console.log(line(r));
  console.log(line({ label: '主题素材  →  templates/', ...assets }));
  console.log(line({ label: '主题样式与展示图  →  templates/', ...boards }));

  const orphans = [...results.flatMap((r) => r.targetOnly.map((rel) => `${r.label.split(' ')[0]}: ${rel}`)), ...assets.targetOnly];
  const unpaired = generated.flatMap((g) => g.missingInSource.map((rel) => `${g.label}/${rel}`));
  const newInSource = results.flatMap((r) => r.sourceOnly.map((rel) => `${r.label.split(' ')[0]}: ${rel}`));
  if (newInSource.length) {
    console.log('\n正本里新增、快照还没有的文件（同步不会自动添加，需决定是否发布）：');
    for (const n of newInSource.slice(0, 15)) console.log(`  ${n}`);
    if (newInSource.length > 15) console.log(`  …另有 ${newInSource.length - 15} 项`);
  }
  const unexpected = orphans.filter((o) => !repoOnlyByDesign.has(o));
  if (unexpected.length) {
    console.log('\n只在快照里、正本没有的文件（需人工确认是不是历史遗留）：');
    for (const o of unexpected) console.log(`  ${o}`);
  }
  console.log(`\n公开仓库自行维护的文档 ${orphans.length - unexpected.length} 份，属正常。`);
  if (unpaired.length) {
    console.log('\n生成物在正本里找不到同名文件（多为导出转换产生，属正常）：');
    for (const u of unpaired.slice(0, 10)) console.log(`  ${u}`);
    if (unpaired.length > 10) console.log(`  …另有 ${unpaired.length - 10} 项`);
  }
  const changed = [...results.flatMap((r) => r.changed), ...assets.changed, ...boards.changed];
  if (changed.length) {
    console.log(`\n${apply ? '已同步' : '需要同步'} ${changed.length} 个文件：`);
    for (const c of changed.slice(0, 20)) console.log(`  ${c}`);
    if (changed.length > 20) console.log(`  …另有 ${changed.length - 20} 项`);
  } else {
    console.log('\n三处正本与快照完全一致。');
  }
  if (!apply) { console.log('\n这是对账模式，未写入任何文件。去掉 --check 才会同步。'); return; }

  // 快照变了就重建目录清单，再用项目自己的检查口径验一遍。
  const templates = join(repo, 'templates');
  const run = (label, command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
    const ok = result.status === 0;
    console.log(`  ${ok ? '通过' : '失败'}  ${label}`);
    if (!ok) console.error((result.stderr || result.stdout || '').trim().split('\n').slice(-6).join('\n'));
    return ok;
  };
  console.log('\n重建与检查');
  const env = { ...process.env, WECHAT_MP_TEMPLATES: templates };
  let ok = run('重建 templates/catalog.json', process.execPath, ['scripts/refresh-template-catalog.mjs'], { env });
  ok = run('自动测试', 'npm', ['test']) && ok;
  ok = run('模板资源审计', process.execPath, ['scripts/audit-templates.mjs'], { env }) && ok;

  const status = spawnSync('git', ['-C', repo, 'status', '--porcelain=v1'], { encoding: 'utf8' }).stdout.trim();
  const pending = status ? status.split('\n').length : 0;
  console.log(`\n发布工作区待提交 ${pending} 项。`);
  console.log(pending ? '先看 git diff，确认无误再提交推送。' : '无需提交。');
  if (!ok) process.exitCode = 1;
}

await main();
