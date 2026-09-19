import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { parseDocument } from 'htmlparser2';
import { parseThemeManifest } from '../src/theme-package.mjs';
import { scaleReferenceQuoteRule } from '../src/reference-composition.mjs';
import { extractQuoteRichText, scaleQuoteRichText, layoutQuoteRichText } from '../plugin/quote-rich-text.mjs';
import { resolveResponsiveQuoteTypography } from '../plugin/quote-typography.mjs';
import { materializeQuoteImages } from '../plugin/quote-image.mjs';
import { HeadingImageLruCache, segmentGraphemes, verifyGeneratedHeadingPng } from '../plugin/heading-image.mjs';

const config = { min_width: 390, max_width: 677, max_font_size: 30 };
const rawRule = { font_id: 'classic', font_size: 20, line_height: 1.8, letter_spacing: 1, color: '#80602F',
  responsive_typography: config, illustration: { asset_id: 'temple', width_percent: 44, gap_percent: 4 },
  text_paint: { type: 'gilded', stops: [{ offset: 0, color: '#6B522D' }, { offset: .42, color: '#BE9955' }, { offset: .66, color: '#957039' }, { offset: 1, color: '#73582F' }],
    stroke: { color: '#66502D', width: .45 }, highlight: { color: '#DEC58B', alpha: .2, width: .25, offset_x: -.15, offset_y: -.2 } },
};
const manifest = rule => JSON.stringify({ schema_version: 3, theme_id: 'responsive-quote', name: '金句字号', components: [],
  assets: [{ asset_id: 'temple', file: '透明装饰素材/temple.png' }],
  fonts: [{ font_id: 'classic', family: 'classic', file: '配套字体资源/classic.woff2', sha256: 'a'.repeat(64) }], quote_images: rule });
const rule = parseThemeManifest(manifest(rawRule)).quoteImages;
const paragraph = text => parseDocument(`<p style="font-size:20px;line-height:36px;letter-spacing:1px">${text}</p>`).children[0];
const png = (width, height) => PNG.sync.write({ width, height, data: Buffer.alloc(width * height * 4) }, { colorType: 6, inputColorType: 6 });

test('responsive quote schema is optional and validates increasing widths and bounded maximum font size', () => {
  assert.deepEqual(rule.responsiveTypography, { minWidth: 390, maxWidth: 677, maxFontSize: 30 });
  assert.deepEqual(parseThemeManifest(manifest({ ...rawRule, responsive_typography: {} })).quoteImages.responsiveTypography, rule.responsiveTypography);
  assert.equal(Object.hasOwn(parseThemeManifest(manifest({ ...rawRule, responsive_typography: undefined })).quoteImages, 'responsiveTypography'), false);
  for (const [responsive, expected] of [
    [null, /必须是对象/],
    [{ ...config, min_width: 239 }, /min_width/],
    [{ ...config, max_width: 390 }, /max_width/],
    [{ ...config, max_width: 1001 }, /max_width/],
    [{ ...config, min_width: 390.5 }, /整数/],
    [{ ...config, max_font_size: 19 }, /max_font_size/],
    [{ ...config, max_font_size: 49 }, /max_font_size/],
    [{ ...config, scale: 3 }, /不支持字段/],
  ]) assert.throws(() => parseThemeManifest(manifest({ ...rawRule, responsive_typography: responsive })), expected);
});

test('390px and below stays 20px, 677px reaches 30px and interpolation clamps without changing image columns', () => {
  const before = JSON.stringify(rule);
  assert.deepEqual([320, 390, 533.5, 677, 900].map(width => resolveResponsiveQuoteTypography(rule, width).rule.fontSize), [20, 20, 25, 30, 30]);
  const { rule: wide, factor } = resolveResponsiveQuoteTypography(rule, 677);
  assert.equal(factor, 1.5); assert.equal(wide.lineHeight, 1.8);
  assert.equal(wide.letterSpacing, 1.5); assert.equal(wide.maxWidth, rule.maxWidth);
  assert.equal(wide.scale, 3); assert.equal(wide.illustration, rule.illustration);
  assert.equal(wide.textPaint.stroke.width, .45 * 1.5);
  assert.equal(wide.textPaint.highlight.width, .25 * 1.5);
  assert.equal(wide.textPaint.highlight.offsetX, -.15 * 1.5);
  assert.equal(wide.textPaint.highlight.alpha, .2);
  assert.equal(JSON.stringify(rule), before);
  assert.equal(resolveResponsiveQuoteTypography(rule, undefined).rule, rule);
  assert.equal(resolveResponsiveQuoteTypography(rule, 1001).rule, rule);
  const legacy = { ...rule, responsiveTypography: undefined };
  assert.equal(resolveResponsiveQuoteTypography(legacy, 677).rule, legacy);
});

test('reference composition and responsive quotes meet the same target instead of multiplying font scales twice', () => {
  const reference = { strategy: 'opening-feature', designWidth: 390 };
  const scaled = scaleReferenceQuoteRule(rule, reference, 677);
  const resolved = resolveResponsiveQuoteTypography(rule, 677, scaled);
  assert.equal(resolved.rule.fontSize, 30);
  assert.ok(Math.abs(resolved.factor * 20 * 677 / 390 - 30) < 1e-8);
  assert.ok(Math.abs(resolved.rule.textPaint.stroke.width - .675) < 1e-8);
  const paragraphAtWidth = parseDocument(`<p style="font-size:${20 * 677 / 390}px;line-height:${36 * 677 / 390}px">山河。</p>`).children[0];
  const rich = scaleQuoteRichText(extractQuoteRichText(paragraphAtWidth, scaled), resolved.factor);
  assert.ok(Math.abs(rich.runs[0].style.fontSize - 30) < 1e-8);
  assert.ok(Math.abs(rich.runs[0].style.absoluteLineHeight - 54) < 1e-8);
  const legacy = { ...rule, responsiveTypography: undefined };
  const referenceLegacy = scaleReferenceQuoteRule(legacy, reference, 677);
  assert.equal(resolveResponsiveQuoteTypography(legacy, 677, referenceLegacy).rule, referenceLegacy);
});

