import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { parseDocument } from 'htmlparser2';
import { parseThemeManifest } from '../src/theme-package.mjs';
import { materializeQuoteImages } from '../plugin/quote-image.mjs';
import { HeadingImageLruCache, HeadingImageRuntime, segmentGraphemes, verifyGeneratedHeadingPng } from '../plugin/heading-image.mjs';
import { copyRenderedArticle, DEFAULT_MAX_PROCESSED_RESOURCES } from '../plugin/copy.mjs';
import { embedImagesForExport } from '../plugin/export-image.mjs';

const rawRule = { font_id: 'classic', font_size: 18, color: '#80602F',
  illustration: { asset_id: 'temple', width_percent: 44, gap_percent: 4 } };
const manifest = (quoteRule = rawRule, assetFile = '透明装饰素材/temple.png') => ({
  schema_version: 3, theme_id: 'quote-layout', name: '引用排布', components: [],
  fonts: [{ font_id: 'classic', file: '配套字体资源/classic.woff2', family: 'classic', sha256: 'a'.repeat(64) }],
  assets: [{ asset_id: 'temple', file: assetFile, alt: '寺院半幅' }], quote_images: quoteRule,
});

test('opt-in table quote keeps two occupied columns with an internal gap through copy', async () => {
  const tableRule=parse(manifest({...rawRule,replace_native_container:true,illustration:{...rawRule.illustration,layout:'table'}})).quoteImages;
  assert.throws(()=>parse(manifest({...rawRule,illustration:{...rawRule.illustration,layout:'flex'}})),/layout/);
  for (const layoutWidth of [320,390,677]) {
    const result=await generate(source(paragraph('山河仍在。')+paragraph('岁月无声。')),{quoteImages:tableRule,layoutWidth});
    assert.deepEqual(result.warnings,[]);
    assert.equal(result.generatedCount,2);
    assert.equal(named(result.html,'blockquote').length,0);
    const table=named(result.html,'table')[0];
    assert.equal(table.attribs.role,'presentation');
    const cells=named(table,'td');
    assert.deepEqual(cells.map(c=>c.attribs.width),['44%','56%']);
    assert.equal(named(cells[0],'img').length,1);
    assert.equal(named(cells[1],'img').length,2);
    const inset=nodes(cells[1],n=>n.attribs?.['data-wechat-quote-text-inset']==='true')[0];
    assert.match(inset.attribs.style,/margin:0 0 0 7\.142857%;/);
    assert.ok(cells.every(c=>c.attribs.style.includes('border:0;')));
    let payload;
    await copyRenderedArticle({html:result.html,text:'',images:result.images,embedImages:true,
      resolveFile:()=>({path:'temple.png'}),readBinary:async()=>png(20,30),_clipboard:{write:v=>{payload=v;}}});
    assert.equal(named(payload.html,'tr').length,1);
    assert.equal(named(payload.html,'td').length,2);
    assert.ok(named(payload.html,'td').every(c=>named(c,'img').length>0));
    assert.ok(nodes(payload.html,n=>n.attribs?.['data-wechat-quote-text-inset']==='true').length===1);
    assert.equal(named(payload.html,'img').length,3);
  }
});
const parse = input => parseThemeManifest(JSON.stringify(input));
const rule = parse(manifest()).quoteImages;
const asset = { id: 'temple', file: {}, filePath: 'vault/theme/temple.png', url: 'app://temple.png', alt: '寺院半幅', wechatUrl: 'https://mmbiz.qpic.cn/test/temple/0' };
const png = (width, height) => PNG.sync.write({ width, height, data: Buffer.alloc(width * height * 4) }, { colorType: 6, inputColorType: 6 });
const nodes = (html, predicate) => {
  const result = []; const visit = node => { if (predicate(node)) result.push(node); for (const child of node.children ?? []) visit(child); };
  visit(typeof html === 'string' ? parseDocument(html) : html); return result;
};
const named = (html, name) => nodes(html, node => node.name === name);
const flatten = node => node.type === 'text' ? node.data : node.name === 'img' && node.attribs?.['data-wechat-generated-quote'] ? node.attribs.alt : (node.children ?? []).map(flatten).join('');
const source = body => `<section id="nice" style="padding:20px"><blockquote style="padding:10px">${body}</blockquote></section>`;
const paragraph = text => `<p style="padding:1px 4px;margin:2px">${text}</p>`;

