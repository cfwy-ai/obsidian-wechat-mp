import { Buffer } from 'node:buffer';
import { PNG } from 'pngjs';
import postcss from 'postcss';
import { paintTextLine } from './text-paint.mjs';

const INLINE = new Set(['span', 'strong', 'b', 'em', 'i', 'code', 'u', 'mark', 'small']);
const FORBIDDEN = new Set(['a', 'sup', 'sub', 'del', 's']);
const CLOSE = /^[，。！？；：、）》】」』”’…,.!?;:%)\]}]/u;
const TRANSPARENT = /^(?:transparent|rgba\([^)]*,\s*0(?:\.0+)?\))$/i;
const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function quoteInlineStyles(node) {
  const source = node?.attribs?.style;
  if (!source) return {};
  const rule = postcss.parse(`x{${source}}`, { from: undefined }).first;
  return Object.fromEntries((rule?.nodes ?? []).filter((item) => item.type === 'decl').map((item) => [item.prop.toLowerCase(), item.value]));
}

function px(value, base, fallback = 0) {
  if (value == null || ['inherit', 'initial', 'unset', 'normal'].includes(value)) return fallback;
  const match = /^([0-9]*\.?[0-9]+)(px|em|rem|%)?$/.exec(String(value));
  if (!match) return fallback;
  const n = Number(match[1]);
  return match[2] === 'em' ? n * base : match[2] === 'rem' ? n * 16 : match[2] === '%' ? n * base / 100 : n;
}

const sides = (value = '0') => {
  const a = value.trim().split(/\s+/);
  return a.length === 1 ? [a[0], a[0], a[0], a[0]] : a.length === 2 ? [a[0], a[1], a[0], a[1]] : a.length === 3 ? [a[0], a[1], a[2], a[1]] : a.slice(0, 4);
};

