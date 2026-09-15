import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoverVaultThemes,
  loadVaultThemeContent,
  selectThemeDescriptor,
} from '../plugin/theme-registry.mjs';

const THEME_FOLDER = '06｜个人账号运营/2. 排版配图/5. 图文主题仓库';

const makeFixture = ({
  duplicate = false,
  missingAsset = false,
  missingPreview = false,
  unreadablePreview = false,
  withHeadingImage = false,
  missingFont = false,
  legacyFontDirectory = false,
  withDarkMode = false,
} = {}) => {
  const entries = new Map();
  const sources = new Map();
  const folder = (path, parent = null) => {
    const value = {
      path,
      name: path.split('/').at(-1),
      parent,
      children: [],
    };
    entries.set(path, value);
    if (parent) parent.children.push(value);
    return value;
  };
  const file = (path, parent, source) => {
    const name = path.split('/').at(-1);
    const value = {
      path,
      name,
      basename: name.replace(/\.[^.]+$/, ''),
      extension: name.includes('.') ? name.split('.').at(-1) : '',
      parent,
      stat: { size: String(source ?? '').length },
    };
    entries.set(path, value);
    sources.set(path, String(source ?? ''));
    parent?.children.push(value);
    return value;
  };

  const root = folder(THEME_FOLDER);
  const v1 = file(`${THEME_FOLDER}/2. 旧版主题.md`, root, [
    '---',
    'theme_palette: 纸白',
    'theme_scenes: 教程',
    '---',
    '```css',
    '#nice { color: #222; }',
    '```',
  ].join('\n'));
  const packageFolder = folder(`${THEME_FOLDER}/1. 纪念碑谷`, root);
  const visualSpecFolder = folder(`${packageFolder.path}/主题视觉规范`, packageFolder);
  const componentFolder = folder(`${packageFolder.path}/正文组件结构`, packageFolder);
  const assetFolder = folder(`${packageFolder.path}/透明装饰素材`, packageFolder);
  const showcaseFolder = folder(`${packageFolder.path}/主题展示案例`, packageFolder);
  const fontDirectory = legacyFontDirectory ? '字体资源' : '配套字体资源';
  const fontFolder = withHeadingImage
    ? folder(`${packageFolder.path}/${fontDirectory}`, packageFolder)
    : null;
  const manifest = {
    schema_version: 3,
    theme_id: 'monument-valley',
    name: '纪念碑谷',
    theme_palette: ['暖白', '珊瑚红'],
    theme_style: ['建筑插画'],
    theme_elements: ['纪念碑', '阶梯'],
    theme_scenes: ['长文'],
    ...(withDarkMode ? { wechat_dark_mode: { strategy: 'preserve-backgrounds', table_border_color: '#C9A45C' } } : {}),
    preview_image: '主题展示案例/主题预览图.png',
    assets: [{ asset_id: 'mark', file: '透明装饰素材/mark.png' }],
    components: [{
      component_id: 'divider',
      file: '正文组件结构/divider.html',
      slot: 'before_heading',
      asset_ids: ['mark'],
    }],
    ...(withHeadingImage ? {
      fonts: [{
        font_id: 'display',
        file: `${fontDirectory}/display.ttf`,
        family: 'Display',
        sha256: 'a'.repeat(64),
      }],
      heading_images: [{
        heading_image_id: 'h1-display',
        heading_levels: [1],
        font_id: 'display',
        align: 'left',
        number_assets: ['mark'],
        number_separator: '·',
      }],
    } : {}),
  };
  file(`${packageFolder.path}/manifest.json`, packageFolder, JSON.stringify(manifest));
  file(`${packageFolder.path}/theme.css`, packageFolder, '#nice .divider { width: 20px; }');
  file(`${visualSpecFolder.path}/1. 视觉风格总则.md`, visualSpecFolder, '视觉风格总则');
  file(`${visualSpecFolder.path}/2. 文章封图规范.md`, visualSpecFolder, '文章封图规范');
  file(`${visualSpecFolder.path}/3. 正文配图规范.md`, visualSpecFolder, '正文配图规范');
  file(`${componentFolder.path}/divider.html`, componentFolder, '<img class="divider" src="theme-asset://mark">');
  if (!missingAsset) file(`${assetFolder.path}/mark.png`, assetFolder, 'png');
  if (!missingPreview) file(`${showcaseFolder.path}/主题预览图.png`, showcaseFolder, 'png');
  if (withHeadingImage && !missingFont) file(`${fontFolder.path}/display.ttf`, fontFolder, 'font');

  if (duplicate) {
    const second = folder(`${THEME_FOLDER}/3. 重复主题`, root);
    const secondVisualSpecs = folder(`${second.path}/主题视觉规范`, second);
    folder(`${second.path}/正文组件结构`, second);
    folder(`${second.path}/透明装饰素材`, second);
    folder(`${second.path}/主题展示案例`, second);
    file(`${second.path}/manifest.json`, second, JSON.stringify({
      schema_version: 3,
      theme_id: 'monument-valley',
      name: '重复主题',
    }));
    file(`${second.path}/theme.css`, second, '#nice{}');
    file(`${secondVisualSpecs.path}/1. 视觉风格总则.md`, secondVisualSpecs, '视觉风格总则');
    file(`${secondVisualSpecs.path}/2. 文章封图规范.md`, secondVisualSpecs, '文章封图规范');
    file(`${secondVisualSpecs.path}/3. 正文配图规范.md`, secondVisualSpecs, '正文配图规范');
  }

  const vault = {
    getAbstractFileByPath: (path) => entries.get(path) ?? null,
    cachedRead: async (entry) => sources.get(entry.path),
    readBinary: async (entry) => {
      if (unreadablePreview && entry.path.endsWith('/主题展示案例/主题预览图.png')) {
        throw new Error('模拟读取失败');
      }
      return new TextEncoder().encode(sources.get(entry.path) ?? '').buffer;
    },
    getResourcePath: (entry) => `app://vault/${encodeURIComponent(entry.path)}`,
  };
  const metadataCache = {
    getFileCache: (entry) => entry === v1
      ? { frontmatter: { theme_palette: '纸白', theme_scenes: '教程' } }
      : null,
  };
  return { vault, metadataCache, entries };
};

