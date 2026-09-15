import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { parseDocument } from 'htmlparser2';
import { withCoveredFontFallbacks } from './font-coverage.mjs';
import { DEFAULT_MAX_PROCESSED_RESOURCES } from './copy.mjs';
import { indexWechatImageReferences } from '../src/wechat-compat.mjs';
import { extractQuoteRichText, layoutQuoteRichText, makeQuoteRichMeasurer, scaleQuoteRichText, sliceQuoteRichHtml } from './quote-rich-text.mjs';
import { scaleReferenceQuoteRule, referenceLayoutScale } from '../src/reference-composition.mjs';
import { headingContainerWidth } from './layout-box.mjs';
import { textPaintPadding } from './text-paint.mjs';
import { resolveResponsiveQuoteTypography } from './quote-typography.mjs';
import { renderQuoteComposition } from './quote-composition.mjs';

const CLOSE = /^[，。！？；：、）》】」』”’…,.!?;:%)\]}]/u;
const MAX_PARAGRAPH_GRAPHEMES = 2000;
const LINES_PER_IMAGE = 4;
const MAX_PARAGRAPH_IMAGES = 32;
const MAX_ARTICLE_IMAGES = 128;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const element = (node) => typeof node?.name === 'string';
// Inlining ::before/::after { content:none } can leave bare empty spans.
// Only attribute-free whitespace placeholders are safe to discard.
const emptyPseudoSpan = (node) => node.name === 'span'
  && Object.keys(node.attribs ?? {}).length === 0
  && (node.children ?? []).every(child => child.type === 'text' && !child.data.trim());
const styleMap = (node) => Object.fromEntries(String(node?.attribs?.style ?? '').split(';').map((part) => { const at = part.indexOf(':'); return [part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()]; }).filter(([name]) => name));
const boxNode = (style) => ({ name: 'section', attribs: { style } });

function quoteIllustrationBoxes(rule) {
  const illustration = rule.illustration;
  const textPercent = Number((100 - illustration.widthPercent - illustration.gapPercent).toFixed(6));
  return {
    row: `display:block;width:100%;max-width:${rule.maxWidth}px;margin:0;padding:0;border:0;background:transparent;font-size:0;line-height:0;text-align:left;`,
    art: `display:inline-block;width:${illustration.widthPercent}%;margin:0;padding:0;border:0;vertical-align:middle;box-sizing:border-box;`,
    text: `display:inline-block;width:${textPercent}%;margin:0 0 0 ${illustration.gapPercent}%;padding:0;border:0;vertical-align:middle;box-sizing:border-box;font-size:${rule.fontSize}px;line-height:${rule.lineHeight};color:${rule.color};text-align:left;`,
  };
}

function illustratedQuoteHtml(content, rule, asset, boxes) {
  const image = `<img data-wechat-quote-art="true" data-no-dark="" src="${escape(asset.url)}" alt="${escape(asset.alt ?? '')}" style="display:block;width:100%;max-width:100%;height:auto;max-height:none;margin:0;padding:0;border:0;border-radius:0;background:transparent;">`;
  if (rule.illustration.layout === 'table') {
    const {widthPercent,gapPercent}=rule.illustration;
    const textColumnPercent=Number((100-widthPercent).toFixed(6));
    const innerGapPercent=Number((gapPercent/textColumnPercent*100).toFixed(6));
    const cell='padding:0;margin:0;border:0;background:transparent;vertical-align:middle;';
    // Keep only two real columns: a spacer cell can become a full-width column
    // when the receiving editor redistributes widths. An inner margin retains
    // the measured text area without influencing the table's column algorithm.
    return `<table role="presentation" data-wechat-quote-illustration="true" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:${rule.maxWidth}px;margin:0;padding:0;border:0;border-collapse:collapse;border-spacing:0;table-layout:fixed;background:transparent;"><tbody style="border:0;background:transparent;"><tr style="border:0;background:transparent;"><td data-wechat-quote-art-column="true" width="${widthPercent}%" valign="middle" style="${cell}width:${widthPercent}%;">${image}</td><td data-wechat-quote-text-column="true" width="${textColumnPercent}%" valign="middle" style="${cell}width:${textColumnPercent}%;font-size:${rule.fontSize}px;line-height:${rule.lineHeight};color:${rule.color};"><section data-wechat-quote-text-inset="true" style="display:block;margin:0 0 0 ${innerGapPercent}%;padding:0;border:0;background:transparent;">${content}</section></td></tr></tbody></table>`;
  }
  // Adjacent inline blocks contain no whitespace. The art keeps its native
  // ratio, and whichever column is taller determines the quote's height.
  return `<section data-wechat-quote-illustration="true" style="${boxes.row}"><section data-wechat-quote-art-column="true" style="${boxes.art}">${image}</section><section data-wechat-quote-text-column="true" style="${boxes.text}">${content}</section></section>`;
}

