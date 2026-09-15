/** Shared Canvas ink: dark outline, per-line gold, then a restrained offset edge. */
export function paintTextLine(context, { paint, color, lineTop, lineHeight, draw }) {
  if (!paint) {
    context.fillStyle = color;
    draw('fillText', 0, 0);
    return;
  }
  if (paint.type !== 'gilded' || typeof context.createLinearGradient !== 'function') {
    throw new Error('当前画布不支持鎏金文字绘制');
  }
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  const gradient = context.createLinearGradient(0, lineTop, 0, lineTop + lineHeight);
  for (const stop of paint.stops) gradient.addColorStop(stop.offset, stop.color);
  if (paint.stroke.width > 0) {
    context.strokeStyle = paint.stroke.color;
    context.lineWidth = paint.stroke.width;
    context.lineJoin = 'round';
    draw('strokeText', 0, 0);
  }
  context.fillStyle = gradient;
  draw('fillText', 0, 0);
  if (paint.highlight.alpha > 0 && paint.highlight.width > 0) {
    context.globalAlpha = paint.highlight.alpha;
    context.strokeStyle = paint.highlight.color;
    context.lineWidth = paint.highlight.width;
    context.lineJoin = 'round';
    draw('strokeText', paint.highlight.offsetX, paint.highlight.offsetY);
    context.globalAlpha = 1;
  }
}

export function textPaintPadding(paint) {
  if (!paint) return 0;
  return Math.ceil(Math.max(paint.stroke.width / 2,
    paint.highlight.width / 2 + Math.abs(paint.highlight.offsetX),
    paint.highlight.width / 2 + Math.abs(paint.highlight.offsetY)) + 1);
}
