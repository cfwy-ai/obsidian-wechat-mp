import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio/slim';
import { PNG } from 'pngjs';
import postcss from 'postcss';
import { parseThemeManifest } from '../src/theme-package.mjs';
import { renderArticle } from '../src/pipeline.mjs';
import { materializeNestedLists, preserveOrderedListImageSemantics } from '../src/nested-lists.mjs';
import { materializeOrderedListImages } from '../plugin/ordered-list-image.mjs';
import { HeadingImageLruCache, layoutHeadingText, verifyGeneratedHeadingPng, renderHeadingPng } from '../plugin/heading-image.mjs';
import { scaleReferenceOrderedListRule } from '../src/reference-composition.mjs';
import { copyRenderedArticle, formatCopyResultNotice } from '../plugin/copy.mjs';
import { embedImagesForExport } from '../plugin/export-image.mjs';

const rule = { fontId: 'brush', fallbackFontIds: [], fontSize: 20, color: '#59614D', scale: 3, gap: 6 };
const wrap = body => `<section id="nice">${body}</section>`;
const parse = html => load(html, {}, false);
const labels = html => parse(html)('[data-wechat-ordered-list-label]').toArray().map(node => node.attribs['data-wechat-ordered-list-label']);
const convert = (html, activeRule = rule) => materializeNestedLists(preserveOrderedListImageSemantics(html, activeRule), { orderedListImages: activeRule }).html;
const font = {
  runtimeFamily: 'theme-brush', hash: 'brush-font', coverageHash: 'brush-coverage',
  coverage: new Set(Array.from({ length: 95 }, (_, i) => i + 32)), weight: 400, style: 'normal',
  document: { createElement: () => ({ getContext: () => ({}) }) },
};
const makePng = ({ layout, rule: r }) => {
  const width = layout.width * r.scale, height = layout.height * r.scale;
  const data = Buffer.alloc(width * height * 4);
  [...layout.text].forEach((char, i) => { data[i * 4] = char.codePointAt(0); data[i * 4 + 3] = 255; });
  return { bytes: PNG.sync.write({ width, height, data }, { colorType: 6, inputColorType: 6 }), physicalWidth: width, physicalHeight: height };
};
const generate = (html, options = {}) => materializeOrderedListImages({
  html, images: [], themeId: 'architecture', orderedListImages: rule, fonts: [{ id: 'brush' }],
  loadFont: async () => font, cache: new HeadingImageLruCache(),
  measureFactory: () => () => 12, layoutText: layoutHeadingText, renderPng: makePng,
  verifyPng: verifyGeneratedHeadingPng, ...options,
});

const emblems = [{ depth: 1, assetId: 'ol-primary', width: 24, height: 24, gap: 4 }, { depth: 2, assetId: 'ol-secondary', width: 20, height: 20, gap: 4 }];
const emblemRule = { ...rule, depthEmblems: emblems };
const emblemAssets = emblems.map(e => ({ id: e.assetId, file: `${e.assetId}.png`, filePath: `${e.assetId}.png` }));
const loadEmblem = async asset => ({ image: { id: asset.id }, hash: `${asset.id}-v1`, width: 100, height: asset.id === 'ol-primary' ? 100 : 50 });
const generateEmblems = (html, options = {}) => generate(html, { orderedListImages: emblemRule, assets: emblemAssets, loadEmblem, layoutWidth: 390, ...options });
const styles = node => Object.fromEntries(postcss.parse(`x{${node.attribs.style ?? ''}}`).first.nodes.filter(n => n.type === 'decl').map(n => [n.prop, n.value]));

test('ordered list images opt in explicitly with registered fonts and bounded fields', async () => {
  const base = { schema_version: 3, theme_id: 'test-lists', name: '测试', fonts: [{ font_id: 'brush', file: '配套字体资源/brush.woff2', family: 'Brush', sha256: 'a'.repeat(64) }] };
  const normalize = value => parseThemeManifest(JSON.stringify(value));
  assert.equal(Object.hasOwn(normalize(base), 'orderedListImages'), false);
  assert.deepEqual(normalize({ ...base, ordered_list_images: { font_id: 'brush' } }).orderedListImages, rule);
  for (const settings of [{ font_id: 'unknown' }, { font_id: 'brush', font_size: 99 }, { font_id: 'brush', color: 'gold' }, { font_id: 'brush', image: 'unsafe' }]) {
    assert.throws(() => normalize({ ...base, ordered_list_images: settings }), /ordered_list_images/);
  }
  const html = wrap('<ol><li>旧主题</li></ol>');
  assert.equal(materializeNestedLists(html).html, html);
  assert.equal(preserveOrderedListImageSemantics(html, null), html);
  assert.equal((await generate(html, { orderedListImages: null, loadFont: () => { throw new Error('must not load'); } })).html, html);
});

