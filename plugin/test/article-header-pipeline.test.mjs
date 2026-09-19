import test from 'node:test';
import assert from 'node:assert/strict';
import { parseThemeManifest } from '../src/theme-package.mjs';
import { renderArticle } from '../src/pipeline.mjs';
import { loadVaultThemeContent } from '../plugin/theme-registry.mjs';
import { copyRenderedArticle } from '../plugin/copy.mjs';

const fixture = (themeId = 'simple-sketch', withHeader = true) => {
  const raw = {
    schema_version: 3, theme_id: themeId, name: '简笔手绘',
    assets: ['default', 'research', 'create', 'frieze'].map((id) => ({
      asset_id: id, file: `透明装饰素材/${id}.png`,
    })),
    components: [
      { component_id: 'frieze', slot: 'before_article', file: '正文组件结构/frieze.html', asset_ids: ['frieze'] },
      { component_id: 'opening', slot: 'before_article', file: '正文组件结构/opening.html', asset_ids: ['default'] },
      { component_id: 'footer', slot: 'after_article', file: '正文组件结构/footer.html', asset_ids: [] },
    ],
    ...(withHeader ? {
      article_header: {
        component_id: 'opening', default_asset_id: 'default',
        presets: [
          { asset_id: 'default', label: '整理思路' },
          { asset_id: 'research', label: '探索问题' },
          { asset_id: 'create', label: '协作创作' },
        ],
      },
    } : {}),
  };
  const manifest = parseThemeManifest(JSON.stringify(raw));
  const html = {
    frieze: '<section class="frieze"></section>',
    opening: '<section class="opening"><img src="theme-asset://default" alt="文章头图"></section>',
    footer: '<section class="footer">版尾保持不变</section>',
  };
  const components = manifest.components.map((component) => ({ ...component, html: html[component.id] }));
  const assets = manifest.assets.map((asset) => ({
    ...asset, url: `app://local/${themeId}/${asset.id}.png`, filePath: `主题/${themeId}/${asset.file}`,
  }));
  const css = '#nice { color:#333333; } #nice .opening img { display:block; width:100%; height:auto; } '
    + '#nice .frieze { height:12px; background-image:url("theme-asset://frieze"); background-size:100% 100%; }';
  return { raw, manifest, components, assets, css };
};

const render = (theme, patch = {}) => renderArticle({
  source: '# 章节标题\n\n正文内容保持不变。',
  themeCss: theme.css,
  themeComponents: theme.components,
  themeAssets: theme.assets,
  themeHeader: theme.manifest.articleHeader,
  resolve: () => null,
  ...patch,
});

test('manifest 声明经过 registry 读取后保留，供预览统一管线使用', async () => {
  const theme = fixture();
  const files = new Map();
  const cssFile = { path: 'theme.css' };
  files.set(cssFile.path, theme.css);
  const components = theme.components.map((component) => {
    const file = { path: component.file };
    files.set(file.path, component.html);
    return { ...component, file };
  });
  const assets = theme.assets.map((asset) => ({ ...asset, file: { path: asset.filePath } }));
  const loaded = await loadVaultThemeContent({
    kind: 'v3', name: '简笔手绘', cssFile, components, assets,
    articleHeader: theme.manifest.articleHeader,
  }, {
    vault: {
      cachedRead: async (file) => files.get(file.path),
      getResourcePath: (file) => `app://local/${file.path}`,
    },
  });
  assert.deepEqual(loaded.articleHeader, theme.manifest.articleHeader);
  assert.deepEqual(loaded.problems, []);
  assert.deepEqual(loaded.components.map((component) => component.html), theme.components.map((component) => component.html));
  const rendered = renderArticle({
    source: '正文', themeCss: loaded.css, themeComponents: loaded.components,
    themeAssets: loaded.assets, themeHeader: loaded.articleHeader,
    headerSelection: { preset: 'research' }, resolve: () => null,
  });
  assert.ok(rendered.images.some((image) => image.filePath.endsWith('/research.png')));
  assert.ok(!rendered.images.some((image) => image.filePath.endsWith('/default.png')));
  assert.deepEqual(rendered.warnings, []);
});

test('完整管线无文章设置使用默认头图，隐藏仅移除声明组件并保留正文首图', () => {
  const theme = fixture();
  const baseline = render(theme);
  assert.equal(baseline.stage, 'wechat-compatible');
  assert.deepEqual(baseline.warnings, []);
  assert.match(baseline.html, /class="opening"/);
  assert.match(baseline.html, /width:100%/);
  assert.ok(baseline.images.some((image) => image.filePath.endsWith('/default.png')));
  const hidden = render(theme, {
    source: '![[正文首图.png]]\n\n正文内容保持不变。',
    headerSelection: { enabled: false },
    resolve: (path) => ({ url: 'app://local/body-first.png', filePath: path }),
  });
  assert.doesNotMatch(hidden.html, /class="opening"/);
  assert.match(hidden.html, /class="frieze"/);
  assert.match(hidden.html, /版尾保持不变/);
  assert.match(hidden.html, /正文内容保持不变/);
  assert.match(hidden.html, /app:\/\/local\/body-first\.png/);
  assert.deepEqual(hidden.images.map((image) => image.filePath).sort(), [
    '正文首图.png', '主题/simple-sketch/透明装饰素材/frieze.png',
  ].sort());
  assert.deepEqual(hidden.warnings, []);
});

