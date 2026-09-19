/**
 * html2canvas draws a wrapped inline background as one bounding box, which can
 * cover text elsewhere on both lines. Paint actual browser line fragments below
 * text instead. Run ONLY inside the isolated export iframe after fonts load.
 * Absolute fragments do not change text, line breaks, flow, or document height.
 */
const hasInlinePencilImage = style => /^url\(/.test(style.backgroundImage)
  && style.backgroundRepeat === 'repeat-x'
  && ['100%', 'bottom', '50%', 'center'].includes(style.backgroundPositionY)
  && /^\d+(?:\.\d+)?px \d+(?:\.\d+)?px$/.test(style.backgroundSize);

export function prepareExportInlineBackgrounds(root) {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const candidates = [...root.querySelectorAll('*')].filter(element => {
    const style = view.getComputedStyle(element);
    const transparent = style.backgroundColor === 'transparent'
      || /^rgba\([^)]*,\s*0\s*\)$/.test(style.backgroundColor);
    return style.display === 'inline' && style.writingMode === 'horizontal-tb'
      && ((style.backgroundImage === 'none' && !transparent) || hasInlinePencilImage(style))
      && element.getClientRects().length > 1;
  });
  let fragmentCount = 0;
  for (const element of candidates) {
    const style = view.getComputedStyle(element);
    const color = style.backgroundColor;
    const imageUnderline = hasInlinePencilImage(style);
    const imagePositionY = ['50%', 'center'].includes(style.backgroundPositionY) ? 'center' : 'bottom';
    const image = style.backgroundImage;
    const imageSize = style.backgroundSize;
    const rects = [...element.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    if (rects.length < 2) continue;
    let parent = element.parentElement;
    while (parent && parent !== root
        && ['inline', 'contents'].includes(view.getComputedStyle(parent).display)) {
      parent = parent.parentElement;
    }
    if (!parent) continue;
    const parentStyle = view.getComputedStyle(parent);
    if (parentStyle.position === 'static') parent.style.position = 'relative';
    if (parentStyle.zIndex === 'auto') parent.style.zIndex = '0';
    const parentRect = parent.getBoundingClientRect();
    const borderLeft = Number.parseFloat(parentStyle.borderLeftWidth) || 0;
    const borderTop = Number.parseFloat(parentStyle.borderTopWidth) || 0;
    const cloneEdges = style.boxDecorationBreak === 'clone' || style.webkitBoxDecorationBreak === 'clone';
    element.style.backgroundColor = 'transparent';
    if (imageUnderline) element.style.backgroundImage = 'none';
    let fragmentOffset = 0;
    for (const [index, rect] of rects.entries()) {
      const leftEdge = cloneEdges || index === (style.direction === 'rtl' ? rects.length - 1 : 0);
      const rightEdge = cloneEdges || index === (style.direction === 'rtl' ? 0 : rects.length - 1);
      const radii = [
        leftEdge ? style.borderTopLeftRadius : '0',
        rightEdge ? style.borderTopRightRadius : '0',
        rightEdge ? style.borderBottomRightRadius : '0',
        leftEdge ? style.borderBottomLeftRadius : '0',
      ].join(' ');
      const fragment = doc.createElement('span');
      fragment.setAttribute('aria-hidden', 'true');
      fragment.setAttribute('data-export-inline-background', '');
      fragment.style.cssText = [
        'display:block', 'position:absolute',
        `left:${rect.left - parentRect.left - borderLeft + parent.scrollLeft}px`,
        `top:${rect.top - parentRect.top - borderTop + parent.scrollTop}px`,
        `width:${rect.width}px`, `height:${rect.height}px`,
        `background-color:${color}`, 'border:0', `border-radius:${radii}`,
        ...(imageUnderline ? [
          `background-image:${image}`, `background-size:${imageSize}`,
          'background-repeat:repeat-x',
          `background-position:${cloneEdges ? 0 : -fragmentOffset}px ${imagePositionY}`,
        ] : []),
        'margin:0', 'padding:0', 'pointer-events:none', 'z-index:-1',
      ].join(';');
      // Preserve outer-before-inner paint order for nested colored spans.
      parent.append(fragment);
      fragmentCount += 1;
      fragmentOffset += rect.width;
    }
  }
  return fragmentCount;
}
