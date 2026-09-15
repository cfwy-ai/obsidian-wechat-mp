import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { parseDocument } from 'htmlparser2';
import { parseThemeManifest as parseManifestSource } from '../src/theme-package.mjs';
import { materializeQuoteImages, layoutQuoteLines, quoteParagraphWidth } from '../plugin/quote-image.mjs';
import { HeadingImageLruCache, renderHeadingPng, segmentGraphemes, verifyGeneratedHeadingPng } from '../plugin/heading-image.mjs';
import { parseFontCoverage, withCoveredFontFallbacks } from '../plugin/font-coverage.mjs';
import { copyRenderedArticle, formatCopyResultNotice } from '../plugin/copy.mjs';
import { materializeIllustratedSurfaces } from '../src/illustrated-surfaces.mjs';
import { embedImagesForExport } from '../plugin/export-image.mjs';
import { extractQuoteRichText, layoutQuoteRichText, makeQuoteRichMeasurer, renderQuoteRichPng, sliceQuoteRichHtml } from '../plugin/quote-rich-text.mjs';

const rule = { fontId: 'primary', fallbackFontIds: ['backup'], fontSize: 18, lineHeight: 1.85, letterSpacing: 0, color: '#59432C', maxWidth: 640, fallbackWidth: 185, scale: 3 };
const parseThemeManifest = (value) => parseManifestSource(JSON.stringify(value));
const wrap = (body) => `<section id="nice" style="padding:22px 20px 34px;font-size:16px"><blockquote style="padding:10px 5px 12px 90px">${body}</blockquote></section>`;
const tags = (html, name) => { const result = []; const walk = (node) => { if (node.name === name) result.push(node); for (const child of node.children ?? []) walk(child); }; walk(parseDocument(html)); return result; };
const textOf = (node) => node.type === 'text' ? node.data : (node.children ?? []).map(textOf).join('');
const png = (width, height) => PNG.sync.write({ width, height, data: Buffer.alloc(width * height * 4) }, { colorType: 6, inputColorType: 6 });
const makeFont = (text, family) => ({ runtimeFamily: family, hash: family, coverageHash: family + '-coverage', coverage: new Set([...text, ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32))].map((character) => character.codePointAt(0))), weight: 400, style: 'normal', document: { createElement: () => ({ getContext: () => ({}) }) } });

async function generate(html, options = {}) {
  const primary = makeFont(options.primaryCoverage ?? html, 'cfwx-primary');
  const backup = makeFont(options.backupCoverage ?? html, 'cfwx-backup');
  return materializeQuoteImages({ html, images: [], themeId: 'crayon', quoteImages: rule, fonts: [{ id: 'primary' }, { id: 'backup' }], layoutWidth: 320, loadFont: async (font) => font.id === 'primary' ? primary : backup, cache: new HeadingImageLruCache(), measureFactory: () => (g) => /[\u0000-\u007f]/.test(g) ? 8 : 18, renderPng: ({ layout, rule: r }) => ({ bytes: png(layout.width * r.scale, layout.height * r.scale) }), verifyPng: verifyGeneratedHeadingPng, segmentGraphemes, ...options });
}

test('quote_images is explicit opt-in; absent rule keeps references and performs no font work', async () => {
  const html = wrap('<p>正常引用</p>'); const images = [{ url: 'original' }];
  const result = await materializeQuoteImages({ html, images, loadFont: () => { throw new Error('should not load'); } });
  assert.equal(result.html, html); assert.equal(result.images, images); assert.equal(result.generatedCount, 0);
});

test('illustrated quote marker remains decorative and does not disable handwriting generation', async () => {
  const url = 'app://theme/quote.png';
  const image = { target:'quote', url, filePath:'theme/quote.png', origin:'theme' };
  const source = wrap(`<span style="display:block;width:20px;height:18px;background-image:url('${url}')"></span><p>金句保留<strong>强调</strong>。</p>`);
  const protectedResult = materializeIllustratedSurfaces(source, { policy:{strategy:'preserve-illustrated-surfaces'}, backgroundImages:[image] });
  const result = await generate(protectedResult.html, { images:protectedResult.images, primaryCoverage:"金句保留强调。" });
  assert.equal(result.generatedCount, 1, JSON.stringify(result.warnings));
  assert.deepEqual(result.warnings, []);
  assert.equal(tags(result.html, 'img').filter(node=>node.attribs.src === url).length, 1);
  assert.equal(tags(result.html, 'img').find(node=>node.attribs['data-wechat-generated-quote'])?.attribs.alt, '金句保留强调。');
});