const length = (value, fontSize, reference) => {
  if (!value || value === 'auto') return 0;
  const match = /^([0-9.]+)(px|em|rem|%)?$/.exec(value);
  if (!match) return 0;
  const n = Number(match[1]);
  return match[2] === '%' ? n * reference / 100 : match[2] === 'em' ? n * fontSize : match[2] === 'rem' ? n * 16 : n;
};

const horizontal = (css, property, fontSize, reference) => {
  const parts = (css[property] ?? '0').split(/\s+/);
  const left = parts.length === 4 ? parts[3] : parts.length >= 2 ? parts[1] : parts[0];
  const right = parts.length >= 2 ? parts[1] : parts[0];
  return length(css[`${property}-left`] ?? left, fontSize, reference) + length(css[`${property}-right`] ?? right, fontSize, reference);
};

const borderWidth = (css, side, fontSize, reference) => {
  const values = (css['border-width'] ?? '').split(/\s+/).filter(Boolean);
  const indexed = values.length === 4 ? values[side === 'left' ? 3 : 1] : values.length >= 2 ? values[1] : values[0];
  const shorthand = css[`border-${side}`] ?? css.border;
  const token = css[`border-${side}-width`] ?? indexed ?? shorthand?.split(/\s+/)[0];
  if (token === 'none' || token === 'hidden') return 0;
  if (['thin', 'medium', 'thick'].includes(token)) return { thin: 1, medium: 3, thick: 5 }[token];
  return length(token, fontSize, reference);
};

/** Width comes from the same final inline HTML as preview/copy, never an H1 width. */
export function quoteParagraphWidth(chain, rule, layoutWidth) {
  if (!Number.isFinite(layoutWidth) || layoutWidth < 240 || layoutWidth > 1000) return rule.fallbackWidth;
  let available = layoutWidth;
  let fontSize = 16;
  for (const node of chain) {
    const css = styleMap(node);
    if (css['font-size']) fontSize = length(css['font-size'], fontSize, available) || fontSize;
    const space = horizontal(css, 'padding', fontSize, available) + horizontal(css, 'margin', fontSize, available);
    const border = borderWidth(css, 'left', fontSize, available) + borderWidth(css, 'right', fontSize, available);
    available = Math.max(0, available - space - border);
    if (css.width && css.width !== 'auto') available = Math.min(available, length(css.width, fontSize, available));
    if (css['max-width'] && css['max-width'] !== 'none') available = Math.min(available, length(css['max-width'], fontSize, available));
  }
  return Math.floor(Math.min(rule.maxWidth, available));
}

function openingEnd(html, index) {
  let quote = '';
  for (let at = index; at < html.length; at += 1) {
    const c = html[at];
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return at + 1;
  }
  throw new Error('引用段落标签不完整');
}

