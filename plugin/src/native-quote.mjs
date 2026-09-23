import { parseDocument } from 'htmlparser2';

// 微信的阅读页会给原生 blockquote 补一条左侧竖线，内联的 border 盖不住它。
// 引用的外观全部由主题的内联样式负责，所以复制与导出前把容器换成普通 section。
// 换标签不改属性、不动内部结构，只是让微信认不出这是引用。
const QUOTE_MARK = 'data-wechat-quote-container';

const openingEnd = (html, index) => {
  let quote = '';
  for (let at = index; at < html.length; at += 1) {
    const character = html[at];
    if (quote) { if (character === quote) quote = ''; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return at + 1;
  }
  return -1;
};

/** 收集所有 blockquote，含嵌套；由解析器给出位置，不自己数尖括号。 */
const collect = (node, found = []) => {
  for (const child of node.children ?? []) {
    if (child.type === 'tag' || child.type === 'script' || child.type === 'style') {
      if (child.name === 'blockquote') found.push(child);
      collect(child, found);
    }
  }
  return found;
};

export function replaceNativeQuoteContainers(html) {
  const source = String(html ?? '');
  if (!source.includes('<blockquote')) return { html: source, replaced: 0 };
  let document;
  try {
    document = parseDocument(source, { withStartIndices: true, withEndIndices: true });
  } catch {
    return { html: source, replaced: 0 };
  }
  const replacements = [];
  for (const quote of collect(document)) {
    const start = quote.startIndex;
    const end = quote.endIndex;
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    const openEnd = openingEnd(source, start);
    const closeStart = source.lastIndexOf('</blockquote', end);
    // 自闭合或结构异常时原样保留，宁可留一条竖线也不破坏正文。
    if (openEnd <= start || closeStart < openEnd) continue;
    const opening = source.slice(start, openEnd);
    if (opening.includes(QUOTE_MARK)) continue;
    const attributes = opening.replace(/^<blockquote/i, '').replace(/\/?>$/, '');
    replacements.push({ start, end: openEnd, html: `<section ${QUOTE_MARK}="true"${attributes}>` });
    replacements.push({ start: closeStart, end: end + 1, html: '</section>' });
  }
  if (replacements.length === 0) return { html: source, replaced: 0 };
  let output = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, replacement.start) + replacement.html + output.slice(replacement.end);
  }
  return { html: output, replaced: replacements.length / 2 };
}