test('resolved px/em rich styles, bold, code frames and line height scale once while original fallback HTML remains unchanged', () => {
  const rich = extractQuoteRichText(paragraph('山<strong style="font-weight:800;color:#614424">河<code style="font-size:.88em;line-height:1.5;padding:1px 4px;border:1px solid #967848;background-color:#E9DDC5">AI</code></strong>'), rule);
  const before = JSON.stringify(rich);
  const scaled = scaleQuoteRichText(rich, 1.5);
  assert.equal(scaled.runs[0].style.fontSize, 30); assert.equal(scaled.runs[0].style.absoluteLineHeight, 54);
  assert.equal(scaled.runs[0].style.letterSpacing, 1.5);
  assert.equal(scaled.runs[1].style.fontWeight, 800); assert.equal(scaled.runs[1].style.color, '#614424');
  assert.ok(Math.abs(scaled.runs[2].style.fontSize - 26.4) < 1e-8);
  assert.equal(scaled.runs[2].style.lineHeight, 1.5); assert.equal(scaled.runs[2].style.absoluteLineHeight, null);
  assert.deepEqual(scaled.runs[2].box.padding, [1.5, 6, 1.5, 6]);
  assert.ok(scaled.runs[2].box.borders.every(border => border.width === 1.5));
  assert.equal(scaled.tree, rich.tree); assert.equal(JSON.stringify(rich), before);
  assert.equal(scaleQuoteRichText(rich, 1), rich);
  assert.throws(() => scaleQuoteRichText(rich, 4), /字号/);
  const lines = layoutQuoteRichText(scaled, { maxWidth: 200, rule: resolveResponsiveQuoteTypography(rule, 677).rule,
    measure: (g, style) => ({ width: style.fontSize, ascent: style.fontSize * .8, descent: style.fontSize * .2, font: `${style.fontWeight} ${style.fontSize}px classic` }), segmentGraphemes });
  assert.ok(lines[0].height >= 54); assert.ok(lines.every(line => line.width <= 200));
});

test('real quote materialization rerenders 44/52 text at each logical width despite fixed 20px inline CSS and caches by typography', async () => {
  const html = '<section id="nice" style="padding:20px"><blockquote style="padding:0"><span></span><p style="font-size:20px;line-height:36px;letter-spacing:1px">山河依旧，岁月无声。<strong style="font-weight:800;color:#614424">认真生活。</strong><code style="font-size:.88em;padding:1px 4px;border:1px solid #967848;background-color:#E9DDC5">AI</code></p><span></span></blockquote></section>';
  const font = { runtimeFamily: 'classic', hash: 'classic', weight: 400, style: 'normal',
    coverage: new Set([...html].map(c => c.codePointAt(0))), coverageHash: 'all',
    document: { createElement: () => ({ getContext: () => ({}) }) } };
  const cache = new HeadingImageLruCache(); const draws = [];
  const input = { html, images: [], themeId: 'responsive-quote', quoteImages: rule, fonts: [{ id: 'classic' }], assets: [{ id: 'temple', url: 'app://temple.png', filePath: 'vault/temple.png' }],
    loadFont: async () => font, loadIllustration: async () => ({ width: 300, height: 400 }), cache,
    measureFactory: (context, typography) => () => typography.fontSize,
    verifyPng: verifyGeneratedHeadingPng, segmentGraphemes,
    renderPng: ({ layout, rule: activeRule }) => { draws.push({ layout, rule: activeRule }); return { bytes: png(layout.width * activeRule.scale, layout.height * activeRule.scale) }; },
  };
  let mobile, desktop;
  for (const width of [320, 390, 677]) {
    const before = draws.length;
    const result = await materializeQuoteImages({ ...input, layoutWidth: width });
    assert.deepEqual(result.warnings, []); assert.ok(result.generatedCount > 0);
    assert.match(result.html, /width:44%;/); assert.match(result.html, /width:52%;/);
    const current = draws.slice(before); const target = width <= 390 ? 20 : 30;
    assert.ok(current.every(draw => draw.rule.fontSize === target && draw.rule.scale === 3));
    const atoms = current.flatMap(draw => draw.layout.richLines.flatMap(line => line.fragments.flatMap(fragment => fragment.atoms)));
    assert.ok(atoms.filter(atom => !atom.style.code).every(atom => atom.style.fontSize === target));
    assert.ok(atoms.some(atom => atom.style.fontWeight === 800));
    const fontInMetrics = atoms[0].metrics.font;
    assert.match(fontInMetrics, new RegExp(` ${target}px `));
    const raster = PNG.sync.read(result.images.find(image => image.generatedKind === 'quote').bytes);
    assert.equal(raster.width, current[0].layout.width * 3);
    const after = draws.length;
    await materializeQuoteImages({ ...input, layoutWidth: width });
    assert.equal(draws.length, after);
    if (width === 390) mobile = result.images[0].url;
    if (width === 677) desktop = result.images[0].url;
  }
  assert.notEqual(mobile, desktop);
  const before = draws.length;
  await materializeQuoteImages({ ...input, layoutWidth: 677, quoteImages: { ...rule, responsiveTypography: { ...rule.responsiveTypography, maxFontSize: 28 } } });
  assert.ok(draws.length > before); assert.equal(draws.at(-1).rule.fontSize, 28);
});