async function generate(html, options = {}) {
  const font = { runtimeFamily: 'classic', hash: 'classic', weight: 400, style: 'normal',
    coverage: new Set([...html].map(c => c.codePointAt(0))), coverageHash: 'all',
    document: { createElement: () => ({ getContext: () => ({}) }) } };
  return materializeQuoteImages({ html, images: [], themeId: 'quote-layout', quoteImages: rule,
    fonts: [{ id: 'classic' }], assets: [asset], layoutWidth: 320,
    loadFont: async () => font, loadIllustration: async () => ({ width: 900, height: 1400 }),
    cache: new HeadingImageLruCache(), measureFactory: () => g => /^[a-zA-Z0-9]$/.test(g) ? 8 : 18,
    renderPng: ({ layout, rule: r }) => ({ bytes: png(layout.width * r.scale, layout.height * r.scale) }),
    verifyPng: verifyGeneratedHeadingPng, segmentGraphemes, ...options });
}

test('quote illustration is opt-in, uses a registered PNG and validates safe column proportions', () => {
  assert.deepEqual(rule.illustration, { assetId: 'temple', widthPercent: 44, gapPercent: 4 });
  assert.equal(Object.hasOwn(parse(manifest({ font_id: 'classic' })).quoteImages, 'illustration'), false);
  assert.deepEqual(parse(manifest({ ...rawRule, illustration: { asset_id: 'temple' } })).quoteImages.illustration, rule.illustration);
  for (const [illustration, expression] of [
    [{ asset_id: 'missing' }, /未登记素材/],
    [{ asset_id: 'temple', width_percent: 70 }, /width_percent/],
    [{ asset_id: 'temple', gap_percent: -1 }, /gap_percent/],
    [{ asset_id: 'temple', width_percent: 60, gap_percent: 8 }, /文字保留至少/],
    [{ asset_id: 'temple', outside: true }, /不支持字段/],
  ]) assert.throws(() => parse(manifest({ ...rawRule, illustration })), expression);
  assert.throws(() => parse(manifest(rawRule, '透明装饰素材/temple.jpg')), /PNG/);
});

test('actual right-column width determines PNG width at 320/390/677, with legal responsive section siblings', async () => {
  const widths = [];
  for (const layoutWidth of [320, 390, 677]) {
    const html = source(paragraph('山河仍在。<strong>岁月无声。</strong>'));
    const result = await generate(html, { layoutWidth });
    assert.deepEqual(result.warnings, []); assert.equal(result.generatedCount, 1);
    const row = nodes(result.html, node => node.attribs?.['data-wechat-quote-illustration'])[0];
    assert.equal(row.parent.name, 'blockquote');
    assert.deepEqual(row.children.map(node => node.name), ['section', 'section']);
    assert.match(row.children[0].attribs.style, /width:44%;/);
    assert.match(row.children[1].attribs.style, /width:52%;margin:0 0 0 4%;/);
    assert.ok(row.children.every(node => /display:inline-block/.test(node.attribs.style) && /vertical-align:middle/.test(node.attribs.style)));
    const art = named(row.children[0], 'img')[0];
    assert.equal(art.attribs.src, asset.url); assert.match(art.attribs.style, /height:auto/);
    assert.equal(Object.hasOwn(art.attribs, 'height'), false);
    const text = nodes(row.children[1], node => node.attribs?.['data-wechat-generated-quote'])[0];
    widths.push(Number(text.attribs.width));
    assert.equal(named(row.children[1], 'p').length, 1);
    assert.equal(nodes(result.html, node => node.name === 'p' && named(node, 'section').length).length, 0);
    assert.doesNotMatch(result.html, /(?:float:|display:flex|position:absolute|min-height:|background-image:)/);
    const record = result.images.find(image => image.origin === 'theme');
    assert.equal(record.url, asset.url); assert.equal(record.filePath, asset.filePath); assert.equal(record.wechatUrl, asset.wechatUrl);
    assert.equal(flatten(parseDocument(result.html)), '山河仍在。岁月无声。');
  }
  assert.deepEqual(widths, [123, 159, 308]);
});

