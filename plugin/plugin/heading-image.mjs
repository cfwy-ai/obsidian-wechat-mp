import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { parseDocument } from 'htmlparser2';
import { inlineStyleMap, headingContainerWidth } from './layout-box.mjs';
export { headingContainerWidth } from './layout-box.mjs';
import { scaleReferenceHeadingRule } from '../src/reference-composition.mjs';
import { themeFontByteLimit, THEME_FONT_DIRECTORIES } from '../src/theme-package.mjs';
import { parseFontCoverage, withCoveredFontFallbacks } from './font-coverage.mjs';
import { materializeQuoteImages } from './quote-image.mjs';
import { materializeOrderedListImages } from './ordered-list-image.mjs';
import { renderQuoteRichPng } from './quote-rich-text.mjs';
import { paintTextLine } from './text-paint.mjs';
import { materializeInlinePaint } from './inline-paint-image.mjs';

export const GENERATED_HEADING_IMAGE_LIMIT = 1024 * 1024;
export const NUMBER_ASSET_LIMIT = 2 * 1024 * 1024;
export const DEFAULT_HEADING_CACHE_ENTRIES = 64;
export const DEFAULT_HEADING_CACHE_BYTES = 12 * 1024 * 1024;

const CLOSING_PUNCTUATION = /^[，。！？；：、）》】」』”’…,.!?;:%)\]}]/u;
const OPENING_PUNCTUATION = /[（《【「『“‘([{]$/u;
const ASCII_RUN = /^[\u0020-\u007e]+$/u;
const ASCII_WORD_CHAR = /^[A-Za-z0-9_+#./:@-]$/u;
const DISALLOWED_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/u;
const BR_TAG = /<br\s*\/?>/gi;

const escapeAttribute = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;');

const decodeHtmlEntities = (value) => String(value).replace(
  /&(?:#(\d+)|#x([a-f0-9]+)|(amp|lt|gt|quot|apos|nbsp));/gi,
  (whole, decimal, hex, named) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      nbsp: ' ',
    }[named.toLowerCase()] ?? whole;
  },
);

export const headingTextFromInlineHtml = (html) => decodeHtmlEntities(
  String(html ?? '').replace(BR_TAG, ' ').replace(/<[^>]*>/g, ''),
).replace(/\s+/g, ' ').trim();

const parseHeadingInlineContent = (html) => {
  const raw = String(html ?? '');
  const breakCount = [...raw.matchAll(BR_TAG)].length;
  if (breakCount > 2) {
    return { ok: false, reason: '标题最多允许 2 个 <br> 强制换行' };
  }
  const withoutBreaks = raw.replace(BR_TAG, '');
  if (/<[^>]+>/.test(withoutBreaks)) {
    return { ok: false, reason: '标题含复杂行内内容' };
  }
  const segments = raw.split(BR_TAG).map((part) =>
    decodeHtmlEntities(part).replace(/\s+/g, ' ').trim());
  if (segments.some((segment) => !segment)) {
    return { ok: false, reason: '标题的 <br> 不能产生空行' };
  }
  return {
    ok: true,
    text: segments.join(' '),
    layoutText: segments.join('\n'),
    segments,
    breakCount,
  };
};

export const segmentGraphemes = (value) => {
  const text = String(value ?? '');
  if (typeof Intl?.Segmenter === 'function') {
    return [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)]
      .map((item) => item.segment);
  }
  return Array.from(text);
};

export function equivalentCharacterCount(value) {
  return segmentGraphemes(value).reduce((total, grapheme) => {
    if (/^\s+$/u.test(grapheme)) return total + 0.25;
    return total + (ASCII_RUN.test(grapheme) ? 0.5 : 1);
  }, 0);
}

const isLatinGrapheme = (grapheme) => ASCII_RUN.test(grapheme);

/** 优先保留中文词边界，同时把连续 ASCII 词组作为不可拆单元。 */
const tokenizeHeading = (text) => {
  const segmented = typeof Intl?.Segmenter === 'function'
    ? [...new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(text)]
    : segmentGraphemes(text).map((segment) => ({ segment, isWordLike: true }));
  const tokens = [];
  let ascii = '';
  const flushAscii = () => {
    if (!ascii) return;
    tokens.push(ascii);
    ascii = '';
  };
  for (const item of segmented) {
    const graphemes = segmentGraphemes(item.segment);
    if (graphemes.length > 0 && graphemes.every((grapheme) => ASCII_WORD_CHAR.test(grapheme))) {
      ascii += item.segment;
      continue;
    }
    flushAscii();
    if (item.isWordLike && graphemes.some((grapheme) => !ASCII_RUN.test(grapheme))) {
      tokens.push(item.segment);
    } else {
      tokens.push(...graphemes);
    }
  }
  flushAscii();
  return tokens;
};

const trackedWidth = (text, measureGrapheme, letterSpacing) => {
  const graphemes = segmentGraphemes(text);
  if (graphemes.length === 0) return 0;
  return graphemes.reduce((sum, grapheme) => sum + measureGrapheme(grapheme), 0)
    + Math.max(0, graphemes.length - 1) * letterSpacing;
};

const cleanLine = (tokens) => tokens.join('').trim();

const expandOversizeCjkTokens = (tokens, options) => tokens.flatMap((token) => {
  if (
    ASCII_RUN.test(token)
    || trackedWidth(token, options.measureGrapheme, options.letterSpacing) <= options.maxInkWidth
  ) {
    return [token];
  }
  return segmentGraphemes(token);
});

const cjkGraphemeFallbackTokens = (tokens) => tokens.flatMap((token) =>
  ASCII_RUN.test(token) ? [token] : segmentGraphemes(token));

const balancedLines = (tokens, lineCount, options) => {
  const {
    maxInkWidth,
    measureGrapheme,
    letterSpacing,
    firstLinePrefixWidth = 0,
  } = options;
  let best = null;

  const inspect = (ranges) => {
    const lines = ranges.map(([start, end]) => cleanLine(tokens.slice(start, end)));
    if (lines.some((line) => !line || equivalentCharacterCount(line) < 2)) return;
    if (lines.some((line, index) =>
      (index < lines.length - 1 && OPENING_PUNCTUATION.test(line))
      || (index > 0 && CLOSING_PUNCTUATION.test(line)))) return;
    const widths = lines.map((line) => trackedWidth(line, measureGrapheme, letterSpacing));
    const inkWidths = widths.map((width, index) =>
      width + (index === 0 ? firstLinePrefixWidth : 0));
    if (inkWidths.some((width) => width > maxInkWidth)) return;
    const average = inkWidths.reduce((sum, width) => sum + width, 0) / inkWidths.length;
    const balancePenalty = inkWidths.reduce((sum, width) => sum + Math.abs(width - average), 0);
    const lastLinePenalty = equivalentCharacterCount(lines.at(-1)) < 3 ? maxInkWidth : 0;
    const score = balancePenalty + lastLinePenalty;
    if (!best || score < best.score) best = { lines, widths, score };
  };

  const choose = (start, remaining, ranges = []) => {
    if (remaining === 1) {
      if (start < tokens.length) inspect([...ranges, [start, tokens.length]]);
      return;
    }
    const latestSplit = tokens.length - (remaining - 1);
    for (let split = start + 1; split <= latestSplit; split += 1) {
      choose(split, remaining - 1, [...ranges, [start, split]]);
    }
  };
  if (tokens.length >= lineCount) choose(0, lineCount);
  return best;
};

// Four-to-six-line container headings use bounded dynamic programming instead
// of enumerating every split combination. Legacy one-to-three-line layouts stay unchanged.
const extendedLines = (tokens, lineCount, options) => {
  const memo = new Map();
  const widths = new Map();
  const target = trackedWidth(tokens.join(''), options.measureGrapheme, options.letterSpacing) / lineCount;
  const choose = (start, remaining) => {
    if (!remaining) return start === tokens.length ? { lines: [], widths: [], score: 0 } : null;
    const key = `${start}:${remaining}`;
    if (memo.has(key)) return memo.get(key);
    let best = null;
    for (let end = start + 1; end <= tokens.length - remaining + 1; end += 1) {
      const line = cleanLine(tokens.slice(start, end));
      if (equivalentCharacterCount(line) < 2 || (start > 0 && CLOSING_PUNCTUATION.test(line))
        || (remaining > 1 && OPENING_PUNCTUATION.test(line))) continue;
      if (!widths.has(line)) widths.set(line, trackedWidth(line, options.measureGrapheme, options.letterSpacing));
      const width = widths.get(line);
      const inkWidth = width + (start === 0 ? options.firstLinePrefixWidth ?? 0 : 0);
      if (inkWidth > options.maxInkWidth) continue;
      const rest = choose(end, remaining - 1);
      if (!rest) continue;
      const score = (inkWidth - target) ** 2 + rest.score
        + (remaining === 1 && equivalentCharacterCount(line) < 3 ? options.maxInkWidth ** 2 : 0);
      if (!best || score < best.score) best = { lines: [line, ...rest.lines], widths: [width, ...rest.widths], score };
    }
    memo.set(key, best);
    return best;
  };
  return choose(0, lineCount);
};

const lineLimitName = (value) => ({ 1: '一', 2: '两', 3: '三', 4: '四', 5: '五', 6: '六' }[value] ?? String(value));

const layoutSegment = (text, options) => {
  const oneLineWidth = trackedWidth(text, options.measureGrapheme, options.letterSpacing);
  if (oneLineWidth + (options.firstLinePrefixWidth ?? 0) <= options.maxInkWidth) {
    return { lines: [text], widths: [oneLineWidth] };
  }
  const tokens = expandOversizeCjkTokens(tokenizeHeading(text), options);
  const graphemeFallback = cjkGraphemeFallbackTokens(tokens);
  for (let lineCount = 2; lineCount <= options.maxLines; lineCount += 1) {
    const arrange = options.widthMode === 'container' && lineCount > 3 ? extendedLines : balancedLines;
    const candidate = arrange(tokens, lineCount, options)
      ?? arrange(graphemeFallback, lineCount, options);
    if (candidate) return candidate;
  }
  return null;
};

/**
 * 按真实字形宽度决定行数；旧模式最多三行，容器模式可显式扩至六行。
 * 不拆英文词，不让闭标点开头，也不接受单字孤行。
 */
export function layoutHeadingText(text, options) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n');
  if (DISALLOWED_CONTROL.test(raw)) return { ok: false, reason: '标题含控制字符' };
  const segments = raw.split('\n').map((segment) => segment.replace(/\s+/g, ' ').trim());
  if (segments.some((segment) => !segment)) return { ok: false, reason: '标题含空行' };
  if (segments.length > options.maxLines) {
    return { ok: false, reason: `标题超过 ${lineLimitName(options.maxLines)}行上限` };
  }
  const normalized = segments.join(' ');
  if (!normalized) return { ok: false, reason: '标题为空' };

  const equivalent = equivalentCharacterCount(normalized);
  if (equivalent > options.maxEquivalentCharacters) {
    return {
      ok: false,
      reason: `标题超过 ${options.maxEquivalentCharacters} 个全角等效字符`,
    };
  }

  const sideInset = options.sideAssets ? options.sideAssets.size + options.sideAssets.gap : 0;
  const maxInkWidth = options.maxWidth - options.paddingX * 2 - sideInset * 2;
  const firstLinePrefixWidth = options.prefix?.totalWidth ?? 0;
  const segmentLayouts = segments.map((segment, index) => layoutSegment(segment, {
    maxInkWidth,
    maxLines: options.maxLines,
    widthMode: options.widthMode,
    measureGrapheme: options.measureGrapheme,
    letterSpacing: options.letterSpacing,
    firstLinePrefixWidth: index === 0 ? firstLinePrefixWidth : 0,
  }));
  if (segmentLayouts.some((layout) => !layout)) {
    return {
      ok: false,
      reason: `标题无法在${lineLimitName(options.maxLines)}行内安全排版`,
    };
  }
  const lines = segmentLayouts.flatMap((layout) => layout.lines);
  const widths = segmentLayouts.flatMap((layout) => layout.widths);
  if (lines.length > options.maxLines) {
    return {
      ok: false,
      reason: `显式换行后的标题无法在${lineLimitName(options.maxLines)}行内安全排版`,
    };
  }
  if (lines.length > 1 && lines.some((line) => equivalentCharacterCount(line) < 2)) {
    return { ok: false, reason: '标题换行后出现单字孤行' };
  }
  if (lines.some((line, index) =>
    (index < lines.length - 1 && OPENING_PUNCTUATION.test(line))
    || (index > 0 && CLOSING_PUNCTUATION.test(line)))) {
    return { ok: false, reason: '标题换行后出现不安全的行首或行尾标点' };
  }

  const inkWidths = widths.map((lineWidth, index) =>
    lineWidth + (index === 0 ? firstLinePrefixWidth : 0));
  const width = Math.min(
    options.maxWidth,
    Math.max(1, Math.ceil(Math.max(...inkWidths) + options.paddingX * 2 + sideInset * 2)),
  );
  const lineHeightPx = options.fontSize * options.lineHeight;
  const height = Math.max(
    1,
    Math.ceil(lines.length * lineHeightPx + options.paddingY * 2),
  );
  const narrowScale = Math.min(1, options.minDisplayWidth / width);
  const effectiveFontSize = options.fontSize * narrowScale;
  if (effectiveFontSize + 0.01 < options.minEffectiveFontSize) {
    return {
      ok: false,
      reason: `最窄屏等效字号将小于 ${options.minEffectiveFontSize}px`,
    };
  }

  return {
    ok: true,
    text: normalized,
    layoutText: segments.join('\n'),
    equivalent,
    forcedBreaks: segments.length - 1,
    lines,
    widths,
    inkWidths,
    prefix: options.prefix ?? null,
    width,
    height,
    lineHeightPx,
    effectiveFontSize,
  };
}

export function headingImageCacheKey({
  themeId,
  fontHash,
  text,
  rule,
  numberAsset = null,
  sideAssets = null,
  watermarkAsset = null,
}) {
  const visual = {
    id: rule.id,
    fontSize: rule.fontSize,
    lineHeight: rule.lineHeight,
    letterSpacing: rule.letterSpacing,
    color: rule.color,
    maxWidth: rule.maxWidth,
    scale: rule.scale,
    paddingX: rule.paddingX,
    paddingY: rule.paddingY,
    maxLines: rule.maxLines,
    maxEquivalentCharacters: rule.maxEquivalentCharacters,
    minDisplayWidth: rule.minDisplayWidth,
    minEffectiveFontSize: rule.minEffectiveFontSize,
    latinFontFamily: rule.latinFontFamily,
    align: rule.align ?? 'center',
    numberSeparator: rule.numberSeparator ?? '',
    numberGap: rule.numberGap ?? 6,
    number: numberAsset ? {
      occurrence: numberAsset.occurrence,
      id: numberAsset.id,
      hash: numberAsset.hash,
      width: numberAsset.width,
      height: numberAsset.height,
    } : null,
  };
  if (rule.textPaint) {
    visual.textPaint = rule.textPaint;
    visual.paintRendererVersion = 1;
  }
  if (rule.sideAssets && sideAssets) {
    visual.sideAssets = {
      ...rule.sideAssets,
      leftHash: sideAssets.left?.hash ?? null,
      rightHash: sideAssets.right?.hash ?? null,
      rendererVersion: 1,
    };
  }
  if (rule.watermark && watermarkAsset) {
    visual.watermark = {
      ...rule.watermark,
      id: watermarkAsset.id,
      hash: watermarkAsset.hash,
      rendererVersion: 1,
    };
  }
  return createHash('sha256')
    .update(JSON.stringify([themeId, fontHash, text, visual]))
    .digest('hex');
}

export class HeadingImageLruCache {
  constructor({
    maxEntries = DEFAULT_HEADING_CACHE_ENTRIES,
    maxBytes = DEFAULT_HEADING_CACHE_BYTES,
  } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.bytes = 0;
  }

  get(key) {
    const value = this.entries.get(key);
    if (!value) return null;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key, value) {
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.bytes.byteLength;
    this.entries.delete(key);
    this.entries.set(key, value);
    this.bytes += value.bytes.byteLength;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      const removed = this.entries.get(oldest);
      this.entries.delete(oldest);
      this.bytes -= removed.bytes.byteLength;
    }
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}

const fontStack = (family) => `"${family}",-apple-system,"PingFang SC",sans-serif`;
const latinFontStack = (family) => `"${family}","Helvetica Neue",Arial,sans-serif`;

const setContextFont = (context, { family, fontSize, weight = 400, style = 'normal' }) => {
  context.font = `${style} ${weight} ${fontSize}px ${family}`;
};

const typographyMeasurer = (context, typography) => {
  const cache = new Map();
  return (grapheme) => {
    const latin = isLatinGrapheme(grapheme);
    const key = `${latin ? 'latin' : 'cjk'}:${grapheme}`;
    if (cache.has(key)) return cache.get(key);
    setContextFont(context, {
      family: typography.familyForGrapheme?.(grapheme) ?? (latin
        ? latinFontStack(typography.latinFontFamily)
        : fontStack(typography.fontFamily)),
      fontSize: typography.fontSize,
      weight: typography.fontWeight,
      style: typography.fontStyle,
    });
    const width = context.measureText(grapheme).width;
    cache.set(key, width);
    return width;
  };
};

const numberPrefixLayout = (numberAsset, rule, measureGrapheme) => {
  if (!numberAsset) return null;
  const numberHeight = rule.fontSize * 0.95;
  const numberWidth = numberAsset.width / numberAsset.height * numberHeight;
  const separator = rule.numberSeparator ?? '';
  const separatorWidth = separator
    ? trackedWidth(separator, measureGrapheme, rule.letterSpacing)
    : 0;
  const gap = rule.numberGap ?? 6;
  return {
    numberWidth,
    numberHeight,
    separator,
    separatorWidth,
    gap,
    totalWidth: numberWidth + gap + (separator ? separatorWidth + gap : 0),
  };
};

const lineBaseline = (context, typography, lineTop, lineHeightPx) => {
  setContextFont(context, {
    family: fontStack(typography.fontFamily),
    fontSize: typography.fontSize,
    weight: typography.fontWeight,
    style: typography.fontStyle,
  });
  const metrics = context.measureText('星轨Ag');
  const ascent = metrics.actualBoundingBoxAscent || typography.fontSize * 0.82;
  const descent = metrics.actualBoundingBoxDescent || typography.fontSize * 0.18;
  return lineTop + Math.max(0, (lineHeightPx - ascent - descent) / 2) + ascent;
};

export function renderHeadingPng({
  layout,
  rule,
  font,
  numberAsset = null,
  sideAssets = null,
  watermarkAsset = null,
  document: ownerDocument = globalThis.document,
  PNGEncoder = PNG,
}) {
  if (!ownerDocument?.createElement) throw new Error('当前环境不能创建标题画布');
  const physicalWidth = layout.width * rule.scale;
  const physicalHeight = layout.height * rule.scale;
  const canvas = ownerDocument.createElement('canvas');
  canvas.width = physicalWidth;
  canvas.height = physicalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法取得标题画布');
  context.clearRect(0, 0, physicalWidth, physicalHeight);
  context.scale(rule.scale, rule.scale);
  context.fillStyle = rule.color;
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';

  const typography = {
    fontFamily: font.runtimeFamily,
    latinFontFamily: rule.latinFontFamily,
    fontSize: rule.fontSize,
    fontWeight: font.weight,
    fontStyle: font.style,
    familyForGrapheme: font.familyForGrapheme,
  };
  const measureGrapheme = typographyMeasurer(context, typography);

  if (rule.watermark && watermarkAsset?.image) {
    const maxWidth = Math.min(rule.watermark.width, Math.max(1, layout.width - rule.paddingX * 2));
    const maxHeight = Math.min(rule.watermark.height, Math.max(1, layout.height - rule.paddingY * 2));
    const factor = Math.min(maxWidth / watermarkAsset.width, maxHeight / watermarkAsset.height);
    const width = watermarkAsset.width * factor;
    const height = watermarkAsset.height * factor;
    const x = (layout.width - width) / 2 + rule.watermark.offsetX;
    const y = (layout.height - height) / 2 + rule.watermark.offsetY;
    context.save();
    context.globalAlpha = rule.watermark.opacity;
    context.drawImage(watermarkAsset.image, x, y, width, height);
    context.restore();
  }

  const buildGlyphRun = (text, startX, baseline) => {
    let x = startX;
    const glyphs = [];
    const graphemes = segmentGraphemes(text);
    for (const [index, grapheme] of graphemes.entries()) {
      glyphs.push({ grapheme, x, baseline });
      x += measureGrapheme(grapheme);
      if (index < graphemes.length - 1) x += rule.letterSpacing;
    }
    return { glyphs, endX: x };
  };

  const drawGlyphRun = (run, method, offsetX = 0, offsetY = 0) => {
    for (const glyph of run.glyphs) {
      const latin = isLatinGrapheme(glyph.grapheme);
      setContextFont(context, {
        family: font.familyForGrapheme?.(glyph.grapheme) ?? (latin
          ? latinFontStack(rule.latinFontFamily)
          : fontStack(font.runtimeFamily)),
        fontSize: rule.fontSize,
        weight: font.weight,
        style: font.style,
      });
      context[method](glyph.grapheme, glyph.x + offsetX, glyph.baseline + offsetY);
    }
  };

  const drawLineRuns = (runs, lineTop) => {
    paintTextLine(context, { paint: rule.textPaint, color: rule.color, lineTop,
      lineHeight: layout.lineHeightPx,
      draw: (method, offsetX, offsetY) => {
        for (const run of runs) drawGlyphRun(run, method, offsetX, offsetY);
      },
    });
  };

  for (const [lineIndex, line] of layout.lines.entries()) {
    const lineWidth = layout.inkWidths?.[lineIndex]
      ?? trackedWidth(line, measureGrapheme, rule.letterSpacing);
    let x = (rule.align ?? 'center') === 'left'
      ? rule.paddingX + (rule.sideAssets ? rule.sideAssets.size + rule.sideAssets.gap : 0)
      : (layout.width - lineWidth) / 2;
    const lineTop = rule.paddingY + lineIndex * layout.lineHeightPx;
    const baseline = lineBaseline(context, typography, lineTop, layout.lineHeightPx);
    const runs = [];
    if (lineIndex === 0 && layout.prefix && numberAsset?.image) {
      context.drawImage(
        numberAsset.image,
        x,
        layout.prefix.verticalAlign === 'middle'
          ? lineTop + (layout.lineHeightPx - layout.prefix.numberHeight) / 2
          : baseline - layout.prefix.numberHeight,
        layout.prefix.numberWidth,
        layout.prefix.numberHeight,
      );
      x += layout.prefix.numberWidth + layout.prefix.gap;
      if (layout.prefix.separator) {
        const separatorRun = buildGlyphRun(layout.prefix.separator, x, baseline);
        runs.push(separatorRun);
        x = separatorRun.endX;
        x += layout.prefix.gap;
      }
    }
    runs.push(buildGlyphRun(line, x, baseline));
    drawLineRuns(runs, lineTop);
  }

  if (rule.sideAssets && sideAssets) {
    // Measure painted glyph bounds, not the full canvas or advance widths.
    // Short and multiline headings therefore keep the same visible side gaps.
    const textPixels = context.getImageData(0, 0, physicalWidth, physicalHeight);
    const boxes = headingSideAssetBoxes(textPixels, rule.scale, rule.sideAssets);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    for (const side of ['left', 'right']) {
      const asset = sideAssets[side];
      if (!asset) continue;
      const box = boxes[side];
      const factor = Math.min(box.size / asset.width, box.size / asset.height);
      const width = asset.width * factor;
      const height = asset.height * factor;
      context.drawImage(asset.image, box.x + (box.size - width) / 2,
        box.y + (box.size - height) / 2, width, height);
    }
  }
  const image = context.getImageData(0, 0, physicalWidth, physicalHeight);
  const alphaAt = (x, y) => image.data[(y * physicalWidth + x) * 4 + 3];
  if (rule.textPaint || rule.sideAssets || rule.watermark) {
    for (let x = 0; x < physicalWidth; x += 1) {
      if (alphaAt(x, 0) !== 0 || alphaAt(x, physicalHeight - 1) !== 0) {
        throw new Error('标题 PNG 边缘不是透明像素');
      }
    }
    for (let y = 0; y < physicalHeight; y += 1) {
      if (alphaAt(0, y) !== 0 || alphaAt(physicalWidth - 1, y) !== 0) {
        throw new Error('标题 PNG 边缘不是透明像素');
      }
    }
  } else {
    const corners = [
      alphaAt(0, 0),
      alphaAt(physicalWidth - 1, 0),
      alphaAt(0, physicalHeight - 1),
      alphaAt(physicalWidth - 1, physicalHeight - 1),
    ];
    if (corners.some((alpha) => alpha !== 0)) throw new Error('标题 PNG 四角不是透明像素');
  }

  const bytes = PNGEncoder.sync.write({
    width: physicalWidth,
    height: physicalHeight,
    data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength),
  }, {
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true,
  });
  return { bytes: Buffer.from(bytes), physicalWidth, physicalHeight };
}