/** Linear greedy wrapping. Do not reuse the heading's exponential balance search. */
export function layoutQuoteLines(text, { maxWidth, fontSize, letterSpacing, measureGrapheme, segmentGraphemes }) {
  const graphemes = segmentGraphemes(text);
  if (graphemes.length > MAX_PARAGRAPH_GRAPHEMES) throw new Error('金句段落超过 2000 字形安全上限');
  const lines = [];
  let line = [];
  let width = 0;
  const lineWidth = (items) => items.reduce((total, g, index) => total + measureGrapheme(g) + (index ? letterSpacing : 0), 0);
  const push = (forced = false) => { lines.push({ text: line.join('').trimEnd(), raw: line.join('') + (forced ? '\n' : '') }); line = []; width = 0; };
  for (const grapheme of graphemes) {
    if (grapheme === '\n') { push(true); continue; }
    const glyphWidth = measureGrapheme(grapheme);
    if (!Number.isFinite(glyphWidth) || glyphWidth < 0 || glyphWidth > maxWidth) throw new Error('金句字形超过可用宽度');
    if (line.length && width + letterSpacing + glyphWidth > maxWidth) {
      const carry = CLOSE.test(grapheme) && line.length > 1 ? line.pop() : null;
      push();
      if (carry) { line.push(carry); width = lineWidth(line); }
    }
    width += (line.length ? letterSpacing : 0) + glyphWidth;
    line.push(grapheme);
  }
  if (line.length || text.endsWith('\n')) push();
  if (!lines.length || lines.length > MAX_PARAGRAPH_IMAGES * LINES_PER_IMAGE) throw new Error('金句行数超出安全范围');
  if (maxWidth < fontSize * 2) throw new Error('引用文字区域过窄');
  return lines;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (data) => { let crc = 0xFFFFFFFF; for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xFFFFFFFF) >>> 0; };

// Copy deduplicates by URL. A lossless ancillary tag keeps each occurrence's
// fallback metadata separate, even when two differently styled quotes look alike.
export function tagQuotePng(bytes, identity) {
  const data = Buffer.from(`cfwx-quote\0${identity}`, 'latin1');
  const type = Buffer.from('tEXt');
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); type.copy(chunk, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), data.length + 8);
  return Buffer.concat([bytes.subarray(0, -12), chunk, bytes.subarray(-12)]);
}

