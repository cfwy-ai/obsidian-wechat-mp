import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyThemeComponents,
  materializeThemeCss,
  parseThemeManifest,
  safeThemeRelativePath,
  LEGACY_THEME_FONT_DIRECTORY,
  THEME_FONT_DIRECTORY,
  THEME_PACKAGE_DIRECTORIES,
  THEME_VISUAL_SPEC_FILES,
} from '../src/theme-package.mjs';
import { renderArticle } from '../src/pipeline.mjs';
import { renderMarkdown } from '../src/markdown.mjs';

const manifest = (patch = {}) => JSON.stringify({
  schema_version: 3,
  theme_id: 'monument-valley',
  name: '纪念碑谷',
  theme_palette: ['暖白', '珊瑚红'],
  theme_style: ['建筑插画'],
  theme_elements: ['纪念碑', '阶梯'],
  theme_scenes: ['教程', '长文'],
  preview_image: '主题展示案例/主题预览图.png',
  assets: [
    {
      asset_id: 'chapter-mark',
      file: '透明装饰素材/章节徽记.png',
      alt: '章节徽记',
    },
  ],
  components: [
    {
      component_id: 'chapter-divider',
      file: '正文组件结构/章节分隔.html',
      slot: 'before_heading',
      heading_levels: [2],
      asset_ids: ['chapter-mark'],
    },
  ],
  ...patch,
});

const fontAndHeading = (headingPatch = {}) => ({
  fonts: [{
    font_id: 'display',
    file: '配套字体资源/display.ttf',
    family: 'Display',
    sha256: 'a'.repeat(64),
  }],
  heading_images: [{
    heading_image_id: 'h1-display',
    heading_levels: [1],
    font_id: 'display',
    ...headingPatch,
  }],
});

const gildedPaint = {
  type: 'gilded',
  stops: [
    { offset: 0, color: '#684313' },
    { offset: 0.42, color: '#f2d477' },
    { offset: 0.66, color: '#b97820' },
    { offset: 1, color: '#76501a' },
  ],
  stroke: { color: '#442a0a', width: 0.7 },
  highlight: {
    color: '#fffbe8',
    alpha: 0.4,
    width: 0.35,
    offset_x: -0.25,
    offset_y: -0.35,
  },
};

test('标题按容器宽度排版必须显式开启；旧主题规则不增加字段', () => {
  const parse = (width_mode) => parseThemeManifest(manifest(fontAndHeading({ width_mode }))).headingImages[0];
  assert.equal(parse('container').widthMode, 'container');
  assert.equal(Object.hasOwn(parse(undefined), 'widthMode'), false);
  for (const invalid of ['viewport', 'fixed', true, null]) {
    assert.throws(() => parse(invalid), /width_mode/);
  }
});

test('双侧标题素材显式开启且验证登记 ID 与尺寸范围', () => {
  const parse = side_assets => parseThemeManifest(manifest(fontAndHeading({side_assets})));
  const valid = {left_asset_id:'chapter-mark',right_asset_id:'chapter-mark',size:18,gap:8};
  assert.deepEqual(parse(valid).headingImages[0].sideAssets, {
    leftAssetId:'chapter-mark',rightAssetId:'chapter-mark',size:18,gap:8,
  });
  assert.deepEqual(parse({left_asset_id:'chapter-mark',size:18,gap:8}).headingImages[0].sideAssets, {
    leftAssetId:'chapter-mark',size:18,gap:8,
  });
  assert.equal(Object.hasOwn(parse(undefined).headingImages[0],'sideAssets'),false);
  assert.throws(()=>parse({...valid,left_asset_id:'missing'}),/未登记素材/);
  assert.throws(()=>parse({...valid,right_asset_id:'../unsafe'}),/未登记素材/);
  assert.throws(()=>parse({...valid,size:100}),/size/);
  assert.throws(()=>parse({...valid,gap:-1}),/gap/);
  assert.throws(()=>parse({size:18,gap:8}),/至少需要一侧素材/);
  assert.throws(()=>parse(null),/side_assets/);
});

test('标题水印素材按配置归一并拒绝未登记素材和孤立配置', () => {
  const parse = patch => parseThemeManifest(manifest(fontAndHeading(patch))).headingImages[0];
  const rule = parse({
    watermark_assets: ['chapter-mark'],
    watermark: {width:64,height:44,opacity:0.8,offset_x:2,offset_y:-1},
  });
  assert.deepEqual(rule.watermarkAssets, ['chapter-mark']);
  assert.deepEqual(rule.watermark, {width:64,height:44,opacity:0.8,offsetX:2,offsetY:-1});
  assert.equal(Object.hasOwn(parse({}), 'watermarkAssets'), false);
  assert.throws(() => parse({watermark_assets:['missing']}), /未登记素材/);
  assert.throws(() => parse({watermark:{width:64}}), /需要 watermark_assets/);
  assert.throws(() => parse({watermark_assets:['chapter-mark'],watermark:{opacity:0}}), /opacity/);
});