test('manifest validates quote rule, fallback IDs and safe coverage paths without changing old metadata shape', () => {
  const base = { schema_version: 3, theme_id: 'test-quote', name: '测试主题', assets: [], components: [], fonts: ['primary', 'backup'].map((id) => ({ font_id: id, file: `配套字体资源/${id}.woff2`, family: id, sha256: 'a'.repeat(64), coverage_file: `配套字体资源/${id}.json` })) };
  assert.equal(Object.hasOwn(parseThemeManifest(base), 'quoteImages'), false);
  const active = { ...base, quote_images: { font_id: 'primary', fallback_font_ids: ['backup'], max_width: 640, fallback_width: 185 }, heading_images: [{ font_id: 'primary', heading_image_id: 'heading', fallback_font_ids: ['backup'] }] };
  const parsed = parseThemeManifest(active);
  assert.equal(parsed.quoteImages.fallbackWidth, 185); assert.equal(parsed.fonts[0].coverageFile, '配套字体资源/primary.json');
  assert.deepEqual(parsed.headingImages[0].fallbackFontIds, ['backup']);
  assert.throws(() => parseThemeManifest({ ...active, quote_images: { font_id: 'primary', fallback_font_ids: ['missing'] } }), /备用字体/);
  assert.throws(() => parseThemeManifest({ ...active, quote_images: { font_id: 'primary', unknown: true } }), /不支持字段/);
  const replaced = parseThemeManifest({ ...active, quote_images: { ...active.quote_images, replace_native_container: true } });
  assert.equal(replaced.quoteImages.replaceNativeContainer, true);
  assert.throws(() => parseThemeManifest({ ...active, quote_images: { ...active.quote_images, replace_native_container: 'true' } }), /布尔/);
  assert.throws(() => parseThemeManifest({ ...base, fonts: [{ ...base.fonts[0], coverage_file: '../outside.json' }] }), /路径|目录|越出/);
});

test('显式开启时在金句图片生成后替换原生引用外壳，保留文字图片', async () => {
  const result = await generate(wrap('<p>引用图片必须保留。</p>'), { quoteImages:{...rule,replaceNativeContainer:true} });
  assert.equal(result.generatedCount,1);assert.deepEqual(result.warnings,[]);
  assert.equal(tags(result.html,'blockquote').length,0);
  assert.equal(tags(result.html,'section').filter(node=>node.attribs['data-wechat-quote-container']==='true').length,1);
  assert.equal(tags(result.html,'img').filter(node=>node.attribs['data-wechat-generated-quote']==='true').length,1);
});

test('only paragraph interiors change; decorations, inline content and manual br remain semantically complete', async () => {
  const html = wrap('<span class="tree" style="height:12px"></span><p class="first"><strong>留一点甜</strong><br><em>慢慢来</em>，<code>keep()</code> <span>补充文字</span></p><p>第二段。</p><span class="leaf"></span>');
  const result = await generate(html);
  assert.equal(result.warnings.length, 0); assert.equal(result.generatedCount, 2);
  assert.match(result.html, /<span class="tree" style="height:12px"><\/span><p class="first">/);
  assert.match(result.html, /<span class="leaf"><\/span>/);
  assert.equal(tags(result.html, 'img').map((image) => image.attribs.alt).join(''), '留一点甜\n慢慢来，keep() 补充文字第二段。');
  assert.equal(result.images.every((image) => image.origin === 'generated' && image.generatedKind === 'quote' && image.bytes && image.fallbackHtml), true);
  assert.equal(tags(result.html, 'img')[0].attribs.width, '185');
});

