import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { parseDocument } from 'htmlparser2';
import { parseThemeManifest } from '../src/theme-package.mjs';
import { materializeQuoteImages } from '../plugin/quote-image.mjs';
import { extractQuoteRichText, layoutQuoteRichText, makeQuoteRichMeasurer, renderQuoteRichPng } from '../plugin/quote-rich-text.mjs';
import { withCoveredFontFallbacks } from '../plugin/font-coverage.mjs';
import { HeadingImageLruCache, segmentGraphemes, verifyGeneratedHeadingPng } from '../plugin/heading-image.mjs';
import { copyRenderedArticle } from '../plugin/copy.mjs';

const raw = { font_id: 'primary', fallback_font_ids: ['backup'], font_size: 20, color: '#80602F', line_height: 1.8,
  inline_code_font: 'quote', responsive_typography: { min_width: 390, max_width: 677, max_font_size: 30 } };
const manifest = quoteRule => JSON.stringify({ schema_version: 3, theme_id: 'code-font', name: '代码字形', components: [], assets: [],
  fonts: ['primary', 'backup'].map(id => ({ font_id: id, family: id, file: `配套字体资源/${id}.woff2`, sha256: 'a'.repeat(64) })), quote_images: quoteRule });
const rule = parseThemeManifest(manifest(raw)).quoteImages;
const font = (characters, runtimeFamily) => ({ runtimeFamily, hash: runtimeFamily, coverageHash: runtimeFamily,
  weight: 400, style: 'normal', coverage: new Set([...characters].map(c => c.codePointAt(0))),
  document: { createElement: () => ({ getContext: () => ({}) }) } });
const png = (width, height) => PNG.sync.write({ width, height, data: Buffer.alloc(width * height * 4) }, { colorType: 6, inputColorType: 6 });
const paragraph = html => parseDocument(`<p style="font-size:20px;color:#80602F">${html}</p>`).children[0];
const wrap = html => `<section id="nice" style="padding:20px"><blockquote><p style="font-size:20px;line-height:1.8;color:#80602F">${html}</p></blockquote></section>`;

test('inline_code_font accepts explicit quote only and adds no field to legacy rules', () => {
  assert.equal(rule.inlineCodeFont, 'quote');
  const legacy = parseThemeManifest(manifest({ ...raw, inline_code_font: undefined })).quoteImages;
  assert.equal(Object.hasOwn(legacy, 'inlineCodeFont'), false);
  for (const value of [null, '', 'inherit', 'monospace', true, {}]) {
    assert.throws(() => parseThemeManifest(manifest({ ...raw, inline_code_font: value })), /inline_code_font 只支持 quote/);
  }
});

