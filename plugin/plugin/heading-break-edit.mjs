import { Lexer } from 'marked';

const BR_TAG = /^<br[ \t]*\/?>$/i;
const ENTITY = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi;
const failure = (reason) => ({ ok: false, reason });
let lastDocument;

const frontmatterEnd = (lines) => {
  if (!/^\uFEFF?---[ \t]*$/.test(lines[0])) return -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[index])) return index;
  }
  // An unfinished property block is not a safe place to edit headings.
  return lines.length - 1;
};

const visibleText = (text) => text
  .replace(/&(?:nbsp|ensp|emsp|thinsp|hairsp|Tab|NewLine);/gi, ' ')
  .replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, value) => {
    const code = /^x/i.test(value)
      ? Number.parseInt(value.slice(1), 16)
      : Number(value);
    return code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
  })
  .replace(/[\s\u200b\uFEFF]/gu, '');

// Only actual inline HTML breaks count. A literal `<br>` inside inline code,
// an image alt, a comment, or escaped Markdown must remain untouched.
const collectBreaks = (tokens, raw, offset = 0) => {
  const breaks = [];
  let consumed = 0;
  for (const token of tokens ?? []) {
    const start = raw.indexOf(token.raw, consumed);
    if (start < 0) continue;
    consumed = start + token.raw.length;
    if (token.type === 'html' && BR_TAG.test(token.raw)) {
      breaks.push({ from: offset + start, to: offset + consumed });
    } else if (['strong', 'em', 'del', 'link'].includes(token.type)) {
      breaks.push(...collectBreaks(token.tokens, token.raw, offset + start));
    }
  }
  return breaks;
};

const getDocument = (source) => {
  if (lastDocument?.source === source) return lastDocument;
  const lines = source.replace(/\r\n|\r/g, '\n').split('\n');
  const propertiesEnd = frontmatterEnd(lines);
  const lineOffsets = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }
  lastDocument = {
    source, lines, propertiesEnd, lineOffsets,
    normalized: lines.map((line, index) => index <= propertiesEnd
      ? line.replace(/./g, ' ')
      : line).join('\n'),
  };
  return lastDocument;
};

const getHeadings = (document) => {
  if (document.headings) return document.headings;
  const headings = new Map();
  let offset = 0;
  for (const token of Lexer.lex(document.normalized, { gfm: true })) {
    // Keep an exact source-to-token relationship instead of searching for a
    // matching title elsewhere in the document.
    if (document.normalized.slice(offset, offset + token.raw.length) !== token.raw) {
      throw new Error('Heading source offset mismatch');
    }
    if (token.type === 'heading' && token.depth >= 1 && token.depth <= 6) headings.set(offset, token);
    offset += token.raw.length;
  }
  if (offset !== document.normalized.length) throw new Error('Incomplete heading source map');
  document.headings = headings;
  return headings;
};