test('dynamic width follows inline padding at 320/390/677, while unknown layout uses safe width', async () => {
  const html = wrap('<p>同一段金句在不同页面宽度中重新换行，不能缩小字号来适配。</p>');
  const widths = [];
  for (const layoutWidth of [320, 390, 677, undefined]) {
    const result = await generate(html, { layoutWidth });
    widths.push(Number(tags(result.html, 'img')[0].attribs.width));
    assert.equal(result.warnings.length, 0);
  }
  assert.deepEqual(widths, [185, 255, 542, 185]);
});

test('known dark-mode quote surface is traversed, nested content falls back as a complete quote', async () => {
  const safe = '<section id="nice"><blockquote><section data-wechat-darkmode-surface="quote"><span class="quote-mark"></span><p>可读金句</p></section></blockquote></section>';
  assert.equal((await generate(safe)).generatedCount, 1);
  for (const body of ['<p>外层</p><blockquote><p>内层</p></blockquote>', '<p>外层</p><ul><li>列表内容</li></ul>']) {
    const html = wrap(body); const result = await generate(html);
    assert.equal(result.html, html); assert.equal(result.generatedCount, 0); assert.match(result.warnings[0], /嵌套块/);
  }
});

test('reference only extends quotes to direct marked scene children and measures margin plus percentage width correctly', async () => {
  const referenceComposition = { strategy: 'opening-feature', designWidth: 390 };
  for (const width of [390, 780]) {
    const html = `<section id="nice"><section data-wechat-scene="feature"><blockquote style="width:50%;margin-left:40%"><p>选择开始。</p></blockquote></section><section><blockquote><p>普通容器保留。</p></blockquote></section></section>`;
    const drawn = [];
    const result = await generate(html, { layoutWidth: width, referenceComposition,
      quoteImages: { ...rule, fontSize: 28 },
      renderPng: ({ layout, rule: r }) => { drawn.push({ layout, rule: r }); return { bytes: png(layout.width * r.scale, layout.height * r.scale) }; },
    });
    assert.deepEqual(result.warnings, []);
    assert.equal(result.generatedCount, 1);
    assert.equal(drawn[0].layout.width, width / 2);
    assert.equal(drawn[0].rule.fontSize, 28 * width / 390);
    assert.equal(drawn[0].rule.paddingX, 0);
    assert.match(result.html, /<p>普通容器保留。<\/p>/);
    const legacy = await generate(html, { layoutWidth: width });
    assert.equal(legacy.generatedCount, 0); assert.equal(legacy.html, html);
  }
  const nested = '<section id="nice"><section data-wechat-scene="feature"><blockquote><p>外层。</p><blockquote><p>内层。</p></blockquote></blockquote></section></section>';
  const result = await generate(nested, { layoutWidth: 390, referenceComposition });
  assert.equal(result.html, nested); assert.equal(result.generatedCount, 0);
  assert.match(result.warnings[0], /嵌套块/);
});

test('image paragraphs and callouts remain live instead of swallowing unsupported content', async () => {
  for (const body of ['<p>正文<img src="local.png" alt="照片"></p>', '<p>[!note] 提示文字</p>', '<p>x<sup>2</sup> 与 <del>旧价格</del></p>', '<p>访问<a href="https://example.com">链接文字</a></p>']) {
    const html = wrap(body); const result = await generate(html);
    assert.equal(result.html, html); assert.equal(result.images.length, 0); assert.equal(result.warnings.length, 1);
  }
});

test('quote width subtracts shorthand borders as well as four-value border widths', () => {
  const dom = parseDocument('<section style="padding:0 18px"><blockquote style="padding:20px;border-left:30px solid orange"><p></p></blockquote></section>');
  const root = dom.children[0]; const quote = root.children[0]; const paragraph = quote.children[0];
  assert.equal(quoteParagraphWidth([root, quote, paragraph], rule, 320), 214);
  quote.attribs.style = 'padding:20px;border-width:1px 12px 3px 8px';
  assert.equal(quoteParagraphWidth([root, quote, paragraph], rule, 320), 224);
});