test('paragraphs commit as a whole quote and a shared illustration is loaded and registered once', async () => {
  let loads = 0;
  const html = source(paragraph('第一句。') + paragraph('第二句。')).replace('</section>', '<blockquote><p>第三句。</p></blockquote></section>');
  const result = await generate(html, { loadIllustration: async () => { loads++; return { width: 900, height: 1400 }; } });
  assert.equal(result.generatedCount, 3); assert.equal(loads, 1);
  assert.equal(result.images.filter(image => image.origin === 'theme').length, 1);
  assert.equal(nodes(result.html, node => node.attribs?.['data-wechat-quote-art']).length, 2);
  const rows = nodes(result.html, node => node.attribs?.['data-wechat-quote-text-column']);
  assert.equal(named(rows[0], 'p').length, 2); assert.equal(named(rows[1], 'p').length, 1);
  const same = await generate(result.html, { images: result.images });
  assert.equal(same.html, result.html); assert.equal(same.images, result.images); assert.deepEqual(same.warnings, []);
});

test('real inlined content:none placeholders are omitted only after every quote paragraph succeeds', async () => {
  const html = source('<span></span>\n<p>引用块。</p>\n<p>里面有<strong>加粗</strong>和<code>keep()</code>。</p>\n<span> \n </span>');
  for (const layoutWidth of [320, 390, 677]) {
    const result = await generate(html, { layoutWidth });
    assert.deepEqual(result.warnings, []); assert.equal(result.generatedCount, 2);
    assert.equal(nodes(result.html, node => node.attribs?.['data-wechat-quote-illustration']).length, 1);
    assert.equal(named(result.html, 'span').length, 0);
    assert.equal(result.images.filter(image => image.generatedKind === 'quote').map(image => image.alt).join(''), '引用块。里面有加粗和keep()。');
    assert.ok(result.images.some(image => image.fallbackHtml?.includes('<strong>加粗</strong>和<code>keep()</code>')));
  }
  const failed = await generate(html, { renderPng: () => { throw new Error('drawing failed'); } });
  assert.equal(failed.html, html); assert.equal(failed.generatedCount, 0);
  const legacy = await generate(html, { quoteImages: { ...rule, illustration: undefined } });
  assert.equal(named(legacy.html, 'span').length, 2);
});

test('nonempty, attributed or nested direct spans remain outside safe illustrated quotes', async () => {
  for (const span of ['<span>原话</span>', '<span style=""></span>', '<span class="art"></span>',
    '<span aria-hidden="true"></span>', '<span><span></span></span>', '<span><img src="app://art.png"></span>']) {
    const html = source(`${span}<p>普通引用。</p>`);
    const result = await generate(html);
    assert.equal(result.html, html); assert.equal(result.generatedCount, 0);
    assert.match(result.warnings[0], /段落之外的行内内容或装饰/);
  }
});

test('missing art, unavailable width, complex semantics or one failing paragraph preserves the entire original quote', async () => {
  const ordinary = source(paragraph('第一句。') + paragraph('第二句。'));
  const variants = [
    [ordinary, { assets: [] }],
    [ordinary, { loadIllustration: async () => { throw new Error('missing png'); } }],
    [ordinary, { loadIllustration: async () => ({ width: 0, height: 5 }) }],
    [ordinary, { layoutWidth: undefined }],
    [source('<p>正常。</p><p><a href="https://example.com">链接</a></p>'), {}],
    [source('<p>正常。</p><ul><li>列表</li></ul>'), {}],
    [source('<span>完整原话</span><p>正常。</p>'), {}],
    [source('<p>[!note] 正常提示。</p>'), {}],
    [ordinary, { renderPng: ({ layout, rule: r }) => { if (layout.lines.join('').includes('第二')) throw new Error('canvas unavailable'); return { bytes: png(layout.width * r.scale, layout.height * r.scale) }; } }],
  ];
  for (const [html, options] of variants) {
    const result = await generate(html, options);
    assert.equal(result.generatedCount, 0); assert.equal(result.html, html); assert.equal(result.images.length, 0);
    assert.ok(result.warnings.length > 0);
  }
});

