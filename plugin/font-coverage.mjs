import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

export function parseFontCoverage(source) {
  const text = String(source ?? '');
  if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('字体覆盖表超过 2 MiB');
  const values = JSON.parse(text);
  if (!Array.isArray(values) || values.length > 200_000 || values.some((value) => !Number.isInteger(value) || value < 0 || value > 0x10FFFF || (value >= 0xD800 && value <= 0xDFFF))) {
    throw new Error('字体覆盖表必须是 Unicode 码点整数数组');
  }
  return { coverage: new Set(values), coverageHash: createHash('sha256').update(text).digest('hex') };
}

/** Explicit, already-loaded theme fonts only; unsupported glyphs stay live text. */
export function withCoveredFontFallbacks(primary, fallbacks, text) {
  const fonts = [primary, ...fallbacks];
  if (fonts.some((font) => !(font.coverage instanceof Set))) throw new Error('字体或备用字体缺少有效覆盖表 coverage_file，已避免生成缺字图片');
  const chosen = new Map();
  const select = (grapheme) => {
    if (chosen.has(grapheme)) return chosen.get(grapheme);
    const points = Array.from(grapheme).filter((character) => character !== '\n').map((character) => character.codePointAt(0));
    const font = fonts.find((candidate) => points.every((point) => candidate.coverage.has(point)));
    if (!font) throw new Error(`主题字体均不支持字形「${grapheme}」，已保留完整活文字`);
    const family = `"${font.runtimeFamily}"`;
    chosen.set(grapheme, family);
    return family;
  };
  // Reject missing codepoints before allocating a canvas, even if a caller's
  // grapheme segmentation later groups combining sequences differently.
  for (const character of Array.from(text)) if (character !== '\n') select(character);
  return {
    ...primary,
    hash: createHash('sha256').update(JSON.stringify(fonts.map((font) => [font.hash, font.coverageHash]))).digest('hex'),
    familyForGrapheme: select,
  };
}
