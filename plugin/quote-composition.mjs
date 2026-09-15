import { Buffer } from 'node:buffer';
import { PNG } from 'pngjs';
import { parseDocument } from 'htmlparser2';
import { cssLength, inlineStyleMap } from './layout-box.mjs';

const MAX_PIXELS = 12_000_000;
const MAX_HEIGHT = 8192;

const edge = (css, property, side, reference, fontSize) => {
  const values = (css[property] ?? '0').split(/\s+/);
  const parts = values.length === 1 ? Array(4).fill(values[0])
    : values.length === 2 ? [values[0], values[1], values[0], values[1]]
      : values.length === 3 ? [...values, values[1]] : values;
  return cssLength(css[`${property}-${side}`] ?? parts[['top', 'right', 'bottom', 'left'].indexOf(side)], reference, fontSize);
};

/** Keep the already-rendered glyph pixels at their original scale. Only the
 * illustration is resized; receiving editors cannot redistribute the columns.
 * Failure is atomic: the caller retains the complete original rich quote.
 */
export function renderQuoteComposition({ content, records, illustration, width, rule, document }) {
  const scale = rule.scale;
  if (!Number.isInteger(width) || width < 120 || width > 1000 || ![2, 3].includes(scale)) throw new Error('引用合成宽度或倍率无效');
  if (!illustration?.image || !(illustration.width > 0 && illustration.height > 0)) throw new Error('引用插画未解码');
  const artWidth = width * rule.illustration.widthPercent / 100;
  const textX = width * (rule.illustration.widthPercent + rule.illustration.gapPercent) / 100;
  const textWidth = width - textX;
  const recordMap = new Map(records.map(record => [record.url, record]));
  const placements = [];
  const paragraphs = [];
  let y = 0;
  for (const node of parseDocument(content, { decodeEntities: true }).children) {
    if (node.type === 'comment' || node.type === 'text' && !node.data.trim()) continue;
    if (node.name === 'br') { y += rule.fontSize * rule.lineHeight; continue; }
    if (node.name !== 'p') throw new Error('引用合成仅支持完整段落');
    const css = inlineStyleMap(node);
    // Do not silently discard a paragraph-level painted surface.
    if (css['background-image'] && css['background-image'] !== 'none'
      || css['background-color'] && css['background-color'] !== 'transparent'
      || Object.entries(css).some(([key, value]) => /^border(?:-(?:top|right|bottom|left))?$/.test(key) && !/^(?:none|0(?:px)?)(?:\s|$)/.test(value))) {
      throw new Error('带段落底图或边框的引用需保留原文');
    }
    const fontSize = css['font-size'] ? cssLength(css['font-size'], textWidth, rule.fontSize) : rule.fontSize;
    const left = edge(css, 'margin', 'left', textWidth, fontSize) + edge(css, 'padding', 'left', textWidth, fontSize);
    y += edge(css, 'margin', 'top', textWidth, fontSize) + edge(css, 'padding', 'top', textWidth, fontSize);
    let paragraphText = '';
    for (const child of node.children) {
      if (child.type === 'comment' || child.type === 'text' && !child.data.trim()) continue;
      const record = child.name === 'img' && recordMap.get(child.attribs.src);
      if (!record || child.attribs['data-wechat-generated-quote'] !== 'true') throw new Error('引用合成含未图片化内容');
      const bytes = Buffer.from(record.bytes);
      const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
      if (w > width * scale || h > MAX_HEIGHT || w * h > MAX_PIXELS) throw new Error('引用字图超过合成安全范围');
      if (Math.round((textX + left) * scale) + w > width * scale) throw new Error('引用文字超出右侧边界，已避免缩小字号');
      placements.push({ bytes, x: textX + left, y, width: w / scale, height: h / scale, fontSize });
      paragraphText += record.alt;
      y += h / scale;
    }
    paragraphs.push(paragraphText);
    y += edge(css, 'padding', 'bottom', textWidth, fontSize) + edge(css, 'margin', 'bottom', textWidth, fontSize);
  }
  if (!placements.length) throw new Error('引用合成没有完整字图');
  const artHeight = artWidth * illustration.height / illustration.width;
  const height = Math.ceil(Math.max(y, artHeight));
  const physicalWidth = width * scale, physicalHeight = height * scale;
  if (physicalHeight > MAX_HEIGHT || physicalWidth * physicalHeight > MAX_PIXELS) throw new Error('引用过长，已保留完整活文字');
  const canvas = document.createElement('canvas');
  canvas.width = physicalWidth; canvas.height = physicalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建引用合成画布');
  ctx.clearRect(0, 0, physicalWidth, physicalHeight);
  ctx.drawImage(illustration.image, 0, (height - artHeight) / 2 * scale, artWidth * scale, artHeight * scale);
  const pixels = ctx.getImageData(0, 0, physicalWidth, physicalHeight);
  const output = { width: physicalWidth, height: physicalHeight, data: Buffer.from(pixels.data) };
  const textOffset = (height - y) / 2;
  for (const part of placements) {
    const text = PNG.sync.read(part.bytes);
    PNG.bitblt(text, output, 0, 0, text.width, text.height, Math.round(part.x * scale), Math.round((part.y + textOffset) * scale));
  }
  const bytes = PNG.sync.write(output, { colorType: 6, inputColorType: 6, inputHasAlpha: true });
  return { bytes, physicalWidth, physicalHeight, height, alt: paragraphs.join('\n\n'),
    geometry: { width, height, art: { x: 0, y: (height - artHeight) / 2, width: artWidth, height: artHeight },
      text: { x: textX, y: textOffset, width: textWidth, height: y },
      glyphScale: 1, fontSizes: [...new Set(placements.map(part => part.fontSize))] } };
}