export async function materializeQuoteImages({ html, images = [], themeId, quoteImages: rule, fonts = [], assets = [], layoutWidth, referenceComposition = null, loadFont, loadIllustration, cache, measureFactory, renderPng, verifyPng, segmentGraphemes }) {
  if (!rule) return { html, images, warnings: [], generatedCount: 0 };
  const sourceTypographyRule = scaleReferenceQuoteRule(rule, referenceComposition, layoutWidth);
  const responsive = resolveResponsiveQuoteTypography(rule, layoutWidth, sourceTypographyRule);
  rule = responsive.rule;
  const referenceScale = referenceLayoutScale(referenceComposition, layoutWidth);
  const source = String(html ?? '');
  const dom = parseDocument(source, { decodeEntities: true, withStartIndices: true, withEndIndices: true });
  const root = dom.children.find((node) => node.name === 'section' && node.attribs?.id === 'nice');
  if (!root) return { html, images, warnings: ['金句图片化未找到正文根容器，已保留原文'], generatedCount: 0 };
  const quotes = [];
  for (const node of root.children) {
    if (node.name === 'blockquote') quotes.push({ quote: node, ancestors: [root] });
    else if (referenceComposition && node.name === 'section'
      && ['opening', 'feature'].includes(node.attribs?.['data-wechat-scene'])) {
      for (const quote of node.children.filter((child) => child.name === 'blockquote')) quotes.push({ quote, ancestors: [root, node] });
    }
  }
  const replacements = [];
  const records = [];
  const illustrationRecords = new Map();
  const illustrationAsset = rule.illustration ? assets.find(asset => asset.id === rule.illustration.assetId) : null;
  const registeredSources = new Set(images.map((image) => image?.url).filter((url) => typeof url === 'string' && url));
  const existingResources = new Set(indexWechatImageReferences(source, { sources: registeredSources }).occurrences.map((occurrence) => occurrence.source));
  const reservedIllustrations = illustrationAsset?.url && !existingResources.has(illustrationAsset.url) ? 1 : 0;
  const imageBudget = Math.max(0, Math.min(MAX_ARTICLE_IMAGES, DEFAULT_MAX_PROCESSED_RESOURCES - existingResources.size - reservedIllustrations));
  const warnings = [];
  const fontMap = new Map(fonts.map((font) => [font.id, font]));
  const loadedFonts = new Map();
  let illustrationPromise;
  const getFont = async (id) => {
    if (!fontMap.has(id)) throw new Error(`未找到字体 ${id}`);
    if (!loadedFonts.has(id)) loadedFonts.set(id, Promise.resolve(loadFont(fontMap.get(id), themeId)));
    return loadedFonts.get(id);
  };
  for (const [quoteIndex, { quote, ancestors }] of quotes.entries()) {
    const structuralChildren = quote.children.filter(element);
    const surface = structuralChildren.length === 1 && structuralChildren[0].name === 'section' && structuralChildren[0].attribs?.['data-wechat-darkmode-surface'] === 'quote' ? structuralChildren[0] : quote;
    if (surface.children.some(node => node.attribs?.['data-wechat-quote-illustration'] === 'true')) continue;
    const supported = surface.children.every((node) => node.type === 'comment' || (node.type === 'text' && !node.data.trim()) || (element(node) && ['p', 'span', 'br'].includes(node.name)));
    if (!supported) { warnings.push(`第 ${quoteIndex + 1} 处引用含嵌套块，已保留完整活文字`); continue; }
    const paragraphs = surface.children.filter((node) => node.name === 'p');
    let illustrationBoxes = null;
    if (rule.illustration) {
      try {
        const plain = surface.children.every(node => node.type === 'comment'
          || (node.type === 'text' && !node.data.trim()) || ['p', 'br'].includes(node.name) || emptyPseudoSpan(node));
        if (!plain) throw new Error('引用含段落之外的行内内容或装饰');
        if (!illustrationAsset?.url || typeof loadIllustration !== 'function') throw new Error('引用建筑素材不可读取');
        illustrationPromise ??= Promise.resolve(loadIllustration(illustrationAsset));
        const loaded = await illustrationPromise;
        if (!(Number.isFinite(loaded?.width) && loaded.width > 0 && Number.isFinite(loaded?.height) && loaded.height > 0)) throw new Error('引用建筑素材尺寸无效');
        illustrationBoxes = quoteIllustrationBoxes(rule);
        // Measuring these exact boxes before inserting them makes the PNG text
        // use the real right column at 320px, desktop, copy and export widths.
        headingContainerWidth([...ancestors, quote, ...(surface === quote ? [] : [surface]), boxNode(illustrationBoxes.row), boxNode(illustrationBoxes.text)], layoutWidth, rule.maxWidth);
      } catch (error) {
        warnings.push(`第 ${quoteIndex + 1} 处引用图文排布不可用，已保留完整原文：${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    const firstReplacement = replacements.length;
    const firstRecord = records.length;
    const firstWarning = warnings.length;
    let illustrationFailed = false;
    for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
      try {
        const rich = scaleQuoteRichText(extractQuoteRichText(paragraph, sourceTypographyRule), responsive.factor);
        const text = rich.text;
        if (!text.trim()) continue;
        if (segmentGraphemes(text).length > MAX_PARAGRAPH_GRAPHEMES) throw new Error('金句段落超过 2000 字形安全上限');
        if (/^\[![^\]]+\]/.test(text)) throw new Error('提示块标记不作为金句图片化');
        const chain = [...ancestors, quote, ...(surface === quote ? [] : [surface]),
          ...(illustrationBoxes ? [boxNode(illustrationBoxes.row), boxNode(illustrationBoxes.text)] : []), paragraph];
        const width = referenceComposition || illustrationBoxes ? headingContainerWidth(chain, layoutWidth, rule.maxWidth)
          : quoteParagraphWidth(chain, rule, layoutWidth);
        const primary = await getFont(rule.fontId);
        const fallbacks = await Promise.all((rule.fallbackFontIds ?? []).map(getFont));
        const handwritingText = rich.runs.filter((run) => !run.style.code || run.style.codeFont === 'quote').map((run) => run.text).join('');
        const font = withCoveredFontFallbacks(primary, fallbacks, handwritingText);
        const canvas = font.document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法创建金句测量画布');
        const measure = makeQuoteRichMeasurer(context, font, measureFactory);
        const paintPadding = textPaintPadding(rule.textPaint);
        const drawRule = { ...rule, align: 'left', paddingX: Math.max(referenceComposition ? 0 : 2, paintPadding), paddingY: Math.max(referenceScale, paintPadding), latinFontFamily: font.runtimeFamily };
        const lines = layoutQuoteRichText(rich, { maxWidth: width - drawRule.paddingX * 2, rule, measure, segmentGraphemes });
        const chunks = [];
        for (let at = 0; at < lines.length; at += LINES_PER_IMAGE) chunks.push(lines.slice(at, at + LINES_PER_IMAGE));
        if (records.length + chunks.length > imageBudget) throw new Error('金句图片数量超过本次剩余安全额度');
        const start = openingEnd(source, paragraph.startIndex);
        const closing = source.slice(paragraph.startIndex, paragraph.endIndex + 1).match(/<\/p\s*>$/i);
        if (!closing) throw new Error('引用段落闭合结构不完整');
        const end = paragraph.endIndex + 1 - closing[0].length;
        const originalInner = source.slice(start, end);
        const pending = [];
        const replacementsHtml = [];
        let paintFallback = false;
        for (const [chunkIndex, chunk] of chunks.entries()) {
          const layout = { width, height: Math.ceil(chunk.reduce((sum, line) => sum + line.height, 0) + drawRule.paddingY * 2), lines: chunk.map((line) => line.text), richLines: chunk };
          const rawText = text.slice(chunk[0].start, chunk.at(-1).end);
          const key = hash(JSON.stringify(['quote-rich-v2', themeId, font.hash, drawRule, layout, rawText]));
          let generated = cache?.get(key);
          if (!generated) {
            const draw = async (renderRule) => {
              const result = await renderPng({ layout, rule: renderRule, font, document: font.document });
              return verifyPng(result.bytes, { physicalWidth: layout.width * rule.scale, physicalHeight: layout.height * rule.scale });
            };
            try {
              generated = { bytes: await draw(drawRule) };
            } catch (error) {
              if (!drawRule.textPaint) throw error;
              const fallbackRule = { ...drawRule };
              delete fallbackRule.textPaint;
              generated = { bytes: await draw(fallbackRule), paintFallback: true };
            }
            cache?.set(key, generated);
          }
          if (generated.paintFallback) paintFallback = true;
          const identity = hash(JSON.stringify([themeId, quoteIndex, paragraphIndex, chunkIndex, originalInner]));
          const bytes = tagQuotePng(Buffer.from(generated.bytes), identity);
          const url = `data:image/png;base64,${bytes.toString('base64')}`;
          const fallbackHtml = chunks.length === 1 ? originalInner : sliceQuoteRichHtml(rich.tree, chunk[0].start, chunk.at(-1).end);
          replacementsHtml.push(`<img data-wechat-generated-quote="true" src="${url}" alt="${escape(rawText)}" width="${layout.width}" height="${layout.height}" style="display:block;width:${layout.width}px;max-width:100%;height:auto;margin:0;border:none;border-radius:0;background-color:transparent;">`);
          pending.push({ target: `generated-quote-${themeId}-${quoteIndex + 1}-${paragraphIndex + 1}-${chunkIndex + 1}.png`, url, origin: 'generated', generatedKind: 'quote', bytes, mimeType: 'image/png', fallbackHtml, alt: rawText });
        }
        replacements.push({ start, end, html: replacementsHtml.join('') });
        records.push(...pending);
        if (paintFallback) warnings.push(`第 ${quoteIndex + 1} 处引用第 ${paragraphIndex + 1} 段鎏金绘制不可用，已使用单色金句图片`);
      } catch (error) {
        illustrationFailed = true;
        warnings.push(`第 ${quoteIndex + 1} 处引用第 ${paragraphIndex + 1} 段未图片化，已保留完整活文字：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (illustrationBoxes) {
      if (illustrationFailed) {
        replacements.splice(firstReplacement);
        records.splice(firstRecord);
        const errors = warnings.splice(firstWarning).filter(message => !message.includes('已使用单色金句图片'));
        warnings.push(...errors, `第 ${quoteIndex + 1} 处引用未全部图片化，已保留整块原文与原始排布`);
      } else if (records.length > firstRecord) {
        const start = openingEnd(source, surface.startIndex);
        const end = source.lastIndexOf('</', surface.endIndex);
        let content = source.slice(start, end);
        const contentReplacements = [
          ...replacements.splice(firstReplacement),
          ...surface.children.filter(emptyPseudoSpan).map(node => ({ start: node.startIndex, end: node.endIndex + 1, html: '' })),
        ];
        for (const replacement of contentReplacements.sort((a, b) => b.start - a.start)) {
          content = content.slice(0, replacement.start - start) + replacement.html + content.slice(replacement.end - start);
        }
        if (rule.illustration.layout === 'image') {
          try {
            const width = headingContainerWidth([...ancestors, quote, ...(surface === quote ? [] : [surface]), boxNode(illustrationBoxes.row)], layoutWidth, rule.maxWidth);
            const composed = renderQuoteComposition({ content, records: records.slice(firstRecord),
              illustration: await illustrationPromise, width, rule, document: (await getFont(rule.fontId)).document });
            const verified = verifyPng(composed.bytes, composed);
            const bytes = tagQuotePng(verified, hash(JSON.stringify([themeId, quoteIndex, source.slice(start, end)])));
            const url = `data:image/png;base64,${bytes.toString('base64')}`;
            records.splice(firstRecord, records.length - firstRecord, {
              target: `generated-quote-composition-${themeId}-${quoteIndex + 1}.png`, url, origin: 'generated', generatedKind: 'quote',
              bytes, mimeType: 'image/png', alt: composed.alt, fallbackHtml: source.slice(start, end),
              quoteComposition: composed.geometry,
            });
            replacements.push({ start, end, html: `<img data-wechat-quote-illustration="true" data-wechat-generated-quote="true" data-wechat-quote-composite="true" data-no-dark="" src="${url}" alt="${escape(composed.alt)}" width="${width}" height="${composed.height}" style="display:block;width:100%;max-width:100%;height:auto;margin:0;padding:0;border:0;border-radius:0;background-color:transparent;">` });
          } catch (error) {
            illustrationFailed = true;
            replacements.splice(firstReplacement);
            records.splice(firstRecord);
            warnings.push(`第 ${quoteIndex + 1} 处引用图文合成失败，已保留完整原文：${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          replacements.push({ start, end, html: illustratedQuoteHtml(content, rule, illustrationAsset, illustrationBoxes) });
        }
        if (rule.illustration.layout !== 'image' && !images.some(image => image.url === illustrationAsset.url)) illustrationRecords.set(illustrationAsset.url, {
          target: illustrationAsset.id, url: illustrationAsset.url, filePath: illustrationAsset.filePath,
          origin: 'theme', ...(illustrationAsset.wechatUrl ? { wechatUrl: illustrationAsset.wechatUrl } : {}),
        });
      }
    }
    if (rule.replaceNativeContainer && records.length > firstRecord && !illustrationFailed) {
      const openEnd = openingEnd(source, quote.startIndex);
      const closeStart = source.lastIndexOf('</blockquote', quote.endIndex);
      if (openEnd > quote.startIndex && closeStart >= openEnd) {
        const style = quote.attribs?.style ? ` style="${escape(quote.attribs.style)}"` : '';
        replacements.push({ start:quote.startIndex, end:openEnd, html:`<section data-wechat-quote-container="true"${style}>` });
        replacements.push({ start:closeStart, end:quote.endIndex + 1, html:'</section>' });
      }
    }
  }
  let output = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) output = output.slice(0, replacement.start) + replacement.html + output.slice(replacement.end);
  return { html: output, images: records.length ? [...images, ...records, ...illustrationRecords.values()] : images, warnings: [...new Set(warnings)], generatedCount: records.length };
}