test('quote generation reserves existing image resources and keeps the final paragraph live before copy safety limit', async () => {
  const originalBytes = png(1, 1); const originalUrl = 'data:image/png;base64,' + originalBytes.toString('base64');
  const html = wrap('<p>甲乙</p>'.repeat(128)).replace('</section>', `<img src="${originalUrl}"></section>`);
  const result = await generate(html, { images: [{ url: originalUrl, origin: 'article', bytes: originalBytes, mimeType: 'image/png', target: 'original.png' }] });
  assert.equal(result.generatedCount, 127); assert.equal(tags(result.html, 'p').at(-1).children[0].data, '甲乙');
  assert.match(result.warnings[0], /安全额度/);
  const copied = await copyRenderedArticle({ html: result.html, images: result.images, text: '甲乙'.repeat(128), embedImages: true, _clipboard: { write() {} } });
  assert.equal(copied.stats.quoteImages.total, 127);
});

test('stale metadata is not charged against the quote resource budget', async () => {
  const stale = Array.from({ length: 128 }, (_, i) => ({ url: `app://unused-${i}.png`, origin: 'theme' }));
  const result = await generate(wrap('<p>可读文字</p>'), { images: stale });
  assert.equal(result.generatedCount, 1); assert.equal(result.warnings.length, 0);
});

test('long paragraphs use bounded chunks and linear layout, preserving all raw text', async () => {
  const content = '生活不是赶路，是让每一个普通的日子都有一点颜色。'.repeat(8);
  const result = await generate(wrap(`<p>${content}</p>`));
  assert.ok(result.generatedCount > 2);
  assert.equal(result.images.map((image) => image.alt).join(''), content);
  for (const image of tags(result.html, 'img')) assert.ok(Number(image.attribs.height) <= 136);
  let calls = 0;
  const lines = layoutQuoteLines('甲'.repeat(1000), { maxWidth: 181, fontSize: 18, letterSpacing: 0, measureGrapheme: () => { calls += 1; return 18; }, segmentGraphemes });
  assert.equal(lines.map((line) => line.raw).join(''), '甲'.repeat(1000));
  assert.ok(calls <= 2000);
});

test('a later PNG failure keeps the entire paragraph and commits no partial image metadata', async () => {
  const html = wrap(`<p>${'测试长金句。'.repeat(20)}</p>`); let renders = 0;
  const result = await generate(html, { renderPng: ({ layout, rule: r }) => { renders += 1; if (renders === 2) throw new Error('canvas unavailable'); return { bytes: png(layout.width * r.scale, layout.height * r.scale) }; } });
  assert.equal(result.html, html); assert.equal(result.images.length, 0); assert.match(result.warnings[0], /保留完整活文字/);
});

test('registered fallback handles a missing primary glyph; missing in both fonts returns the intact paragraph', async () => {
  const html = wrap('<p>甲乙</p>');
  const supported = await generate(html, { primaryCoverage: '甲', backupCoverage: '乙' });
  assert.equal(supported.generatedCount, 1); assert.equal(supported.warnings.length, 0);
  const missing = await generate(html, { primaryCoverage: '甲', backupCoverage: '甲' });
  assert.equal(missing.html, html); assert.match(missing.warnings[0], /均不支持字形「乙」/);
});

test('inline code spaces and ampersands are preserved in quote image alt and copy fallback', async () => {
  const result = await generate(wrap('<p>代码 <code>a  &amp;  b</code> 结束</p>'));
  assert.equal(result.images.map((image) => image.alt).join(''), '代码 a  &  b 结束');
  assert.match(result.images[0].fallbackHtml, /a  &amp;  b/);
});

test('coverage validation and glyph selection are strict; primary Latin uses the runtime alias', () => {
  assert.throws(() => parseFontCoverage('[55296]'), /码点/);
  assert.throws(() => parseFontCoverage('["甲"]'), /码点/);
  const selected = withCoveredFontFallbacks(makeFont('甲A', 'cfwx-wenxin'), [makeFont('乙', 'cfwx-backup')], '甲乙A');
  assert.equal(selected.familyForGrapheme('甲'), '"cfwx-wenxin"');
  assert.equal(selected.familyForGrapheme('乙'), '"cfwx-backup"');
  assert.equal(selected.familyForGrapheme('A'), '"cfwx-wenxin"');
  assert.throws(() => withCoveredFontFallbacks({ runtimeFamily: 'missing' }, [], '甲'), /覆盖表/);
});