export function headingSideAssetBoxes(pixels, scale, { size, gap }) {
  let left = pixels.width, top = pixels.height, right = -1, bottom = -1;
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      if (pixels.data[(y * pixels.width + x) * 4 + 3] > 0) {
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < left) throw new Error('标题没有可见文字，不能定位两侧装饰');
  const y = (top + bottom + 1) / (2 * scale) - size / 2;
  const boxes = {
    left: { x: left / scale - gap - size, y, size },
    right: { x: (right + 1) / scale + gap, y, size },
  };
  if (boxes.left.x <= 0 || boxes.right.x + size >= pixels.width / scale
    || y <= 0 || y + size >= pixels.height / scale) {
    throw new Error('标题两侧装饰超出安全边界');
  }
  return boxes;
}

export function verifyGeneratedHeadingPng(bytes, { physicalWidth, physicalHeight }) {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength > GENERATED_HEADING_IMAGE_LIMIT) {
    throw new Error('标题 PNG 超过单图 1 MiB 上限');
  }
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('标题图片不是有效 PNG');
  }
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('标题 PNG 缺少 IHDR');
  }
  if (buffer.readUInt32BE(16) !== physicalWidth || buffer.readUInt32BE(20) !== physicalHeight) {
    throw new Error('标题 PNG 尺寸与排版结果不一致');
  }
  if (buffer[24] !== 8 || buffer[25] !== 6) {
    throw new Error('标题 PNG 必须是 8-bit RGBA');
  }
  return buffer;
}