test('v3 manifest 归一稳定 ID、元数据、预览图、素材与安全插槽', () => {
  const parsed = parseThemeManifest(manifest(), { directoryName: '1. 纪念碑谷' });
  assert.equal(parsed.schemaVersion, 3);
  assert.equal(parsed.themeId, 'monument-valley');
  assert.equal(parsed.name, '纪念碑谷');
  assert.deepEqual(parsed.palette, ['暖白', '珊瑚红']);
  assert.deepEqual(parsed.style, ['建筑插画']);
  assert.deepEqual(parsed.elements, ['纪念碑', '阶梯']);
  assert.deepEqual(parsed.scenes, ['教程', '长文']);
  assert.equal(parsed.previewImage, '主题展示案例/主题预览图.png');
  assert.deepEqual(parsed.assets.map((asset) => asset.id), ['chapter-mark']);
  assert.deepEqual(parsed.components[0], {
    id: 'chapter-divider',
    file: '正文组件结构/章节分隔.html',
    slot: 'before_heading',
    headingLevels: [2],
    assetIds: ['chapter-mark'],
  });
  assert.deepEqual(parsed.fonts, []);
  assert.deepEqual(parsed.headingImages, []);
  assert.deepEqual(THEME_PACKAGE_DIRECTORIES, {
    visualSpecs: '主题视觉规范',
    components: '正文组件结构',
    assets: '透明装饰素材',
    showcases: '主题展示案例',
  });
  assert.deepEqual(THEME_VISUAL_SPEC_FILES, [
    '1. 视觉风格总则.md',
    '2. 文章封图规范.md',
    '3. 正文配图规范.md',
  ]);
});

test('schema 3 可选声明主题内字体和标题图片规则，旧主题保持空数组', () => {
  const parsed = parseThemeManifest(manifest({
    fonts: [{
      font_id: 'display',
      file: '配套字体资源/display.ttf',
      family: '仓耳玄三04',
      sha256: 'a'.repeat(64),
      weight: 400,
    }],
    heading_images: [{
      heading_image_id: 'h1-display',
      heading_levels: [1],
      font_id: 'display',
      font_size: 28,
      line_height: 1.46,
      letter_spacing: 1,
      color: '#253246',
      max_width: 331,
      min_display_width: 284,
      min_effective_font_size: 24,
      scale: 3,
      padding_x: 6,
      padding_y: 8,
      max_lines: 3,
      max_equivalent_characters: 40,
      latin_font_family: 'Avenir Next',
      align: 'left',
      number_assets: ['chapter-mark'],
      number_separator: '·',
      number_gap: 6,
    }],
  }));

  assert.deepEqual(parsed.fonts[0], {
    id: 'display',
    file: '配套字体资源/display.ttf',
    family: '仓耳玄三04',
    sha256: 'a'.repeat(64),
    weight: 400,
    style: 'normal',
  });
  assert.deepEqual(parsed.headingImages[0], {
    id: 'h1-display',
    headingLevels: [1],
    fontId: 'display',
    fontSize: 28,
    lineHeight: 1.46,
    letterSpacing: 1,
    color: '#253246',
    maxWidth: 331,
    minDisplayWidth: 284,
    minEffectiveFontSize: 24,
    scale: 3,
    paddingX: 6,
    paddingY: 8,
    maxLines: 3,
    maxEquivalentCharacters: 40,
    latinFontFamily: 'Avenir Next',
    align: 'left',
    numberAssets: ['chapter-mark'],
    numberSeparator: '·',
    numberGap: 6,
  });
  const defaults = parseThemeManifest(manifest({
    fonts: [{
      font_id: 'display',
      file: '配套字体资源/display.ttf',
      family: '仓耳玄三04',
      sha256: 'a'.repeat(64),
    }],
    heading_images: [{
      heading_image_id: 'h1-defaults',
      heading_levels: [1],
      font_id: 'display',
    }],
  })).headingImages[0];
  assert.equal(defaults.align, 'center');
  assert.deepEqual(defaults.numberAssets, []);
  assert.equal(defaults.numberSeparator, '');
  assert.equal(defaults.numberGap, 6);
  const legacy = parseThemeManifest(manifest());
  assert.deepEqual(legacy.fonts, []);
  assert.deepEqual(legacy.headingImages, []);
  assert.equal(THEME_FONT_DIRECTORY, '配套字体资源');
  assert.equal(LEGACY_THEME_FONT_DIRECTORY, '字体资源');
});

test('schema 3 可选归一 gilded text_paint，未声明的旧标题规则不增加字段', () => {
  const parsed = parseThemeManifest(manifest(fontAndHeading({
    color: '#e6cf91',
    text_paint: gildedPaint,
  })));
  assert.deepEqual(parsed.headingImages[0].textPaint, {
    type: 'gilded',
    stops: [
      { offset: 0, color: '#684313' },
      { offset: 0.42, color: '#F2D477' },
      { offset: 0.66, color: '#B97820' },
      { offset: 1, color: '#76501A' },
    ],
    stroke: { color: '#442A0A', width: 0.7 },
    highlight: {
      color: '#FFFBE8',
      alpha: 0.4,
      width: 0.35,
      offsetX: -0.25,
      offsetY: -0.35,
    },
  });
  const legacy = parseThemeManifest(manifest(fontAndHeading())).headingImages[0];
  assert.equal(Object.hasOwn(legacy, 'textPaint'), false);
});