test('quote-font code preserves spaces and code ranges while measuring/drawing the exact covered quote family', () => {
  const rich = extractQuoteRichText(paragraph('甲<strong style="font-weight:800;color:#923E32"><code style="font-family:inherit;font-size:1em;padding:0;border:none;background-color:transparent;text-decoration:underline">A  &amp; 乙</code></strong>'), rule);
  assert.equal(rich.text, '甲A  & 乙');
  const code = rich.runs.find(run => run.style.code);
  assert.equal(code.style.codeFont, 'quote'); assert.equal(code.style.fontWeight, 800); assert.equal(code.style.color, '#923E32');
  assert.equal(code.style.underline, true); assert.equal(code.box.keepTogether, true);
  const selected = withCoveredFontFallbacks(font('甲 ', 'quote-primary'), [font('A&乙', 'quote-backup')], rich.text);
  const operations = []; const measuredSamples = []; const canvas = { width: 0, height: 0 };
  const context = {
    clearRect() {}, scale() {},
    measureText(value) { measuredSamples.push(value); return { width: 20, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4 }; },
    fillText(text, x, y) { operations.push({ kind: 'text', text, font: this.font, color: this.fillStyle, x, y }); },
    fillRect(...values) { operations.push({ kind: 'underline', values, color: this.fillStyle }); },
    getImageData() { return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }; },
  };
  canvas.getContext = () => context;
  const families = [];
  const measure = makeQuoteRichMeasurer(context, selected, (ctx, typography) => grapheme => {
    families.push([grapheme, typography.familyForGrapheme(grapheme)]); return typography.fontSize;
  });
  const lines = layoutQuoteRichText(rich, { maxWidth: 220, rule, measure, segmentGraphemes });
  const height = Math.ceil(lines.reduce((sum, line) => sum + line.height, 0) + 4);
  renderQuoteRichPng({ layout: { width: 224, height, richLines: lines }, rule: { ...rule, paddingX: 2, paddingY: 2 }, document: { createElement: () => canvas } });
  const draws = operations.filter(op => op.kind === 'text');
  assert.equal(draws.map(op => op.text).join(''), rich.text);
  assert.equal(families.find(([g]) => g === '甲')[1], '"quote-primary"');
  for (const character of ['A', '&', '乙']) {
    assert.equal(families.find(([g]) => g === character)[1], '"quote-backup"');
    assert.match(draws.find(op => op.text === character).font, /^normal 800 20px "quote-backup"$/);
  }
  assert.ok(draws.filter(op => op.text === ' ').every(op => op.font.endsWith('"quote-primary"')));
  assert.ok(draws.every(op => !/inherit|Menlo|monospace/.test(op.font)));
  assert.ok(measuredSamples.every(value => value === '国Ag'));
  assert.ok(operations.some(op => op.kind === 'underline' && op.color === '#923E32'));
});

test('omitting the option preserves the legacy monospace family and Latin metrics sample', () => {
  const legacyRule = { ...rule, inlineCodeFont: undefined };
  const rich = extractQuoteRichText(paragraph('甲<code>A  B</code>'), legacyRule);
  const code = rich.runs.find(run => run.style.code);
  assert.equal(Object.hasOwn(code.style, 'codeFont'), false);
  const selected = withCoveredFontFallbacks(font('甲', 'quote-primary'), [], '甲');
  const samples = []; const context = { measureText(value) { samples.push(value); return { width: 10 }; } };
  const measure = makeQuoteRichMeasurer(context, selected, () => () => 10);
  const metric = measure('A', code.style);
  assert.match(metric.font, /SFMono-Regular.*Menlo.*monospace/);
  assert.deepEqual(samples, ['Ag']);
});

test('new quote-font underlines use currentColor only when introduced and preserve actual ancestor decoration color', () => {
  const own = extractQuoteRichText(paragraph('<code style="color:#923E32;text-decoration:underline">红<span style="color:#3F625E">青</span></code>'), rule);
  assert.ok(own.runs.every(run => run.style.underlineColor === '#923E32'));
  assert.equal(own.runs[1].style.color, '#3F625E');
  const propagated = extractQuoteRichText(paragraph('<span style="color:#3F625E;text-decoration:underline"><code style="color:#923E32;text-decoration:underline">红字青线</code></span>'), rule);
  assert.equal(propagated.runs[0].style.color, '#923E32');
  assert.equal(propagated.runs[0].style.underlineColor, '#3F625E');
  const fromParagraph = parseDocument('<p style="color:#80602F;text-decoration:underline"><code style="color:#923E32;text-decoration:underline">红字旧金线</code></p>').children[0];
  assert.equal(extractQuoteRichText(fromParagraph, rule).runs[0].style.underlineColor, '#80602F');
  const legacy = extractQuoteRichText(paragraph('<code style="color:#923E32;text-decoration:underline">原路径</code>'), { ...rule, inlineCodeFont: undefined });
  assert.equal(legacy.runs[0].style.underlineColor, '#80602F');
});