test('illustration resource reserves one copy slot and leaves all paragraphs intact when the quote cannot fit', async () => {
  const precedingImages = Array.from({ length: DEFAULT_MAX_PROCESSED_RESOURCES - 2 }, (_, index) => ({ url: `app://existing-${index}.png`, origin: 'article' }));
  const html = source(paragraph('第一句。') + paragraph('第二句。')).replace('<blockquote', `${precedingImages.map(image => `<img src="${image.url}">`).join('')}<blockquote`);
  const result = await generate(html, { images: precedingImages });
  assert.equal(result.html, html); assert.equal(result.images, precedingImages); assert.equal(result.generatedCount, 0);
  assert.match(result.warnings.join(' '), /剩余安全额度/);
});

test('copy/export resolve the illustration record and preserve quote HTML when generated text falls back', async () => {
  const result = await generate(source(paragraph('山河<strong>仍在</strong>。')));
  const artBytes = png(90, 140); let clipboard;
  const io = { resolveFile: () => ({ extension: 'png' }), readBinary: async () => artBytes,
    transformImage: async bytes => ({ bytes, mimeType: 'image/png' }) };
  const copied = await copyRenderedArticle({ html: result.html, images: result.images, text: '山河仍在。', embedImages: true,
    ...io, _clipboard: { write(value) { clipboard = value; } } });
  assert.equal(copied.stats.quoteImages.embedded, 1);
  assert.ok(copied.stats.themeImages.remote + copied.stats.themeImages.embedded >= 1);
  assert.equal(nodes(clipboard.html, node => node.attribs?.['data-wechat-quote-art']).length, 1);
  const exported = await embedImagesForExport({ html: result.html, images: result.images, ...io });
  assert.match(exported.html, /data:image\/png;base64/); assert.doesNotMatch(exported.html, /app:\/\/temple/);
  const fallback = await copyRenderedArticle({ html: result.html, images: result.images, text: '山河仍在。', embedImages: true,
    maxSingleImageBytes: 1, ...io, _clipboard: { write(value) { clipboard = value; } } });
  assert.equal(fallback.stats.quoteImages.textFallbacks, 1);
  assert.match(clipboard.html, /山河<strong>仍在<\/strong>。/);
  assert.equal(nodes(clipboard.html, node => node.attribs?.['data-wechat-quote-text-column']).length, 1);
});

test('heading runtime passes resolved assets to the quote illustration loader without ordered-list regression', async () => {
  const canvas = { width: 0, height: 0 };
  const context = { clearRect() {}, scale() {}, fillText() {},
    measureText() { return { width: 18, actualBoundingBoxAscent: 14, actualBoundingBoxDescent: 4 }; },
    getImageData() { return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }; } };
  canvas.getContext = () => context;
  const document = { createElement: () => canvas };
  const runtime = new HeadingImageRuntime({ document }); let loaded;
  runtime.loadFont = async () => ({ runtimeFamily: 'classic', hash: 'classic', weight: 400, style: 'normal', document,
    coverage: new Set([...'山河。'].map(c => c.codePointAt(0))), coverageHash: 'classic' });
  runtime.loadNumberAsset = async value => { loaded = value; return { width: 900, height: 1400 }; };
  const result = await runtime.materialize({ html: source(paragraph('山河。')), images: [], themeId: 'quote-layout',
    headingImages: [], fonts: [{ id: 'classic' }], assets: [asset], quoteImages: rule, layoutWidth: 320 });
  assert.equal(loaded, asset); assert.equal(result.quoteGeneratedCount, 1);
  assert.deepEqual(result.warnings, []); assert.equal(result.images.find(image => image.origin === 'theme').url, asset.url);
});