test('gilded text_paint 拒绝坏类型、节点数量、顺序、颜色与越界描边高光', () => {
  const invalid = [
    [null, /必须是对象/],
    [{ ...gildedPaint, type: 'gradient' }, /只支持 gilded/],
    [{ ...gildedPaint, stops: gildedPaint.stops.slice(0, 3) }, /4–8/],
    [{ ...gildedPaint, stops: [
      { offset: 0, color: '#684313' },
      { offset: 0.6, color: '#F2D477' },
      { offset: 0.5, color: '#B97820' },
      { offset: 1, color: '#76501A' },
    ] }, /严格递增/],
    [{ ...gildedPaint, stops: [
      { offset: 0.1, color: '#684313' },
      { offset: 0.42, color: '#F2D477' },
      { offset: 0.66, color: '#B97820' },
      { offset: 1, color: '#76501A' },
    ] }, /从 0 开始/],
    [{ ...gildedPaint, stops: [
      { offset: 0, color: '#684313' },
      { offset: 0.42, color: 'gold' },
      { offset: 0.66, color: '#B97820' },
      { offset: 1, color: '#76501A' },
    ] }, /6 位 HEX/],
    [{ ...gildedPaint, stops: [
      { offset: null, color: '#684313' },
      { offset: 0.42, color: '#F2D477' },
      { offset: 0.66, color: '#B97820' },
      { offset: 1, color: '#76501A' },
    ] }, /offset 必须是数字/],
    [{ ...gildedPaint, stroke: { color: '#442A0A', width: 2.1 } }, /stroke\.width/],
    [{ ...gildedPaint, stroke: { color: '#442A0A', width: '0.7' } }, /必须是数字/],
    [{ ...gildedPaint, highlight: { ...gildedPaint.highlight, alpha: 1.1 } }, /highlight\.alpha/],
    [{ ...gildedPaint, highlight: { ...gildedPaint.highlight, offset_x: -1.1 } }, /offset_x/],
  ];
  for (const [textPaint, expected] of invalid) {
    assert.throws(
      () => parseThemeManifest(manifest(fontAndHeading({ text_paint: textPaint }))),
      expected,
    );
  }
});

test('声明 text_paint 时必须显式保留 color 作为单色回退', () => {
  assert.throws(
    () => parseThemeManifest(manifest(fontAndHeading({
      text_paint: gildedPaint,
      color: undefined,
    }))),
    /color 必须显式提供.*单色回退/,
  );
});

test('迁移期继续接受旧「字体资源」路径，但新清单以「配套字体资源」为正本', () => {
  const parsed = parseThemeManifest(manifest({
    fonts: [{
      font_id: 'legacy-display',
      file: '字体资源/display.ttf',
      family: 'Legacy Display',
      sha256: 'b'.repeat(64),
    }],
  }));
  assert.equal(parsed.fonts[0].file, '字体资源/display.ttf');
  assert.equal(THEME_FONT_DIRECTORY, '配套字体资源');
});

test('字体和标题图片声明拒绝越界路径、坏哈希、未知字体与重复标题级别', () => {
  assert.throws(() => parseThemeManifest(manifest({
    fonts: [{
      font_id: 'bad',
      file: '透明装饰素材/font.ttf',
      family: 'Bad',
      sha256: 'a'.repeat(64),
    }],
  })), /配套字体资源/);
  assert.throws(() => parseThemeManifest(manifest({
    fonts: [{
      font_id: 'bad',
      file: '配套字体资源/font.ttf',
      family: 'Bad',
      sha256: 'not-a-hash',
    }],
  })), /sha256/);
  assert.throws(() => parseThemeManifest(manifest({
    heading_images: [{
      heading_image_id: 'h1',
      heading_levels: [1],
      font_id: 'missing',
    }],
  })), /未登记字体/);
  assert.throws(() => parseThemeManifest(manifest({
    fonts: [{
      font_id: 'display',
      file: '配套字体资源/font.ttf',
      family: 'Display',
      sha256: 'a'.repeat(64),
    }],
    heading_images: [
      { heading_image_id: 'one', heading_levels: [1], font_id: 'display' },
      { heading_image_id: 'two', heading_levels: [1], font_id: 'display' },
    ],
  })), /不能重复声明/);
  assert.throws(() => parseThemeManifest(manifest({
    fonts: [{
      font_id: 'display',
      file: '配套字体资源/font.ttf',
      family: 'Display',
      sha256: 'a'.repeat(64),
    }],
    heading_images: [{
      heading_image_id: 'numbered',
      heading_levels: [1],
      font_id: 'display',
      number_assets: ['missing-number'],
    }],
  })), /未登记素材/);
  assert.throws(() => parseThemeManifest(manifest({
    fonts: [{
      font_id: 'display',
      file: '配套字体资源/font.ttf',
      family: 'Display',
      sha256: 'a'.repeat(64),
    }],
    heading_images: [{
      heading_image_id: 'bad-align',
      heading_levels: [1],
      font_id: 'display',
      align: 'right',
    }],
  })), /align/);
  assert.throws(() => parseThemeManifest(manifest({
    fonts: [{
      font_id: 'display',
      file: '配套字体资源/font.ttf',
      family: 'Display',
      sha256: 'a'.repeat(64),
    }],
    heading_images: [{
      heading_image_id: 'bad-gap',
      heading_levels: [1],
      font_id: 'display',
      number_gap: -1,
    }],
  })), /number_gap/);
});

test('标题图片规则允许最多三行，并拒绝四行配置', () => {
  const withFont = {
    fonts: [{
      font_id: 'display',
      file: '配套字体资源/font.ttf',
      family: 'Display',
      sha256: 'a'.repeat(64),
    }],
  };
  assert.equal(parseThemeManifest(manifest({
    ...withFont,
    heading_images: [{
      heading_image_id: 'h1',
      heading_levels: [1],
      font_id: 'display',
      max_lines: 3,
      max_equivalent_characters: 40,
    }],
  })).headingImages[0].maxLines, 3);
  assert.throws(() => parseThemeManifest(manifest({
    ...withFont,
    heading_images: [{
      heading_image_id: 'h1',
      heading_levels: [1],
      font_id: 'display',
      max_lines: 4,
    }],
  })), /max_lines/);
});

