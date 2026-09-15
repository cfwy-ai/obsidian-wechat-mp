import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPluginThemeVault,
  createThemeAwareReader,
  pluginThemeFolder,
} from '../plugin/plugin-theme-vault.mjs';

const PLUGIN_DIR = '.obsidian/plugins/changfeng-wechat-mp';
const THEMES = `${PLUGIN_DIR}/themes`;

/** 用内存目录树伪造 vault.adapter，验证不经 Obsidian 索引也能发现主题 */
const makeAdapter = (tree) => ({
  list: async (path) => {
    if (!(path in tree)) throw new Error(`不存在：${path}`);
    return tree[path];
  },
  exists: async (path) => path in tree || Object.values(tree).some((n) => n.files.includes(path)),
  stat: async () => ({ size: 12, mtime: 1, ctime: 1 }),
  read: async (path) => `text:${path}`,
  readBinary: async (path) => new Uint8Array([1, 2, 3]).buffer,
  getResourcePath: (path) => `app://local/${path}`,
});

const FULL_TREE = {
  [THEMES]: { files: [], folders: [`${THEMES}/dune-echo`] },
  [`${THEMES}/dune-echo`]: {
    files: [`${THEMES}/dune-echo/manifest.json`, `${THEMES}/dune-echo/theme.css`, `${THEMES}/dune-echo/.DS_Store`],
    folders: [`${THEMES}/dune-echo/透明装饰素材`],
  },
  [`${THEMES}/dune-echo/透明装饰素材`]: {
    files: [`${THEMES}/dune-echo/透明装饰素材/ref-sand.png`],
    folders: [],
  },
};

test('插件目录下的主题包不经 Obsidian 索引即可发现', async () => {
  const app = { vault: { adapter: makeAdapter(FULL_TREE), configDir: '.obsidian' } };
  const vault = await createPluginThemeVault(app, PLUGIN_DIR);
  assert.ok(vault, '应识别出插件目录形态');
  assert.equal(vault.source, 'plugin');
  assert.equal(vault.themeFolder, THEMES);

  const folder = vault.getAbstractFileByPath(`${THEMES}/dune-echo`);
  assert.ok(Array.isArray(folder.children), '主题目录应表现为文件夹');

  const css = vault.getAbstractFileByPath(`${THEMES}/dune-echo/theme.css`);
  assert.ok(css && !Array.isArray(css.children), 'theme.css 应表现为文件');
  assert.equal(css.parent.path, `${THEMES}/dune-echo`, '应保留 parent 供直属判断');

  const asset = vault.getAbstractFileByPath(`${THEMES}/dune-echo/透明装饰素材/ref-sand.png`);
  assert.ok(asset, '嵌套目录中的素材应被索引');
  assert.equal(typeof asset.stat.size, 'number', '应带 stat 供体积门槛判断');
});

test('.DS_Store 不进索引，避免被当成主题文件', async () => {
  const app = { vault: { adapter: makeAdapter(FULL_TREE), configDir: '.obsidian' } };
  const vault = await createPluginThemeVault(app, PLUGIN_DIR);
  assert.equal(vault.getAbstractFileByPath(`${THEMES}/dune-echo/.DS_Store`), null);
});

test('插件目录没有主题包时返回 null，交给调用方回退 vault', async () => {
  const empty = { [THEMES]: { files: [`${THEMES}/README.md`], folders: [] } };
  const app = { vault: { adapter: makeAdapter(empty), configDir: '.obsidian' } };
  assert.equal(await createPluginThemeVault(app, PLUGIN_DIR), null, '只有文件没有主题目录应视为未安装');

  const missing = { vault: { adapter: makeAdapter({}), configDir: '.obsidian' } };
  assert.equal(await createPluginThemeVault(missing, PLUGIN_DIR), null, 'themes 目录不存在应回退');
});

test('缺少 adapter 时安全回退，不抛异常', async () => {
  assert.equal(await createPluginThemeVault({ vault: {} }, PLUGIN_DIR), null);
  assert.equal(await createPluginThemeVault({}, PLUGIN_DIR), null);
});