test('flat and nested markers preserve start, li value, reversed defaults and type past five', () => {
  const html = convert(wrap('<ol start="8"><li>八</li><li value="13">十三<ul><li>子项<ol reversed><li>内二</li><li>内一</li></ol></li></ul></li><li>十四</li></ol><ol reversed start="0"><li>零</li><li value="-3">负三</li><li>负四</li></ol><ol type="A" start="26"><li>Z</li><li>AA</li></ol>'));
  assert.deepEqual(labels(html), ['8.', '13.', '2.', '1.', '14.', '0.', '-3.', '-4.', 'Z.', 'AA.']);
  const $ = parse(html);
  assert.equal($('[role="listitem"]').length, 11);
  assert.match($.text(), /子项/);
  assert.equal($('[data-wechat-list-group="ol"][data-wechat-ordered-list-reversed="true"]').length, 2);
});

test('render pipeline carries reversed through sanitization only in opt-in mode; plain text has numbering', () => {
  const source = '<ol reversed start="8"><li>八<strong>加粗</strong></li><li value="3">三</li><li>二</li></ol>';
  const result = renderArticle({ source, themeCss: '#nice ol,#nice li { list-style-type:none }', resolve: () => null, orderedListImages: rule });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(labels(result.html), ['8.', '3.', '2.']);
  assert.equal(parse(result.html)('strong').text(), '加粗');
  assert.equal(parse(result.html)('[data-wechat-list-marker="ol"]').text().replace(/\s/g, ''), '8.3.2.');
});

test('only marker interiors become PNG; full text, links, nested content and code stay editable', async () => {
  const html = convert(wrap('<ol start="6"><li><p>第六<a href="https://example.org">链接</a></p><p>续段</p><ul><li>嵌套</li></ul></li><li value="101"><strong>第一百零一</strong><pre><code>ol 1</code></pre></li></ol>'));
  const result = await generate(html);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.generatedCount, 2);
  const $ = parse(result.html);
  assert.deepEqual($('img').toArray().map(node => node.attribs.alt), ['6.', '101.']);
  assert.equal($('a').attr('href'), 'https://example.org');
  assert.equal($('strong').text(), '第一百零一');
  assert.equal($('pre code').text(), 'ol 1');
  assert.match($.text(), /续段/);
  for (const image of result.images) {
    assert.equal(image.generatedKind, 'ordered-list');
    assert.ok(image.fallbackHtml.includes(image.alt));
    assert.equal(PNG.sync.read(image.bytes).colorType, 6);
  }
});

test('missing glyphs, font errors and raster failure keep exact numbered source and complete body', async () => {
  const html = convert(wrap('<ol start="19"><li>正文完整</li><li>继续正文</li></ol>'));
  for (const options of [
    { loadFont: async () => ({ ...font, coverage: new Set([49, 46]) }) },
    { loadFont: async () => { throw new Error('font failed'); } },
    { renderPng: () => { throw new Error('canvas failed'); } },
  ]) {
    const result = await generate(html, options);
    assert.equal(result.html, html);
    assert.equal(result.images.length, 0);
    assert.match(result.warnings.join(''), /保留正确编号与正文/);
  }
});

test('copy budget fallback restores the correct numbers and exports use generated resources', async () => {
  const result = await generate(convert(wrap('<ol start="8"><li>八项</li><li>九项</li><li value="101">一百零一项</li></ol>')));
  let clipboard;
  const copied = await copyRenderedArticle({ html: result.html, images: result.images, text: '8. 八项\n9. 九项\n101. 一百零一项', embedImages: true, maxSingleImageBytes: 1, _clipboard: { write: value => { clipboard = value; } } });
  assert.equal(copied.stats.orderedListImages.textFallbacks, 3);
  assert.equal(copied.stats.headingImages.total, 0);
  assert.match(formatCopyResultNotice(copied), /列表编号 3 处恢复文字/);
  assert.doesNotMatch(clipboard.html, /<img/);
  assert.deepEqual(labels(clipboard.html), ['8.', '9.', '101.']);
  assert.match(parse(clipboard.html).text(), /8\.\s*八项/);
  assert.match(parse(clipboard.html).text(), /101\.\s*一百零一项/);
  const exported = await embedImagesForExport({ html: result.html, images: result.images, resolveFile: () => { throw new Error('no filesystem needed'); }, transformImage: async bytes => ({ bytes, mimeType: 'image/png' }) });
  assert.equal(exported.embeddedCount, 3);
  assert.deepEqual(exported.warnings, []);
});

