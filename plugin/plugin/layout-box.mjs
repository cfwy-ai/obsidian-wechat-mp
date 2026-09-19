import postcss from 'postcss';

export const inlineStyleMap = (node) => {
  const css = {};
  postcss.parse(`x{${node.attribs?.style ?? ''}}`).walkDecls((declaration) => {
    css[declaration.prop.toLowerCase()] = declaration.value.trim();
  });
  return css;
};

export const cssLength = (value, reference, fontSize) => {
  if (!value || ['auto', 'none', 'hidden'].includes(value)) return 0;
  if (['thin', 'medium', 'thick'].includes(value)) return { thin: 1, medium: 3, thick: 5 }[value];
  const match = /^([0-9.]+)(px|%|em|rem)?$/.exec(value);
  if (!match) throw new Error(`标题容器含无法测量的长度 ${value}`);
  const number = Number(match[1]);
  return number * (match[2] === '%' ? reference / 100 : match[2] === 'em' ? fontSize : match[2] === 'rem' ? 16 : 1);
};

const horizontalLengths = (css, property, reference, fontSize) => {
  const parts = (css[property] ?? '0').split(/\s+/);
  return ['left', 'right'].reduce((total, side) => {
    const value = css[`${property}-${side}`]
      ?? (side === 'left' && parts.length === 4 ? parts[3] : parts.length >= 2 ? parts[1] : parts[0]);
    return total + cssLength(value, reference, fontSize);
  }, 0);
};

/** Read the same final inline boxes delivered to preview, copy and export. */
export function headingContainerWidth(chain, layoutWidth, maxWidth) {
  if (!Array.isArray(chain) || !chain.length) throw new Error('未找到标题的正文容器');
  if (!Number.isFinite(layoutWidth) || layoutWidth < 240 || layoutWidth > 1000) {
    throw new Error('标题容器模式缺少有效布局宽度');
  }
  let available = layoutWidth;
  let fontSize = 16;
  for (const node of chain) {
    const css = inlineStyleMap(node);
    const reference = available;
    if (css['font-size']) fontSize = cssLength(css['font-size'], reference, fontSize) || fontSize;
    const margin = horizontalLengths(css, 'margin', reference, fontSize);
    const padding = horizontalLengths(css, 'padding', reference, fontSize);
    const border = ['left', 'right'].reduce((total, side) => {
      const parts = (css['border-width'] ?? '').split(/\s+/).filter(Boolean);
      const indexed = side === 'left' && parts.length === 4 ? parts[3] : parts.length >= 2 ? parts[1] : parts[0];
      const shorthand = css[`border-${side}`] ?? css.border;
      const value = css[`border-${side}-width`] ?? indexed ?? shorthand?.split(/\s+/)[0];
      return total + cssLength(value, reference, fontSize);
    }, 0);
    const innerLimit = Math.max(0, reference - margin - padding - border);
    // Percentages refer to the containing box before this element's own padding.
    available = css.width && css.width !== 'auto'
      ? Math.min(innerLimit, cssLength(css.width, reference, fontSize))
      : innerLimit;
    if (css['max-width'] && css['max-width'] !== 'none') {
      available = Math.min(available, cssLength(css['max-width'], reference, fontSize));
    }
  }
  return Math.floor(Math.min(maxWidth, available));
}

