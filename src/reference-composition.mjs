import { parseDocument } from 'htmlparser2';
import postcss from 'postcss';

const SOURCE_BLOCK = 'data-wechat-reference-block';
const rootOf = (html) => parseDocument(html, { withStartIndices: true, withEndIndices: true }).children
  .find((node) => node.name === 'section' && node.attribs?.id === 'nice');
const blocksOf = (root) => (root?.children ?? []).filter((node) => typeof node.name === 'string');
const textOf = node => node.type === 'text' ? node.data
  : node.type === 'comment' ? '' : (node.children ?? []).map(textOf).join('');
const visibleCharacters = node => Array.from(textOf(node).replace(/\s/g, '')).length;
const codeLineCount = node => {
  const text = textOf(node).replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return text ? text.split('\n').length : 0;
};

export function normalizeReferenceComposition(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reference_composition 必须是对象');
  for (const key of Object.keys(value)) {
    if (!['strategy', 'design_width'].includes(key)) throw new Error(`reference_composition 不支持字段：${key}`);
  }
  if (!['opening-feature', 'document-flow'].includes(value.strategy)) throw new Error('reference_composition.strategy 只支持 opening-feature 或 document-flow');
  if (!Number.isInteger(value.design_width) || value.design_width < 240 || value.design_width > 1000) {
    throw new Error('reference_composition.design_width 必须是 240–1000 的整数');
  }
  return { strategy: value.strategy, designWidth: value.design_width };
}

export function referenceLayoutScale(composition, layoutWidth) {
  if (!composition) return 1;
  const width = layoutWidth ?? composition.designWidth;
  if (!Number.isFinite(width) || width < 240 || width > 1000) throw new Error('参考构图的布局宽度必须在 240–1000 之间');
  return width / composition.designWidth;
}

/** Plan only from original, direct Markdown blocks, before decorative slots run. */
export function planReferenceComposition(html, composition) {
  if (!composition) return { html, groups: [] };
  const blocks = blocksOf(rootOf(html));
  const groupContent = composition.strategy === 'opening-feature';
  if (groupContent && blocks.some((node) => node.attribs?.['data-wechat-scene'])) return { html, groups: [] };
  const groups = [];
  const firstH1 = groupContent ? blocks.findIndex((node) => node.name === 'h1') : -1;
  if (firstH1 >= 0) {
    let end = firstH1, characters = 0, paragraphs = 0;
    while (paragraphs < 2 && blocks[end + 1]?.name === 'p') {
      const count = visibleCharacters(blocks[end + 1]);
      if (characters + count > 160) break;
      characters += count; paragraphs += 1; end += 1;
    }
    groups.push({ kind: 'opening', start: firstH1, end, ...(end === firstH1 ? { variant: 'standalone' } : {}) });
  }
  const firstQuote = groupContent ? blocks.findIndex((node) => node.name === 'blockquote') : -1;
  if (firstQuote >= 0) {
    if (blocks[firstQuote - 1]?.name === 'h2'
      && visibleCharacters(blocks[firstQuote - 1]) <= 18
      && visibleCharacters(blocks[firstQuote]) <= 100) {
      let end = firstQuote;
      if (blocks[end + 1]?.name === 'p' && visibleCharacters(blocks[end + 1]) <= 100) end += 1;
      if (blocks[end + 1]?.name === 'pre' && codeLineCount(blocks[end + 1]) <= 12) end += 1;
      groups.push({ kind: 'feature', start: firstQuote - 1, end });
    } else {
      groups.push({ kind: 'feature', start: firstQuote, end: firstQuote, variant: 'standalone' });
    }
  }
  if (!groups.length && !blocks.some(node => node.name === 'table')) return { html, groups };
  let output = html;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const node = blocks[index];
    const at = node.startIndex + node.name.length + 1;
    const tableSpacing = node.name === 'table' ? ' cellspacing="0" cellpadding="0"' : '';
    const marker = groups.length ? ` ${SOURCE_BLOCK}="${index}"` : '';
    if (marker || tableSpacing) output = `${output.slice(0, at)}${marker}${tableSpacing}${output.slice(at)}`;
  }
  return { html: output, groups };
}