test('只有 container 模式可显式启用四至六行；两种模式默认仍是三行', () => {
  const parse = (patch) => parseThemeManifest(manifest(fontAndHeading(patch))).headingImages[0];
  assert.equal(parse({}).maxLines, 3);
  assert.equal(parse({ width_mode: 'container' }).maxLines, 3);
  for (const max_lines of [4, 5, 6]) {
    assert.equal(parse({ width_mode: 'container', max_lines }).maxLines, max_lines);
    assert.throws(() => parse({ max_lines }), /max_lines/);
  }
  assert.throws(() => parse({ width_mode: 'container', max_lines: 7 }), /max_lines/);
});

test('manifest 可为主题素材登记受限 HTTPS 公众号交付地址', () => {
  const parsed = parseThemeManifest(manifest({
    assets: [{
      asset_id: 'paper-grain',
      file: '透明装饰素材/paper-grain.png',
      wechat_url: 'https://res.wx.qq.com/example/paper-grain.png',
    }],
    components: [],
  }));
  assert.equal(
    parsed.assets[0].wechatUrl,
    'https://res.wx.qq.com/example/paper-grain.png',
  );
});

test('manifest 拒绝非 HTTPS、带凭据、空主机、空值与超长 wechat_url', () => {
  const invalidUrls = [
    'http://example.com/grain.png',
    'https://user:secret@example.com/grain.png',
    'https://cdn.example.com/grain.png',
    'https://res.wx.qq.com:444/grain.png',
    'https://',
    '',
    `https://example.com/${'a'.repeat(2050)}`,
  ];
  for (const wechatUrl of invalidUrls) {
    assert.throws(
      () => parseThemeManifest(manifest({
        assets: [{
          asset_id: 'paper-grain',
          file: '透明装饰素材/paper-grain.png',
          wechat_url: wechatUrl,
        }],
        components: [],
      })),
      /wechat_url|HTTPS|URL|主机名|微信官方|端口/,
    );
  }
});

test('主题名可从四字目录回退，但 theme_id 与 schema_version 必须明确', () => {
  const parsed = parseThemeManifest(manifest({ name: '' }), {
    directoryName: '2. 山水长卷',
  });
  assert.equal(parsed.name, '山水长卷');
  assert.throws(
    () => parseThemeManifest(manifest({ theme_id: '中文 ID' })),
    /theme_id/,
  );
  assert.throws(
    () => parseThemeManifest(manifest({ theme_id: 'Monument-Valley' })),
    /theme_id/,
  );
  assert.throws(
    () => parseThemeManifest(manifest({ schema_version: 2 })),
    /schema_version/,
  );
  assert.throws(
    () => parseThemeManifest(manifest(), { directoryName: '3. 五个字主题' }),
    /必须是四个字/,
  );
});

test('主题目录允许末尾研发完成标记，但主题名称与 ID 不包含标记', () => {
  for (const directoryName of ['03. 简笔手绘 ✅', '03. 简笔手绘 ✅\uFE0F']) {
    const fallback = parseThemeManifest(manifest({ name: '', theme_id: 'simple-sketch' }), { directoryName });
    assert.equal(fallback.name, '简笔手绘');
    assert.equal(fallback.themeId, 'simple-sketch');
    const explicit = parseThemeManifest(manifest({ name: '简笔手绘' }), { directoryName });
    assert.equal(explicit.name, '简笔手绘');
  }
  for (const directoryName of ['03. 简笔手绘✅', '03. 简笔手绘 ⭐', '03. 五个字主题 ✅', '03. 简笔手绘 ✅ ✅']) {
    assert.throws(() => parseThemeManifest(manifest(), { directoryName }), /必须是四个字/);
  }
});

test('manifest 路径阻止父目录、绝对路径、反斜杠和跨目录登记', () => {
  for (const value of ['../secret.png', '/tmp/a.png', 'C:/tmp/a.png', '透明装饰素材\\a.png']) {
    assert.throws(() => safeThemeRelativePath(value), /不能/);
  }
  assert.throws(
    () => parseThemeManifest(manifest({
      assets: [{ asset_id: 'bad', file: '其他目录/a.png' }],
    })),
    /透明装饰素材/,
  );
  assert.throws(
    () => parseThemeManifest(manifest({
      components: [{
        component_id: 'bad',
        file: '正文组件结构/../../escape.html',
        slot: 'before_article',
      }],
    })),
    /不能越出主题包/,
  );
  assert.throws(
    () => parseThemeManifest(manifest({ preview_image: '../主题预览图.png' })),
    /不能越出主题包/,
  );
  assert.throws(
    () => parseThemeManifest(manifest({ preview_image: '透明装饰素材/主题预览图.png' })),
    /主题展示案例/,
  );
  assert.throws(
    () => parseThemeManifest(manifest({ preview_image: '主题展示案例/主题预览图.webp' })),
    /PNG 或 JPG/,
  );
});

test('preview_image 可省略，但显式空值不能伪装成未声明', () => {
  const parsed = parseThemeManifest(manifest({ preview_image: undefined }));
  assert.equal(parsed.previewImage, '');
  assert.throws(
    () => parseThemeManifest(manifest({ preview_image: '' })),
    /不能为空/,
  );
});

