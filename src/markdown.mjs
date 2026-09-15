// Markdown → HTML。
//
// 结构必须对齐既有 #nice 主题 DOM；六套旧 CSS 已原样迁入目录式主题包：
//   #nice h2 .content   标题内层要有 span.content
//   #nice ...           整体包在 id="nice" 的容器里
// 改这里之前先确认主题选择器，否则样式会静默挂不上。

import { Lexer, Marked } from 'marked';
import hljs from 'highlight.js/lib/common';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 先于主题 CSS 内联：普通主题也能区分待办状态，主题可进一步装饰 marker。
export const MARKDOWN_BASE_CSS = `
#nice li.wechat-task-item { list-style-type: none; }
#nice .wechat-task-marker { margin-right: 8px; }
#nice li.wechat-task-item > p.wechat-task-line { margin: 0; padding: 0; }
`;

/**
 * 只在普通行内文本中寻找结束符，避开代码、HTML 属性、链接地址及转义。
 * 使用不含本扩展的 Marked lexer 做边界判断，避免在整个 HTML 上替换 ==。
 */
function highlightEnd(source, links) {
  const lexer = new Lexer({ gfm: true, breaks: false, async: false });
  lexer.tokens.links = links;
  let offset = 0;
  for (const token of lexer.inlineTokens(source)) {
    if (token.type === 'text' && !token.escaped) {
      for (const match of token.raw.matchAll(/==/g)) {
        const index = offset + match.index;
        if (source[index - 1] !== '=' && source[index + 2] !== '=') return index;
      }
    }
    offset += token.raw.length;
  }
  return -1;
}

const highlight = {
  name: 'highlight',
  level: 'inline',
  start(source) {
    return source.search(/(?<!=)==(?!=)/);
  },
  tokenizer(source, tokens) {
    if (this.lexer.state.inRawBlock || !source.startsWith('==') || source[2] === '=') return;
    // === 及更长的等号串保持字面值，不从等号串中间重新识别高亮。
    if (tokens.at(-1)?.raw.endsWith('=')) return;
    const line = source.slice(2).split(/\r?\n/, 1)[0];
    if (!line.includes('==')) return;
    const end = highlightEnd(line, this.lexer.tokens.links);
    if (end < 1) return;
    const text = line.slice(0, end);
    if (!text.trim() || /^\s|\s$/.test(text)) return;
    return {
      type: 'highlight',
      raw: source.slice(0, end + 4),
      text,
      tokens: this.lexer.inlineTokens(text),
    };
  },
  renderer({ tokens }) {
    // Preserve the source distinction for themes; both forms keep mark semantics.
    return `<mark class="wechat-inline-highlight">${this.parser.parseInline(tokens)}</mark>`;
  },
};

/**
 * 只认文件开头的 frontmatter，正文中间的 --- 是分割线不能误伤。
 * @returns {{ frontmatter: string, body: string }}
 */
export function splitFrontmatter(content) {
  const m = FRONTMATTER.exec(content);
  if (!m) return { frontmatter: '', body: content };
  return { frontmatter: m[1], body: content.slice(m[0].length).replace(/^\s*\n/, '') };
}

const renderer = {
  heading({ tokens, depth }) {
    const inner = this.parser.parseInline(tokens);
    return `<h${depth}><span class="content">${inner}</span></h${depth}>\n`;
  },

  code({ text, lang }) {
    const name = (lang || '').match(/\S+/)?.[0] || '';
    const known = name && hljs.getLanguage(name);
    const body = known ? hljs.highlight(text, { language: name }).value : escapeHtml(text);
    const cls = known ? `hljs language-${name}` : 'hljs';
    return `<pre><code class="${cls}">${body}</code></pre>\n`;
  },

  listitem(item) {
    if (!item.task) return false;
    const state = item.checked ? 'is-checked' : 'is-unchecked';
    const tokens = item.tokens;
    let lineTokens;
    let consumed = 0;
    if (tokens[0]?.type === 'paragraph' && tokens[0].tokens?.[0]?.type === 'checkbox') {
      lineTokens = tokens[0].tokens;
      consumed = 1;
    } else if (tokens[0]?.type === 'checkbox') {
      lineTokens = [tokens[0]];
      consumed = 1;
      while (tokens[consumed]?.type === 'text') {
        const token = tokens[consumed++];
        lineTokens.push(...(token.tokens ?? [{ ...token, type: 'text' }]));
      }
    }
    // Keep marker and text in one explicit paragraph before clipboard cleanup.
    // Never wrap the whole item: nested lists and later paragraphs stay outside.
    const body = lineTokens
      ? `<p class="wechat-task-line">${this.parser.parseInline(lineTokens)}</p>\n${this.parser.parse(tokens.slice(consumed))}`
      : this.parser.parse(tokens);
    return `<li class="wechat-task-item ${state}">${body}</li>\n`;
  },

  checkbox({ checked }) {
    const state = checked ? 'is-checked' : 'is-unchecked';
    const label = checked ? '已完成' : '未完成';
    return `<span class="wechat-task-marker ${state}" role="img" aria-label="${label}">${checked ? '✓' : '☐'}</span>`;
  },
};

const marked = new Marked({ gfm: true, breaks: false, async: false });
marked.use({ renderer, extensions: [highlight] });

/** Markdown → 带 #nice 容器的 HTML */
export function renderMarkdown(body) {
  return `<section id="nice">${marked.parse(body).trim()}</section>`;
}