test('equal-looking generated rasters keep different label fallbacks and repeat labels share one resource', async () => {
  const samePng = args => makePng({ ...args, layout: { ...args.layout, text: 'same' } });
  const html = convert(wrap('<ol><li>甲</li><li>乙</li></ol><ol><li>丙</li></ol>'));
  const result = await generate(html, { renderPng: samePng });
  assert.equal(result.images.length, 2);
  assert.notEqual(result.images[0].url, result.images[1].url);
  const $ = parse(result.html);
  assert.equal($('img').eq(0).attr('src'), $('img').eq(2).attr('src'));
  assert.deepEqual($('img').toArray().map(node => node.attribs.alt), ['1.', '2.', '1.']);
});

test('resource budget includes existing live images and leaves ungenerated numbering intact', async () => {
  const images = Array.from({ length: 127 }, (_, i) => ({ url: `app://existing/${i}.png`, origin: 'theme' }));
  const html = convert(wrap(images.map(image => `<img src="${image.url}" />`).join('') + '<ol start="8"><li>八</li><li>九</li></ol><ol start="8"><li>再次八</li></ol>'));
  const result = await generate(html, { images });
  assert.equal(result.generatedCount, 1);
  assert.match(result.warnings.join(''), /复制上限/);
  const $ = parse(result.html);
  assert.equal($('img[data-wechat-generated-ordered-list]').length, 2);
  assert.equal($('[data-wechat-ordered-list-label="9."]').text().trim(), '9.');
});

test('unexpectedly wide artistic digits fall back before overlapping the editable body, including cache hits', async () => {
  const html = convert(wrap('<ol><li>正文完整</li></ol>'));
  const cache = new HeadingImageLruCache();
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await generate(html, { cache, measureFactory: () => () => 25 });
    assert.equal(result.html, html);
    assert.equal(result.generatedCount, 0);
    assert.match(result.warnings.join(''), /超过预留宽度/);
  }
});

test('depth emblems require registered PNG assets and bounded unique levels while old metadata stays unchanged', () => {
  const base = { schema_version: 3, theme_id: 'depth-test', name: '测试',
    fonts: [{ font_id: 'brush', file: '配套字体资源/brush.woff2', family: 'Brush', sha256: 'a'.repeat(64) }],
    assets: [{ asset_id: 'ol-primary', file: '透明装饰素材/primary.png' }, { asset_id: 'ol-secondary', file: '透明装饰素材/secondary.png' }, { asset_id: 'photo', file: '透明装饰素材/photo.jpg' }] };
  const values = emblems.map(({ assetId, ...e }) => ({ ...e, asset_id: assetId }));
  const normalize = depth_emblems => parseThemeManifest(JSON.stringify({ ...base, ordered_list_images: { font_id: 'brush', ...(depth_emblems === undefined ? {} : { depth_emblems }) } })).orderedListImages;
  assert.deepEqual(normalize(undefined), rule);
  assert.deepEqual(normalize([...values].reverse()).depthEmblems, emblems);
  for (const invalid of [[], [{ ...values[0], asset_id: 'missing' }], [{ ...values[0], asset_id: 'photo' }], [values[0], values[0]], [values[1]], [{ ...values[0], width: 65 }], [{ ...values[0], height: 0 }], [{ ...values[0], depth: 0 }], [{ ...values[0], src: 'https://example.com/a.png' }]]) {
    assert.throws(() => normalize(invalid), /depth_emblems/);
  }
});

test('different-depth equal labels get distinct composed PNGs, deeper levels reuse the second emblem without distortion', async () => {
  const html = convert(wrap('<ol><li>一级<ol><li>二级<ol><li>三级</li></ol></li></ol></li><li>一级二</li></ol>'), emblemRule);
  const loaded = [], drawn = [];
  const result = await generateEmblems(html, {
    loadEmblem: async a => { loaded.push(a.id); return loadEmblem(a); },
    renderPng: input => { drawn.push(input); return makePng(input); },
  });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(loaded.sort(), ['ol-primary', 'ol-secondary']);
  assert.equal(result.generatedCount, 3);
  const $ = parse(result.html), images = $('img[data-wechat-generated-ordered-list]');
  assert.deepEqual(images.toArray().map(n => n.attribs.alt), ['1.', '1.', '1.', '2.']);
  assert.notEqual(images.eq(0).attr('src'), images.eq(1).attr('src'));
  assert.equal(images.eq(1).attr('src'), images.eq(2).attr('src'));
  const first = drawn.find(i => i.numberAsset.image.id === 'ol-primary');
  const second = drawn.find(i => i.numberAsset.image.id === 'ol-secondary');
  assert.equal(first.layout.prefix.numberWidth, 24); assert.equal(first.layout.prefix.numberHeight, 24);
  assert.equal(second.layout.prefix.numberWidth, 20); assert.equal(second.layout.prefix.numberHeight, 10);
  assert.equal(first.rule.fontSize, 20); assert.equal(second.rule.fontSize, 20);
  assert.match($.text(), /一级/); assert.match($.text(), /三级/);
});