function edge(css, side, index, fontSize, color) {
  const shorthand = css[`border-${side}`] ?? css.border ?? '';
  const tokens = shorthand.split(/\s+/);
  const widthToken = css[`border-${side}-width`] ?? (css['border-width'] ? sides(css['border-width'])[index] : tokens[0]);
  const borderStyle = css[`border-${side}-style`] ?? (css['border-style'] ? sides(css['border-style'])[index] : tokens.find((token) => ['solid', 'dashed', 'dotted', 'none', 'hidden'].includes(token)));
  const width = ['none', 'hidden'].includes(borderStyle) || ['none', 'hidden'].includes(widthToken) ? 0 : px(widthToken, fontSize, 0);
  const shorthandColor = shorthand.match(/#[a-f\d]{3,8}\b|rgba?\([^)]*\)/i)?.[0];
  return { width, color: css[`border-${side}-color`] ?? css['border-color'] ?? shorthandColor ?? color };
}

function resolvedStyle(node, parent, rule) {
  const css = quoteInlineStyles(node);
  if (node.name !== 'p' && css['background-image'] && css['background-image'] !== 'none') throw new Error('行内图片装饰需保留原始样式，已避免把图片下划线变成普通线条');
  const style = { ...parent };
  if (node.name === 'strong' || node.name === 'b') style.fontWeight = 700;
  if (node.name === 'em' || node.name === 'i') style.fontStyle = 'italic';
  if (node.name === 'u') style.underline = true;
  if (node.name === 'small') style.fontSize *= .85;
  if (node.name === 'code') {
    style.code = true;
    style.fontFamily = '"SFMono-Regular",Menlo,Consolas,monospace';
    if (rule.inlineCodeFont === 'quote') style.codeFont = 'quote';
  }
  if (css['font-size']) style.fontSize = px(css['font-size'], parent.fontSize, style.fontSize);
  if (style.fontSize < 6 || style.fontSize > 72) throw new Error('行内字号不在可图片化的安全范围');
  if (css['font-weight']) {
    const weight = css['font-weight'];
    style.fontWeight = weight === 'bold' ? 700 : weight === 'normal' ? 400 : weight === 'bolder' ? Math.max(700, parent.fontWeight) : /^\d{3}$/.test(weight) ? Number(weight) : parent.fontWeight;
  }
  if (['normal', 'italic', 'oblique'].includes(css['font-style'])) style.fontStyle = css['font-style'];
  if (css.color && !['inherit', 'unset'].includes(css.color)) style.color = css.color;
  // Paragraph paint is explicit theme art direction. An inline color override
  // and inline code retain their own ink and semantics inside that paragraph.
  if (rule.textPaint && (style.code || (node.name !== 'p' && css.color
    && !['inherit', 'unset'].includes(css.color)
    && css.color.toLowerCase() !== parent.color.toLowerCase()))) style.useTextPaint = false;
  if (style.code && css['font-family']) style.fontFamily = css['font-family'];
  if (css['letter-spacing'] && css['letter-spacing'] !== 'normal') style.letterSpacing = px(css['letter-spacing'], style.fontSize, style.letterSpacing);
  if (css['line-height'] && css['line-height'] !== 'inherit') {
    if (/^\d*\.?\d+$/.test(css['line-height'])) { style.lineHeight = Number(css['line-height']); style.absoluteLineHeight = null; }
    else style.absoluteLineHeight = px(css['line-height'], style.fontSize, null);
  }
  const decoration = css['text-decoration-line'] ?? css['text-decoration'];
  if (decoration?.includes('underline')) style.underline = true;
  if (node.name === 'u') style.underline = true;
  // Only the new quote-font mode resolves a newly introduced underline from
  // currentColor. An actual ancestor underline keeps its originating color.
  const underlineColor = rule.inlineCodeFont === 'quote' && style.underline && !parent.underline
    ? style.color : style.underlineColor ?? style.color;
  style.underlineColor = css['text-decoration-color'] ?? css['border-bottom-color'] ?? underlineColor;
  const padding = sides(css.padding ?? '0').map((value) => px(value, style.fontSize));
  for (const [index, side] of ['top', 'right', 'bottom', 'left'].entries()) if (css[`padding-${side}`]) padding[index] = px(css[`padding-${side}`], style.fontSize);
  const borders = ['top', 'right', 'bottom', 'left'].map((side, index) => edge(css, side, index, style.fontSize, style.color));
  const background = css['background-color'] ?? (node.name === 'mark' ? '#FFF1A8' : 'transparent');
  const box = node.name === 'code' || node.name === 'mark' || !TRANSPARENT.test(background) || borders.some((border) => border.width > 0)
    ? { kind: node.name === 'code' ? 'code' : 'inline', padding, borders, background, radius: px(css['border-radius']?.split(/\s+/)[0], style.fontSize), keepTogether: node.name === 'code' }
    : null;
  return { style, box };
}

/** Retain both the normalized inline tree and styled source ranges. */
export function extractQuoteRichText(paragraph, rule) {
  let offset = 0;
  let boxSequence = 0;
  let text = '';
  const runs = [];
  const defaults = { fontSize: rule.fontSize, fontWeight: 400, fontStyle: 'normal', color: rule.color, lineHeight: rule.lineHeight, absoluteLineHeight: null, letterSpacing: rule.letterSpacing, code: false, fontFamily: '', underline: false, underlineColor: null };
  if (rule.textPaint) defaults.useTextPaint = true;
  const base = resolvedStyle(paragraph, defaults, rule).style;
  const walk = (node, parentStyle, activeBox = null) => {
    const start = offset;
    if (node.type === 'comment') return null;
    if (node.type === 'text') {
      const value = parentStyle.code ? node.data : node.data.replace(/[\r\n\t]+/gu, ' ');
      text += value; offset += value.length;
      if (value) runs.push({ text: value, start, end: offset, style: { ...parentStyle }, box: activeBox });
      return { type: 'text', text: value, start, end: offset };
    }
    if (node.name === 'br') {
      text += '\n'; offset += 1;
      runs.push({ text: '\n', start, end: offset, style: { ...parentStyle }, box: activeBox });
      return { type: 'br', start, end: offset };
    }
    if (FORBIDDEN.has(node.name)) throw new Error('段落含链接、上下标或删除线，需保留原始语义');
    if (!INLINE.has(node.name) || node.attribs?.['aria-hidden'] === 'true') throw new Error('段落含图片或复杂行内结构');
    const resolved = resolvedStyle(node, parentStyle, rule);
    if (resolved.box && activeBox) throw new Error('嵌套的行内边框或底色需保留原始样式');
    const box = resolved.box ? { ...resolved.box, id: ++boxSequence } : activeBox;
    const children = (node.children ?? []).map((child) => walk(child, resolved.style, box)).filter(Boolean);
    return { type: 'element', tag: node.name, attribs: { ...node.attribs }, start, end: offset, children };
  };
  const children = (paragraph.children ?? []).map((node) => walk(node, base)).filter(Boolean);
  return { text, runs, tree: { type: 'root', start: 0, end: offset, children } };
}

/** Scale resolved typography once, including px CSS overrides and code boxes.
 * The source tree stays unchanged so copy fallback restores original rich HTML.
 */
export function scaleQuoteRichText(rich, factor) {
  if (factor === 1) return rich;
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('金句文字缩放比例无效');
  const boxes = new Map();
  const scaleBox = (box) => {
    if (!box) return box;
    if (!boxes.has(box)) boxes.set(box, { ...box,
      padding: box.padding.map(value => value * factor),
      borders: box.borders.map(border => ({ ...border, width: border.width * factor })),
      radius: box.radius * factor,
    });
    return boxes.get(box);
  };
  const runs = rich.runs.map(run => {
    const fontSize = run.style.fontSize * factor;
    if (fontSize < 6 || fontSize > 72) throw new Error('自适应后的行内字号不在可图片化的安全范围');
    return { ...run, box: scaleBox(run.box), style: { ...run.style,
      fontSize, letterSpacing: run.style.letterSpacing * factor,
      absoluteLineHeight: Number.isFinite(run.style.absoluteLineHeight) ? run.style.absoluteLineHeight * factor : run.style.absoluteLineHeight,
    } };
  });
  return { ...rich, runs };
}

/** Re-open/close rich ancestors at every PNG boundary; never leak a tag. */
export function sliceQuoteRichHtml(tree, start, end) {
  const visit = (node) => {
    if (node.end <= start || node.start >= end) return '';
    if (node.type === 'text') return escape(node.text.slice(Math.max(0, start - node.start), Math.min(node.text.length, end - node.start)));
    if (node.type === 'br') return '<br>';
    const inner = node.children.map(visit).join('');
    if (node.type === 'root' || !inner) return inner;
    const attrs = Object.entries(node.attribs ?? {}).filter(([key]) => !/^on/i.test(key)).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
    return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
  };
  return visit(tree);
}

function glyphFamily(grapheme, style, font) {
  if (!style.code || style.codeFont === 'quote') return font.familyForGrapheme(grapheme);
  const fallback = /^[\u0020-\u007e]+$/u.test(grapheme) ? `"${font.runtimeFamily}"` : font.familyForGrapheme(grapheme);
  return `${style.fontFamily || 'Menlo,Consolas,monospace'},${fallback}`;
}

export function makeQuoteRichMeasurer(context, font, measureFactory) {
  const measures = new Map();
  const metrics = new Map();
  return (grapheme, style) => {
    const family = glyphFamily(grapheme, style, font);
    const styleKey = JSON.stringify([style, family]);
    const key = styleKey + '\0' + grapheme;
    if (metrics.has(key)) return metrics.get(key);
    const typography = { fontFamily: font.runtimeFamily, latinFontFamily: font.runtimeFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle, familyForGrapheme: () => family };
    if (!measures.has(styleKey)) measures.set(styleKey, measureFactory(context, typography));
    const width = measures.get(styleKey)(grapheme);
    const canvasFont = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${family}`;
    context.font = canvasFont;
    const measured = typeof context.measureText === 'function' ? context.measureText(style.code && style.codeFont !== 'quote' ? 'Ag' : '国Ag') : {};
    const ascent = measured.actualBoundingBoxAscent || style.fontSize * .82;
    const descent = measured.actualBoundingBoxDescent || style.fontSize * .18;
    if (!Number.isFinite(width) || width < 0) throw new Error('行内字形宽度无效');
    const value = { width, ascent, descent, font: canvasFont };
    metrics.set(key, value);
    return value;
  };
}

const atomWidth = (atoms) => atoms.reduce((sum, atom, index) => sum + atom.metrics.width + (index ? atom.style.letterSpacing : 0), 0);
const boxHorizontal = (box) => box ? box.padding[1] + box.padding[3] + box.borders[1].width + box.borders[3].width : 0;

function makeFragment(atoms, box = null) {
  const glyphWidth = atomWidth(atoms);
  let ascent = 0, descent = 0;
  for (const atom of atoms) {
    const lineHeight = atom.style.absoluteLineHeight ?? atom.style.fontSize * atom.style.lineHeight;
    const leading = Math.max(0, lineHeight - atom.metrics.ascent - atom.metrics.descent) / 2;
    ascent = Math.max(ascent, atom.metrics.ascent + leading);
    descent = Math.max(descent, atom.metrics.descent + leading);
  }
  if (box) { ascent += box.padding[0] + box.borders[0].width; descent += box.padding[2] + box.borders[2].width; }
  return { atoms, box, width: glyphWidth + boxHorizontal(box), ascent, descent };
}

/** Style-aware linear layout, keeping short code boxes atomic. */
export function layoutQuoteRichText(rich, { maxWidth, rule, measure, segmentGraphemes }) {
  const atoms = [];
  for (const run of rich.runs) {
    let offset = run.start;
    for (const grapheme of segmentGraphemes(run.text)) {
      const end = offset + grapheme.length;
      atoms.push({ text: grapheme, start: offset, end, style: run.style, box: run.box, metrics: grapheme === '\n' ? null : measure(grapheme, run.style) });
      offset = end;
    }
  }
  if (atoms.length > 2000) throw new Error('金句段落超过 2000 字形安全上限');
  const lines = [];
  let fragments = [], used = 0, lineStart = 0, lineEnd = 0;
  const pushLine = () => {
    let above = Math.max(0, ...fragments.map((fragment) => fragment.ascent));
    let below = Math.max(0, ...fragments.map((fragment) => fragment.descent));
    const extra = Math.max(0, rule.fontSize * rule.lineHeight - above - below) / 2;
    above += extra; below += extra;
    lines.push({ fragments, start: lineStart, end: lineEnd, raw: rich.text.slice(lineStart, lineEnd), text: rich.text.slice(lineStart, lineEnd).replace(/\n$/, ''), ascent: above, descent: below, height: above + below, width: used });
    fragments = []; used = 0; lineStart = lineEnd;
  };
  const add = (fragment) => {
    const gap = fragments.length && !fragment.box ? fragment.atoms[0].style.letterSpacing : 0;
    fragment.x = used + gap;
    fragments.push(fragment); used += fragment.width + gap; lineEnd = fragment.atoms.at(-1).end;
  };
  let at = 0;
  while (at < atoms.length) {
    const atom = atoms[at];
    if (atom.text === '\n') { lineEnd = atom.end; pushLine(); at += 1; continue; }
    if (!atom.box) {
      const fragment = makeFragment([atom]);
      const gap = fragments.length ? atom.style.letterSpacing : 0;
      if (fragment.width > maxWidth) throw new Error('金句字形超过可用宽度');
      if (fragments.length && used + gap + fragment.width > maxWidth) {
        const previous = fragments.at(-1);
        const completeCode = previous?.box?.kind === 'code' && previous.box.keepTogether
          && previous.atoms[0] === atoms[at - previous.atoms.length]
          && atoms[at - previous.atoms.length - 1]?.box?.id !== previous.box.id;
        const canCarry = previous && (!previous.box || completeCode)
          && previous.width + fragment.width + atom.style.letterSpacing <= maxWidth;
        if (CLOSE.test(atom.text) && fragments.length > 1 && canCarry) {
          const carry = fragments.pop(); used = carry.x; lineEnd = carry.atoms[0].start; pushLine(); add(carry);
        } else pushLine();
      }
      add(fragment); at += 1; continue;
    }
    let end = at;
    while (end < atoms.length && atoms[end].box?.id === atom.box.id && atoms[end].text !== '\n') end += 1;
    const group = atoms.slice(at, end);
    const whole = makeFragment(group, atom.box);
    if (atom.box.keepTogether && whole.width <= maxWidth) {
      if (fragments.length && used + whole.width > maxWidth) pushLine();
      add(whole); at = end; continue;
    }
    const horizontal = boxHorizontal(atom.box);
    let consumed = 0;
    while (consumed < group.length) {
      const room = maxWidth - used - horizontal;
      let count = 0, textWidth = 0;
      while (consumed + count < group.length) {
        const next = group[consumed + count];
        const nextWidth = textWidth + next.metrics.width + (count ? next.style.letterSpacing : 0);
        if (nextWidth > room) break;
        textWidth = nextWidth; count += 1;
      }
      if (count === 0) {
        if (!fragments.length) throw new Error('代码字形与边框无法放入引用宽度');
        pushLine(); continue;
      }
      add(makeFragment(group.slice(consumed, consumed + count), atom.box));
      consumed += count;
      if (consumed < group.length) pushLine();
    }
    at = end;
  }
  if (fragments.length) pushLine();
  if (!lines.length || lines.length > 128) throw new Error('金句行数超出安全范围');
  if (lines.some((line) => !Number.isFinite(line.width) || line.width > maxWidth + .001)) throw new Error('带样式的金句行超过可用宽度');
  return lines;
}

function paintBox(context, box, x, y, width, height) {
  const fill = box.background && !TRANSPARENT.test(box.background);
  const uniform = box.borders.every((border) => border.width === box.borders[0].width && border.color === box.borders[0].color);
  if (fill) { context.fillStyle = box.background; context.fillRect(x, y, width, height); }
  if (uniform && box.borders[0].width > 0) {
    const border = box.borders[0]; context.strokeStyle = border.color; context.lineWidth = border.width;
    if (box.radius > 0 && typeof context.roundRect === 'function') {
      context.beginPath(); context.roundRect(x + border.width / 2, y + border.width / 2, width - border.width, height - border.width, Math.min(box.radius, height / 2)); context.stroke();
    } else context.strokeRect(x + border.width / 2, y + border.width / 2, width - border.width, height - border.width);
    return;
  }
  for (const [index, border] of box.borders.entries()) {
    if (!border.width) continue;
    context.fillStyle = border.color;
    if (index === 0) context.fillRect(x, y, width, border.width);
    else if (index === 1) context.fillRect(x + width - border.width, y, border.width, height);
    else if (index === 2) context.fillRect(x, y + height - border.width, width, border.width);
    else context.fillRect(x, y, border.width, height);
  }
}

/** Quote-only rasterizer; no mutation of heading rendering or loaded fonts. */
export function renderQuoteRichPng({ layout, rule, document: ownerDocument = globalThis.document, PNGEncoder = PNG }) {
  const physicalWidth = layout.width * rule.scale, physicalHeight = layout.height * rule.scale;
  const canvas = ownerDocument.createElement('canvas'); canvas.width = physicalWidth; canvas.height = physicalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法取得金句绘制画布');
  context.clearRect(0, 0, physicalWidth, physicalHeight); context.scale(rule.scale, rule.scale);
  context.textBaseline = 'alphabetic'; context.textAlign = 'left';
  let y = rule.paddingY;
  for (const line of layout.richLines) {
    const baseline = y + line.ascent;
    const paintedGlyphs = [];
    const underlines = [];
    for (const fragment of line.fragments) {
      let x = rule.paddingX + fragment.x;
      if (fragment.box) {
        paintBox(context, fragment.box, x, baseline - fragment.ascent, fragment.width, fragment.ascent + fragment.descent);
        x += fragment.box.padding[3] + fragment.box.borders[3].width;
      }
      for (const [index, atom] of fragment.atoms.entries()) {
        if (index) x += atom.style.letterSpacing;
        if (rule.textPaint && atom.style.useTextPaint) {
          paintedGlyphs.push({ atom, x });
        } else {
          context.font = atom.metrics.font; context.fillStyle = atom.style.color;
          context.fillText(atom.text, x, baseline);
        }
        if (atom.style.underline) {
          if (rule.textPaint && atom.style.useTextPaint) underlines.push({ atom, x });
          else {
            context.fillStyle = atom.style.underlineColor || atom.style.color;
            context.fillRect(x, baseline + Math.max(1, atom.metrics.descent * .4), atom.metrics.width + atom.style.letterSpacing, Math.max(1, atom.style.fontSize / 18));
          }
        }
        x += atom.metrics.width;
      }
    }
    if (paintedGlyphs.length) {
      paintTextLine(context, { paint: rule.textPaint, color: rule.color, lineTop: y,
        lineHeight: line.height,
        draw: (method, offsetX, offsetY) => {
          for (const { atom, x } of paintedGlyphs) {
            context.font = atom.metrics.font;
            context[method](atom.text, x + offsetX, baseline + offsetY);
          }
        },
      });
      for (const { atom, x } of underlines) {
        context.fillStyle = atom.style.underlineColor || atom.style.color;
        context.fillRect(x, baseline + Math.max(1, atom.metrics.descent * .4), atom.metrics.width + atom.style.letterSpacing, Math.max(1, atom.style.fontSize / 18));
      }
    }
    y += line.height;
  }
  const pixels = context.getImageData(0, 0, physicalWidth, physicalHeight);
  const bytes = PNGEncoder.sync.write({ width: physicalWidth, height: physicalHeight, data: Buffer.from(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength) }, { colorType: 6, inputColorType: 6, inputHasAlpha: true });
  return { bytes: Buffer.from(bytes), physicalWidth, physicalHeight };
}