test('drawing really uses the chosen glyph font, including Latin, rather than the raw manifest family', () => {
  const draws = [];
  const canvas = { width: 0, height: 0 };
  const context = { clearRect() {}, scale() {}, measureText() { return { width: 18, actualBoundingBoxAscent: 14, actualBoundingBoxDescent: 4 }; }, fillText(g) { draws.push([g, this.font]); }, getImageData() { return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }; } };
  canvas.getContext = () => context;
  const font = withCoveredFontFallbacks(makeFont('甲A', 'cfwx-wenxin'), [makeFont('乙', 'cfwx-backup')], '甲乙A');
  renderHeadingPng({ layout: { width: 100, height: 36, lines: ['甲乙A'], lineHeightPx: 33.3 }, rule: { ...rule, paddingX: 2, paddingY: 1, align: 'left', latinFontFamily: 'Uninstalled Name' }, font, document: { createElement: () => canvas } });
  assert.match(draws[0][1], /cfwx-wenxin/); assert.match(draws[1][1], /cfwx-backup/); assert.match(draws[2][1], /cfwx-wenxin/);
});

test('identical-looking paragraphs keep distinct fallbacks when copy hits its image budget', async () => {
  const html = wrap('<p class="a"><strong>同一句</strong></p><p class="b"><em>同一句</em></p>');
  const result = await generate(html);
  assert.notEqual(result.images[0].url, result.images[1].url);
  let clipboard;
  const copied = await copyRenderedArticle({ html: result.html, images: result.images, text: '同一句同一句', embedImages: true, maxSingleImageBytes: 1, _clipboard: { write(value) { clipboard = value; } } });
  assert.equal(tags(clipboard.html, 'p').length, 2);
  assert.match(clipboard.html, /<strong>同一句<\/strong>/); assert.match(clipboard.html, /<em>同一句<\/em>/);
  assert.equal(copied.stats.headingImages.total, 0); assert.equal(copied.stats.quoteImages.textFallbacks, 2);
  assert.match(formatCopyResultNotice(copied), /金句.*恢复活文字/);
  assert.doesNotMatch(clipboard.html, /data:image|<p[^>]*>\s*<p/);
});

test('generated quote metadata travels through normal copy and export without file resolution', async () => {
  const result = await generate(wrap('<p>愿你天天有一点甜。</p>'));
  let clipboard;
  const copied = await copyRenderedArticle({ html: result.html, images: result.images, text: '愿你天天有一点甜。', embedImages: true, resolveFile: () => { throw new Error('generated images are in memory'); }, _clipboard: { write(value) { clipboard = value; } } });
  assert.equal(copied.stats.quoteImages.embedded, 1); assert.match(clipboard.html, /data:image\/png;base64/);
  const exported = await embedImagesForExport({ html: result.html, images: result.images, resolveFile: () => { throw new Error('should not resolve'); }, transformImage: async (bytes) => ({ bytes, mimeType: 'image/png' }) });
  assert.equal(exported.embeddedCount, 1); assert.equal(exported.warnings.length, 0);
});

