import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { PNG } from 'pngjs';
import {
  equivalentCharacterCount,
  headingImageCacheKey,
  headingContainerWidth,
  headingSideAssetBoxes,
  HeadingImageLruCache,
  HeadingImageRuntime,
  layoutHeadingText,
  materializeHeadingImages,
  renderHeadingPng,
} from '../plugin/heading-image.mjs';

const rule = {
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
};

const sideRule = { ...rule, sideAssets: {
  leftAssetId: 'star', rightAssetId: 'star', size: 18, gap: 8,
} };

test('标题双侧装饰保留相同边距，不改字号；旧规则不额外预留宽度', () => {
  const plain = layoutHeadingText('一级标题', { ...rule, measureGrapheme });
  const sides = layoutHeadingText('一级标题', { ...sideRule, measureGrapheme });
  assert.equal(sides.width, plain.width + 52);
  assert.equal(sides.height, plain.height);
  assert.equal(sides.effectiveFontSize, 28);
  for (const text of ['两行标题测试自动换行', '一行标题\n第二行标题\n第三行标题']) {
    const result = layoutHeadingText(text, { ...sideRule, measureGrapheme });
    assert.equal(result.ok, true);
    assert.ok(result.widths.every(w => w + 52 + rule.paddingX * 2 <= rule.maxWidth));
  }
});

test('标题装饰依据字形 Alpha 边缘定位，左右距离和垂直中心相同', () => {
  const pixels = { width: 600, height: 210, data: new Uint8ClampedArray(600*210*4) };
  for (let y=40;y<150;y++) for(let x=120;x<480;x++) pixels.data[(y*600+x)*4+3]=255;
  const boxes = headingSideAssetBoxes(pixels, 3, {size:18,gap:8});
  assert.equal(120/3 - (boxes.left.x+boxes.left.size), 8);
  assert.equal(boxes.right.x - 480/3, 8);
  assert.equal(boxes.left.y, boxes.right.y);
  assert.equal(boxes.left.y+9, 95/3);
  assert.throws(() => headingSideAssetBoxes(pixels,3,{size:50,gap:8}), /安全边界/);
  pixels.data.fill(0);
  assert.throws(() => headingSideAssetBoxes(pixels,3,{size:18,gap:8}), /没有可见文字/);
});

test('双侧素材哈希与间距进入缓存键，未开启时保持旧键', () => {
  const base = {themeId:'test',fontHash:'font',text:'标题',rule};
  const plain = headingImageCacheKey(base);
  const sideAssets = {left:{hash:'one'},right:{hash:'two'}};
  assert.equal(headingImageCacheKey({...base,sideAssets}), plain);
  const key = headingImageCacheKey({...base,rule:sideRule,sideAssets});
  assert.notEqual(key,plain);
  assert.notEqual(key,headingImageCacheKey({...base,rule:sideRule,sideAssets:{...sideAssets,right:{hash:'changed'}}}));
  assert.notEqual(key,headingImageCacheKey({...base,rule:{...sideRule,sideAssets:{...sideRule.sideAssets,gap:9}},sideAssets}));
});

test('标题水印素材与绘制参数进入缓存键，未开启时保持旧键', () => {
  const base={themeId:'test',fontHash:'font',text:'标题',rule};
  const watermarkRule={...rule,watermarkAssets:['wm'],watermark:{width:64,height:44,opacity:0.8,offsetX:0,offsetY:0}};
  const watermarkAsset={id:'wm',hash:'watermark-one'};
  const plain=headingImageCacheKey(base);
  assert.equal(headingImageCacheKey({...base,watermarkAsset}),plain);
  const key=headingImageCacheKey({...base,rule:watermarkRule,watermarkAsset});
  assert.notEqual(key,plain);
  assert.notEqual(key,headingImageCacheKey({...base,rule:watermarkRule,watermarkAsset:{...watermarkAsset,hash:'changed'}}));
  assert.notEqual(key,headingImageCacheKey({...base,rule:{...watermarkRule,watermark:{...watermarkRule.watermark,width:72}},watermarkAsset}));
});

test('标题水印按标题次序循环并合成进同一张透明标题图', async () => {
  const watermarkRule={...rule,watermarkAssets:['wm-one','wm-two'],watermark:{width:64,height:44,opacity:0.8,offsetX:0,offsetY:0}};
  const seen=[];
  const result=await materializeHeadingImages({
    html:'<h1><span class="content">一级标题</span></h1><h1><span class="content">一级标题</span></h1><h1><span class="content">一级标题</span></h1>',
    themeId:'watermark-test',headingImages:[watermarkRule],fonts:[fakeFont],
    assets:[{id:'wm-one'},{id:'wm-two'}],loadFont:async()=>fakeFont,
    loadSideAsset:async asset=>({image:{},width:160,height:120,hash:asset.id}),
    renderPng:args=>{seen.push(args.watermarkAsset.id);return renderPng(args);},
  });
  assert.deepEqual(seen,['wm-one','wm-two']);
  assert.equal((result.html.match(/<img /g)||[]).length,3);
  assert.equal(result.generatedCount,1);
  assert.deepEqual(result.warnings,[]);
});

test('双侧素材共用一次加载；文字、预览与复制仍输出单张 H1 PNG', async () => {
  let loaded=0, rendered=0;
  const result=await materializeHeadingImages({
    html:'<h1><span class="content">一级标题</span></h1><h1><span class="content">一级标题</span></h1>',
    themeId:'test',headingImages:[sideRule],fonts:[fakeFont],assets:[{id:'star'}],
    loadFont:async()=>fakeFont,
    loadSideAsset:async()=>{loaded++;return {image:{},width:160,height:160,hash:'star-hash'};},
    renderPng:args=>{rendered++;assert.ok(args.sideAssets.left.image);return renderPng(args);},
  });
  assert.equal(loaded,1);assert.equal(rendered,1);
  assert.equal(result.generatedCount,1);
  assert.deepEqual(result.warnings,[]);
  assert.equal((result.html.match(/<img /g)||[]).length,2);
  assert.ok(result.images[0].fallbackHtml.includes('一级标题'));
});

