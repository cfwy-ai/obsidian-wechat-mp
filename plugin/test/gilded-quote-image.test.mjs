import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { parseDocument } from 'htmlparser2';
import { parseThemeManifest } from '../src/theme-package.mjs';
import { scaleReferenceQuoteRule } from '../src/reference-composition.mjs';
import { extractQuoteRichText, layoutQuoteRichText, renderQuoteRichPng } from '../plugin/quote-rich-text.mjs';
import { materializeQuoteImages } from '../plugin/quote-image.mjs';
import { HeadingImageLruCache, segmentGraphemes, verifyGeneratedHeadingPng } from '../plugin/heading-image.mjs';

const paint = {
  type: 'gilded',
  stops: [{ offset: 0, color: '#6B522D' }, { offset: .42, color: '#BE9955' },
    { offset: .66, color: '#957039' }, { offset: 1, color: '#73582F' }],
  stroke: { color: '#66502D', width: .45 },
  highlight: { color: '#DEC58B', alpha: .2, width: .25, offset_x: -.15, offset_y: -.2 },
};
const manifest = (quoteImages) => JSON.stringify({ schema_version: 3, theme_id: 'gold-quote',
  name: '金句测试', assets: [], components: [],
  fonts: [{ font_id: 'classic', file: '配套字体资源/classic.woff2', family: 'classic', sha256: 'a'.repeat(64) }],
  quote_images: quoteImages,
});
const rawRule = { font_id: 'classic', color: '#80602F', font_size: 20, text_paint: paint };
const rule = parseThemeManifest(manifest(rawRule)).quoteImages;
const png = (width, height) => PNG.sync.write({ width, height, data: Buffer.alloc(width * height * 4) }, { colorType: 6, inputColorType: 6 });
const measure = (text, style) => ({ width: /^[a-zA-Z0-9]+$/.test(text) ? 9 : style.fontSize,
  ascent: style.fontSize * .8, descent: style.fontSize * .2,
  font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${style.code ? 'monospace' : 'classic'}` });

test('quote gilded paint uses the heading contract and leaves legacy metadata unchanged', () => {
  assert.equal(Object.hasOwn(parseThemeManifest(manifest({ font_id: 'classic' })).quoteImages, 'textPaint'), false);
  assert.deepEqual(rule.textPaint.stops, paint.stops);
  assert.equal(rule.textPaint.highlight.offsetX, -.15);
  for (const [replacement, expression] of [
    [{ ...paint, type: 'gradient' }, /只支持 gilded/],
    [{ ...paint, stops: paint.stops.slice(0, 3) }, /4–8/],
    [{ ...paint, stroke: { ...paint.stroke, width: 4 } }, /stroke.width/],
    [{ ...paint, stops: paint.stops.map((stop, index) => index === 1 ? { ...stop, color: 'gold' } : stop) }, /6 位 HEX/],
    [{ ...paint, highlight: { ...paint.highlight, alpha: 2 } }, /highlight.alpha/],
  ]) assert.throws(() => parseThemeManifest(manifest({ ...rawRule, text_paint: replacement })), expression);
  assert.throws(() => parseThemeManifest(manifest({ ...rawRule, color: undefined })), /显式提供.*单色回退/);
});

test('quote Canvas uses line-local gold layers and preserves italic, bold, inline colors, code and underline', () => {
  const paragraph = parseDocument('<p>山<strong>河</strong><em>静</em><br><u>远</u><span style="color:#204B45">绿</span><code style="color:#222222;background-color:#EFE8D9;border:1px solid #80755E">A</code></p>').children[0];
  const rich = extractQuoteRichText(paragraph, rule);
  const lines = layoutQuoteRichText(rich, { maxWidth: 220, rule, measure, segmentGraphemes });
  const gradients = [], operations = [];
  const canvas = { width: 0, height: 0 };
  const context = {
    globalAlpha: 1, clearRect() {}, scale() {},
    createLinearGradient(...bounds) { const gradient = { bounds, stops: [], addColorStop(...stop) { this.stops.push(stop); } }; gradients.push(gradient); return gradient; },
    fillText(text, x, y) { operations.push({ method: 'fill', text, x, y, font: this.font, color: this.fillStyle, alpha: this.globalAlpha }); },
    strokeText(text, x, y) { operations.push({ method: 'stroke', text, x, y, font: this.font, color: this.strokeStyle, alpha: this.globalAlpha }); },
    fillRect(...box) { operations.push({ method: 'box', box, color: this.fillStyle }); },
    strokeRect(...box) { operations.push({ method: 'frame', box, color: this.strokeStyle }); },
    getImageData() { return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }; },
  };
  canvas.getContext = () => context;
  const height = Math.ceil(lines.reduce((sum, line) => sum + line.height, 0) + 4);
  const result = renderQuoteRichPng({ layout: { width: 224, height, richLines: lines },
    rule: { ...rule, paddingX: 2, paddingY: 2 }, document: { createElement: () => canvas } });
  const decoded = PNG.sync.read(result.bytes);
  assert.equal(decoded.width, 224 * rule.scale); assert.equal(decoded.height, height * rule.scale);
  assert.equal(gradients.length, 2);
  assert.deepEqual(gradients.map(({ bounds }) => bounds), [[0, 2, 0, 2 + lines[0].height], [0, 2 + lines[0].height, 0, 2 + lines[0].height + lines[1].height]]);
  assert.deepEqual(gradients[0].stops, paint.stops.map(({ offset, color }) => [offset, color]));
  for (const glyph of ['山', '河', '静', '远']) {
    const ink = operations.filter(({ text }) => text === glyph);
    assert.deepEqual(ink.map(({ method }) => method), ['stroke', 'fill', 'stroke']);
    assert.equal(ink[0].color, paint.stroke.color); assert.equal(ink[0].alpha, 1);
    assert.equal(ink[2].alpha, paint.highlight.alpha);
    assert.ok(Math.abs(ink[2].x - ink[0].x - paint.highlight.offset_x) < 1e-8);
    assert.ok(Math.abs(ink[2].y - ink[0].y - paint.highlight.offset_y) < 1e-8);
  }
  assert.match(operations.find(({ text }) => text === '河').font, /700/);
  assert.match(operations.find(({ text }) => text === '静').font, /^italic/);
  assert.equal(operations.find(({ text }) => text === '绿').color, '#204B45');
  const code = operations.filter(({ text }) => text === 'A');
  assert.equal(code.length, 1); assert.equal(code[0].color, '#222222'); assert.match(code[0].font, /monospace/);
  assert.ok(operations.some(({ method, color }) => method === 'frame' && color === '#80755E'));
  assert.ok(operations.some(({ method, color }) => method === 'box' && color === '#80602F'));
  assert.equal(context.globalAlpha, 1);
});

test('reference layout scales optional gold stroke and highlight without mutating the rule', () => {
  const scaled = scaleReferenceQuoteRule(rule, { strategy: 'opening-feature', designWidth: 390 }, 780);
  assert.equal(scaled.textPaint.stroke.width, rule.textPaint.stroke.width * 2);
  assert.equal(scaled.textPaint.highlight.offsetX, rule.textPaint.highlight.offsetX * 2);
  assert.equal(rule.textPaint.stroke.width, .45);
});

test('materializing gold quotes caches by paint and restores intact source on Canvas failure', async () => {
  const source = '<section id="nice"><blockquote><p>山<strong>河</strong><em>静</em></p></blockquote></section>';
  const cache = new HeadingImageLruCache(); let rendered = 0;
  const font = { runtimeFamily: 'classic', hash: 'classic', coverage: new Set([..."山河静"].map((c) => c.codePointAt(0))),
    coverageHash: 'coverage', weight: 400, style: 'normal', document: { createElement: () => ({ getContext: () => ({}) }) } };
  const input = { html: source, themeId: 'gold-quote', quoteImages: rule, fonts: [{ id: 'classic' }], layoutWidth: 320,
    loadFont: async () => font, cache, measureFactory: () => (g) => g.length * 20,
    verifyPng: verifyGeneratedHeadingPng, segmentGraphemes,
    renderPng: ({ layout, rule: r }) => { rendered++; assert.ok(r.paddingX >= 2 && r.paddingY >= 2); return { bytes: png(layout.width * r.scale, layout.height * r.scale) }; },
  };
  const first = await materializeQuoteImages(input);
  assert.deepEqual(first.warnings, []); assert.equal(first.generatedCount, 1);
  await materializeQuoteImages(input); assert.equal(rendered, 1);
  await materializeQuoteImages({ ...input, quoteImages: { ...rule, textPaint: { ...rule.textPaint, stroke: { ...rule.textPaint.stroke, color: '#604421' } } } });
  assert.equal(rendered, 2);
  const fallbackCache = new HeadingImageLruCache(); let fallbackDraws = 0;
  const fallbackInput = { ...input, cache: fallbackCache, renderPng: ({ layout, rule: r }) => {
    fallbackDraws++;
    if (r.textPaint) throw new Error('gradient unavailable');
    return { bytes: png(layout.width * r.scale, layout.height * r.scale) };
  } };
  const plain = await materializeQuoteImages(fallbackInput);
  assert.equal(plain.generatedCount, 1); assert.match(plain.warnings[0], /单色金句图片/);
  assert.equal(plain.images[0].fallbackHtml, '山<strong>河</strong><em>静</em>');
  await materializeQuoteImages(fallbackInput); assert.equal(fallbackDraws, 2);
  const failed = await materializeQuoteImages({ ...input, cache: new HeadingImageLruCache(), renderPng: () => { throw new Error('当前画布不支持鎏金文字绘制'); } });
  assert.equal(failed.generatedCount, 0); assert.equal(failed.html, source); assert.match(failed.warnings[0], /保留完整活文字/);
  const nested = source.replace('</p>', '</p><ul><li>列表语义</li></ul>');
  const kept = await materializeQuoteImages({ ...input, html: nested });
  assert.equal(kept.html, nested); assert.equal(kept.generatedCount, 0);
});
