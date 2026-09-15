/**
 * 把插件与 10 套主题一起装进指定 vault。
 *
 * 只回答一件事：怎样让别人用一条命令装好这个插件，并且左侧文件树不多出任何文档。
 *
 * 与 install.mjs 的区别：那个脚本只装三件构建产物，供作者本机快速迭代；
 * 这个脚本额外把 themes/ 复制进插件目录，是给使用者的安装入口。
 *
 * 用法：
 *   node scripts/install-with-themes.mjs "/path/to/YourVault"
 *   或  WECHAT_MP_VAULT="/path/to/YourVault" node scripts/install-with-themes.mjs
 */
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_ID = 'changfeng-wechat-mp';
const ARTIFACTS = ['main.js', 'manifest.json', 'styles.css'];

const vault = process.argv[2] ?? process.env.WECHAT_MP_VAULT ?? '';
if (!vault) {
  console.error('请提供 vault 路径：node scripts/install-with-themes.mjs "/path/to/YourVault"');
  process.exit(1);
}

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(join(vault, '.obsidian')))) {
  console.error(`这个目录不像 Obsidian vault（没有 .obsidian）：${vault}`);
  process.exit(1);
}

const dist = join(root, 'dist');
for (const name of ARTIFACTS) {
  if (!(await exists(join(dist, name)))) {
    console.error(`缺少构建产物 dist/${name}，请先运行：npm run build`);
    process.exit(1);
  }
}

const themesSource = join(root, 'themes');
if (!(await exists(themesSource))) {
  console.error('缺少 themes/ 目录，主题包不完整');
  process.exit(1);
}

const target = join(vault, '.obsidian/plugins', PLUGIN_ID);
const parent = dirname(target);
const nonce = randomUUID();
const stage = join(parent, `.${PLUGIN_ID}-stage-${nonce}`);

const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

try {
  await mkdir(stage, { recursive: true });

  // 先装进暂存目录并逐文件校验，避免半成品覆盖已装版本
  for (const name of ARTIFACTS) {
    const from = join(dist, name);
    const to = join(stage, name);
    await cp(from, to);
    if ((await digest(from)) !== (await digest(to))) {
      throw new Error(`${name} 复制后校验不一致`);
    }
  }
  await cp(themesSource, join(stage, 'themes'), { recursive: true });

  const installed = (await readdir(join(stage, 'themes'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).length;
  if (installed === 0) throw new Error('themes 复制后为空');

  // 保留用户已有配置：data.json 不覆盖
  const existingData = join(target, 'data.json');
  if (await exists(existingData)) {
    await cp(existingData, join(stage, 'data.json'));
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(parent, { recursive: true });
  await rename(stage, target);

  console.log(`已安装到 ${target}`);
  console.log(`主题 ${installed} 套已随插件安装，不会出现在左侧文件树中。`);
  console.log('接下来：重启或重载 Obsidian，在设置的第三方插件里启用「长风无月 · 公众号排版」。');
} finally {
  await rm(stage, { recursive: true, force: true });
}