test('单侧素材只加载并绘制已声明一侧，仍输出一张透明标题图', async () => {
  let loaded=0;
  const leftRule={...sideRule,sideAssets:{leftAssetId:'star',size:18,gap:8}};
  const result=await materializeHeadingImages({
    html:'<h1><span class="content">一级标题</span></h1>',themeId:'test',
    headingImages:[leftRule],fonts:[fakeFont],assets:[{id:'star'}],loadFont:async()=>fakeFont,
    loadSideAsset:async()=>{loaded++;return {image:{},width:160,height:160,hash:'star-hash'};},
    renderPng:args=>{assert.ok(args.sideAssets.left.image);assert.equal(args.sideAssets.right,undefined);return renderPng(args);},
  });
  assert.equal(loaded,1);assert.equal(result.generatedCount,1);assert.deepEqual(result.warnings,[]);
});

test('双侧装饰加载、排版或绘制失败时优先保留完整标题图片', async () => {
  for (const failure of ['load','layout','draw']) {
    const text = failure==='layout' ? '一二三四五六七八九十'.repeat(3) : '一级标题';
    const result=await materializeHeadingImages({
      html:`<h1><span class="content">${text}</span></h1>`,themeId:'test',
      headingImages:[sideRule],fonts:[fakeFont],assets:[{id:'star'}],loadFont:async()=>fakeFont,
      loadSideAsset:async()=>{
        if(failure==='load')throw new Error('missing');
        return {image:{},width:160,height:160,hash:'star'};
      },
      renderPng:args=>{
        if(failure==='draw'&&args.sideAssets)throw new Error('drawing failed');
        return renderPng(args);
      },
    });
    assert.equal(result.generatedCount,1,failure);
    assert.ok(result.html.includes(`alt="${text}"`),failure);
    assert.equal(result.warnings.length,1,failure);
    assert.match(result.warnings[0],/已保留完整标题图片/);
  }
});

const numberedRule = {
  ...rule,
  id: 'h1-numbered',
  align: 'left',
  numberAssets: Array.from({ length: 9 }, (_, index) => `sk-num-${index + 1}`),
  numberSeparator: '·',
  numberGap: 6,
};