test('封闭插槽只在指定位置插入组件，并登记实际使用的主题素材', () => {
  const rendered = '<section id="nice"><h2><span class="content">标题</span></h2><p>正文</p></section>';
  const assets = [{
    id: 'chapter-mark',
    filePath: '主题/透明装饰素材/章节徽记.png',
    url: 'app://theme/chapter.png',
    alt: '章节徽记',
  }];
  const components = [
    {
      id: 'opening',
      slot: 'before_article',
      headingLevels: [],
      html: '<p class="opening">开场</p>',
    },
    {
      id: 'divider',
      slot: 'before_heading',
      headingLevels: [2],
      html: '<img class="divider" src="theme-asset://chapter-mark">',
    },
    {
      id: 'ending',
      slot: 'after_article',
      headingLevels: [],
      html: '<p class="ending">收束</p>',
    },
  ];
  const result = applyThemeComponents(rendered, components, assets);
  assert.match(result.html, /^<section id="nice"><p class="opening">/);
  assert.ok(result.html.indexOf('app://theme/chapter.png') < result.html.indexOf('<h2>'));
  assert.match(result.html, /alt="章节徽记"/);
  assert.match(result.html, /<p class="ending">收束<\/p><\/section>$/);
  assert.deepEqual(result.images, [{
    target: 'chapter-mark',
    url: 'app://theme/chapter.png',
    origin: 'theme',
    filePath: '主题/透明装饰素材/章节徽记.png',
  }]);
});

test('文章没有匹配标题时不插组件，也不虚增主题图片记录', () => {
  const result = applyThemeComponents(
    '<section id="nice"><p>正文</p></section>',
    [{
      id: 'h2-divider',
      slot: 'before_heading',
      headingLevels: [2],
      assetIds: ['mark'],
      html: '<img src="theme-asset://mark">',
    }],
    [{
      id: 'mark',
      url: 'app://theme/mark.png',
      filePath: '主题/透明装饰素材/mark.png',
    }],
  );
  assert.equal(result.html, '<section id="nice"><p>正文</p></section>');
  assert.deepEqual(result.images, []);
});

const blockDecorations = () => [
  ['quote-cat', 'before_blockquote'],
  ['table-cat', 'before_table'],
  ['code-cats', 'before_codeblock'],
].map(([id, slot]) => ({
  id,
  slot,
  assetIds: ['cat'],
  html: `<p class="${id}"><img src="theme-asset://cat"></p>`,
}));

const blockDecorationAssets = [{
  id: 'cat',
  url: 'app://theme/cat.png',
  filePath: '主题/透明装饰素材/cat.png',
}];

test('三个可选块前插槽保留封闭枚举、素材约束和组件 ID 唯一性', () => {
  const components = blockDecorations().map((item) => ({
    component_id: item.id,
    file: `正文组件结构/${item.id}.html`,
    slot: item.slot,
    asset_ids: ['chapter-mark'],
  }));
  const parsed = parseThemeManifest(manifest({ components }));
  assert.deepEqual(parsed.components.map((item) => item.slot), [
    'before_blockquote', 'before_table', 'before_codeblock',
  ]);
  assert.ok(parsed.components.every((item) => item.headingLevels.length === 0));
  for (const slot of ['before_block', 'inside_table', 'before_pre', '#nice table']) {
    assert.throws(() => parseThemeManifest(manifest({
      components: [{ ...components[0], slot }],
    })), /插槽不受支持/);
  }
  assert.throws(() => parseThemeManifest(manifest({
    components: [components[0], components[0]],
  })), /组件 ID 重复/);
  assert.throws(() => parseThemeManifest(manifest({
    components: [{ ...components[0], asset_ids: ['unknown-cat'] }],
  })), /未登记素材/);
});

test('新块前插槽按直属原始节点插入，不重写正文实体和属性', () => {
  const source = '<section id="nice"><p title=\'A &amp; B\'>字&#x4e00;</p>\n' +
    '<blockquote cite=\'source\'><p>引用</p></blockquote>\n' +
    '<table data-note="&quot;原文&quot;"><tr><td>内容</td></tr></table>\n' +
    '<pre><code>&lt;table&gt;示例&lt;/table&gt;</code></pre></section>';
  const result = applyThemeComponents(source, blockDecorations(), blockDecorationAssets);
  const inserted = /<p class="(?:quote-cat|table-cat|code-cats)"><img src="app:\/\/theme\/cat.png"><\/p>/g;
  assert.equal(result.html.replace(inserted, ''), source);
  assert.match(result.html, /class="quote-cat"[^]*?<\/p><blockquote/);
  assert.match(result.html, /class="table-cat"[^]*?<\/p><table/);
  assert.match(result.html, /class="code-cats"[^]*?<\/p><pre/);
  assert.deepEqual(result.images.map((image) => image.target), ['cat']);
  assert.deepEqual(result.warnings, []);
});