const codeStyle = 'font-size:0.88em;font-family:Menlo,Consolas,monospace;padding:1px 4px;border:2px solid #E59A32;background-color:#FFE5A4;color:#A74C13';
const richParagraph = (body) => tags(`<p style="font-size:18px;line-height:1.85;color:#59432C">${body}</p>`, 'p')[0];
const richMeasure = (grapheme, style) => ({ width: style.code ? 8 : 18, ascent: style.fontSize * .8, descent: style.fontSize * .2, font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${style.code ? style.fontFamily : 'cfwx-wenxin'}` });

test('rich extraction resolves strong/code nested inheritance, 0.88em and box dimensions from inline CSS', () => {
  const rich = extractQuoteRichText(richParagraph(`<strong style="font-weight:700;color:#A74C13">强调<code style="${codeStyle}">a  &amp; b</code></strong><br>继续`), rule);
  assert.equal(rich.text, '强调a  & b\n继续');
  const strong = rich.runs.find((run) => run.text === '强调');
  const code = rich.runs.find((run) => run.style.code);
  assert.equal(strong.style.fontWeight, 700); assert.equal(strong.style.color, '#A74C13');
  assert.equal(code.style.fontWeight, 700); assert.ok(Math.abs(code.style.fontSize - 15.84) < .001);
  assert.match(code.style.fontFamily, /Menlo/); assert.deepEqual(code.box.padding, [1, 4, 1, 4]);
  assert.equal(code.box.borders.every((border) => border.width === 2 && border.color === '#E59A32'), true);
  assert.equal(code.box.background, '#FFE5A4');
});

test('short code is atomic at exact-fit and one-pixel-short boundaries; long code redraws each fragment frame', () => {
  const rich = extractQuoteRichText(richParagraph(`甲甲<code style="${codeStyle}">abc</code>`), rule);
  const fit = layoutQuoteRichText(rich, { maxWidth: 72, rule, measure: richMeasure, segmentGraphemes });
  assert.equal(fit.length, 1); assert.equal(fit[0].width, 72);
  const wrapLines = layoutQuoteRichText(rich, { maxWidth: 71, rule, measure: richMeasure, segmentGraphemes });
  assert.equal(wrapLines.length, 2); assert.equal(wrapLines[1].fragments.length, 1);
  assert.equal(wrapLines[1].fragments[0].atoms.map((atom) => atom.text).join(''), 'abc');
  const long = extractQuoteRichText(richParagraph(`<code style="${codeStyle}">${'abcdefgh'.repeat(10)}</code>`), rule);
  const split = layoutQuoteRichText(long, { maxWidth: 70, rule, measure: richMeasure, segmentGraphemes });
  assert.ok(split.length > 4); assert.equal(split.map((line) => line.raw).join(''), long.text);
  assert.equal(split.every((line) => line.width <= 70 && line.fragments.every((fragment) => fragment.box?.borders.every((border) => border.width === 2))), true);
});

test('closing-punctuation carry never moves a large styled glyph into an over-wide line', () => {
  const rich = extractQuoteRichText(richParagraph('甲<span style="font-size:60px">乙，</span>'), rule);
  const measure = (grapheme, style) => ({ width: style.fontSize, ascent: style.fontSize * .8, descent: style.fontSize * .2, font: 'test' });
  const lines = layoutQuoteRichText(rich, { maxWidth: 100, rule, measure, segmentGraphemes });
  assert.equal(lines.map((line) => line.raw).join(''), '甲乙，');
  assert.ok(lines.every((line) => line.width <= 100));
  assert.deepEqual(lines.map((line) => line.width), [78, 60]);
});

test('a complete inline code box carries its closing punctuation to the next line when the pair fits', () => {
  for (const punctuation of ['。', '，', '）', '」']) {
    const rich = extractQuoteRichText(richParagraph(`甲甲<code style="${codeStyle}">abc</code>${punctuation}`), rule);
    const lines = layoutQuoteRichText(rich, { maxWidth: 80, rule, measure: richMeasure, segmentGraphemes });
    assert.deepEqual(lines.map(line => line.text), ['甲甲', `abc${punctuation}`]);
    assert.equal(lines.map(line => line.raw).join(''), rich.text);
    assert.ok(lines.every(line => line.width <= 80));
    assert.equal(lines[1].fragments[0].box, rich.runs.find(run => run.style.code).box);
    assert.equal(lines[1].fragments[0].width, 36);
  }
  const exact = extractQuoteRichText(richParagraph(`甲<code style="${codeStyle}">abc</code>。`), rule);
  const fits = layoutQuoteRichText(exact, { maxWidth: 54, rule, measure: richMeasure, segmentGraphemes });
  assert.deepEqual(fits.map(line => line.text), ['甲', 'abc。']);
  assert.equal(fits[1].width, 54);
  const tooNarrow = layoutQuoteRichText(exact, { maxWidth: 53, rule, measure: richMeasure, segmentGraphemes });
  assert.equal(tooNarrow.map(line => line.raw).join(''), exact.text);
  assert.ok(tooNarrow.every(line => line.width <= 53));
});

test('rich renderer measures and paints real style runs: Wenxin bold, monospace code, fill and orange frame', () => {
  const calls = []; const canvas = { width: 0, height: 0 };
  const context = {
    clearRect() {}, scale() {},
    measureText(text) { const size = Number(/ ([0-9.]+)px/.exec(this.font)?.[1] ?? 18); return { width: text.length * size * .5, actualBoundingBoxAscent: size * .8, actualBoundingBoxDescent: size * .2 }; },
    fillText(text, x, y) { calls.push({ kind: 'text', text, x, y, font: this.font, color: this.fillStyle }); },
    fillRect(x, y, width, height) { calls.push({ kind: 'fill', x, y, width, height, color: this.fillStyle }); },
    strokeRect(x, y, width, height) { calls.push({ kind: 'border', x, y, width, height, color: this.strokeStyle, thickness: this.lineWidth }); },
    getImageData() { return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }; },
  };
  canvas.getContext = () => context;
  const font = withCoveredFontFallbacks(makeFont('字A', 'cfwx-wenxin'), [], '字A');
  const factory = (ctx, typography) => (g) => { ctx.font = `${typography.fontStyle} ${typography.fontWeight} ${typography.fontSize}px ${typography.familyForGrapheme(g)}`; return ctx.measureText(g).width; };
  const measure = makeQuoteRichMeasurer(context, font, factory);
  const rich = extractQuoteRichText(richParagraph(`字<strong style="color:#A74C13;font-weight:700">字</strong><code style="${codeStyle}">A</code>`), rule);
  const lines = layoutQuoteRichText(rich, { maxWidth: 181, rule, measure, segmentGraphemes });
  const layout = { width: 185, height: Math.ceil(lines.reduce((sum, line) => sum + line.height, 0) + 2), richLines: lines };
  renderQuoteRichPng({ layout, rule: { ...rule, paddingX: 2, paddingY: 1 }, document: { createElement: () => canvas } });
  const textCalls = calls.filter((call) => call.kind === 'text');
  assert.match(textCalls[0].font, /400 18px.*cfwx-wenxin/); assert.equal(textCalls[0].color, '#59432C');
  assert.match(textCalls[1].font, /700 18px.*cfwx-wenxin/); assert.equal(textCalls[1].color, '#A74C13');
  assert.match(textCalls[2].font, /15\.84px Menlo,Consolas,monospace/);
  assert.ok(calls.some((call) => call.kind === 'fill' && call.color === '#FFE5A4'));
  assert.ok(calls.some((call) => call.kind === 'border' && call.color === '#E59A32' && call.thickness === 2));
  assert.ok(lines[0].height >= 35.3);
});

test('styled cache invalidates on a color or border change, but reuses an identical styled render', async () => {
  const cache = new HeadingImageLruCache(); let count = 0;
  const renderPng = ({ layout, rule: r }) => { count += 1; return { bytes: png(layout.width * r.scale, layout.height * r.scale) }; };
  const first = wrap('<p><strong style="color:#A74C13;font-weight:700">同一句</strong></p>');
  const second = first.replace('#A74C13', '#59432C');
  await generate(first, { cache, renderPng }); await generate(second, { cache, renderPng }); await generate(second, { cache, renderPng });
  assert.equal(count, 2);
  const third = wrap(`<p><code style="${codeStyle}">same</code></p>`);
  await generate(third, { cache, renderPng }); await generate(third.replace('2px solid', '3px solid'), { cache, renderPng });
  assert.equal(count, 4);
});

test('rich slices close and reopen strong/code across PNG boundaries, preserving entities, spaces and br', () => {
  const rich = extractQuoteRichText(richParagraph(`<strong style="color:#A74C13">开头<code style="${codeStyle}">ab  &amp; &lt;cd&gt;🟡efghijklmnop</code>结尾</strong><br>下一行`), rule);
  const lines = layoutQuoteRichText(rich, { maxWidth: 70, rule, measure: richMeasure, segmentGraphemes });
  const slices = [];
  for (let at = 0; at < lines.length; at += 4) {
    const group = lines.slice(at, at + 4);
    const slice = sliceQuoteRichHtml(rich.tree, group[0].start, group.at(-1).end);
    slices.push(slice);
    assert.equal((slice.match(/<strong\b/g) ?? []).length, (slice.match(/<\/strong>/g) ?? []).length);
    assert.equal((slice.match(/<code\b/g) ?? []).length, (slice.match(/<\/code>/g) ?? []).length);
  }
  const contents = (node) => node.name === 'br' ? '\n' : node.type === 'text' ? node.data : (node.children ?? []).map(contents).join('');
  assert.equal(contents(parseDocument(slices.join(''))), rich.text);
  assert.match(slices.join(''), /ab  &amp; &lt;cd&gt;/);
});

test('first, middle, last and full image fallback retain rich markup without leaking styles over adjacent PNGs', async () => {
  const content = 'code  & value '.repeat(24);
  const source = wrap(`<p><strong style="color:#A74C13;font-weight:700">开始<code style="${codeStyle}">${content.replace(/&/g, '&amp;')}</code>结束</strong></p>`);
  const result = await generate(source); assert.ok(result.images.length >= 3);
  assert.equal(result.images.map((image) => image.alt).join(''), '开始' + content + '结束');
  let clipboard;
  const flattened = (node) => node.name === 'img' ? node.attribs.alt ?? '' : node.name === 'br' ? '\n' : node.type === 'text' ? node.data : (node.children ?? []).map(flattened).join('');
  const containsImage = (node) => node.name === 'img' || (node.children ?? []).some(containsImage);
  for (const failingIndex of [0, Math.floor(result.images.length / 2), result.images.length - 1]) {
    const images = result.images.map((image, index) => index === failingIndex ? { ...image, bytes: Buffer.alloc(1024 * 1024 + 1) } : image);
    const copied = await copyRenderedArticle({ html: result.html, images, text: '开始' + content + '结束', embedImages: true, _clipboard: { write(value) { clipboard = value; } } });
    assert.equal(copied.stats.quoteImages.textFallbacks, 1);
    assert.ok(tags(clipboard.html, 'code').length > 0); assert.ok(tags(clipboard.html, 'strong').length > 0);
    assert.equal(tags(clipboard.html, 'strong').some(containsImage), false);
    assert.equal(flattened(tags(clipboard.html, 'p')[0]), '开始' + content + '结束');
  }
  const all = await copyRenderedArticle({ html: result.html, images: result.images, text: '开始' + content + '结束', embedImages: true, maxSingleImageBytes: 1, _clipboard: { write(value) { clipboard = value; } } });
  assert.equal(all.stats.quoteImages.textFallbacks, result.images.length);
  assert.equal(flattened(tags(clipboard.html, 'p')[0]), '开始' + content + '结束');
  assert.equal(tags(clipboard.html, 'img').length, 0); assert.ok(tags(clipboard.html, 'code').every((node) => node.attribs.style.includes('2px solid #E59A32')));
});

test('ordinary em/mark/underline preserve their decoration while image underlines explicitly retain live HTML', async () => {
  const rich = extractQuoteRichText(richParagraph('<em style="font-style:normal;font-weight:600">强调</em><mark style="background-color:#FFD777;padding:1px 3px">重点</mark><u>下划线</u>'), rule);
  assert.equal(rich.runs[0].style.fontStyle, 'normal'); assert.equal(rich.runs[0].style.fontWeight, 600);
  assert.equal(rich.runs[1].box.background, '#FFD777'); assert.equal(rich.runs[2].style.underline, true);
  const html = wrap('<p><strong>保留</strong><u style="background-image:url(\'app://brush.png\')">图片下划线</u></p>');
  const result = await generate(html); assert.equal(result.html, html); assert.equal(result.generatedCount, 0); assert.match(result.warnings[0], /行内图片装饰/);
});