const resolveContext = (source, cursor) => {
  if (typeof source !== 'string' || !Number.isInteger(cursor?.line)
    || !Number.isInteger(cursor?.ch)) {
    return failure('无法确定光标位置，请重新点击标题');
  }
  const document = getDocument(source);
  const { lines, propertiesEnd } = document;
  const lineText = lines[cursor.line];
  if (lineText === undefined || cursor.line < 0 || cursor.ch < 0
    || cursor.ch > lineText.length) {
    return failure('光标位置已失效，请重新点击标题');
  }
  const prefix = /^ {0,3}(#{1,6})[ \t]+/.exec(lineText);
  if (!prefix) return failure('请先将光标放到一至六级标题中');
  if (cursor.line <= propertiesEnd) return failure('属性区中的文字不是正文标题');
  let heading;
  try {
    heading = getHeadings(document).get(document.lineOffsets[cursor.line]);
  } catch {
    return failure('无法解析当前文档，请稍后再试');
  }
  if (!heading || heading.depth !== prefix[1].length) return failure('请在正文顶层的一至六级标题中使用此功能');
  if (!heading.text || !visibleText(heading.text)) return failure('当前标题没有文字');
  const contentStart = prefix[0].length;
  const contentEnd = contentStart + heading.text.length;
  if (lineText.slice(contentStart, contentEnd) !== heading.text) {
    return failure('无法可靠定位标题正文，请重新点击标题后再试');
  }
  const breaks = collectBreaks(heading.tokens, heading.text, contentStart);
  return {
    ok: true,
    level: heading.depth,
    line: cursor.line,
    lineText,
    contentStart,
    contentEnd,
    hasBreak: breaks.length > 0,
    breakCount: breaks.length,
    breaks,
    tokens: heading.tokens,
  };
};

/** Inspect the cursor's top-level ATX H1–H6 without changing the source. */
export function getHeadingBreakContext(source, cursor) {
  const context = resolveContext(source, cursor);
  if (!context.ok) return context;
  const { breaks, tokens, ...publicContext } = context;
  return publicContext;
}

const completeLineChange = (context, text, ch) => ({
  ok: true,
  change: {
    from: { line: context.line, ch: 0 },
    to: { line: context.line, ch: context.lineText.length },
    text,
  },
  cursor: { line: context.line, ch },
});

const resetBreaks = (context, cursor) => {
  if (!context.hasBreak) return failure('当前标题没有手动换行');
  const { lineText, contentStart, contentEnd } = context;
  const spans = [];
  for (const current of context.breaks) {
    let from = current.from;
    let to = current.to;
    while (from > contentStart && /[ \t]/.test(lineText[from - 1])) from -= 1;
    while (to < contentEnd && /[ \t]/.test(lineText[to])) to += 1;
    const previous = spans.at(-1);
    if (previous && previous.to >= from) previous.to = Math.max(previous.to, to);
    else spans.push({ from, to });
  }
  let text = '';
  let consumed = 0;
  let ch = cursor.ch;
  let delta = 0;
  for (const span of spans) {
    const before = lineText.slice(contentStart, span.from);
    const after = lineText.slice(span.to, contentEnd);
    const original = lineText.slice(span.from, span.to);
    const hadWordSpace = /^[ \t]|[ \t]$/.test(original);
    const joinsLatinWords = /[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(after);
    const replacement = before && after && (hadWordSpace || joinsLatinWords) ? ' ' : '';
    text += lineText.slice(consumed, span.from) + replacement;
    if (cursor.ch >= span.to) ch += replacement.length - (span.to - span.from);
    else if (cursor.ch > span.from) ch = span.from + delta + replacement.length;
    delta += replacement.length - (span.to - span.from);
    consumed = span.to;
  }
  text += lineText.slice(consumed);
  return completeLineChange(context, text, Math.max(0, Math.min(ch, text.length)));
};

/** Plan one complete-line replacement so the editor can make one undo step. */
export function planHeadingBreakEdit({ source, cursor, action, maxLines, maxBreaks } = {}) {
  if (action !== 'insert' && action !== 'reset') return failure('未知的标题换行操作');
  const context = resolveContext(source, cursor);
  if (!context.ok) return context;
  if (action === 'reset') return resetBreaks(context, cursor);
  const { lineText, contentStart, contentEnd } = context;
  const ch = cursor.ch;
  if (ch <= contentStart || ch >= contentEnd) {
    return failure('请将光标放在标题文字中间，不能在开头或结尾换行');
  }
  if (context.breaks.some((span) => ch > span.from && ch < span.to)) {
    return failure('光标位于已有换行标记内，请移动到标题文字中');
  }
  if (context.tokens.some((token) => token.type !== 'text'
    && !(token.type === 'html' && BR_TAG.test(token.raw)))) {
    return failure('当前标题含链接、加粗或其他行内格式，暂不支持插入换行');
  }
  for (const match of lineText.matchAll(ENTITY)) {
    if (ch > match.index && ch < match.index + match[0].length) {
      return failure('不能在 HTML 字符实体中间换行，请移动光标');
    }
  }
  const previous = lineText.charCodeAt(ch - 1);
  const next = lineText.charCodeAt(ch);
  if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
    return failure('不能在一个字符中间换行，请移动光标');
  }
  // Live-text headings have no image renderer's line or manual-break limit.
  // Image-heading callers supply their own rule and the renderer's hard cap.
  const lineBreakLimit = Number.isFinite(maxLines) ? Math.max(1, Math.floor(maxLines)) - 1 : Infinity;
  const manualBreakLimit = Number.isFinite(maxBreaks) ? Math.max(0, Math.floor(maxBreaks)) : Infinity;
  const allowedBreaks = Math.min(lineBreakLimit, manualBreakLimit);
  if (context.breakCount >= allowedBreaks) {
    return failure(allowedBreaks === 0
      ? '当前主题只允许单行标题'
      : `当前主题最多支持 ${allowedBreaks} 处手动换行`);
  }
  const content = lineText.slice(contentStart, ch) + '<br>' + lineText.slice(ch, contentEnd);
  if (content.split(/<br[ \t]*\/?>/gi).some((part) => !visibleText(part))) {
    return failure('这个位置会产生空行，请将光标放在两段标题文字之间');
  }
  return completeLineChange(context, lineText.slice(0, ch) + '<br>' + lineText.slice(ch), ch + 4);
}
