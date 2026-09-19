import postcss from 'postcss';
import { transformSanitizedHtmlElements } from './sanitize.mjs';

// Theme-drawn empty boxes must not hide a second checkbox glyph with color:
// transparent. Mobile WeChat may restore text color. Non-breaking spacing
// reserves the inline footprint without any visible character to resurrect.
export function materializeEmptyTaskMarkers(html) {
  if (!html.includes('wechat-task-marker') || !html.includes('is-unchecked')
      || !/color\s*:\s*transparent/i.test(html)) return html;
  return transformSanitizedHtmlElements(html, (tagName, attribs) => {
    const classes = new Set((attribs.class ?? '').split(/\s+/));
    if (tagName !== 'span' || !classes.has('wechat-task-marker')
        || !classes.has('is-unchecked') || !attribs.style) return { tagName, attribs };
    let color;
    try {
      postcss.parse(`marker{${attribs.style}}`).walkDecls(decl => {
        if (decl.prop.toLowerCase() === 'color') color = decl.value.trim().toLowerCase();
      });
    } catch { return { tagName, attribs }; }
    return color === 'transparent'
      ? { tagName, attribs, text: '\u00a0\u00a0\u00a0' }
      : { tagName, attribs };
  }, { textTags: ['span'] });
}