const bytesToDataUrl = (bytes) =>
  `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

const assetMimeType = (asset) => /\.jpe?g$/i.test(asset?.filePath ?? asset?.file?.path ?? '')
  ? 'image/jpeg'
  : 'image/png';

const headingImageHtml = ({ dataUrl, text, width, height, align = 'center' }) => [
  '<img',
  ' data-wechat-generated-heading="true"',
  ` src="${dataUrl}"`,
  ` alt="${escapeAttribute(text)}"`,
  ` width="${width}"`,
  ` height="${height}"`,
  ` style="display:block;width:${width}px;max-width:100%;height:auto;margin:${align === 'left' ? '0' : '0 auto'};border:none;border-radius:0;background-color:transparent;"`,
  '>',
].join('');

const HEADING = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
const CONTENT = /^\s*(<span\b(?=[^>]*\bclass=["'][^"']*\bcontent\b[^"']*["'])[^>]*>([\s\S]*?)<\/span>)\s*$/i;

const headingContainerChains = (html) => {
  const chains = new Map();
  const dom = parseDocument(String(html ?? ''), { withStartIndices: true });
  const visit = (node) => {
    if (/^h[1-6]$/.test(node.name ?? '')) {
      const chain = [];
      let ancestor = node;
      while (ancestor?.name) {
        chain.unshift(ancestor);
        if (ancestor.name === 'section' && ancestor.attribs?.id === 'nice') break;
        ancestor = ancestor.parent;
      }
      if (chain[0]?.name === 'section' && chain[0].attribs?.id === 'nice') {
        const content = node.children?.find((child) => child.name === 'span'
          && String(child.attribs?.class ?? '').split(/\s+/).includes('content'));
        if (content) chain.push(content);
        chains.set(node.startIndex, chain);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(dom);
  return chains;
};

/**
 * 对已经过微信兼容过滤的活文字 HTML 做异步、显式 opt-in 的 H1 图片化。
 * 返回值才是预览、复制和长图共同使用的最终结果。
 */
export async function materializeHeadingImages({
  html,
  images = [],
  themeId,
  headingImages = [],
  fonts = [],
  assets = [],
  layoutWidth,
  referenceComposition = null,
  loadFont,
  loadNumberAsset,
  loadSideAsset = loadNumberAsset,
  renderPng = renderHeadingPng,
  cache = new HeadingImageLruCache(),
}) {
  if (!Array.isArray(headingImages) || headingImages.length === 0) {
    return { html, images, warnings: [], generatedCount: 0 };
  }
  const rules = new Map();
  for (const inputRule of headingImages) {
    const rule = scaleReferenceHeadingRule(inputRule, referenceComposition, layoutWidth);
    for (const level of rule.headingLevels) rules.set(level, rule);
  }
  const fontMap = new Map(fonts.map((font) => [font.id, font]));
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const fontPromises = new Map();
  const numberAssetPromises = new Map();
  const sideAssetPromises = new Map();
  const watermarkAssetPromises = new Map();
  const generatedImages = new Map();
  const warnings = [];
  const ruleOccurrences = new Map();
  const overflowWarnings = new Set();
  const paintFallbackWarnings = new Set();
  const sideFallbackWarnings = new Set();
  const watermarkFallbackWarnings = new Set();
  const warnSideFallback = (rule, reason) => {
    if (sideFallbackWarnings.has(rule.id)) return;
    sideFallbackWarnings.add(rule.id);
    warnings.push(`标题图片规则 ${rule.id} 的两侧装饰不可用，已保留完整标题图片：${reason}`);
  };
  const warnWatermarkFallback = (rule, reason) => {
    if (watermarkFallbackWarnings.has(rule.id)) return;
    watermarkFallbackWarnings.add(rule.id);
    warnings.push(`标题图片规则 ${rule.id} 的水印装饰不可用，已保留完整标题图片：${reason}`);
  };
  const matches = [...String(html ?? '').matchAll(HEADING)];
  const containerChains = referenceComposition || headingImages.some((entry) => entry.widthMode === 'container')
    ? headingContainerChains(html) : null;
  let output = '';
  let offset = 0;

  for (const [index, match] of matches.entries()) {
    output += html.slice(offset, match.index);
    offset = match.index + match[0].length;
    const level = Number(match[1]);
    let rule = rules.get(level);
    if (!rule) {
      output += match[0];
      continue;
    }
    const occurrence = (ruleOccurrences.get(rule.id) ?? 0) + 1;
    ruleOccurrences.set(rule.id, occurrence);
    const numberAssetIds = rule.numberAssets ?? [];
    const numberAssetId = numberAssetIds[occurrence - 1] ?? '';
    const watermarkAssetIds = rule.watermarkAssets ?? [];
    const watermarkAssetId = watermarkAssetIds.length > 0
      ? watermarkAssetIds[(occurrence - 1) % watermarkAssetIds.length]
      : '';
    if (
      numberAssetIds.length > 0
      && occurrence > numberAssetIds.length
      && !overflowWarnings.has(rule.id)
    ) {
      overflowWarnings.add(rule.id);
      warnings.push(
        `标题图片规则 ${rule.id} 的编号素材只有 ${numberAssetIds.length} 个；第 ${occurrence} 个及以后只画标题文字`,
      );
    }
    const content = CONTENT.exec(match[3]);
    if (!content) {
      warnings.push(`h${level} 含复杂行内内容，已保留活文字`);
      output += match[0];
      continue;
    }
    const parsedContent = parseHeadingInlineContent(content[2]);
    if (!parsedContent.ok) {
      warnings.push(`h${level} ${parsedContent.reason}，已保留活文字`);
      output += match[0];
      continue;
    }
    const { text, layoutText } = parsedContent;
    const font = fontMap.get(rule.fontId);
    if (!font) {
      warnings.push(`h${level}「${text || '空标题'}」缺少字体 ${rule.fontId}，已保留活文字`);
      output += match[0];
      continue;
    }

    try {
      if (referenceComposition) {
        const chain = containerChains.get(match.index);
        const contentStyle = inlineStyleMap(chain?.at(-1) ?? {});
        const cssFont = contentStyle['font-size'];
        if (cssFont && /^\d+(?:\.\d+)?px$/.test(cssFont) && Number.parseFloat(cssFont) > 0) {
          const fontSize = Number.parseFloat(cssFont);
          rule = { ...rule, fontSize, minEffectiveFontSize: fontSize };
        }
        const spacing = contentStyle['letter-spacing'];
        if (spacing === 'normal') rule = { ...rule, letterSpacing: 0 };
        else if (spacing && /^-?(?:\d*\.)?\d+(?:px|em)?$/.test(spacing)) {
          rule = { ...rule, letterSpacing: Number.parseFloat(spacing) * (spacing.endsWith('em') ? rule.fontSize : 1) };
        }
        const lineHeight = contentStyle['line-height'];
        if (lineHeight && /^(?:\d*\.)?\d+(?:px|em|%)?$/.test(lineHeight)) {
          const value = Number.parseFloat(lineHeight);
          const ratio = lineHeight.endsWith('px') ? value / rule.fontSize : lineHeight.endsWith('%') ? value / 100 : value;
          if (ratio > 0) rule = { ...rule, lineHeight: ratio };
        }
      }
      if (!fontPromises.has(font.id)) {
        fontPromises.set(font.id, Promise.resolve(loadFont(font, themeId)));
      }
      let loadedFont = await fontPromises.get(font.id);
      if (rule.fallbackFontIds !== undefined) {
        const fallbackFonts = await Promise.all(rule.fallbackFontIds.map(async (id) => {
          const definition = fontMap.get(id);
          if (!definition) throw new Error(`缺少备用字体 ${id}`);
          if (!fontPromises.has(id)) fontPromises.set(id, Promise.resolve(loadFont(definition, themeId)));
          return fontPromises.get(id);
        }));
        loadedFont = withCoveredFontFallbacks(loadedFont, fallbackFonts, parsedContent.layoutText);
      }
      const measureCanvas = loadedFont.document.createElement('canvas');
      const measureContext = measureCanvas.getContext('2d');
      if (!measureContext) throw new Error('无法取得标题测量画布');
      const measureGrapheme = typographyMeasurer(measureContext, {
        fontFamily: loadedFont.runtimeFamily,
        latinFontFamily: rule.latinFontFamily,
        fontSize: rule.fontSize,
        fontWeight: loadedFont.weight,
        fontStyle: loadedFont.style,
        familyForGrapheme: loadedFont.familyForGrapheme,
      });
      let numberAsset = null;
      if (numberAssetId) {
        const asset = assetMap.get(numberAssetId);
        if (!asset) {
          warnings.push(
            `h${level}「${text || '空标题'}」缺少编号素材 ${numberAssetId}，已只画标题文字`,
          );
        } else {
          try {
            if (!numberAssetPromises.has(numberAssetId)) {
              if (typeof loadNumberAsset !== 'function') throw new Error('未提供编号素材加载器');
              numberAssetPromises.set(
                numberAssetId,
                Promise.resolve(loadNumberAsset(asset, themeId)),
              );
            }
            numberAsset = {
              ...await numberAssetPromises.get(numberAssetId),
              id: numberAssetId,
              occurrence,
            };
          } catch (error) {
            warnings.push(
              `h${level}「${text || '空标题'}」编号素材 ${numberAssetId} 加载失败，已只画标题文字：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      const prefix = numberPrefixLayout(numberAsset, rule, measureGrapheme);
      let watermarkAsset = null;
      if (watermarkAssetId) {
        try {
          if (!watermarkAssetPromises.has(watermarkAssetId)) {
            const asset = assetMap.get(watermarkAssetId);
            if (!asset || typeof loadSideAsset !== 'function') throw new Error(`无法加载 ${watermarkAssetId}`);
            watermarkAssetPromises.set(
              watermarkAssetId,
              Promise.resolve(loadSideAsset(asset, themeId)),
            );
          }
          watermarkAsset = {
            ...await watermarkAssetPromises.get(watermarkAssetId),
            id: watermarkAssetId,
            occurrence,
          };
          if (!watermarkAsset.image || !watermarkAsset.hash
            || !(watermarkAsset.width > 0) || !(watermarkAsset.height > 0)) {
            throw new Error(`素材 ${watermarkAssetId} 尺寸不正确`);
          }
        } catch (error) {
          watermarkAsset = null;
          warnWatermarkFallback(rule, error instanceof Error ? error.message : String(error));
        }
      }
      let activeRule = rule;
      if (rule.widthMode === 'container') {
        const available = headingContainerWidth(containerChains.get(match.index), layoutWidth, rule.maxWidth);
        if (available < rule.fontSize * 2 + rule.paddingX * 2) throw new Error('标题文字安全区过窄，已保留字号与原文');
        activeRule = { ...rule, maxWidth: available, minDisplayWidth: available };
      }
      let sideAssets = null;
      const withoutSides = () => {
        activeRule = { ...activeRule };
        delete activeRule.sideAssets;
        sideAssets = null;
      };
      if (rule.sideAssets) {
        try {
          const load = async (assetId) => {
            if (!sideAssetPromises.has(assetId)) {
              const asset = assetMap.get(assetId);
              if (!asset || typeof loadSideAsset !== 'function') throw new Error(`无法加载 ${assetId}`);
              sideAssetPromises.set(assetId, Promise.resolve(loadSideAsset(asset, themeId)));
            }
            const loaded = await sideAssetPromises.get(assetId);
            if (!loaded.image || !(loaded.width > 0) || !(loaded.height > 0)) {
              throw new Error(`素材 ${assetId} 尺寸不正确`);
            }
            return loaded;
          };
          const [left, right] = await Promise.all([
            rule.sideAssets.leftAssetId ? load(rule.sideAssets.leftAssetId) : null,
            rule.sideAssets.rightAssetId ? load(rule.sideAssets.rightAssetId) : null,
          ]);
          sideAssets = { ...(left ? { left } : {}), ...(right ? { right } : {}) };
        } catch (error) {
          withoutSides();
          warnSideFallback(rule, error instanceof Error ? error.message : String(error));
        }
      }
      let layout = layoutHeadingText(layoutText, { ...activeRule, measureGrapheme, prefix });
      if (!layout.ok && sideAssets) {
        const reason = layout.reason;
        withoutSides();
        layout = layoutHeadingText(layoutText, { ...activeRule, measureGrapheme, prefix });
        if (layout.ok) warnSideFallback(rule, reason);
      }
      if (!layout.ok) throw new Error(layout.reason);
      const key = headingImageCacheKey({
        themeId,
        fontHash: loadedFont.hash,
        text: layoutText,
        rule: activeRule,
        numberAsset,
        sideAssets,
        watermarkAsset,
      });
      let generated = cache.get(key);
      if (!generated) {
        const renderVerified = (renderRule) => {
          const rendered = renderPng({
            layout,
            rule: renderRule,
            font: loadedFont,
            numberAsset,
            watermarkAsset,
            ...(sideAssets ? { sideAssets } : {}),
            document: loadedFont.document,
          });
          return verifyGeneratedHeadingPng(rendered.bytes, {
            physicalWidth: rendered.physicalWidth,
            physicalHeight: rendered.physicalHeight,
          });
        };
        let bytes;
        let paintFallbackReason = '';
        let sideFallbackReason = '';
        const renderWithPaintFallback = () => {
          try {
            return renderVerified(activeRule);
          } catch (error) {
            if (!activeRule.textPaint) throw error;
            const fallbackRule = { ...activeRule };
            delete fallbackRule.textPaint;
            paintFallbackReason = error instanceof Error ? error.message : String(error);
            try {
              return renderVerified(fallbackRule);
            } catch (fallbackError) {
              throw new Error(`鎏金绘制失败：${paintFallbackReason}；单色回退也失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
            }
          }
        };
        try {
          bytes = renderWithPaintFallback();
        } catch (error) {
          if (!sideAssets) throw error;
          sideFallbackReason = error instanceof Error ? error.message : String(error);
          withoutSides();
          layout = layoutHeadingText(layoutText, { ...activeRule, measureGrapheme, prefix });
          if (!layout.ok) throw new Error(layout.reason);
          bytes = renderWithPaintFallback();
        }
        generated = {
          ...layout,
          bytes,
          ...(paintFallbackReason ? { paintFallbackReason } : {}),
          ...(sideFallbackReason ? { sideFallbackReason } : {}),
        };
        cache.set(key, generated);
      }
      if (generated.sideFallbackReason) warnSideFallback(rule, generated.sideFallbackReason);
      if (generated.paintFallbackReason && !paintFallbackWarnings.has(rule.id)) {
        paintFallbackWarnings.add(rule.id);
        warnings.push(
          `标题图片规则 ${rule.id} 鎏金绘制失败，已使用单色标题：${generated.paintFallbackReason}`,
        );
      }
      const dataUrl = bytesToDataUrl(generated.bytes);
      output += `<h${level}${match[2]}>${headingImageHtml({
        dataUrl,
        text,
        width: generated.width,
        height: generated.height,
        align: rule.align,
      })}</h${level}>`;
      if (!generatedImages.has(dataUrl)) {
        generatedImages.set(dataUrl, {
          target: `generated-heading-${themeId}-${rule.id}-${index + 1}.png`,
          url: dataUrl,
          origin: 'generated',
          bytes: generated.bytes,
          mimeType: 'image/png',
          fallbackHtml: content[1],
          alt: text,
        });
      }
    } catch (error) {
      warnings.push(
        `h${level}「${text || '空标题'}」图片化失败，已保留活文字：${error instanceof Error ? error.message : String(error)}`,
      );
      output += match[0];
    }
  }
  output += html.slice(offset);

  return {
    html: output,
    images: [...images, ...generatedImages.values()],
    warnings: [...new Set(warnings)],
    generatedCount: generatedImages.size,
  };
}

export class HeadingImageRuntime {
  constructor({
    vault,
    document: ownerDocument = globalThis.document,
    FontFaceClass = globalThis.FontFace,
    fontSet = ownerDocument?.fonts,
    cache = new HeadingImageLruCache(),
    fontTimeoutMs = 10_000,
    imageTimeoutMs = 10_000,
  } = {}) {
    this.vault = vault;
    this.document = ownerDocument;
    this.FontFaceClass = FontFaceClass;
    this.fontSet = fontSet;
    this.cache = cache;
    this.quoteCache = new HeadingImageLruCache();
    this.orderedListCache = new HeadingImageLruCache();
    this.inlinePaintCache = new HeadingImageLruCache();
    this.fontTimeoutMs = fontTimeoutMs;
    this.imageTimeoutMs = imageTimeoutMs;
    this.fonts = new Map();
    this.numberAssets = new Map();
    this.disposed = false;
  }

  async loadFont(font, themeId = 'theme') {
    if (this.disposed) throw new Error('标题图片运行时已经关闭');
    if (!this.vault?.readBinary || !font?.file) throw new Error('字体文件不可读');
    if (!this.FontFaceClass || !this.fontSet?.add) throw new Error('当前 Obsidian 不支持 FontFace');
    const maxBytes = themeFontByteLimit(font);
    const sizeError = () => new Error(`字体文件超过 ${maxBytes / 1024 / 1024} MiB 上限`);
    if ((font.file.stat?.size ?? 0) > maxBytes) throw sizeError();
    let coverageFile = null;
    if (font.coverageFile) {
      const marker = THEME_FONT_DIRECTORIES.map((directory) => `/${directory}/`).find((part) => font.filePath.includes(part));
      if (!marker) throw new Error('字体覆盖表无法定位主题目录');
      const coveragePath = font.filePath.slice(0, font.filePath.lastIndexOf(marker) + 1) + font.coverageFile;
      coverageFile = this.vault.getAbstractFileByPath?.(coveragePath);
      if (!coverageFile || Array.isArray(coverageFile.children)) throw new Error('字体覆盖表不存在');
    }
    const fileKey = [
      font.filePath,
      font.file.stat?.mtime ?? 0,
      font.file.stat?.size ?? 0,
      font.sha256,
      maxBytes,
      ...(coverageFile ? [coverageFile.path, coverageFile.stat?.mtime ?? 0, coverageFile.stat?.size ?? 0] : []),
    ].join(':');
    const existing = this.fonts.get(fileKey);
    if (existing) return existing;

    const bytes = Buffer.from(await this.vault.readBinary(font.file));
    if (bytes.byteLength > maxBytes) throw sizeError();
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== font.sha256) throw new Error('字体 SHA-256 与 manifest 不一致');
    let coverage = {};
    if (coverageFile) {
      const read = this.vault.read ?? this.vault.cachedRead;
      if (!read) throw new Error('字体覆盖表不可读取');
      coverage = parseFontCoverage(await read.call(this.vault, coverageFile));
    }
    const safeThemeId = String(themeId).replace(/[^a-z0-9_-]/gi, '-').slice(0, 48) || 'theme';
    const runtimeFamily = `cfwx-${safeThemeId}-${font.id}-${hash.slice(0, 12)}`;
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const face = new this.FontFaceClass(runtimeFamily, arrayBuffer, {
      weight: String(font.weight),
      style: font.style,
    });
    let timeoutId = null;
    const timeout = new Promise((_, reject) => {
      timeoutId = globalThis.setTimeout(
        () => reject(new Error('字体加载超时')),
        this.fontTimeoutMs,
      );
    });
    try {
      await Promise.race([face.load(), timeout]);
    } finally {
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
    }
    if (this.disposed) throw new Error('标题图片运行时已经关闭');
    this.fontSet.add(face);
    const loaded = {
      runtimeFamily,
      hash,
      face,
      document: this.document,
      weight: font.weight,
      style: font.style,
      ...coverage,
    };
    this.fonts.set(fileKey, loaded);
    return loaded;
  }

  async loadNumberAsset(asset) {
    if (this.disposed) throw new Error('标题图片运行时已经关闭');
    if (!this.vault?.readBinary || !asset?.file) throw new Error('编号素材文件不可读');
    if (!this.document?.createElement) throw new Error('当前环境不能解码编号素材');
    const fileKey = [
      asset.filePath,
      asset.file.stat?.mtime ?? 0,
      asset.file.stat?.size ?? 0,
    ].join(':');
    const existing = this.numberAssets.get(fileKey);
    if (existing) return existing;

    const bytes = Buffer.from(await this.vault.readBinary(asset.file));
    if (bytes.byteLength > NUMBER_ASSET_LIMIT) {
      throw new Error('编号素材超过单图 2 MiB 上限');
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    const image = this.document.createElement('img');
    const dataUrl = `data:${assetMimeType(asset)};base64,${bytes.toString('base64')}`;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        image.onload = null;
        image.onerror = null;
        if (error) reject(error);
        else resolve();
      };
      const timeoutId = globalThis.setTimeout(
        () => finish(new Error('编号素材解码超时')),
        this.imageTimeoutMs,
      );
      image.onload = () => finish();
      image.onerror = () => finish(new Error('编号素材无法解码'));
      image.src = dataUrl;
      if (image.complete && (image.naturalWidth || image.width)) finish();
    });
    const width = Number(image.naturalWidth || image.width);
    const height = Number(image.naturalHeight || image.height);
    if (!(width > 0 && height > 0)) throw new Error('编号素材尺寸无效');
    const loaded = { image, hash, width, height };
    this.numberAssets.set(fileKey, loaded);
    return loaded;
  }

  async materialize(input) {
    const headings = await materializeHeadingImages({
      ...input,
      loadFont: (font, themeId) => this.loadFont(font, themeId),
      loadNumberAsset: (asset) => this.loadNumberAsset(asset),
      cache: this.cache,
    });
    const quotes = input.quoteImages ? await materializeQuoteImages({
      ...input,
      html: headings.html,
      images: headings.images,
      loadFont: (font, themeId) => this.loadFont(font, themeId),
      loadIllustration: (asset) => this.loadNumberAsset(asset),
      cache: this.quoteCache,
      measureFactory: typographyMeasurer,
      renderPng: renderQuoteRichPng,
      verifyPng: verifyGeneratedHeadingPng,
      segmentGraphemes,
    }) : { ...headings, warnings: [], generatedCount: 0 };
    const ordered = await materializeOrderedListImages({
      ...input,
      html: quotes.html,
      images: quotes.images,
      loadFont: (font, themeId) => this.loadFont(font, themeId),
      cache: this.orderedListCache,
      loadEmblem: (asset) => this.loadNumberAsset(asset),
      measureFactory: typographyMeasurer,
      layoutText: layoutHeadingText,
      renderPng: renderHeadingPng,
      verifyPng: verifyGeneratedHeadingPng,
    });
    const inlinePaint=await materializeInlinePaint({
      html:ordered.html,images:ordered.images,layoutWidth:input.layoutWidth,
      document:this.document,cache:this.inlinePaintCache,
      readAsset:async asset=>{
        if(asset.bytes)return asset.bytes;
        const file=(input.assets??[]).find(a=>a.filePath===asset.filePath)?.file;
        if(!file)throw new Error('笔触素材文件不可读');
        return this.vault.readBinary(file);
      },
    });
    return {
      ...headings, html: inlinePaint.html, images: inlinePaint.images,
      warnings: [...headings.warnings, ...quotes.warnings, ...ordered.warnings, ...inlinePaint.warnings],
      ...(input.quoteImages ? { quoteGeneratedCount: quotes.generatedCount } : {}),
      ...(input.orderedListImages ? { orderedListGeneratedCount: ordered.generatedCount } : {}),
    };
  }

  dispose() {
    this.disposed = true;
    for (const font of this.fonts.values()) this.fontSet?.delete?.(font.face);
    this.fonts.clear();
    this.numberAssets.clear();
    this.cache.clear();
    this.quoteCache.clear();
    this.orderedListCache.clear();
    this.inlinePaintCache.clear();
  }
}