test('composed multi-digit markers grow group gutters consistently without moving nested rows or losing continuations', async () => {
  const html = convert(wrap('<ol><li><p>第一项</p><p>第一项续段</p><ul><li>无序子项</li></ul></li><li value="101">第一百零一项</li></ol>'), emblemRule);
  const result = await generateEmblems(html, { measureFactory: () => () => 25 });
  assert.deepEqual(result.warnings, []);
  const $ = parse(result.html);
  const group = $('[data-wechat-list-root="ol"]')[0];
  const ownRows = $('[data-wechat-list-row]').toArray().filter(n => $(n).closest('[data-wechat-list-group]')[0] === group);
  const widths = $('[data-wechat-ordered-list-label]').toArray().map(n => Number.parseFloat(styles(n).width));
  assert.deepEqual(widths, [138, 138]);
  assert.ok(ownRows.every(n => Number.parseFloat(styles(n)['padding-left']) === 138));
  assert.equal(Number.parseFloat(styles($('[data-wechat-list-group="ul"] [data-wechat-list-row]')[0])['padding-left']), 22.4);
  assert.equal($('p').filter((_, n) => $(n).text() === '第一项续段').length, 1);
  assert.deepEqual($('img').toArray().map(n => n.attribs.alt), ['1.', '101.']);
  assert.ok($('img').toArray().every(n => Number(n.attribs.width) + rule.gap <= 138));
});

test('emblems retain reversed, negative, large starting numbers and mixed UL/OL depth semantics', async () => {
  const html = convert(wrap('<ol reversed start="0"><li>零</li><li value="-3">负三</li></ol><ul><li>父项<ol start="12345"><li>大序号</li></ol></li></ul>'), emblemRule);
  const result = await generateEmblems(html);
  assert.deepEqual(result.warnings, []);
  const $ = parse(result.html);
  assert.deepEqual($('img').toArray().map(n => n.attribs.alt), ['0.', '-3.', '12345.']);
  assert.deepEqual(labels(result.html), ['0.', '-3.', '12345.']);
  assert.equal($('[data-wechat-ordered-list-reversed="true"]').length, 1);
  assert.equal($('[data-wechat-list-marker="ul"]').text().trim(), '•');
});

test('emblem hashes invalidate cached images and resource budgets count distinct depth designs', async () => {
  const cache = new HeadingImageLruCache();
  const html = convert(wrap('<ol><li>一级<ol><li>二级</li></ol></li></ol><ol><li>再次一级</li></ol>'), emblemRule);
  const first = await generateEmblems(html, { cache });
  const changed = await generateEmblems(html, { cache, loadEmblem: async asset => ({ ...await loadEmblem(asset), hash: `${asset.id}-v2` }) });
  assert.notEqual(first.images[0].url, changed.images[0].url);
  const images = Array.from({ length: 127 }, (_, i) => ({ url: `app://existing/${i}.png`, origin: 'theme' }));
  const withExisting = html.replace('<section id="nice">', '<section id="nice">' + images.map(i => `<img src="${i.url}">`).join(''));
  const limited = await generateEmblems(withExisting, { images });
  const $ = parse(limited.html);
  assert.equal(limited.generatedCount, 1);
  assert.equal($('img[data-wechat-generated-ordered-list]').length, 2);
  assert.equal($('[data-wechat-list-depth="2"] [data-wechat-ordered-list-label]').text().trim(), '1.');
  assert.match(limited.warnings.join(''), /复制上限/);
});

test('missing emblems preserve exact numbered content and copy fallbacks restore numbers', async () => {
  const html = convert(wrap('<ol start="19"><li>正文完整</li><li>第二项</li></ol>'), emblemRule);
  const missing = await generateEmblems(html, { assets: [] });
  assert.equal(missing.html, html); assert.equal(missing.generatedCount, 0);
  assert.match(missing.warnings.join(''), /编号图形不可读取/);
  const result = await generateEmblems(html);
  let clipboard;
  const copied = await copyRenderedArticle({ html: result.html, images: result.images, text: '19. 正文完整\n20. 第二项', embedImages: true, maxSingleImageBytes: 1, _clipboard: { write: value => { clipboard = value; } } });
  assert.equal(copied.stats.orderedListImages.textFallbacks, 2);
  assert.deepEqual(labels(clipboard.html), ['19.', '20.']);
  assert.match(parse(clipboard.html).text(), /正文完整/);
  assert.doesNotMatch(clipboard.html, /<img/);
});

