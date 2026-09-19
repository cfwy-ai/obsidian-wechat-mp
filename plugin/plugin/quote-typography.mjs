/** Resolve logical font pixels, keeping source/reference typography separate.
 * CSS is already inlined (and reference CSS already scaled) before this step.
 */
export function resolveResponsiveQuoteTypography(sourceRule, layoutWidth, referenceRule = sourceRule) {
  const config = sourceRule.responsiveTypography;
  if (!config || !Number.isFinite(layoutWidth) || layoutWidth < 240 || layoutWidth > 1000) {
    return { rule: referenceRule, factor: 1 };
  }
  const progress = Math.max(0, Math.min(1, (layoutWidth - config.minWidth) / (config.maxWidth - config.minWidth)));
  const fontSize = Number((sourceRule.fontSize + (config.maxFontSize - sourceRule.fontSize) * progress).toFixed(6));
  const factor = fontSize / referenceRule.fontSize;
  if (factor === 1) return { rule: referenceRule, factor };
  const rule = { ...referenceRule, fontSize, letterSpacing: referenceRule.letterSpacing * factor };
  if (referenceRule.textPaint) rule.textPaint = {
    ...referenceRule.textPaint,
    stroke: { ...referenceRule.textPaint.stroke, width: referenceRule.textPaint.stroke.width * factor },
    highlight: {
      ...referenceRule.textPaint.highlight,
      width: referenceRule.textPaint.highlight.width * factor,
      offsetX: referenceRule.textPaint.highlight.offsetX * factor,
      offsetY: referenceRule.textPaint.highlight.offsetY * factor,
    },
  };
  return { rule, factor };
}
