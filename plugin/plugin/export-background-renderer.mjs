import html2canvasModule from 'html2canvas/dist/lib/index.js';
import canvasModule from 'html2canvas/dist/lib/render/canvas/canvas-renderer.js';
import backgroundModule from 'html2canvas/dist/lib/render/background.js';

/**
 * html2canvas 1.4.1 normally shrinks URL backgrounds to CSS-sized canvases
 * before painting onto the scaled output. Keep the source pixels instead;
 * the pattern transform preserves CSS size/repeat, including fractional sizes.
 * Returning null asks the caller to retain the library's original fallback.
 */
export function sourceBackgroundPattern(ctx, image, width, height, repetition = 'repeat') {
  if (![image.width, image.height, width, height].every(n => Number.isFinite(n) && n > 0)) {
    return null;
  }
  const pattern = ctx.createPattern(image, repetition);
  if (typeof pattern?.setTransform !== 'function') return null;
  try {
    pattern.setTransform({ a: width / image.width, b: 0, c: 0, d: height / image.height, e: 0, f: 0 });
    return pattern;
  } catch {
    return null;
  }
}

export function withSourceBackgrounds(BaseRenderer, calculateBackgroundRendering) {
  return class ExportCanvasRenderer extends BaseRenderer {
    async renderBackgroundImage(container) {
      const layers = container.styles.backgroundImage;
      // Type 0 is URL in 1.4.1. Fractional background sizes need this path even
      // at 1x: the upstream temporary canvas truncates 354.8px to 354px, then
      // repeats the dark left edge into a 355px rounded no-repeat clip.
      if (layers.some(layer => layer.type !== 0)) {
        return super.renderBackgroundImage(container);
      }
      for (let index = layers.length - 1; index >= 0; index--) {
        const { url } = layers[index];
        let image;
        try {
          image = await this.context.cache.match(url);
        } catch {
          this.context.logger.error(`Error loading background-image ${url}`);
        }
        if (!image) continue;
        const [path, x, y, width, height] = calculateBackgroundRendering(container, index, [
          image.width, image.height, image.width / image.height,
        ]);
        const repeats = container.styles.backgroundRepeat ?? [0];
        const repetition = ['repeat', 'no-repeat', 'repeat-x', 'repeat-y'][repeats[index] ?? repeats[0]] ?? 'repeat';
        const pattern = sourceBackgroundPattern(this.ctx, image, width, height, repetition)
          ?? this.ctx.createPattern(this.resizeImage(image, width, height), repetition);
        if (pattern) this.renderRepeat(path, pattern, x, y);
      }
    }
  };
}

// Private to the plugin's export bundle: no node_modules edit, global Canvas
// hook, DOM rewrite, or change to preview/copy HTML. Pin 1.4.1 because this
// adapter uses its internal CJS renderer export; re-test when upgrading it.
canvasModule.CanvasRenderer = withSourceBackgrounds(
  canvasModule.CanvasRenderer,
  backgroundModule.calculateBackgroundRendering,
);

export default html2canvasModule.default;