test('主题目录路径由 manifest.dir 推导，缺省时回落 configDir', () => {
  assert.equal(pluginThemeFolder({}, PLUGIN_DIR), THEMES);
  assert.equal(
    pluginThemeFolder({ vault: { configDir: '.obsidian-custom' } }, ''),
    '.obsidian-custom/plugins/changfeng-wechat-mp/themes',
  );
});

test('读取路由把主题文件送往主题源，正文图片仍走真实 vault', async () => {
  const app = { vault: { adapter: makeAdapter(FULL_TREE), configDir: '.obsidian' } };
  const themeVault = await createPluginThemeVault(app, PLUGIN_DIR);

  const calls = [];
  const appVault = {
    readBinary: async (file) => { calls.push(['vault', file.path]); return new ArrayBuffer(0); },
    getResourcePath: (file) => { calls.push(['vault', file.path]); return `app://vault/${file.path}`; },
    cachedRead: async (file) => { calls.push(['vault', file.path]); return 'article'; },
    getAbstractFileByPath: (path) => ({ path, fromVault: true }),
  };
  const reader = createThemeAwareReader(appVault, themeVault);

  const asset = { path: `${THEMES}/dune-echo/透明装饰素材/ref-sand.png` };
  await reader.readBinary(asset);
  assert.deepEqual(calls, [], '主题素材不应落到真实 vault');
  assert.match(reader.getResourcePath(asset), /^app:\/\/local\//, '主题素材应由 adapter 给出地址');

  const articleImage = { path: '00｜本库附件/插图.png' };
  await reader.readBinary(articleImage);
  assert.deepEqual(calls, [['vault', '00｜本库附件/插图.png']], '正文图片必须走真实 vault');

  assert.equal(
    reader.getAbstractFileByPath('00｜本库附件/插图.png').fromVault,
    true,
    '非主题路径的查找应交给真实 vault',
  );
});

test('开发形态下读取路由完全等价于真实 vault', async () => {
  const seen = [];
  const appVault = {
    readBinary: async (file) => { seen.push(file.path); return new ArrayBuffer(0); },
    getResourcePath: (file) => `app://vault/${file.path}`,
    cachedRead: async () => 'text',
    getAbstractFileByPath: (path) => ({ path }),
  };
  // themeVault 为 null 即开发形态（主题正本仍在 vault 里）
  const reader = createThemeAwareReader(appVault, null);
  await reader.readBinary({ path: '主题仓库/dune-echo/theme.css' });
  assert.deepEqual(seen, ['主题仓库/dune-echo/theme.css'], '无插件主题包时一切照旧');
});

test('发布形态不再要求视觉规范与展示案例，开发形态仍然要求', async () => {
  const { discoverVaultThemes } = await import('../plugin/theme-registry.mjs');
  const app = { vault: { adapter: makeAdapter(FULL_TREE), configDir: '.obsidian' } };
  const vault = await createPluginThemeVault(app, PLUGIN_DIR);

  // 真实 manifest 形状，最小可渲染
  const manifest = {
    schema_version: 3, theme_id: 'dune-echo', name: '沙丘版画',
    theme_palette: '沙色配色', theme_scenes: ['叙事'],
    assets: [{ asset_id: 'ref-sand', file: '透明装饰素材/ref-sand.png', alt: '沙纹' }],
    components: [], fonts: [], heading_images: [],
  };
  const readingVault = { ...vault, cachedRead: async (f) => (
    f.path.endsWith('manifest.json') ? JSON.stringify(manifest) : `text:${f.path}`) };

  const released = await discoverVaultThemes({
    vault: readingVault, metadataCache: { getFileCache: () => null },
    themeFolder: THEMES, requireAuthoringDocs: false,
  });
  assert.deepEqual(released.problems, [], '剥掉作者资料后不应报问题');
  assert.equal(released.themes.length, 1, '主题应正常注册');
  assert.equal(released.themes[0].themeId, 'dune-echo');

  const authoring = await discoverVaultThemes({
    vault: readingVault, metadataCache: { getFileCache: () => null },
    themeFolder: THEMES, requireAuthoringDocs: true,
  });
  assert.equal(authoring.themes.length, 0, '开发形态缺资料应拒绝注册');
  assert.match(authoring.problems.join(), /缺少/, '并给出明确原因');
});
