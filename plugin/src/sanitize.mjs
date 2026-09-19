// Markdown 允许原始 HTML 透传，但原文可能来自导入或同步。
// 在进入 Obsidian DOM 和之后的推送管线前，只保留文章排版必需的 HTML。

import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'cite', 'code', 'dd', 'del', 'details',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
  'q', 's', 'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
];

const OPTIONS = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    '*': ['id', 'class', 'data-*', 'role', 'aria-*'],
    a: ['href', 'title'],
    font: ['color', 'face', 'size'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    ol: ['start', 'type'],
    li: ['value'],
    td: ['colspan', 'rowspan', 'align', 'valign'],
    th: ['colspan', 'rowspan', 'align', 'valign', 'scope'],
    table: [
      { name: 'cellspacing', values: ['0'] },
      { name: 'cellpadding', values: ['0'] },
    ],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel', 'app', 'file', 'local'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'app', 'file', 'local'],
  },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
};

const STYLE_ALLOWED_ATTRIBUTES = {
  ...OPTIONS.allowedAttributes,
  '*': [...OPTIONS.allowedAttributes['*'], 'style'],
};

/**
 * 移除脚本、事件属性、iframe、SVG 与其他可执行或可嵌入内容。
 *
 * 原始 HTML 的 style 属性不保留；风格 CSS 会在净化之后由 juice
 * 重新内联，因此最终输出仍有完整行内样式，但不会执行原文携带的 CSS URL。
 */
export function sanitizeRenderedHtml(html) {
  return sanitizeHtml(html, OPTIONS);
}

/**
 * 在同一套安全标签边界内遍历真实 HTML 节点。
 *
 * 这个入口专供 juice 之后的行内样式处理使用：允许已内联的
 * style，但仍会丢弃脚本、事件属性与其他非文章标签。
 */
export function transformSanitizedHtmlElements(
  html,
  transformElement,
  { allowDataImages = false, textTags = [] } = {},
) {
  return sanitizeHtml(html, {
    ...OPTIONS,
    allowedAttributes: STYLE_ALLOWED_ATTRIBUTES,
    allowedSchemesByTag: {
      ...OPTIONS.allowedSchemesByTag,
      // 只有复制/导出对已净化 HTML 的二次处理可保留自己生成的 data URL。
      img: allowDataImages
        ? [...OPTIONS.allowedSchemesByTag.img, 'data']
        : OPTIONS.allowedSchemesByTag.img,
    },
    transformTags: {
      // sanitize-html only applies a transform's `text` on a named tag, not '*'.
      // Keep the callback once per element when named text transforms are used.
      '*': (tagName, attribs) => textTags.includes(tagName)
        ? { tagName, attribs } : transformElement(tagName, attribs),
      ...Object.fromEntries(textTags.filter(tag => ALLOWED_TAGS.includes(tag))
        .map(tag => [tag, (tagName, attribs) => transformElement(tagName, attribs)])),
    },
  });
}