test('代码块后插槽紧跟直属 pre，组件内代码不会再次触发插入', () => {
  const parsed = parseThemeManifest(manifest({components:[{
    component_id:'code-tail',file:'正文组件结构/code-tail.html',slot:'after_codeblock',asset_ids:['chapter-mark'],
  }]}));
  assert.equal(parsed.components[0].slot, 'after_codeblock');
  const source = '<section id="nice"><pre><code>正文代码</code></pre><p>结尾</p></section>';
  const components = [{
    id: 'code-tail',
    slot: 'after_codeblock',
    assetIds: ['cat'],
    html: '<section class="code-tail"><img src="theme-asset://cat"></section>',
  }];
  const result = applyThemeComponents(source, components, blockDecorationAssets);
  assert.equal(
    result.html,
    '<section id="nice"><pre><code>正文代码</code></pre><section class="code-tail"><img src="app://theme/cat.png"></section><p>结尾</p></section>',
  );
  assert.deepEqual(result.images.map((image) => image.target), ['cat']);
});

test('新插槽只装饰最外层引用，跳过嵌套引用及容器里的表格代码', () => {
  const source = '<section id="nice"><blockquote><p>外层</p>' +
    '<blockquote><p>内层</p></blockquote><table><tr><td>引用表</td></tr></table>' +
    '<pre><code>引用代码</code></pre></blockquote>' +
    '<div><blockquote>容器引用</blockquote><table></table><pre>容器代码</pre></div>' +
    '<ul><li><blockquote>列表引用</blockquote><pre>列表代码</pre></li></ul></section>';
  const result = applyThemeComponents(source, blockDecorations(), blockDecorationAssets);
  assert.equal((result.html.match(/class="quote-cat"/g) ?? []).length, 1);
  assert.doesNotMatch(result.html, /class="table-cat"|class="code-cats"/);
  assert.equal(result.images.length, 1);
});

test('代码示例、HTML 注释、script 字符串及属性伪标签不触发块前插槽', () => {
  const source = renderMarkdown([
    '> 真实引用', '', '| A | B |', '| --- | --- |', '| a | b |', '',
    '```html', '<table><tr><td>伪</td></tr></table>', '<blockquote>伪</blockquote>',
    '<pre>伪</pre>', '```', '', '<!-- <table>注释</table><blockquote>伪</blockquote> -->', '',
    '<script>const s="<pre>伪</pre><table>伪</table>"</script>',
    '<div title="<table>属性伪表</table>">容器</div>',
  ].join('\n'));
  const result = applyThemeComponents(source, blockDecorations(), blockDecorationAssets);
  for (const id of ['quote-cat', 'table-cat', 'code-cats']) {
    assert.equal((result.html.match(new RegExp(`class="${id}"`, 'g')) ?? []).length, 1);
  }
  assert.match(result.html, /&lt;/);
});

test('块前组件不会递归装饰自身或其他组件内部的标题、表格、引用和代码', () => {
  const tableComponent = '<section class="table-cat"><h1>组件标题</h1>' +
    '<table><tr><td>组件表</td></tr></table><blockquote>组件引用</blockquote>' +
    '<pre>组件代码</pre></section>';
  const articleComponent = '<section class="article-cat"><table></table><pre></pre></section>';
  const result = applyThemeComponents('<section id="nice"><h1>正文标题</h1><table></table></section>', [
    { id: 'article-cat', slot: 'before_article', html: articleComponent },
    { id: 'heading-cat', slot: 'before_heading', headingLevels: [1], html: '<p class="heading-cat">猫</p>' },
    { id: 'table-cat', slot: 'before_table', html: tableComponent },
    ...blockDecorations().filter((item) => item.slot !== 'before_table'),
  ], blockDecorationAssets);
  assert.equal((result.html.match(/class="heading-cat"/g) ?? []).length, 1);
  assert.equal((result.html.match(/class="table-cat"/g) ?? []).length, 1);
  assert.doesNotMatch(result.html, /class="quote-cat"|class="code-cats"/);
  assert.ok(result.html.includes(tableComponent));
  assert.ok(result.html.includes(articleComponent));
  assert.deepEqual(result.images, []);
});

test('同一块前插槽多组件保持声明顺序，每个原始块只插一组', () => {
  const result = applyThemeComponents('<section id="nice"><table></table><table></table></section>', [
    { id: 'first', slot: 'before_table', html: '<p>第一</p>' },
    { id: 'second', slot: 'before_table', html: '<p>第二</p>' },
  ]);
  assert.equal(result.html, '<section id="nice">' +
    '<p>第一</p><p>第二</p><table></table>'.repeat(2) + '</section>');
});

test('文章、标题和块插槽在相同插入点仍保持顺序', () => {
  const components = [
    { id: 'opening', slot: 'before_article', html: '<p>开场</p>' },
    { id: 'heading-before', slot: 'before_heading', headingLevels: [1], html: '<p>标题前</p>' },
    { id: 'heading-after', slot: 'after_heading', headingLevels: [1], html: '<p>标题后</p>' },
    { id: 'table-before', slot: 'before_table', html: '<p>表格前</p>' },
    { id: 'ending', slot: 'after_article', html: '<p>结尾</p>' },
  ];
  assert.equal(applyThemeComponents('<section id="nice"><h1>标题</h1><table></table></section>', components).html,
    '<section id="nice"><p>开场</p><p>标题前</p><h1>标题</h1><p>标题后</p>' +
    '<p>表格前</p><table></table><p>结尾</p></section>');
  assert.equal(applyThemeComponents('<section id="nice"><table></table></section>', components).html,
    '<section id="nice"><p>开场</p><p>表格前</p><table></table><p>结尾</p></section>');
});