const gildedRule = {
  ...rule,
  id: 'h1-gilded',
  textPaint: {
    type: 'gilded',
    stops: [
      { offset: 0, color: '#684313' },
      { offset: 0.2, color: '#B77A24' },
      { offset: 0.42, color: '#F2D477' },
      { offset: 0.52, color: '#FFF6D2' },
      { offset: 0.66, color: '#B97820' },
      { offset: 0.84, color: '#E7C363' },
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
  },
};

const measureGrapheme = (grapheme) => {
  if (/^\s$/u.test(grapheme)) return 7;
  return /^[\u0020-\u007e]$/u.test(grapheme) ? 14 : 28;
};

const layout = (text) => layoutHeadingText(text, { ...rule, measureGrapheme });

const fakeDocument = {
  createElement: () => ({
    getContext: () => ({
      font: '',
      measureText: (grapheme) => ({ width: measureGrapheme(grapheme) }),
    }),
  }),
};

const fakeFont = {
  id: 'display',
  runtimeFamily: 'runtime-display',
  hash: 'b'.repeat(64),
  document: fakeDocument,
  weight: 400,
  style: 'normal',
};

const pngFor = (physicalWidth, physicalHeight, marker = 0) => {
  const data = Buffer.alloc(physicalWidth * physicalHeight * 4);
  if (marker) {
    const center = (
      Math.floor(physicalHeight / 2) * physicalWidth
      + Math.floor(physicalWidth / 2)
    ) * 4;
    data[center] = marker;
    data[center + 3] = 255;
  }
  return PNG.sync.write({
    width: physicalWidth,
    height: physicalHeight,
    data,
  }, {
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true,
  });
};

const renderPng = ({ layout: current, rule: currentRule }) => {
  const physicalWidth = current.width * currentRule.scale;
  const physicalHeight = current.height * currentRule.scale;
  return {
    bytes: pngFor(physicalWidth, physicalHeight),
    physicalWidth,
    physicalHeight,
  };
};

const baseHtml = (content) => [
  '<section id="nice">',
  '<h1 style="margin:58px 4px 34px;font-size:0;text-align:center">',
  `<span class="content" style="font-size:28px">${content}</span>`,
  '</h1>',
  '<p>正文</p>',
  '</section>',
].join('');

test('容器标题按最终盒子计算百分比、边线和内容宽度，百分比不受自身 padding 二次压缩', () => {
  const node = (style) => ({ attribs: { style } });
  assert.equal(headingContainerWidth([
    node('padding:0 20px'),
    node('padding:0 40% 0 10px;border:1px solid #000000'),
    node('max-width:100%'),
  ], 390, 354), 198);
  assert.equal(headingContainerWidth([
    node('padding:0 20px'),
    node('width:50%;padding:0 10px'),
  ], 390, 354), 175);
  assert.equal(headingContainerWidth([
    node('padding:0 20px'),
    node('max-width:200px;margin:0 auto'),
    node('padding:0 5%'),
  ], 390, 354), 180);
});

test('首标题半幅与后续全幅按各自空间断行，字图字号不缩小', async () => {
  const captured = [];
  const text = '沙海中的选择已经开始';
  const result = await materializeHeadingImages({
    html: `<section id="nice" style="padding:0 20px"><h1 style="padding-right:40%"><span class="content">${text}</span></h1><h1><span class="content">${text}</span></h1></section>`,
    themeId: 'container-test', headingImages: [{ ...rule, widthMode: 'container' }],
    fonts: [fakeFont], loadFont: async () => fakeFont, layoutWidth: 390,
    renderPng: (input) => { captured.push(input); return renderPng(input); },
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(captured.length, 2);
  assert.ok(captured[0].layout.lines.length > captured[1].layout.lines.length);
  assert.ok(captured[0].layout.width <= 210);
  for (const input of captured) {
    assert.equal(input.rule.fontSize, 28);
    assert.equal(input.layout.effectiveFontSize, 28);
  }
});

test('同一标题切换手机与导出宽度重新排版并隔离缓存，未启用的规则输出不变', async () => {
  const text = '沙海中的选择已经开始';
  const html = `<section id="nice" style="padding:0 20px"><h1 style="padding-right:40%"><span class="content">${text}</span></h1></section>`;
  const shared = { html, themeId: 'container-test', fonts: [fakeFont], loadFont: async () => fakeFont };
  const cache = new HeadingImageLruCache();
  const widths = [];
  const render = (input) => { widths.push(input.layout.width); return renderPng(input); };
  const mobile = await materializeHeadingImages({ ...shared, headingImages: [{ ...rule, widthMode: 'container' }], layoutWidth: 390, renderPng: render, cache });
  const desktop = await materializeHeadingImages({ ...shared, headingImages: [{ ...rule, widthMode: 'container' }], layoutWidth: 677, renderPng: render, cache });
  assert.equal(widths.length, 2);
  assert.ok(widths[0] < widths[1]);
  assert.notEqual(mobile.html, desktop.html);
  const legacyMobile = await materializeHeadingImages({ ...shared, headingImages: [rule], layoutWidth: 390, renderPng });
  const legacyDesktop = await materializeHeadingImages({ ...shared, headingImages: [rule], layoutWidth: 677, renderPng });
  assert.equal(legacyMobile.html, legacyDesktop.html);
  assert.deepEqual(legacyMobile.images, legacyDesktop.images);
});

test('容器宽度缺失或文字安全区太窄时保留完整活文字，不先生成再缩小', async () => {
  for (const [layoutWidth, padding, warning] of [
    [undefined, '0', /缺少有效布局宽度/],
    [390, '0 48%', /安全区过窄/],
  ]) {
    const html = `<section id="nice"><h1 style="padding:${padding}"><span class="content">完整标题</span></h1></section>`;
    const result = await materializeHeadingImages({
      html, themeId: 'container-test', headingImages: [{ ...rule, widthMode: 'container' }],
      fonts: [fakeFont], loadFont: async () => fakeFont, layoutWidth, renderPng,
    });
    assert.equal(result.html, html);
    assert.equal(result.generatedCount, 0);
    assert.match(result.warnings[0], warning);
  }
});

test('320px 首标题半幅容纳二十字四至五行，保留30px字号和完整字图', async () => {
  const text = '沙海中的选择留下痕迹命运始终仍在我们手中';
  assert.equal(Array.from(text).length, 20);
  const captured = [];
  const thirtyFont = { ...fakeFont, document: {
    createElement: () => ({ getContext: () => ({ font: '', measureText: () => ({ width: 30 }) }) }),
  } };
  const result = await materializeHeadingImages({
    html: `<section id="nice"><h1 style="padding:6% 40% 32% 6%"><span class="content">${text}</span></h1></section>`,
    themeId: 'container-test', headingImages: [{ ...rule, widthMode: 'container', fontSize: 30, minEffectiveFontSize: 30, maxLines: 5 }],
    fonts: [thirtyFont], loadFont: async () => thirtyFont, layoutWidth: 320,
    renderPng: (input) => { captured.push(input); return renderPng(input); },
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.generatedCount, 1);
  assert.ok(captured[0].layout.lines.length >= 4 && captured[0].layout.lines.length <= 5);
  assert.equal(captured[0].layout.lines.join(''), text);
  assert.equal(captured[0].layout.effectiveFontSize, 30);
  assert.equal(captured[0].rule.fontSize, 30);
  assert.ok(captured[0].layout.width <= 172);
  assert.ok(captured[0].layout.height > 30 * rule.lineHeight * 3);
});

test('reference scenes scale optical typography and use actual CSS font sizes and ancestor widths', async () => {
  const composition = { strategy: 'opening-feature', designWidth: 390 };
  const opticalFont = { ...fakeFont, document: { createElement: () => ({ getContext: () => ({
    font: '', measureText() { return { width: Number(this.font.match(/([\d.]+)px/)[1]) }; },
  }) }) } };
  for (const width of [390, 887]) {
    const factor = width / 390; const captured = [];
    const html = `<section id="nice"><section data-wechat-scene="opening"><h1 style="margin-left:10%;width:44%"><span class="content" style="font-size:${40 * factor}px">沙海中的<br>选择</span></h1></section><section data-wechat-scene="feature"><h2 style="margin-left:40%;width:50%"><span class="content" style="font-size:${14 * factor}px">沙面痕迹</span></h2></section></section>`;
    const result = await materializeHeadingImages({
      html, layoutWidth: width, referenceComposition: composition, themeId: 'reference', fonts: [opticalFont],
      headingImages: [{ ...rule, headingLevels: [1], fontSize: 40, letterSpacing: 3.5 }, { ...rule, id: 'h2', headingLevels: [2], fontSize: 18, minEffectiveFontSize: 18, letterSpacing: 0 }],
      loadFont: async () => opticalFont,
      renderPng: input => { captured.push(input); return renderPng(input); },
    });
    assert.deepEqual(result.warnings, []);
    assert.equal(result.generatedCount, 2);
    assert.deepEqual(captured[0].layout.lines, ['沙海中的', '选择']);
    assert.ok(Math.abs(captured[0].rule.fontSize - 40 * factor) < 0.0001);
    assert.ok(Math.abs(captured[1].rule.fontSize - 14 * factor) < 0.0001);
    assert.equal(captured[0].rule.paddingX, 0);
    assert.ok(captured[0].layout.width <= width * 0.44);
    assert.equal(captured[1].layout.effectiveFontSize, captured[1].rule.fontSize);
  }
});

test('reference heading typography follows final font size, letter spacing and px/unitless line height per heading', async () => {
  const cases = [
    { css: 'font-size:26px;letter-spacing:1px;line-height:1.2', font: 26, spacing: 1, line: 1.2 },
    { css: 'font-size:40px;letter-spacing:3.5px;line-height:46px', font: 40, spacing: 3.5, line: 1.15 },
    { css: 'font-size:21px;letter-spacing:.8px;line-height:31.5px', font: 21, spacing: .8, line: 1.5 },
    { css: 'font-size:13.5px;letter-spacing:.3px;line-height:19.6px', font: 13.5, spacing: .3, line: 19.6 / 13.5 },
    { css: 'font-size:26px', font: 26, spacing: rule.letterSpacing, line: rule.lineHeight },
    { css: 'font-size:26px;letter-spacing:normal;line-height:150%', font: 26, spacing: 0, line: 1.5 },
  ];
  const html = '<section id="nice">' + cases.map(c => `<h1><span class="content" style="${c.css}">标题</span></h1>`).join('') + '</section>';
  const drawn = [];
  const result = await materializeHeadingImages({
    html, themeId: 'reference', layoutWidth: 390, referenceComposition: { strategy: 'opening-feature', designWidth: 390 },
    headingImages: [rule], fonts: [fakeFont], loadFont: async () => fakeFont,
    renderPng: input => { drawn.push(input.rule); return renderPng(input); },
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(drawn.length, cases.length);
  cases.forEach((expected, i) => {
    assert.equal(drawn[i].fontSize, expected.font);
    assert.equal(drawn[i].letterSpacing, expected.spacing);
    assert.ok(Math.abs(drawn[i].lineHeight - expected.line) < 1e-9);
  });
  const ordinary = [];
  await materializeHeadingImages({ html, themeId: 'ordinary', headingImages: [rule], fonts: [fakeFont], loadFont: async () => fakeFont,
    renderPng: input => { ordinary.push(input.rule); return renderPng(input); },
  });
  assert.equal(ordinary.length, 1);
  assert.equal(ordinary[0].fontSize, rule.fontSize);
  assert.equal(ordinary[0].letterSpacing, rule.letterSpacing);
  assert.equal(ordinary[0].lineHeight, rule.lineHeight);
});

const repeatedHeadingsHtml = (count, content = '重复标题') => [
  '<section id="nice">',
  ...Array.from({ length: count }, () => [
    '<h1 style="margin:58px 4px 34px;font-size:0;text-align:center">',
    `<span class="content" style="font-size:28px">${content}</span>`,
    '</h1>',
  ].join('')),
  '</section>',
].join('');

const numberedAssets = numberedRule.numberAssets.map((id) => ({ id }));

const loadNumberAsset = async (asset) => ({
  image: { id: asset.id },
  hash: asset.id.padEnd(64, '0'),
  width: 65,
  height: 120,
});

const numberedPng = ({ layout: current, rule: currentRule, numberAsset }) => {
  const physicalWidth = current.width * currentRule.scale;
  const physicalHeight = current.height * currentRule.scale;
  return {
    bytes: pngFor(physicalWidth, physicalHeight, numberAsset?.occurrence ?? 250),
    physicalWidth,
    physicalHeight,
  };
};

test('短标题使用自然宽度居中，不强撑到最大宽度', () => {
  const result = layout('核心参数');
  assert.equal(result.ok, true);
  assert.deepEqual(result.lines, ['核心参数']);
  assert.ok(result.width < rule.maxWidth);
  assert.equal(result.lines.length, 1);
});

test('中长中文标题按真实字宽排成两行，22 字仍保持最窄屏 24px', () => {
  const result = layout('星轨主题正在建立清晰稳定一致可靠完整阅读秩序');
  assert.equal(equivalentCharacterCount('星轨主题正在建立清晰稳定一致可靠完整阅读秩序'), 22);
  assert.equal(result.ok, true);
  assert.equal(result.lines.length, 2);
  assert.ok(result.width <= 331);
  assert.ok(result.effectiveFontSize >= 24);
  assert.ok(result.lines.every((line) => equivalentCharacterCount(line) >= 2));
});

test('中英数字混排不拆 Codex 和数字词组', () => {
  const result = layout('在 Codex 里配置 2026 年核心参数规则');
  assert.equal(result.ok, true);
  assert.ok(result.lines.some((line) => line.includes('Codex')));
  assert.ok(result.lines.some((line) => line.includes('2026')));
  assert.equal(
    result.lines.join('').replace(/\s+/g, ''),
    '在 Codex 里配置 2026 年核心参数规则'.replace(/\s+/g, ''),
  );
});

test('自动换行不产生行首闭标点、行尾开标点或单字孤行', () => {
  const result = layout('这是一个用于测试换行的标题（需要正确处理），后面还有内容');
  assert.equal(result.ok, true);
  assert.equal(result.lines.length, 3);
  assert.ok(result.lines.every((line) => equivalentCharacterCount(line) >= 2));
  assert.ok(result.lines.slice(0, -1).every((line) => !/[（《【「『“‘([{]$/u.test(line)));
  assert.ok(result.lines.slice(1).every((line) => !/^[，。！？；：、）》】」』”’…,.!?;:%)\]}]/u.test(line)));
});

test('25 个全角等效字符按真实字宽生成三行且不缩小字号', () => {
  const text = '这个中文一级标题已经超过二十二字边界需要回退活文字';
  const result = layout(text);
  assert.equal(equivalentCharacterCount(text), 25);
  assert.equal(result.ok, true);
  assert.equal(result.lines.length, 3);
  assert.equal(result.effectiveFontSize, 28);
  assert.ok(result.lines.every((line) => equivalentCharacterCount(line) >= 2));
});

test('超过三行、超 40 字保护线与不可拆长英文分别回退', () => {
  const needsFourLines = layout('超'.repeat(35));
  assert.equal(needsFourLines.ok, false);
  assert.match(needsFourLines.reason, /三行|3 行/);

  const overProtection = layout('超'.repeat(41));
  assert.equal(overProtection.ok, false);
  assert.match(overProtection.reason, /超过 40/);

  const unbreakable = layout('Supercalifragilisticexpialidocious');
  assert.equal(unbreakable.ok, false);
  assert.match(unbreakable.reason, /无法|宽度/);
});

test('显式 opt-in 的 H1 生成透明 PNG 记录并保留 h1 与 alt', async () => {
  const result = await materializeHeadingImages({
    html: baseHtml('核心参数'),
    images: [],
    themeId: 'cobalt-orbit',
    headingImages: [rule],
    fonts: [{ id: 'display' }],
    loadFont: async () => fakeFont,
    renderPng,
    cache: new HeadingImageLruCache(),
  });

  assert.equal(result.generatedCount, 1);
  assert.match(result.html, /<h1[^>]*><img/);
  assert.match(result.html, /alt="核心参数"/);
  assert.match(result.html, /data:image\/png;base64,/);
  assert.match(result.html, /max-width:100%/);
  assert.match(result.html, /background-color:transparent/);
  assert.match(result.html, /margin:0 auto/);
  assert.doesNotMatch(result.html, /font\.ttf|file:\/\/|app:\/\//);
  assert.equal(result.images[0].origin, 'generated');
  assert.match(result.images[0].fallbackHtml, />核心参数<\/span>/);
});

test('未声明 textPaint 的旧规则保持 v0.9.10 缓存键，鎏金参数独立分流缓存', () => {
  const input = {
    themeId: 'cobalt-orbit',
    fontHash: 'b'.repeat(64),
    text: '核心参数',
    rule,
  };
  const legacy = headingImageCacheKey(input);
  assert.equal(legacy, 'cf17d2aa88560bbafdbdea6b91a396fb933413d8652684cf6acc8b0774d52685');
  const gilded = headingImageCacheKey({ ...input, rule: gildedRule });
  const changed = headingImageCacheKey({
    ...input,
    rule: {
      ...gildedRule,
      textPaint: {
        ...gildedRule.textPaint,
        stroke: { ...gildedRule.textPaint.stroke, width: 0.8 },
      },
    },
  });
  assert.notEqual(gilded, legacy);
  assert.notEqual(changed, gilded);
});

test('鎏金标题逐行执行描边、基础渐变和偏移高光，且每行单独建渐变', () => {
  const operations = [];
  const gradients = [];
  let canvas;
  const context = {
    font: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    clearRect: () => {},
    scale: () => {},
    measureText: (grapheme) => ({
      width: measureGrapheme(grapheme),
      actualBoundingBoxAscent: 22,
      actualBoundingBoxDescent: 5,
    }),
    createLinearGradient: (x0, y0, x1, y1) => {
      const gradient = {
        id: `gradient-${gradients.length}`,
        bounds: [x0, y0, x1, y1],
        stops: [],
        addColorStop(offset, color) {
          this.stops.push([offset, color]);
        },
      };
      gradients.push(gradient);
      return gradient;
    },
    strokeText(text, x, y) {
      operations.push({
        method: 'stroke',
        text,
        x,
        y,
        style: this.strokeStyle,
        width: this.lineWidth,
        alpha: this.globalAlpha,
      });
    },
    fillText(text, x, y) {
      operations.push({
        method: 'fill',
        text,
        x,
        y,
        style: this.fillStyle?.id ?? this.fillStyle,
        alpha: this.globalAlpha,
      });
    },
    getImageData: () => ({
      data: new Uint8ClampedArray(canvas.width * canvas.height * 4),
    }),
  };
  const ownerDocument = {
    createElement: () => {
      canvas = { width: 0, height: 0, getContext: () => context };
      return canvas;
    },
  };
  const currentLayout = layoutHeadingText('甲乙\n丙丁', {
    ...gildedRule,
    measureGrapheme,
  });
  assert.equal(currentLayout.ok, true);
  renderHeadingPng({
    layout: currentLayout,
    rule: gildedRule,
    font: { ...fakeFont, document: ownerDocument },
    document: ownerDocument,
    PNGEncoder: {
      sync: { write: ({ width, height }) => pngFor(width, height) },
    },
  });

  assert.equal(gradients.length, 2);
  assert.deepEqual(
    gradients.map((gradient) => gradient.stops),
    [gildedRule.textPaint.stops, gildedRule.textPaint.stops].map((stops) =>
      stops.map(({ offset, color }) => [offset, color])),
  );
  assert.deepEqual(gradients[0].bounds, [
    0,
    gildedRule.paddingY,
    0,
    gildedRule.paddingY + currentLayout.lineHeightPx,
  ]);
  assert.deepEqual(gradients[1].bounds, [
    0,
    gildedRule.paddingY + currentLayout.lineHeightPx,
    0,
    gildedRule.paddingY + currentLayout.lineHeightPx * 2,
  ]);
  for (let lineIndex = 0; lineIndex < 2; lineIndex += 1) {
    const chunk = operations.slice(lineIndex * 6, lineIndex * 6 + 6);
    assert.deepEqual(chunk.map(({ method }) => method), [
      'stroke', 'stroke', 'fill', 'fill', 'stroke', 'stroke',
    ]);
    assert.ok(chunk.slice(0, 2).every(({ style, alpha }) =>
      style === gildedRule.textPaint.stroke.color && alpha === 1));
    assert.ok(chunk.slice(2, 4).every(({ style, alpha }) =>
      style === `gradient-${lineIndex}` && alpha === 1));
    assert.ok(chunk.slice(4).every(({ style, width, alpha }) =>
      style === gildedRule.textPaint.highlight.color
      && width === gildedRule.textPaint.highlight.width
      && alpha === gildedRule.textPaint.highlight.alpha));
    assert.equal(chunk[4].x - chunk[0].x, gildedRule.textPaint.highlight.offsetX);
    assert.ok(
      Math.abs(
        (chunk[4].y - chunk[0].y) - gildedRule.textPaint.highlight.offsetY,
      ) < 1e-9,
    );
  }
});

test('鎏金标题检查完整一圈透明边缘，而不只检查四角', () => {
  let canvas;
  const context = {
    font: '',
    globalAlpha: 1,
    clearRect: () => {},
    scale: () => {},
    measureText: (grapheme) => ({
      width: measureGrapheme(grapheme),
      actualBoundingBoxAscent: 22,
      actualBoundingBoxDescent: 5,
    }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    strokeText: () => {},
    fillText: () => {},
    getImageData: () => {
      const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
      data[Math.floor(canvas.width / 2) * 4 + 3] = 255;
      return { data };
    },
  };
  const ownerDocument = {
    createElement: () => {
      canvas = { width: 0, height: 0, getContext: () => context };
      return canvas;
    },
  };
  const currentLayout = layoutHeadingText('边缘检查', {
    ...gildedRule,
    measureGrapheme,
  });
  assert.throws(() => renderHeadingPng({
    layout: currentLayout,
    rule: gildedRule,
    font: { ...fakeFont, document: ownerDocument },
    document: ownerDocument,
    PNGEncoder: { sync: { write: () => { throw new Error('不应编码'); } } },
  }), /边缘不是透明像素/);
});

test('鎏金绘制失败时缓存单色 PNG 并按规则去重告警，单色也失败才回退活文字', async () => {
  const cache = new HeadingImageLruCache();
  const calls = [];
  const fallbackRenderer = (input) => {
    calls.push(Boolean(input.rule.textPaint));
    if (input.rule.textPaint) throw new Error('模拟渐变不可用');
    return renderPng(input);
  };
  const input = {
    html: repeatedHeadingsHtml(2, '鎏金标题'),
    images: [],
    themeId: 'nyx-night',
    headingImages: [gildedRule],
    fonts: [{ id: 'display' }],
    loadFont: async () => fakeFont,
    renderPng: fallbackRenderer,
    cache,
  };
  const first = await materializeHeadingImages(input);
  assert.equal(first.generatedCount, 1);
  assert.deepEqual(calls, [true, false]);
  assert.equal(first.warnings.length, 1);
  assert.match(first.warnings[0], /鎏金绘制失败.*单色标题.*模拟渐变不可用/);
  assert.equal((first.html.match(/data-wechat-generated-heading/g) ?? []).length, 2);

  const second = await materializeHeadingImages(input);
  assert.deepEqual(calls, [true, false]);
  assert.equal(second.warnings.length, 1);
  assert.match(second.warnings[0], /鎏金绘制失败.*单色标题/);

  const failed = await materializeHeadingImages({
    ...input,
    cache: new HeadingImageLruCache(),
    renderPng: ({ rule: renderRule }) => {
      throw new Error(renderRule.textPaint ? '鎏金坏了' : '单色也坏了');
    },
  });
  assert.equal(failed.generatedCount, 0);
  assert.match(failed.html, /<span class="content"/);
  assert.match(failed.warnings[0], /鎏金绘制失败.*单色回退也失败/);
});

test('一级标题按规则命中顺序绘制 1–5，左对齐并把编号计入缓存', async () => {
  const calls = [];
  const result = await materializeHeadingImages({
    html: repeatedHeadingsHtml(5),
    images: [],
    themeId: 'simple-sketch',
    headingImages: [numberedRule],
    fonts: [{ id: 'display' }],
    assets: numberedAssets,
    loadFont: async () => fakeFont,
    loadNumberAsset,
    renderPng: (input) => {
      calls.push(input);
      return numberedPng(input);
    },
    cache: new HeadingImageLruCache(),
  });

  assert.equal(result.generatedCount, 5);
  assert.equal((result.html.match(/data-wechat-generated-heading/g) ?? []).length, 5);
  assert.equal((result.html.match(/margin:0;/g) ?? []).length, 5);
  assert.deepEqual(calls.map((call) => call.numberAsset.occurrence), [1, 2, 3, 4, 5]);
  assert.deepEqual(calls.map((call) => call.numberAsset.id), numberedRule.numberAssets.slice(0, 5));
  assert.ok(calls.every((call) => call.layout.prefix?.separator === '·'));
  assert.equal(new Set(result.images.map((image) => image.url)).size, 5);
  assert.deepEqual(result.warnings, []);
});

test('编号素材耗尽后只画标题，且整篇只记一条 warning', async () => {
  const calls = [];
  const result = await materializeHeadingImages({
    html: repeatedHeadingsHtml(12),
    images: [],
    themeId: 'simple-sketch',
    headingImages: [numberedRule],
    fonts: [{ id: 'display' }],
    assets: numberedAssets,
    loadFont: async () => fakeFont,
    loadNumberAsset,
    renderPng: (input) => {
      calls.push(input);
      return numberedPng(input);
    },
    cache: new HeadingImageLruCache(),
  });

  assert.equal((result.html.match(/data-wechat-generated-heading/g) ?? []).length, 12);
  assert.deepEqual(
    calls.slice(0, 9).map((call) => call.numberAsset.occurrence),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(calls[9].numberAsset, null);
  assert.equal(calls.length, 10);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /第 10 个及以后只画标题文字/);
});

test('编号只占第一行，自动三行和强制 br 仍沿用 v0.9.6 排版', async () => {
  const captured = [];
  for (const content of [
    '这是一个用于测试编号与三行换行兼容的一级标题内容',
    '第一行内容<br>第二行内容<br>第三行内容',
  ]) {
    const result = await materializeHeadingImages({
      html: baseHtml(content),
      images: [],
      themeId: 'simple-sketch',
      headingImages: [numberedRule],
      fonts: [{ id: 'display' }],
      assets: numberedAssets,
      loadFont: async () => fakeFont,
      loadNumberAsset,
      renderPng: (input) => {
        captured.push(input.layout);
        return numberedPng(input);
      },
      cache: new HeadingImageLruCache(),
    });
    assert.equal(result.generatedCount, 1);
  }

  assert.equal(captured[0].lines.length, 3);
  assert.equal(
    captured[0].inkWidths[0],
    captured[0].widths[0] + captured[0].prefix.totalWidth,
  );
  assert.deepEqual(captured[0].inkWidths.slice(1), captured[0].widths.slice(1));
  assert.deepEqual(captured[1].lines, ['第一行内容', '第二行内容', '第三行内容']);
  assert.equal(
    captured[1].inkWidths[0],
    captured[1].widths[0] + captured[1].prefix.totalWidth,
  );
  assert.deepEqual(captured[1].inkWidths.slice(1), captured[1].widths.slice(1));
});

test('画布先绘制手绘数字和分隔符，数字底部与第一行文字基线对齐', () => {
  const operations = [];
  let canvas;
  const context = {
    font: '',
    clearRect: () => {},
    scale: () => {},
    measureText: (grapheme) => ({
      width: measureGrapheme(grapheme),
      actualBoundingBoxAscent: 22,
      actualBoundingBoxDescent: 5,
    }),
    drawImage: (...args) => operations.push(['image', ...args]),
    fillText: (...args) => operations.push(['text', ...args]),
    getImageData: () => ({
      data: new Uint8ClampedArray(canvas.width * canvas.height * 4),
    }),
  };
  const ownerDocument = {
    createElement: (tag) => {
      assert.equal(tag, 'canvas');
      canvas = {
        width: 0,
        height: 0,
        getContext: () => context,
      };
      return canvas;
    },
  };
  const prefix = {
    numberWidth: 14,
    numberHeight: numberedRule.fontSize * 0.95,
    separator: '·',
    separatorWidth: 28,
    gap: 6,
    totalWidth: 14 + 6 + 28 + 6,
  };
  const currentLayout = layoutHeadingText('第一行内容\n第二行内容', {
    ...numberedRule,
    measureGrapheme,
    prefix,
  });
  assert.equal(currentLayout.ok, true);
  const numberAsset = { image: { id: 'one' } };
  renderHeadingPng({
    layout: currentLayout,
    rule: numberedRule,
    font: { ...fakeFont, document: ownerDocument },
    numberAsset,
    document: ownerDocument,
    PNGEncoder: {
      sync: {
        write: ({ width, height }) => pngFor(width, height),
      },
    },
  });

  assert.equal(operations.filter(([type]) => type === 'image').length, 1);
  assert.equal(operations[0][0], 'image');
  assert.equal(operations[0][2], numberedRule.paddingX);
  assert.equal(operations[0][3] + operations[0][5], operations[1][3]);
  assert.deepEqual(operations[1].slice(0, 2), ['text', '·']);
});

test('H1 只允许纯文本加最多两个 br，强制断点仍可在段内自动换行', async () => {
  const captured = [];
  const capturePng = (input) => {
    captured.push(input.layout);
    return renderPng(input);
  };
  const manual = await materializeHeadingImages({
    html: baseHtml('Codex 与 Agent<br>如何共享上下文'),
    images: [],
    themeId: 'cobalt-orbit',
    headingImages: [rule],
    fonts: [{ id: 'display' }],
    loadFont: async () => fakeFont,
    renderPng: capturePng,
    cache: new HeadingImageLruCache(),
  });
  assert.equal(manual.generatedCount, 1);
  assert.deepEqual(captured[0].lines, ['Codex 与 Agent', '如何共享上下文']);
  assert.match(manual.html, /alt="Codex 与 Agent 如何共享上下文"/);
  assert.match(manual.images[0].fallbackHtml, /Codex 与 Agent<br>如何共享上下文/);

  const threeForced = await materializeHeadingImages({
    html: baseHtml('第一段<br/>第二段<br />第三段'),
    images: [],
    themeId: 'cobalt-orbit',
    headingImages: [rule],
    fonts: [{ id: 'display' }],
    loadFont: async () => fakeFont,
    renderPng: capturePng,
    cache: new HeadingImageLruCache(),
  });
  assert.equal(threeForced.generatedCount, 1);
  assert.deepEqual(captured[1].lines, ['第一段', '第二段', '第三段']);

  const forcedAndWrapped = await materializeHeadingImages({
    html: baseHtml('这个一级标题片段需要自动换行<br>收束'),
    images: [],
    themeId: 'cobalt-orbit',
    headingImages: [rule],
    fonts: [{ id: 'display' }],
    loadFont: async () => fakeFont,
    renderPng: capturePng,
    cache: new HeadingImageLruCache(),
  });
  assert.equal(forcedAndWrapped.generatedCount, 1);
  assert.equal(captured[2].lines.length, 3);
  assert.equal(captured[2].lines.at(-1), '收束');
});

test('三个 br、空强制行与其他行内标签都保留活文字并明确告警', async () => {
  for (const [content, reason] of [
    ['一<br>二<br>三<br>四', /最多允许 2 个|三个换行/],
    ['第一行<br><br>第三行', /空行/],
    ['<strong>复杂标题</strong>', /复杂行内内容/],
  ]) {
    const result = await materializeHeadingImages({
      html: baseHtml(content),
      images: [],
      themeId: 'cobalt-orbit',
      headingImages: [rule],
      fonts: [{ id: 'display' }],
      loadFont: async () => fakeFont,
      renderPng,
    });
    assert.equal(result.generatedCount, 0);
    assert.match(result.warnings[0], reason);
    assert.match(result.html, /<span class="content"/);
  }
});

test('连续两个 H1 始终保留为两个独立标题节点和两张标题图', async () => {
  const html = [
    '<section id="nice">',
    baseHtml('第一章').replace(/^<section id="nice">|<\/section>$/g, ''),
    baseHtml('第二章节').replace(/^<section id="nice">|<\/section>$/g, ''),
    '</section>',
  ].join('');
  const result = await materializeHeadingImages({
    html,
    images: [],
    themeId: 'cobalt-orbit',
    headingImages: [rule],
    fonts: [{ id: 'display' }],
    loadFont: async () => fakeFont,
    renderPng,
    cache: new HeadingImageLruCache(),
  });
  assert.equal((result.html.match(/<h1\b/g) ?? []).length, 2);
  assert.equal((result.html.match(/data-wechat-generated-heading="true"/g) ?? []).length, 2);
  assert.equal(result.images.length, 2);
  assert.match(result.html, /alt="第一章"/);
  assert.match(result.html, /alt="第二章节"/);
});

test('字体加载失败和超过保护线的标题分别回退原活文字', async () => {
  const fontFailure = await materializeHeadingImages({
    html: baseHtml('核心参数'),
    images: [],
    themeId: 'cobalt-orbit',
    headingImages: [rule],
    fonts: [{ id: 'display' }],
    loadFont: async () => { throw new Error('模拟字体失败'); },
    renderPng,
  });
  assert.equal(fontFailure.generatedCount, 0);
  assert.match(fontFailure.html, /<span class="content"[^>]*>核心参数<\/span>/);
  assert.match(fontFailure.warnings[0], /模拟字体失败/);

  const tooLong = await materializeHeadingImages({
    html: baseHtml('超'.repeat(41)),
    images: [],
    themeId: 'cobalt-orbit',
    headingImages: [rule],
    fonts: [{ id: 'display' }],
    loadFont: async () => fakeFont,
    renderPng,
  });
  assert.equal(tooLong.generatedCount, 0);
  assert.match(tooLong.warnings[0], /超过 40/);
});

test('没有 heading_images 的其他主题保持 HTML 和图片记录字节级不变', async () => {
  const html = baseHtml('其他主题');
  const images = [{ target: 'article.png', url: 'app://article.png' }];
  let loads = 0;
  const result = await materializeHeadingImages({
    html,
    images,
    themeId: 'other-theme',
    headingImages: [],
    fonts: [],
    loadFont: async () => { loads += 1; },
  });
  assert.equal(result.html, html);
  assert.equal(result.images, images);
  assert.equal(loads, 0);
});

test('FontFace 从 Vault 字节加载并按文件状态缓存，不依赖系统安装', async () => {
  const bytes = Buffer.from('font-bytes');
  const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  let reads = 0;
  let loads = 0;
  const added = [];
  class FakeFontFace {
    constructor(family, source, descriptors) {
      this.family = family;
      this.source = source;
      this.descriptors = descriptors;
    }

    async load() {
      loads += 1;
      return this;
    }
  }
  const runtime = new HeadingImageRuntime({
    vault: {
      readBinary: async () => {
        reads += 1;
        return bytes;
      },
    },
    document: fakeDocument,
    FontFaceClass: FakeFontFace,
    fontSet: {
      add: (face) => added.push(face),
      delete: () => true,
    },
  });
  const descriptor = {
    id: 'display',
    filePath: '主题/配套字体资源/display.ttf',
    file: { stat: { mtime: 1, size: bytes.byteLength } },
    sha256,
    weight: 400,
    style: 'normal',
  };
  const first = await runtime.loadFont(descriptor);
  const second = await runtime.loadFont(descriptor);
  assert.equal(first, second);
  assert.equal(reads, 1);
  assert.equal(loads, 1);
  assert.equal(added.length, 1);
  assert.match(first.runtimeFamily, /^cfwx-theme-display-/);
  runtime.dispose();
});

test('编号素材从 Vault 字节解码并按文件状态缓存', async () => {
  const bytes = Buffer.from('fake-png');
  let reads = 0;
  let assignedSource = '';
  class FakeImage {
    constructor() {
      this.complete = false;
      this.naturalWidth = 65;
      this.naturalHeight = 120;
    }

    set src(value) {
      assignedSource = value;
      this.complete = true;
    }
  }
  const runtime = new HeadingImageRuntime({
    vault: {
      readBinary: async () => {
        reads += 1;
        return bytes;
      },
    },
    document: {
      createElement: (tag) => {
        assert.equal(tag, 'img');
        return new FakeImage();
      },
    },
  });
  const descriptor = {
    id: 'sk-num-1',
    filePath: '主题/透明装饰素材/sk-num-1.png',
    file: { stat: { mtime: 1, size: bytes.byteLength } },
  };
  const first = await runtime.loadNumberAsset(descriptor);
  const second = await runtime.loadNumberAsset(descriptor);
  assert.equal(first, second);
  assert.equal(reads, 1);
  assert.equal(first.width, 65);
  assert.equal(first.height, 120);
  assert.match(assignedSource, /^data:image\/png;base64,/);
  runtime.dispose();
});

test('320/390/430 三档不溢出且 430 不放大', () => {
  const result = layout('星轨主题正在建立清晰稳定一致可靠完整阅读秩序');
  assert.equal(result.ok, true);
  const displayWidths = [284, 354, 394].map((available) => Math.min(result.width, available));
  assert.ok(displayWidths[0] <= 284);
  assert.ok(displayWidths[1] <= 331);
  assert.equal(displayWidths[2], result.width);
  assert.ok(28 * displayWidths[0] / result.width >= 24);
});