/** Wrap after slots: original ranges absorb their code/header decoration without reordering text. */
export function applyReferenceComposition(html, plan) {
  if (!plan?.groups?.length) return html;
  const blocks = blocksOf(rootOf(html));
  const edits = [];
  for (const group of plan.groups) {
    let start = blocks.findIndex((node) => node.attribs?.[SOURCE_BLOCK] === String(group.start));
    const end = blocks.findIndex((node) => node.attribs?.[SOURCE_BLOCK] === String(group.end));
    if (start < 0 || end < start) continue;
    // Only injected blocks lack the marker; the first group also takes its brand.
    while (start > 0 && (group.kind === 'opening' || group.start > 0)
      && blocks[start - 1].attribs?.[SOURCE_BLOCK] === undefined
      && !blocks[start - 1].attribs?.['data-wechat-scene']) start -= 1;
    edits.push({ at: blocks[start].startIndex, value: `<section data-wechat-scene="${group.kind}"${group.variant ? ` data-wechat-scene-variant="${group.variant}"` : ''}>` });
    edits.push({ at: blocks[end].endIndex + 1, value: '</section>' });
  }
  let output = html;
  for (const edit of edits.sort((a, b) => b.at - a.at || (a.value === '</section>' ? 1 : -1))) output = output.slice(0, edit.at) + edit.value + output.slice(edit.at);
  return output.replace(/\sdata-wechat-reference-block="\d+"/g, '');
}

export function scaleReferenceCss(css, composition, layoutWidth) {
  const factor = referenceLayoutScale(composition, layoutWidth);
  if (!composition || factor === 1) return css;
  const ast = postcss.parse(css, { from: undefined });
  ast.walkDecls((declaration) => {
    // Never rewrite URLs or quoted font-family/content strings containing "px".
    declaration.value = declaration.value.replace(
      /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\([^)]*\))|(-?(?:\d*\.)?\d+)px\b/gi,
      (whole, literal, number) => literal ?? `${Number((Number(number) * factor).toFixed(6))}px`,
    );
  });
  return ast.toString();
}

const scaledFields = (value, fields, factor) => {
  const copy = { ...value };
  for (const key of fields) if (Number.isFinite(value[key])) copy[key] = value[key] * factor;
  return copy;
};

export function scaleReferenceHeadingRule(rule, composition, layoutWidth) {
  if (!composition) return rule;
  const factor = referenceLayoutScale(composition, layoutWidth);
  const copy = scaledFields(rule, ['fontSize', 'letterSpacing', 'maxWidth', 'minDisplayWidth', 'minEffectiveFontSize', 'paddingX', 'paddingY', 'numberGap'], factor);
  copy.widthMode = 'container';
  copy.paddingX = 0;
  if (rule.sideAssets) copy.sideAssets = scaledFields(rule.sideAssets, ['size', 'gap'], factor);
  if (rule.watermark) copy.watermark = scaledFields(
    rule.watermark,
    ['width', 'height', 'offsetX', 'offsetY'],
    factor,
  );
  if (rule.textPaint) copy.textPaint = {
    ...rule.textPaint,
    stroke: scaledFields(rule.textPaint.stroke, ['width'], factor),
    highlight: scaledFields(rule.textPaint.highlight, ['width', 'offsetX', 'offsetY'], factor),
  };
  return copy;
}

export function scaleReferenceQuoteRule(rule, composition, layoutWidth) {
  if (!rule || !composition) return rule;
  const factor = referenceLayoutScale(composition, layoutWidth);
  const copy = scaledFields(rule, ['fontSize', 'letterSpacing', 'maxWidth', 'fallbackWidth'], factor);
  if (rule.textPaint) copy.textPaint = {
    ...rule.textPaint,
    stroke: scaledFields(rule.textPaint.stroke, ['width'], factor),
    highlight: scaledFields(rule.textPaint.highlight, ['width', 'offsetX', 'offsetY'], factor),
  };
  return copy;
}

