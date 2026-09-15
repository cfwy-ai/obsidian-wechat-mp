import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArticleHeader, resolveArticleHeader } from '../src/article-header.mjs';
import { applyThemeComponents } from '../src/theme-package.mjs';

const fixture = () => {
  const assets = ['default', 'research', 'create', 'frieze'].map((id) => ({
    id, url: `app://vault/${id}.png`, filePath: `主题/素材/${id}.png`,
  }));
  const components = [
    { id: 'frieze', slot: 'before_article', assetIds: ['frieze'], html: '<div class="frieze"></div>' },
    { id: 'opening', slot: 'before_article', assetIds: ['default'], html: '<section class="opening"><img src="theme-asset://default" alt=""></section>' },
    { id: 'footer', slot: 'after_article', assetIds: [], html: '<section>版尾保持不变</section>' },
  ];
  const raw = {
    component_id: 'opening', default_asset_id: 'default',
    presets: [
      { asset_id: 'default', label: '整理思路' },
      { asset_id: 'research', label: '探索问题' },
      { asset_id: 'create', label: '协作创作' },
    ],
  };
  const definition = normalizeArticleHeader(raw, { components, assets });
  return { components, assets, raw, definition };
};

test('未声明头图的旧主题保持原组件，即便文章有头图设置', () => {
  const input = fixture();
  assert.equal(normalizeArticleHeader(undefined), null);
  assert.equal(normalizeArticleHeader(null), null);
  const result = resolveArticleHeader({ ...input, definition: null, selection: { enabled: false } });
  assert.deepEqual(result, { components: input.components, assets: input.assets, warnings: [] });
});

test('归一头图声明、预设标签与重复预设', () => {
  const { raw, components, assets } = fixture();
  raw.presets.push({ asset_id: 'default', label: '重复' });
  raw.presets[0].label = '  整理   思路  ';
  assert.deepEqual(normalizeArticleHeader(raw, { components, assets }), {
    componentId: 'opening', defaultAssetId: 'default', presets: [
      { assetId: 'default', label: '整理 思路' },
      { assetId: 'research', label: '探索问题' },
      { assetId: 'create', label: '协作创作' },
    ],
  });
});

test('非法头图声明不能误把其他插槽或未登记素材作为头图', () => {
  const { raw, components, assets } = fixture();
  for (const value of [false, 'opening', [], 3]) {
    assert.throws(() => normalizeArticleHeader(value, { components, assets }), /必须是对象/);
  }
  assert.throws(() => normalizeArticleHeader({ ...raw, component_id: 'missing' }, { components, assets }), /不存在/);
  assert.throws(() => normalizeArticleHeader({ ...raw, component_id: 'footer' }, { components, assets }), /before_article/);
  assert.throws(() => normalizeArticleHeader({ ...raw, default_asset_id: 'create' }, { components, assets }), /asset_ids/);
  assert.throws(() => normalizeArticleHeader(raw, { components, assets: assets.filter((asset) => asset.id !== 'default') }), /默认素材未登记/);
  assert.throws(() => normalizeArticleHeader({ ...raw, presets: raw.presets.slice(1) }, { components, assets }), /必须包含在 presets/);
  for (const presets of [[], Array.from({ length: 13 }, () => raw.presets[0]), null]) {
    assert.throws(() => normalizeArticleHeader({ ...raw, presets }, { components, assets }), /1–12/);
  }
  for (const preset of [{ asset_id: 'unknown', label: '未知' }, { asset_id: 'default', label: '' }, { asset_id: 'default', label: '字'.repeat(25) }]) {
    assert.throws(() => normalizeArticleHeader({ ...raw, presets: [preset] }, { components, assets }));
  }
});

test('无文章设置和默认选择沿用原头图', () => {
  const input = fixture();
  for (const selection of [undefined, null, {}, { enabled: true }, { preset: 'default' }]) {
    assert.deepEqual(resolveArticleHeader({ ...input, selection }), {
      components: input.components, assets: input.assets, warnings: [],
    });
  }
});

test('关闭仅移除明确声明的头图，其他开场装饰与版尾不变', () => {
  const input = fixture();
  const result = resolveArticleHeader({ ...input, selection: { enabled: false, preset: 'research' } });
  assert.deepEqual(result.components, [input.components[0], input.components[2]]);
  const article = '<section id="nice"><p><img src="https://example.test/article.png"></p></section>';
  const rendered = applyThemeComponents(article, result.components, result.assets);
  assert.ok(rendered.html.includes('https://example.test/article.png'));
  assert.ok(rendered.html.includes('frieze'));
  assert.ok(rendered.html.includes('版尾保持不变'));
  assert.ok(!rendered.html.includes('class="opening"'));
});