test('完整管线选择三个预设时图片清单只交付所选头图，未残留内部 asset token', () => {
  const theme = fixture();
  for (const preset of ['default', 'research', 'create']) {
    const result = render(theme, { headerSelection: { enabled: true, preset } });
    assert.deepEqual(result.images.map((image) => image.filePath).sort(), [
      `主题/simple-sketch/透明装饰素材/${preset}.png`,
      '主题/simple-sketch/透明装饰素材/frieze.png',
    ].sort());
    assert.ok(result.images.every((image) => image.origin === 'theme'));
    assert.doesNotMatch(result.html, /theme-asset:\/\//);
    assert.equal(result.compatibility.removedStyleCount, 0);
    assert.deepEqual(result.warnings, []);
  }
});

test('自定义头图在完整管线保留 article origin、真实附件路径，并与正文复用解析缓存', () => {
  const theme = fixture();
  const calls = [];
  const result = render(theme, {
    source: '正文引用同一张图。\n\n![[附件/我的头图.png]]',
    headerSelection: { custom_image: '[[附件/我的头图.png]]' },
    resolve: (path) => {
      calls.push(path);
      return { url: 'app://local/custom.png', filePath: '附件/我的头图.png' };
    },
  });
  assert.deepEqual(calls, ['附件/我的头图.png']);
  assert.equal((result.html.match(/src="app:\/\/local\/custom\.png"/g) ?? []).length, 2);
  const records = result.images.filter((image) => image.filePath === '附件/我的头图.png');
  assert.equal(records.length, 1);
  assert.equal(records[0].origin, 'article');
  assert.ok(!result.images.some((image) => image.filePath.endsWith('/default.png')));
  assert.deepEqual(result.warnings, []);

  const onlyHeader = render(theme, {
    headerSelection: { custom_image: '附件/我的头图.png' },
    resolve: () => ({ url: 'app://local/custom.png', filePath: '附件/我的头图.png' }),
  });
  assert.equal(onlyHeader.images.find((image) => image.filePath === '附件/我的头图.png').origin, 'article');
});

test('自定义头图继续通过复制模块变成可交付图片，真实剪贴板不参与测试', async () => {
  const theme = fixture();
  const rendered = render(theme, {
    headerSelection: { custom_image: '附件/custom.png' },
    resolve: () => ({ url: 'app://local/custom.png', filePath: '附件/custom.png' }),
  });
  let clipboardPayload;
  const readPaths = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const copied = await copyRenderedArticle({
    html: rendered.html, text: '正文内容保持不变。', images: rendered.images,
    embedImages: true,
    resolveFile: (_target, image) => ({ path: image.filePath, stat: { size: png.length } }),
    readBinary: async (file) => { readPaths.push(file.path); return png; },
    _clipboard: { write: (value) => { clipboardPayload = value; } },
  });
  assert.deepEqual(copied.warnings, []);
  assert.ok(readPaths.includes('附件/custom.png'));
  assert.match(clipboardPayload.html, /src="data:image\/png;base64,/);
  assert.doesNotMatch(clipboardPayload.html, /app:\/\/local|theme-asset:\/\//);
  assert.equal(copied.stats.articleImages.total, 1);
  assert.equal(copied.stats.articleImages.embedded, 1);
  assert.equal(copied.stats.themeImages.total, 0);
});

test('非法设置或丢失附件回退默认，正文和原有装饰继续完整渲染', () => {
  const theme = fixture();
  const baseline = render(theme);
  for (const selection of [{ preset: 'unknown' }, { custom_image: '../outside.png' }, { custom_image: '附件/丢失.png' }, { enabled: 'false' }, 'broken']) {
    const result = render(theme, { headerSelection: selection });
    assert.equal(result.html, baseline.html);
    assert.deepEqual(result.images, baseline.images);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /默认头图/);
  }
});

test('手写头图设置不能把 Markdown 或其他非图片附件误渲染成头图', () => {
  const theme = fixture();
  const baseline = render(theme);
  for (const path of ['附件/文章.md', '附件/文件.pdf', '附件/脚本.svg']) {
    const result = render(theme, {
      headerSelection: { custom_image: path },
      resolve: (filePath) => ({ url: `app://local/${filePath}`, filePath }),
    });
    assert.equal(result.html, baseline.html);
    assert.match(result.warnings[0], /默认头图/);
  }
  const wrongFile = render(theme, {
    headerSelection: { custom_image: '头像.png' },
    resolve: () => ({ url: 'app://local/错误.md', filePath: '错误.md' }),
  });
  assert.equal(wrongFile.html, baseline.html);
  assert.match(wrongFile.warnings[0], /默认头图/);
});

test('切换文章和主题不会污染主题缓存，没有头图声明的其他主题完全保持原样', () => {
  const theme = fixture();
  const another = fixture('nyx-night', false);
  const before = structuredClone(theme);
  const normal = render(theme);
  const otherNormal = render(another);
  render(theme, { headerSelection: { preset: 'research' } });
  render(theme, { headerSelection: { enabled: false } });
  render(theme, {
    headerSelection: { custom_image: '附件/custom.png' },
    resolve: () => ({ url: 'app://local/custom.png', filePath: '附件/custom.png' }),
  });
  for (const headerSelection of [{ enabled: false }, { preset: 'research' }, { custom_image: '附件/custom.png' }]) {
    const otherResult = render(another, { headerSelection });
    assert.equal(otherResult.html, otherNormal.html);
    assert.deepEqual(otherResult.images, otherNormal.images);
    assert.deepEqual(otherResult.warnings, []);
  }
  assert.deepEqual(render(theme), normal);
  assert.deepEqual(theme, before);
});