export function scaleReferenceOrderedListRule(rule, composition, layoutWidth) {
  // Existing font-only numbering keeps its old contract; emblems opt into design scaling.
  if (!rule?.depthEmblems?.length || !composition) return rule;
  const factor = referenceLayoutScale(composition, layoutWidth);
  const copy = scaledFields(rule, ['fontSize', 'gap'], factor);
  copy.layoutScale = factor;
  if (rule.depthEmblems) copy.depthEmblems = rule.depthEmblems.map(emblem => scaledFields(emblem, ['width', 'height', 'gap'], factor));
  return copy;
}

const styleOf = (node) => {
  const values = {};
  postcss.parse(`x{${node.attribs?.style ?? ''}}`).walkDecls(d => { values[d.prop.toLowerCase()] = d.value; });
  return values;
};
const positiveLength = (value, reference) => {
  const match = /^(\d+(?:\.\d+)?)(px|%)?$/.exec(value ?? '');
  return match ? Number(match[1]) * (match[2] === '%' ? reference / 100 : 1) : 0;
};
const paddingSide = (css, side, reference) => {
  const parts = (css.padding ?? '0').split(/\s+/);
  const value = css[`padding-${side}`] ?? (side === 'top' ? parts[0] : parts.length >= 3 ? parts[2] : parts[0]);
  return positiveLength(value, reference);
};
const plainLines = node => node.name === 'br' ? '\n' : node.type === 'text'
  ? node.data.replace(/\s+/g, ' ') : (node.children ?? []).map(plainLines).join('');
const estimatedLines = (node, width, fontNode = node) => {
  const css = styleOf(node), font = styleOf(fontNode);
  const size = positiveLength(font['font-size'], width);
  const gap = positiveLength(font['letter-spacing'], width);
  const available = positiveLength(css.width, width);
  if (!(size > 0 && available > 0)) return Infinity;
  // A full em per Unicode character is conservative; long or complex intros
  // return to normal flow rather than relying on unmeasured text behind artwork.
  return plainLines(node).trim().split('\n').reduce((total, line) => {
    const count = Array.from(line.trim()).length;
    return total + Math.max(1, Math.ceil((count * size + Math.max(0, count - 1) * gap) / available));
  }, 0);
};

/** Only the generated opening + immediately adjacent feature can overlap. */
export function referenceSceneOverlapPolicy(html, plan, composition, layoutWidth) {
  const policies = new Map();
  if (composition?.strategy !== 'opening-feature' || !plan?.groups?.some(g => g.kind === 'opening')) return policies;
  const width = layoutWidth ?? composition.designWidth;
  referenceLayoutScale(composition, width);
  const root = rootOf(html), blocks = blocksOf(root);
  const sectionIndexes = new Map(); let index = 0;
  const visit = node => {
    if (node.name === 'section') sectionIndexes.set(node, index++);
    for (const child of node.children ?? []) visit(child);
  };
  if (!root) return policies;
  visit(root);
  for (let i = 1; i < blocks.length; i += 1) {
    const opening = blocks[i - 1], feature = blocks[i];
    if (opening.attribs?.['data-wechat-scene'] !== 'opening' || feature.attribs?.['data-wechat-scene'] !== 'feature') continue;
    if (feature.attribs?.['data-wechat-scene-variant'] === 'standalone') continue;
    const featureCss = styleOf(feature), openingCss = styleOf(opening);
    const margin = /^-(\d+(?:\.\d+)?)px$/.exec(featureCss['margin-top'] ?? '');
    if (!margin) continue;
    const amount = Number(margin[1]), limit = width * 0.3;
    if (!(amount > 0 && amount <= limit)) continue;
    const title = blocksOf(opening).find(n => n.name === 'h1');
    const titleFont = title?.children?.find(n => n.name === 'span') ?? title;
    const paragraphs = blocksOf(opening).filter(n => n.name === 'p');
    const safeText = title && paragraphs.length > 0
      && estimatedLines(title, width, titleFont) <= 2
      && paragraphs.reduce((sum, p) => sum + estimatedLines(p, width), 0) <= 4;
    const clearance = paddingSide(openingCss, 'bottom', width) + paddingSide(featureCss, 'top', width);
    policies.set(sectionIndexes.get(feature), { limit, mode: safeText && clearance >= amount ? 'allow' : 'zero' });
  }
  return policies;
}
