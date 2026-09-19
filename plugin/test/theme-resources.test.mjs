import test from 'node:test';
import assert from 'node:assert/strict';
import { ThemeResources } from '../plugin/theme-resources.mjs';
import { migrateLegacyThemeSettings } from '../plugin/settings-migration.mjs';
import { DEFAULT_SETTINGS } from '../plugin/constants.mjs';

const root = '.obsidian/plugins/changfeng-wechat-mp';
const setup = (files = ['sample/manifest.json', 'sample/theme.css', 'sample/配套字体资源/coverage.json']) => {
  const text = new Map([
    [`${root}/templates/catalog.json`, JSON.stringify({ schema_version: 1,
      themes: [{ theme_id: 'sample', directory: 'sample', name: '测试模板', order: 1 }],
      files: files.map(path => ({ path, bytes: 12 })),
    })],
    [`${root}/templates/sample/manifest.json`, JSON.stringify({ schema_version: 3, theme_id: 'sample', name: '测试模板' })],
    [`${root}/templates/sample/theme.css`, '#nice { color: #123456; }'],
  ]);
  const article = { path: 'article.png' };
  const vault = {
    adapter: {
      read: async path => { if (!text.has(path)) throw new Error('Missing'); return text.get(path); },
      readBinary: async () => new Uint8Array([1, 2, 3]).buffer,
      getResourcePath: path => `app://plugin/${path}`,
    },
    getAbstractFileByPath: path => path === article.path ? article : null,
    cachedRead: async () => 'article text', read: async () => 'article text',
    readBinary: async () => new Uint8Array([4, 5, 6]).buffer,
    getResourcePath: () => 'app://article',
  };
  return { resources: new ThemeResources({ vault, pluginDir: root, metadataCache: {} }), article };
};

test('新用户默认内置模板，升级保留开发者主题来源和已选 ID', () => {
  assert.equal(DEFAULT_SETTINGS.themeSource, 'bundled');
  assert.equal(DEFAULT_SETTINGS.themeFolder, '');
  assert.equal(migrateLegacyThemeSettings({}).settings.themeSource, 'bundled');
  const original = { themeFolder: 'My themes', selectedThemeId: 'nyx-night', mobilePreview: true };
  const { settings } = migrateLegacyThemeSettings(original);
  assert.equal(settings.themeSource, 'vault');
  assert.equal(settings.themeFolder, 'My themes');
  assert.equal(settings.selectedThemeId, 'nyx-night');
  assert.equal(settings.mobilePreview, true);
});

test('隐藏目录主题无创作规范也能加载，并逐文件区分主题资源和文章图片', async () => {
  const { resources, article } = setup();
  await resources.initialize();
  const result = await resources.discover(DEFAULT_SETTINGS);
  assert.deepEqual(result.problems, []);
  assert.equal(result.themes[0].themeId, 'sample');
  const file = resources.getAbstractFileByPath(`${root}/templates/sample/theme.css`);
  assert.equal(resources.ownsFile(file), true);
  assert.equal(resources.ownsFile({ path: file.path }), false);
  assert.match(await resources.cachedRead(file), /123456/);
  assert.deepEqual([...new Uint8Array(await resources.readBinary(file))], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(await resources.readBinary(article))], [4, 5, 6]);
  assert.equal(resources.getAbstractFileByPath(article.path), article);
  assert.ok(resources.getAbstractFileByPath(`${root}/templates/sample/配套字体资源/coverage.json`));
});

test('损坏和越界资源清单明确失败，不读取 Vault 其他目录', async () => {
  const { resources } = setup(['../private.md']);
  await resources.initialize();
  const result = await resources.discover(DEFAULT_SETTINGS);
  assert.deepEqual(result.themes, []);
  assert.match(result.problems[0], /不能越出主题包/);
});

test('发布包根目录 README 不是第11个主题，不访问 Vault 元数据缓存', async () => {
  const { resources } = setup(['README.md', 'sample/manifest.json', 'sample/theme.css']);
  await resources.initialize();
  const result = await resources.discover(DEFAULT_SETTINGS);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.themes.map(theme => theme.themeId), ['sample']);
});