test('quote code coverage includes Latin/code-only text before raster allocation and uses registered fallback fonts', async () => {
  const html = wrap('<code>A  乙</code>');
  let draws = 0, allocations = 0;
  const primary = font(' ', 'primary');
  primary.document = { createElement: () => { allocations++; return { getContext: () => ({}) }; } };
  const input = { html, images: [], themeId: 'code-font', quoteImages: rule, fonts: [{ id: 'primary' }, { id: 'backup' }], layoutWidth: 390,
    loadFont: async entry => entry.id === 'primary' ? primary : font('A乙', 'backup'), cache: new HeadingImageLruCache(),
    measureFactory: () => () => 20, verifyPng: verifyGeneratedHeadingPng, segmentGraphemes,
    renderPng: ({ layout, rule: activeRule }) => { draws++; return { bytes: png(layout.width * activeRule.scale, layout.height * activeRule.scale) }; },
  };
  const result = await materializeQuoteImages(input);
  assert.deepEqual(result.warnings, []); assert.equal(result.generatedCount, 1); assert.equal(result.images[0].alt, 'A  乙');
  assert.equal(draws, 1); assert.equal(allocations, 1);
  allocations = 0;
  const missing = await materializeQuoteImages({ ...input, loadFont: async () => primary, cache: new HeadingImageLruCache() });
  assert.equal(missing.html, html); assert.equal(missing.generatedCount, 0); assert.equal(allocations, 0);
  assert.match(missing.warnings[0], /不支持字形「A」/);
});

test('same-font bold code rerenders at 20/30px, participates in cache keys and retains spaces/semantics on copy fallback', async () => {
  const html = wrap('甲<strong style="font-weight:800;color:#923E32"><code style="font-size:1em;font-family:inherit;padding:0;border:none;background-color:transparent">A  &amp; 乙</code></strong>');
  const draws = []; const cache = new HeadingImageLruCache();
  const primary = font('甲A &乙', 'primary');
  const input = { html, images: [], themeId: 'code-font', quoteImages: rule, fonts: [{ id: 'primary' }, { id: 'backup' }],
    loadFont: async () => primary, cache, measureFactory: (ctx, typography) => () => typography.fontSize,
    verifyPng: verifyGeneratedHeadingPng, segmentGraphemes,
    renderPng: ({ layout, rule: activeRule }) => { draws.push({ layout, rule: activeRule }); return { bytes: png(layout.width * activeRule.scale, layout.height * activeRule.scale) }; },
  };
  let desktop;
  for (const width of [390, 677]) {
    const result = await materializeQuoteImages({ ...input, layoutWidth: width });
    assert.deepEqual(result.warnings, []); assert.equal(result.generatedCount, 1);
    const active = draws.at(-1); const size = width === 390 ? 20 : 30;
    const atoms = active.layout.richLines.flatMap(line => line.fragments.flatMap(fragment => fragment.atoms));
    assert.ok(atoms.every(atom => atom.style.fontSize === size));
    assert.ok(atoms.filter(atom => atom.style.code).every(atom => atom.style.codeFont === 'quote' && atom.style.fontWeight === 800 && atom.metrics.font === `normal 800 ${size}px "primary"`));
    const count = draws.length; await materializeQuoteImages({ ...input, layoutWidth: width }); assert.equal(draws.length, count);
    if (width === 677) desktop = result;
  }
  const before = draws.length;
  await materializeQuoteImages({ ...input, layoutWidth: 677, quoteImages: { ...rule, inlineCodeFont: undefined } });
  assert.equal(draws.length, before + 1);
  assert.ok(draws.at(-1).layout.richLines.flatMap(line => line.fragments.flatMap(fragment => fragment.atoms)).some(atom => atom.style.code && /inherit,/.test(atom.metrics.font)));
  let clipboard;
  const copied = await copyRenderedArticle({ html: desktop.html, images: desktop.images, text: '甲A  & 乙', embedImages: true, maxSingleImageBytes: 1,
    _clipboard: { write(value) { clipboard = value; } } });
  assert.equal(copied.stats.quoteImages.textFallbacks, 1);
  assert.match(clipboard.html, /<strong[^>]*><code[^>]*>A  &amp; 乙<\/code><\/strong>/);
});