test('预设只替换目标组件的默认素材，预览与复制共用的图片清单包含所选图', () => {
  const input = fixture();
  const result = resolveArticleHeader({ ...input, selection: { preset: 'research' } });
  assert.equal(result.components[0], input.components[0]);
  assert.equal(result.components[2], input.components[2]);
  assert.match(result.components[1].html, /theme-asset:\/\/research/);
  assert.deepEqual(result.components[1].assetIds, ['research']);
  const rendered = applyThemeComponents('<section id="nice"><p>正文</p></section>', result.components, result.assets);
  assert.deepEqual(rendered.images.map((image) => image.filePath), ['主题/素材/research.png']);
  assert.deepEqual(rendered.warnings, []);
});

test('自定义 Vault 图片注入独立 asset，按正文图片记录且不覆盖同名主题素材', () => {
  const input = fixture();
  input.assets.push({ id: 'article-header-custom', url: 'app://existing', filePath: '已有.png' });
  let resolvedPath;
  const result = resolveArticleHeader({
    ...input,
    selection: { enabled: true, custom_image: '[[附件/我的头图.png]]' },
    resolveCustom: (path) => {
      resolvedPath = path;
      return { url: 'app://vault/custom.png', filePath: '附件/我的头图.png', width: 1200, height: 400 };
    },
  });
  assert.equal(resolvedPath, '附件/我的头图.png');
  const custom = result.assets.at(-1);
  assert.equal(custom.id, 'article-header-custom-2');
  assert.equal(custom.origin, 'article');
  assert.equal(custom.filePath, '附件/我的头图.png');
  assert.equal(custom.width, 1200);
  assert.equal(custom.target, '附件/我的头图.png');
  assert.match(result.components[1].html, /theme-asset:\/\/article-header-custom-2/);
  assert.deepEqual(result.warnings, []);
});

test('自定义允许普通 Vault 路径、空格和百分号文件名，优先于之前预设', () => {
  const input = fixture();
  for (const path of ['附件/banner.png', '我的 头图.png', '附件/100%.png']) {
    const result = resolveArticleHeader({
      ...input, selection: { custom_image: path, preset: 'research' },
      resolveCustom: (value) => ({ url: 'app://vault/custom', filePath: value }),
    });
    assert.deepEqual(result.warnings, []);
    assert.equal(result.assets.at(-1).target, path);
  }
});

test('自定义路径拒绝远程、文件系统绝对路径、越界、编码越界及链接别名', () => {
  const input = fixture();
  const unsafe = ['https://site.test/a.png', 'http://a.png', 'file:///tmp/a.png', '/tmp/a.png', '~/a.png',
    '../a.png', '附件/../a.png', 'C:\\a.png', '附件\\a.png', '//host/a.png',
    '%2e%2e/a.png', '%2Ftmp/a.png', '[[../a.png]]', '[[附件/a.png|别名]]', '[[附件/a.png#部分]]', '附件/\u0000.png'];
  for (const path of unsafe) {
    let calls = 0;
    const result = resolveArticleHeader({ ...input, selection: { custom_image: path }, resolveCustom: () => { calls += 1; } });
    assert.equal(calls, 0, path);
    assert.equal(result.warnings.length, 1, path);
    assert.deepEqual(result.components, input.components, path);
  }
});

test('丢失图片、解析异常、未知预设与坏设置均保留默认并明确提示', () => {
  const input = fixture();
  const cases = [
    { selection: { preset: 'unknown' } },
    { selection: { custom_image: '附件/lost.png' }, resolveCustom: () => null },
    { selection: { custom_image: '附件/broken.png' }, resolveCustom: () => { throw new Error('读取失败'); } },
    { selection: { custom_image: '附件/no-path.png' }, resolveCustom: () => ({ url: 'app://image' }) },
    ...[[], 'preset', true, { enabled: 'false' }, { preset: 2 }, { custom_image: {} }].map((selection) => ({ selection })),
  ];
  for (const patch of cases) {
    const result = resolveArticleHeader({ ...input, ...patch });
    assert.deepEqual(result.components, input.components);
    assert.deepEqual(result.assets, input.assets);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /默认头图/);
  }
  const missing = resolveArticleHeader({ ...input, assets: input.assets.filter((asset) => asset.id !== 'research'), selection: { preset: 'research' } });
  assert.match(missing.warnings[0], /不可读取/);
});

test('组件文件与声明不匹配时不替换其他开场图片', () => {
  const input = fixture();
  input.components[1].html = '<section><img src="theme-asset://default-other"></section>';
  const result = resolveArticleHeader({ ...input, selection: { preset: 'research' } });
  assert.deepEqual(result.components, input.components);
  assert.match(result.warnings[0], /缺少可替换图片/);
});

test('替换保留组件其他素材引用且所有输入均未修改', () => {
  const input = fixture();
  input.components[1].assetIds.push('frieze');
  input.components[1].html += '<img src="theme-asset://frieze">';
  const before = structuredClone(input);
  const result = resolveArticleHeader({
    ...input,
    selection: { custom_image: '附件/custom.png' },
    resolveCustom: () => ({ url: 'app://vault/custom.png', filePath: '附件/custom.png' }),
  });
  assert.deepEqual(input, before);
  assert.deepEqual(result.components[1].assetIds, ['article-header-custom', 'frieze']);
  assert.ok(result.components[1].html.includes('theme-asset://frieze'));
});
