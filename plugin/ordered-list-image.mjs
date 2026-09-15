import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { parseDocument } from 'htmlparser2';
import postcss from 'postcss';
import { ORDERED_LIST_IMAGE_MARKER_ATTRIBUTE, orderedListEmblemForDepth } from '../src/nested-lists.mjs';
import { scaleReferenceOrderedListRule } from '../src/reference-composition.mjs';
import { headingContainerWidth, inlineStyleMap } from './layout-box.mjs';
import { withCoveredFontFallbacks } from './font-coverage.mjs';
import { DEFAULT_MAX_PROCESSED_RESOURCES } from './copy.mjs';
import { indexWechatImageReferences } from '../src/wechat-compat.mjs';

const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_MARKERS = 256;
const ancestor = (node, attribute) => {
  for (let current = node.parent; current; current = current.parent) if (current.attribs?.[attribute] !== undefined) return current;
  return null;
};
const openingEnd = (html, start) => {
  let quote = '';
  for (let at = start; at < html.length; at++) {
    const character = html[at];
    if (quote) { if (character === quote) quote = ''; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return at + 1;
  }
  throw new Error('列表标签不完整');
};
const styleWith = (node, changes) => {
  const style = postcss.parse(`x{${node.attribs?.style ?? ''}}`).first;
  for (const [property, value] of Object.entries(changes)) {
    style.walkDecls(property, declaration => declaration.remove());
    style.append({ prop: property, value });
  }
  return style.nodes.map(node => node.toString()).join(';');
};
const markerGutter = node => Number(node.attribs.style?.match(/(?:^|;)\s*width\s*:\s*([0-9.]+)px\b/i)?.[1]);
const px = value => `${Math.ceil(value * 1000) / 1000}px`;

function markerGroupContexts(markers, layoutWidth, fallbackFontSize) {
  const groups = new Map(), contexts = new Map();
  for (const marker of markers) {
    const group = ancestor(marker, 'data-wechat-list-group');
    const row = ancestor(marker, 'data-wechat-list-row');
    const item = ancestor(marker, 'data-wechat-list-item');
    if (!group || !row || !item) continue;
    if (!groups.has(group)) groups.set(group, { group, markers: [], items: new Set(), original: 0, required: 0, limit: Infinity });
    const entry = groups.get(group);
    entry.markers.push(marker); entry.items.add(item);
    entry.original = Math.max(entry.original, markerGutter(marker) || 0);
    if (Number.isFinite(layoutWidth) && layoutWidth >= 240 && layoutWidth <= 1000) {
      const chain = []; let current = row;
      while (current?.name) { chain.unshift(current); if (current.attribs?.id === 'nice') break; current = current.parent; }
      chain[chain.length - 1] = { attribs: { style: styleWith(row, { 'padding-left': '0' }) } };
      const available = headingContainerWidth(chain, layoutWidth, 1000);
      const fontSize = Number.parseFloat(inlineStyleMap(marker)['font-size']) || fallbackFontSize;
      entry.limit = Math.min(entry.limit, Math.max(0, available - fontSize * 2));
    }
    contexts.set(marker, entry);
  }
  return { groups, contexts };
}

function gutterReplacements(html, groups) {
  const changes = new Map();
  const set = (node, property, value) => {
    if (!changes.has(node)) changes.set(node, {});
    changes.get(node)[property] = value;
  };
  for (const entry of groups.values()) {
    if (!entry.required && entry.original <= entry.limit) continue;
    const gutter = px(Math.max(Math.min(entry.original, entry.limit), entry.required));
    for (const marker of entry.markers) {
      set(marker, 'width', gutter);
      if (marker.parent?.name === 'p') set(marker.parent, 'text-indent', `-${gutter}`);
    }
    for (const item of entry.items) {
      const visit = node => {
        if (node !== item && node.attribs?.['data-wechat-list-item'] !== undefined) return;
        if (node.attribs?.['data-wechat-list-row'] !== undefined && ancestor(node, 'data-wechat-list-item') === item) set(node, 'padding-left', gutter);
        for (const child of node.children ?? []) visit(child);
      };
      visit(item);
    }
  }
  return [...changes].map(([node, values]) => {
    const end = openingEnd(html, node.startIndex);
    const tag = html.slice(node.startIndex, end);
    const style = ` style="${escape(styleWith(node, values))}"`;
    const updated = /\sstyle=(?:"[^"]*"|'[^']*')/i.test(tag)
      ? tag.replace(/\sstyle=(?:"[^"]*"|'[^']*')/i, () => style)
      : tag.replace(/>$/, () => `${style}>`);
    return { start: node.startIndex, end, html: updated };
  });
}
const crc32 = bytes => {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xEDB88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
};
const stampPng = (bytes, identity) => {
  // Equal-looking glyphs must not share a different label's copy fallback.
  // A lossless ancillary chunk gives each label its own resource identity.
  const data = Buffer.from(`cfwx-ordered-list\0${identity}`, 'latin1');
  const type = Buffer.from('tEXt');
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); type.copy(chunk, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), chunk.length - 4);
  const source = Buffer.from(bytes);
  return Buffer.concat([source.subarray(0, -12), chunk, source.subarray(-12)]);
};