test('新块插槽没有匹配时不新增图片，也不处理 nice 之外的内容', () => {
  for (const source of [
    '<section id="nice"><p>只有正文</p></section>',
    '<section id="other"><table></table><blockquote>外部</blockquote><pre></pre></section>',
    '<table></table><section id="nice"><p>只有正文</p></section><pre></pre>',
  ]) {
    const result = applyThemeComponents(source, blockDecorations(), blockDecorationAssets);
    assert.equal(result.html, source);
    assert.deepEqual(result.images, []);
    assert.deepEqual(result.warnings, []);
  }
});

test('新块插槽缺图仍保留正文并使用原有明确告警', () => {
  const source = '<section id="nice"><table><tr><td>保留文字</td></tr></table></section>';
  const result = applyThemeComponents(source, blockDecorations(), []);
  assert.match(result.html, /<table><tr><td>保留文字<\/td><\/tr><\/table>/);
  assert.doesNotMatch(result.html, /<img|theme-asset|src=""/);
  assert.deepEqual(result.images, []);
  assert.ok(result.warnings.every((warning) => /素材不可用/.test(warning)));
});

test('未启用新插槽的旧主题组件输出保持原样', () => {
  const source = '<section id="nice"><h1 data-x=\'a\'>字&#x4e00;</h1><table></table></section>';
  const oldComponents = [
    { id: 'opening', slot: 'before_article', html: '<p>开场</p>' },
    { id: 'before', slot: 'before_heading', headingLevels: [1], html: '<p>前</p>' },
    { id: 'after', slot: 'after_heading', headingLevels: [1], html: '<p>后</p>' },
    { id: 'ending', slot: 'after_article', html: '<p>结束</p>' },
  ];
  const expected = '<section id="nice"><p>开场</p><p>前</p><h1 data-x=\'a\'>字&#x4e00;</h1>' +
    '<p>后</p><table></table><p>结束</p></section>';
  assert.equal(applyThemeComponents(source, oldComponents).html, expected);
  assert.equal(applyThemeComponents(source, []).html, source);
});

test('缺失主题素材时删除对应 img 并留下明确警告', () => {
  const result = applyThemeComponents(
    '<section id="nice"><p>正文</p></section>',
    [{
      id: 'missing-divider',
      slot: 'after_article',
      headingLevels: [],
      html: '<img src="theme-asset://missing">',
    }],
    [],
  );
  assert.doesNotMatch(result.html, /<img|theme-asset|src=""/);
  assert.match(result.warnings[0], /missing/);
  assert.equal(result.images.length, 0);
});

test('组件不能绕过 manifest 直接引用包外或网络图片', () => {
  const result = applyThemeComponents(
    '<section id="nice"><p>正文</p></section>',
    [{
      id: 'unsafe-image',
      slot: 'before_article',
      headingLevels: [],
      html: '<img src="file:///tmp/private.png"><img src="https://example.com/a.png">',
    }],
    [],
  );
  assert.doesNotMatch(result.html, /<img|private\.png|example\.com/);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every((warning) => /未登记图片地址/.test(warning)));
});

test('组件只能使用自己在 asset_ids 中声明的主题素材', () => {
  const result = applyThemeComponents(
    '<section id="nice"><p>正文</p></section>',
    [{
      id: 'undeclared-asset',
      slot: 'before_article',
      headingLevels: [],
      assetIds: [],
      html: '<img src="theme-asset://mark">',
    }],
    [{
      id: 'mark',
      url: 'app://theme/mark.png',
      filePath: '主题/透明装饰素材/mark.png',
    }],
  );
  assert.doesNotMatch(result.html, /<img|app:\/\/theme/);
  assert.match(result.warnings[0], /asset_ids/);
});

test('主题 CSS 只展开已登记的单个背景素材，未使用素材不登记', () => {
  const result = materializeThemeCss([
    '#nice {',
    '  background-color: #F7F8FA;',
    '  background-image: url("theme-asset://paper-grain");',
    '}',
  ].join('\n'), [
    {
      id: 'paper-grain',
      url: 'app://theme/paper-grain.png',
      filePath: '主题/透明装饰素材/paper-grain.png',
      wechatUrl: 'https://res.wx.qq.com/example/paper-grain.png',
    },
    {
      id: 'unused',
      url: 'app://theme/unused.png',
      filePath: '主题/透明装饰素材/unused.png',
    },
  ]);

  assert.match(result.css, /background-color:\s*#F7F8FA/);
  assert.match(result.css, /background-image:\s*url\("app:\/\/theme\/paper-grain\.png"\)/);
  assert.deepEqual(result.images.map((image) => image.target), ['paper-grain']);
  assert.equal(result.images[0].wechatUrl, 'https://res.wx.qq.com/example/paper-grain.png');
  assert.deepEqual(result.warnings, []);
});

test('主题 CSS literal none 大小写均可清除背景，不要求登记或产生图片记录', () => {
  for (const value of ['none', 'NONE', ' nOnE ']) {
    const result = materializeThemeCss(`#nice .brand{background-image:${value}}`);
    assert.match(result.css, /background-image:\s*none/);
    assert.deepEqual(result.images, []);
    assert.deepEqual(result.warnings, []);
  }
  for (const value of ['url("https://example.com/a.png")', 'url("app://unknown.png")', 'url("theme-asset://missing")', 'none,url("https://example.com/a.png")']) {
    const result = materializeThemeCss(`#nice{background-image:${value}}`);
    assert.doesNotMatch(result.css, /background-image/);
    assert.ok(result.warnings.length > 0);
    assert.deepEqual(result.images, []);
  }
});

test('真实内联管线以 none 覆盖已登记背景，不误报或交付已经停用的图片', () => {
  const result = renderArticle({
    source: '<section class="brand"><p>品牌</p></section>',
    themeCss: '#nice .brand{background-image:url("theme-asset://paper");background-repeat:no-repeat;background-size:100% auto;background-position:center}#nice section.brand{background-image:NONE}',
    themeAssets: [{ id: 'paper', url: 'app://theme/paper.png', filePath: 'theme/paper.png' }],
    resolve: () => null,
  });
  assert.match(result.html, /background-image:\s*none/);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.compatibility.backgroundImageUrls, []);
});