test('an exceptionally wide number falls back correctly without leaving an oversized gutter outside the column', async () => {
  const activeRule = { ...emblemRule, fontSize: 28 };
  const html = convert(wrap('<ol start="987654321098765" style="margin-left:10%;margin-right:10%;font-size:16px"><li>正文完整</li></ol>'), activeRule);
  const result = await generateEmblems(html, { orderedListImages: activeRule, layoutWidth: 320, measureFactory: () => () => 28 });
  const $ = parse(result.html);
  assert.equal(result.generatedCount, 0);
  assert.deepEqual(labels(result.html), ['987654321098765.']);
  assert.match($.text(), /正文完整/);
  assert.equal(Number.parseFloat(styles($('[data-wechat-ordered-list-label]')[0]).width), 224);
  assert.match(result.warnings.join(''), /图形编号过宽/);
});

test('document-flow scales emblem, number, gutter and nested offsets together; font-only rules remain untouched', async () => {
  const referenceComposition = { strategy: 'document-flow', designWidth: 390 };
  assert.equal(scaleReferenceOrderedListRule(rule, referenceComposition, 780), rule);
  const outcomes = [];
  for (const width of [390, 780]) {
    const rendered = renderArticle({ source: '<ol start="99"><li>正文<ol><li>嵌套</li></ol></li></ol>', themeCss: '#nice{font-size:16px}#nice li{font-size:16px}#nice ol{margin:0;padding-left:0}', resolve: () => null, orderedListImages: emblemRule, referenceComposition, layoutWidth: width });
    const drawn = [];
    const result = await generateEmblems(rendered.html, { referenceComposition, layoutWidth: width, measureFactory: (_ctx, typography) => () => typography.fontSize * .6,
      renderPng: input => { drawn.push(input); return makePng(input); },
    });
    assert.deepEqual(result.warnings, []);
    const $ = parse(result.html);
    outcomes.push({ font: drawn[0].rule.fontSize, emblem: drawn[0].layout.prefix.numberWidth, pngWidth: Number($('img').first().attr('width')),
      gutter: Number.parseFloat(styles($('[data-wechat-ordered-list-label]')[0]).width),
      nested: Number.parseFloat(styles($('[data-wechat-list-row][data-wechat-list-depth="2"]')[0])['margin-left']) });
  }
  for (const field of ['font', 'emblem', 'pngWidth', 'gutter', 'nested']) assert.equal(outcomes[1][field], outcomes[0][field] * 2, field);
});

test('number renderer draws the prefix bitmap and exact digits once, centered inside the transparent marker canvas', () => {
  const calls = [], canvas = { width: 0, height: 0 };
  const context = { clearRect() {}, scale() {}, measureText: text => ({ width: text.length * 12, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4 }),
    drawImage: (...args) => calls.push(['image', ...args]), fillText: (...args) => calls.push(['text', ...args]),
    getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }) };
  canvas.getContext = () => context;
  const r = { fontSize: 20, minEffectiveFontSize: 20, lineHeight: 1.25, letterSpacing: 0, scale: 3, color: '#222222', paddingX: 2, paddingY: 1, maxWidth: 200, minDisplayWidth: 200, maxLines: 1, maxEquivalentCharacters: 32, align: 'left' };
  const prefix = { numberWidth: 24, numberHeight: 24, gap: 4, separator: '', totalWidth: 28, verticalAlign: 'middle' };
  const layout = layoutHeadingText('101.', { ...r, prefix, measureGrapheme: () => 12 });
  const image = { id: 'emblem' };
  const result = renderHeadingPng({ layout, rule: r, font: { ...font, familyForGrapheme: () => 'theme-brush' }, numberAsset: { image }, document: { createElement: () => canvas } });
  const picture = calls.find(c => c[0] === 'image');
  assert.equal(picture[1], image); assert.equal(picture[4], 24); assert.equal(picture[5], 24);
  assert.ok(picture[3] >= 0 && picture[3] + picture[5] <= layout.height);
  assert.equal(calls.filter(c => c[0] === 'text').map(c => c[1]).join(''), '101.');
  assert.equal(calls.find(c => c[0] === 'text')[2], 30);
  assert.equal(PNG.sync.read(result.bytes).colorType, 6);
});