/** Rasterize markers and, for emblems, fit their gutter; list contents stay editable. */
export async function materializeOrderedListImages({
  html, images = [], themeId, orderedListImages: rule, fonts = [], assets = [], loadFont, loadEmblem,
  referenceComposition = null, layoutWidth,
  cache = new Map(), measureFactory, layoutText, renderPng, verifyPng,
}) {
  const noOp = () => ({ html, images, warnings: [], generatedCount: 0 });
  if (!rule || !String(html).includes(ORDERED_LIST_IMAGE_MARKER_ATTRIBUTE)) return noOp();
  rule = scaleReferenceOrderedListRule(rule, referenceComposition, layoutWidth);
  const scale = rule.layoutScale ?? 1;
  const root = parseDocument(html, { withStartIndices: true, withEndIndices: true });
  const markers = [];
  const walk = (node, inArticle = false, inCode = false) => {
    const inside = inArticle || node.attribs?.id === 'nice';
    const code = inCode || ['pre', 'code'].includes(node.name);
    if (inside && !code && node.name === 'span' && node.attribs?.['data-wechat-list-marker'] === 'ol'
      && node.attribs[ORDERED_LIST_IMAGE_MARKER_ATTRIBUTE] && !node.children.some(child => child.type !== 'text')) markers.push(node);
    for (const child of node.children ?? []) walk(child, inside, code);
  };
  walk(root);
  if (!markers.length) return noOp();
  const warnings = new Set();
  const generated = new Map();
  const committedLabels = new Set();
  const sources = new Set(images.map(image => image?.url).filter(Boolean));
  const existingResources = new Set(indexWechatImageReferences(html, { sources }).occurrences.map(item => item.source));
  const imageBudget = Math.max(0, DEFAULT_MAX_PROCESSED_RESOURCES - existingResources.size);
  const replacements = [];
  const fontMap = new Map(fonts.map(font => [font.id, font]));
  const assetMap = new Map(assets.map(asset => [asset.id, asset]));
  const emblemPromises = new Map();
  const groupState = rule.depthEmblems?.length ? markerGroupContexts(markers, layoutWidth, rule.fontSize) : null;
  let fontPromise;
  const load = () => fontPromise ??= Promise.all([rule.fontId, ...(rule.fallbackFontIds ?? [])].map(id => {
    if (!fontMap.has(id)) throw new Error(`未找到编号字体 ${id}`);
    return loadFont(fontMap.get(id), themeId);
  }));
  for (const [index, marker] of markers.entries()) {
    if (index >= MAX_MARKERS) { warnings.add('有序列表超过 256 个图片编号，其余条目保留正确文字编号'); break; }
    const text = marker.attribs[ORDERED_LIST_IMAGE_MARKER_ATTRIBUTE];
    const group = groupState?.contexts.get(marker);
    const depth = Number(group?.group.attribs['data-wechat-list-depth']) || 1;
    const emblem = orderedListEmblemForDepth(rule, depth);
    try {
      // Attribute + text must agree. Never interpret article-authored nested markup.
      if (text.length > 32 || marker.children.map(child => child.data).join('').trim() !== text) continue;
      if (!emblem && !committedLabels.has(text) && committedLabels.size >= imageBudget) {
        warnings.add('图片资源已接近复制上限，其余有序列表保留正确文字编号');
        continue;
      }
      const [primary, ...fallbacks] = await load();
      const font = withCoveredFontFallbacks(primary, fallbacks, text);
      let emblemAsset = null, prefix = null;
      if (emblem) {
        if (!group) throw new Error('图形编号需要受管列表结构');
        const definition = assetMap.get(emblem.assetId);
        if (!definition || typeof loadEmblem !== 'function') throw new Error(`编号图形不可读取：${emblem.assetId}`);
        if (!emblemPromises.has(emblem.assetId)) emblemPromises.set(emblem.assetId, Promise.resolve(loadEmblem(definition, themeId)));
        emblemAsset = await emblemPromises.get(emblem.assetId);
        if (!emblemAsset?.image || !emblemAsset.hash || !(emblemAsset.width > 0 && emblemAsset.height > 0)) throw new Error('编号图形解码失败');
        const fit = Math.min(emblem.width / emblemAsset.width, emblem.height / emblemAsset.height);
        prefix = { numberWidth: emblemAsset.width * fit, numberHeight: emblemAsset.height * fit,
          gap: emblem.gap, separator: '', separatorWidth: 0,
          totalWidth: emblemAsset.width * fit + emblem.gap, verticalAlign: 'middle' };
      }
      const renderRule = {
        fontSize: rule.fontSize, minEffectiveFontSize: rule.fontSize,
        lineHeight: Math.max(1.25, (prefix?.numberHeight ?? 0) / rule.fontSize), letterSpacing: 0, scale: rule.scale, color: rule.color,
        paddingX: 2 * scale, paddingY: scale, maxWidth: (emblem ? 512 : 240) * scale, minDisplayWidth: (emblem ? 512 : 240) * scale,
        maxLines: 1, maxEquivalentCharacters: 32, align: 'left',
      };
      const key = hash(JSON.stringify(emblem
        ? ['ordered-list-emblem-v1', themeId, font.hash, text, renderRule, emblem, emblemAsset.hash, prefix]
        : ['ordered-list-v1', themeId, font.hash, text, renderRule]));
      const identity = emblem ? key : text;
      if (!committedLabels.has(identity) && committedLabels.size >= imageBudget) {
        warnings.add('图片资源已接近复制上限，其余有序列表保留正确文字编号');
        continue;
      }
      let result = cache.get(key);
      if (!result) {
        const context = font.document?.createElement('canvas').getContext('2d');
        if (!context) throw new Error('当前环境不能创建编号画布');
        const measureGrapheme = measureFactory(context, {
          fontFamily: font.runtimeFamily, fontSize: rule.fontSize,
          fontWeight: font.weight, fontStyle: font.style,
          familyForGrapheme: font.familyForGrapheme,
        });
        const layout = layoutText(text, { ...renderRule, measureGrapheme, ...(prefix ? { prefix } : {}) });
        if (!layout.ok) throw new Error(layout.reason);
        const rendered = renderPng({ layout, rule: renderRule, font, ...(emblemAsset ? { numberAsset: emblemAsset } : {}), document: font.document });
        const bytes = verifyPng(rendered.bytes, {
          physicalWidth: rendered.physicalWidth ?? layout.width * rule.scale,
          physicalHeight: rendered.physicalHeight ?? layout.height * rule.scale,
        });
        result = { width: layout.width, height: layout.height, bytes: stampPng(bytes, key) };
        cache.set(key, result);
      }
      const gutter = markerGutter(marker);
      if (emblem && result.width + rule.gap > group.limit) throw new Error('图形编号过宽，已避免挤出正文');
      if (!emblem && Number.isFinite(gutter) && result.width + rule.gap > gutter) {
        throw new Error('艺术字编号超过预留宽度，避免遮挡正文');
      }
      const dataUrl = `data:image/png;base64,${Buffer.from(result.bytes).toString('base64')}`;
      const opening = openingEnd(html, marker.startIndex);
      const end = html.lastIndexOf('</', marker.endIndex);
      const imageHtml = `<img data-wechat-generated-ordered-list="true" src="${dataUrl}" alt="${escape(text)}" width="${result.width}" height="${result.height}" style="display: inline-block; width: ${result.width}px; height: ${result.height}px; max-width: none; margin: 0; padding: 0; border: 0; vertical-align: -0.28em;" />`;
      replacements.push({ start: opening, end, html: imageHtml });
      committedLabels.add(identity);
      if (emblem) group.required = Math.max(group.required, result.width + rule.gap);
      if (!generated.has(dataUrl)) generated.set(dataUrl, {
        target: `generated-ordered-list-${themeId}-${key.slice(0, 16)}.png`, url: dataUrl,
        origin: 'generated', generatedKind: 'ordered-list', bytes: result.bytes,
        mimeType: 'image/png', fallbackHtml: escape(text) + '&#160;', alt: text,
      });
    } catch (error) {
      warnings.add(`有序列表编号图片化失败，已保留正确编号与正文：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (groupState) replacements.push(...gutterReplacements(html, groupState.groups));
  let output = html;
  for (const item of replacements.sort((a, b) => b.start - a.start)) output = output.slice(0, item.start) + item.html + output.slice(item.end);
  return { html: output, images: [...images, ...generated.values()], warnings: [...warnings], generatedCount: generated.size };
}