test('Vault 主题注册表并存发现 v1/v3，稳定 ID 优先恢复选择', async () => {
  const fixture = makeFixture();
  const result = await discoverVaultThemes({
    ...fixture,
    themeFolder: THEME_FOLDER,
  });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.themes.map((theme) => [theme.kind, theme.name]), [
    ['v3', '纪念碑谷'],
    ['v1', '旧版主题'],
  ]);
  const selected = selectThemeDescriptor(result.themes, {
    selectedThemeId: 'monument-valley',
    selectedThemeFile: '已经改名的旧路径/manifest.json',
  });
  assert.equal(selected.kind, 'v3');
  assert.equal(selected.themeId, 'monument-valley');
  assert.equal(selected.style, '建筑插画');
  assert.equal(selected.elements, '纪念碑、阶梯');
  assert.equal(selected.previewImage.filePath, `${THEME_FOLDER}/1. 纪念碑谷/主题展示案例/主题预览图.png`);

  const content = await loadVaultThemeContent(selected, { vault: fixture.vault });
  assert.equal(content.css, '#nice .divider { width: 20px; }');
  assert.equal(content.components[0].html, '<img class="divider" src="theme-asset://mark">');
  assert.match(content.assets[0].url, /^app:\/\/vault\//);
  assert.equal(content.assets[0].filePath, `${THEME_FOLDER}/1. 纪念碑谷/透明装饰素材/mark.png`);
});

test('Vault 注册表只为显式 opt-in 主题加载字体描述和标题图片规则', async () => {
  const fixture = makeFixture({ withHeadingImage: true });
  const result = await discoverVaultThemes({
    ...fixture,
    themeFolder: THEME_FOLDER,
  });
  const selected = result.themes.find((theme) => theme.kind === 'v3');
  assert.equal(selected.fonts.length, 1);
  assert.equal(selected.headingImages.length, 1);
  const content = await loadVaultThemeContent(selected, { vault: fixture.vault });
  assert.equal(content.fonts[0].filePath, `${THEME_FOLDER}/1. 纪念碑谷/配套字体资源/display.ttf`);
  assert.deepEqual(content.headingImages[0].headingLevels, [1]);
  assert.equal(content.headingImages[0].align, 'left');
  assert.deepEqual(content.headingImages[0].numberAssets, ['mark']);
  assert.equal(content.headingImages[0].numberSeparator, '·');

  const legacy = result.themes.find((theme) => theme.kind === 'v1');
  const legacyContent = await loadVaultThemeContent(legacy, { vault: fixture.vault });
  assert.deepEqual(legacyContent.fonts, []);
  assert.deepEqual(legacyContent.headingImages, []);
});

test('Vault注册表把显式深色背景策略完整传给运行时，旧主题默认关闭', async () => {
  const fixture=makeFixture({withDarkMode:true});
  const result=await discoverVaultThemes({...fixture,themeFolder:THEME_FOLDER});
  const selected=result.themes.find(theme=>theme.kind==='v3');
  const expected={strategy:'preserve-backgrounds',tableBorderColor:'#C9A45C'};
  assert.deepEqual(selected.wechatDarkMode,expected);
  assert.deepEqual((await loadVaultThemeContent(selected,{vault:fixture.vault})).wechatDarkMode,expected);
  const legacy=await loadVaultThemeContent(result.themes.find(theme=>theme.kind==='v1'),{vault:fixture.vault});
  assert.equal(legacy.wechatDarkMode??null,null);
});