test('主题 CSS 背景素材缺失、多背景或用错属性时删图但保留底色', () => {
  const result = materializeThemeCss([
    '#nice {',
    '  background-color: #F7F8FA;',
    '  background-image: url("theme-asset://missing");',
    '  background-repeat: repeat;',
    '  background-position: center top;',
    '  background-size: 320px auto;',
    '  border-image: url("theme-asset://missing");',
    '}',
    '#nice p { background-image: url("theme-asset://missing"), url("theme-asset://missing"); }',
  ].join('\n'), []);

  assert.match(result.css, /background-color:\s*#F7F8FA/);
  assert.doesNotMatch(
    result.css,
    /theme-asset|background-image|background-repeat|background-position|background-size|border-image/,
  );
  assert.equal(result.images.length, 0);
  assert.ok(result.warnings.some((warning) => /未登记或不可用/.test(warning)));
  assert.ok(result.warnings.some((warning) => /只能用于 background-image/.test(warning)));
  assert.ok(result.warnings.some((warning) => /单个 theme-asset/.test(warning)));
});

test('主题 CSS 不能直写本地或网络 URL 绕过 theme-asset 登记', () => {
  const result = materializeThemeCss([
    '#nice { background-color:#fff; background-image:url("app://theme/grain.png"); }',
    '#nice p { background-image:url("https://example.com/grain.png"); }',
  ].join('\n'), [{
    id: 'grain',
    url: 'app://theme/grain.png',
    filePath: '主题/透明装饰素材/grain.png',
  }]);
  assert.match(result.css, /background-color:\s*#fff/);
  assert.doesNotMatch(result.css, /background-image|app:\/\/|https:\/\//);
  assert.deepEqual(result.images, []);
  assert.ok(result.warnings.every((warning) => /theme-asset/.test(warning)));
});

test('统一管线保留文章图与同名主题素材的独立来源和精确路径', () => {
  const result = renderArticle({
    source: '## 标题\n\n![[chapter-mark.png]]',
    themeCss: '#nice .divider { width: 30px; }',
    resolve: () => ({
      url: 'app://article/chapter.png',
      filePath: '00｜本库附件/chapter-mark.png',
    }),
    themeAssets: [{
      id: 'chapter-mark',
      url: 'app://theme/chapter.png',
      filePath: '主题/透明装饰素材/chapter-mark.png',
    }],
    themeComponents: [{
      id: 'divider',
      slot: 'before_heading',
      headingLevels: [2],
      html: '<img class="divider" src="theme-asset://chapter-mark">',
    }],
  });
  assert.deepEqual(result.images.map((image) => ({
    origin: image.origin,
    filePath: image.filePath,
  })), [
    { origin: 'article', filePath: '00｜本库附件/chapter-mark.png' },
    { origin: 'theme', filePath: '主题/透明装饰素材/chapter-mark.png' },
  ]);
  assert.match(result.html, /app:\/\/article\/chapter\.png/);
  assert.match(result.html, /app:\/\/theme\/chapter\.png/);
});

test('同一主题素材同时用于组件 img 和 CSS 背景时只登记一次', () => {
  const asset = {
    id: 'paper-grain',
    url: 'app://theme/paper-grain.png',
    filePath: '主题/透明装饰素材/paper-grain.png',
    wechatUrl: 'https://res.wx.qq.com/example/paper-grain.png',
  };
  const result = renderArticle({
    source: '正文',
    themeCss: [
      '#nice { background-color:#F7F8FA;',
      'background-image:url("theme-asset://paper-grain");',
      'background-repeat:repeat;background-position:center top;background-size:320px 320px; }',
    ].join(''),
    resolve: () => null,
    themeAssets: [asset],
    themeComponents: [{
      id: 'opening',
      slot: 'before_article',
      headingLevels: [],
      assetIds: ['paper-grain'],
      html: '<img src="theme-asset://paper-grain">',
    }],
  });

  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].target, 'paper-grain');
  assert.equal(result.images[0].wechatUrl, 'https://res.wx.qq.com/example/paper-grain.png');
  assert.match(result.html, /<img src="app:\/\/theme\/paper-grain\.png"/);
  assert.match(result.html, /background-image:url\(['"]app:\/\/theme\/paper-grain\.png['"]\)/);
  assert.match(result.html, /background-repeat:repeat/);
  assert.equal(result.compatibility.removedStyleCount, 0);
});

test('选择器未命中正文时不虚增 CSS 背景图记录', () => {
  const result = renderArticle({
    source: '正文',
    themeCss: '#nice .not-present { background-image:url("theme-asset://grain"); }',
    resolve: () => null,
    themeAssets: [{
      id: 'grain',
      url: 'app://theme/grain.png',
      filePath: '主题/透明装饰素材/grain.png',
    }],
  });
  assert.deepEqual(result.images, []);
  assert.doesNotMatch(result.html, /background-image/);
});