test('Vault loader 在迁移期继续读取旧「字体资源」主题', async () => {
  const fixture = makeFixture({ withHeadingImage: true, legacyFontDirectory: true });
  const result = await discoverVaultThemes({
    ...fixture,
    themeFolder: THEME_FOLDER,
  });
  const selected = result.themes.find((theme) => theme.kind === 'v3');
  assert.ok(selected);
  assert.equal(selected.fonts[0].filePath, `${THEME_FOLDER}/1. 纪念碑谷/字体资源/display.ttf`);
  assert.equal(result.problems.some((problem) => /字体/.test(problem)), false);
});

test('主题字体缺失时保留主题并让运行时逐标题回退', async () => {
  const fixture = makeFixture({ withHeadingImage: true, missingFont: true });
  const result = await discoverVaultThemes({
    ...fixture,
    themeFolder: THEME_FOLDER,
  });
  const selected = result.themes.find((theme) => theme.kind === 'v3');
  assert.ok(selected);
  assert.deepEqual(selected.fonts, []);
  assert.equal(selected.headingImages.length, 1);
  assert.ok(result.problems.some((problem) => /缺少字体/.test(problem)));
});

test('旧平铺主题迁成 v3 目录后按原文件名保留选中主题', async () => {
  const fixture = makeFixture();
  const result = await discoverVaultThemes({
    ...fixture,
    themeFolder: THEME_FOLDER,
  });
  const selected = selectThemeDescriptor(result.themes, {
    selectedThemeFile: `${THEME_FOLDER}/1. 纪念碑谷风格.md`,
  });
  assert.equal(selected.kind, 'v3');
  assert.equal(selected.themeId, 'monument-valley');
});

test('v3 缺任一六字固定目录时不注册为可用主题', async () => {
  const fixture = makeFixture();
  fixture.entries.delete(`${THEME_FOLDER}/1. 纪念碑谷/主题展示案例`);
  const result = await discoverVaultThemes({
    ...fixture,
    themeFolder: THEME_FOLDER,
  });
  assert.equal(result.themes.some((theme) => theme.kind === 'v3'), false);
  assert.ok(result.problems.some((problem) => /主题展示案例/.test(problem)));
});

test('v3 缺素材保留可用主题但给出问题，重复 theme_id 排除后项', async () => {
  const fixture = makeFixture({ duplicate: true, missingAsset: true });
  const result = await discoverVaultThemes({
    ...fixture,
    themeFolder: THEME_FOLDER,
  });
  assert.equal(result.themes.length, 2);
  assert.ok(result.problems.some((problem) => /缺少素材/.test(problem)));
  assert.ok(result.problems.some((problem) => /theme_id.*重复/.test(problem)));
  const selected = result.themes.find((theme) => theme.kind === 'v3');
  const content = await loadVaultThemeContent(selected, { vault: fixture.vault });
  assert.deepEqual(content.assets, []);
});

test('v3 缺少任一视觉规范文档时不注册为可用主题', async () => {
  const fixture = makeFixture();
  fixture.entries.delete(`${THEME_FOLDER}/1. 纪念碑谷/主题视觉规范/3. 正文配图规范.md`);
  const result = await discoverVaultThemes({
    ...fixture,
    themeFolder: THEME_FOLDER,
  });
  assert.equal(result.themes.some((theme) => theme.kind === 'v3'), false);
  assert.ok(result.problems.some((problem) => /正文配图规范\.md/.test(problem)));
});

test('preview_image 缺失或不可读时保留主题并忽略预览图', async () => {
  for (const options of [{ missingPreview: true }, { unreadablePreview: true }]) {
    const fixture = makeFixture(options);
    const result = await discoverVaultThemes({
      ...fixture,
      themeFolder: THEME_FOLDER,
    });
    const selected = result.themes.find((theme) => theme.kind === 'v3');
    assert.ok(selected);
    assert.equal(selected.previewImage, null);
    assert.ok(result.problems.some((problem) => /preview_image/.test(problem)));
  }
});

test('不存在的主题仓库返回明确问题，不扫描 Vault 其他目录', async () => {
  const fixture = makeFixture();
  const result = await discoverVaultThemes({
    ...fixture,
    themeFolder: '不存在/主题仓库',
  });
  assert.deepEqual(result.themes, []);
  assert.match(result.problems[0], /主题仓库不存在/);
});
