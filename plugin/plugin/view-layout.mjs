// 微信公众号桌面编辑器把 677px 正文放在约 900px 的白色编辑画布中。
// 这 223px 只属于本地预览外框，不进入复制 HTML，也不改变主题正文的 15px 页边距。
import { DEFAULT_MOBILE_PREVIEW_WIDTH, DEFAULT_PREVIEW_WIDTH } from './constants.mjs';

export const WECHAT_EDITOR_CANVAS_EXTRA_WIDTH = 223;
export const MOBILE_EDITOR_CANVAS_EXTRA_WIDTH = 32;

/** 390px 是手机参考宽度；不同机型可以通过设置在 320–430px 内调整。 */
export function previewLayoutForMode({
  desktopWidth = DEFAULT_PREVIEW_WIDTH,
  mobileWidth = DEFAULT_MOBILE_PREVIEW_WIDTH,
  mobilePreview = false,
} = {}) {
  const requestedWidth = Number(mobilePreview ? mobileWidth : desktopWidth);
  const fallbackWidth = mobilePreview ? DEFAULT_MOBILE_PREVIEW_WIDTH : DEFAULT_PREVIEW_WIDTH;
  const previewWidth = Number.isFinite(requestedWidth) && requestedWidth > 0
    ? requestedWidth
    : fallbackWidth;
  const canvasExtraWidth = mobilePreview
    ? MOBILE_EDITOR_CANVAS_EXTRA_WIDTH
    : WECHAT_EDITOR_CANVAS_EXTRA_WIDTH;
  return {
    mode: mobilePreview ? 'mobile' : 'desktop',
    previewWidth,
    canvasExtraWidth,
    canvasWidth: previewWidth + canvasExtraWidth,
  };
}

/** 把当前设置的正文宽度同时应用到正文与编辑器画布。 */
export function applyPreviewWidth(
  contentEl,
  shellEl,
  width,
  canvasExtraWidth = WECHAT_EDITOR_CANVAS_EXTRA_WIDTH,
) {
  contentEl.style.setProperty('--wechat-preview-width', `${width}px`);
  contentEl.style.setProperty(
    '--wechat-editor-canvas-width',
    `${width + canvasExtraWidth}px`,
  );
  // Obsidian 会把 aria-label 当成悬浮提示，曾在正文底部显示黑框白字。
  // article 本身已有文档语义，宽度无需额外朗读。
  shellEl?.removeAttribute('aria-label');
  shellEl?.removeAttribute('aria-labelledby');
  shellEl?.setAttribute('data-preview-width', String(width));
}

/** 面板不足 900px 时等比缩放整张编辑画布，保留 677px 排版与断行。 */
export function previewScaleForWidth(availableWidth, canvasWidth) {
  const available = Number(availableWidth);
  const canvas = Number(canvasWidth);
  if (!Number.isFinite(available) || !Number.isFinite(canvas) || canvas <= 0) return 1;
  return Math.max(0.1, Math.min(1, available / canvas));
}

/** 按当前风格名称估算选择框宽度，避免为未知的最长模板名长期留白。 */
export function themeSelectWidthEm(label) {
  const units = [...String(label ?? '')].reduce(
    (total, character) => total + (/^[\x00-\xFF]$/.test(character) ? 0.62 : 1),
    0,
  );
  return Math.min(20, Math.max(6, Number((units + 2.4).toFixed(2))));
}

export function applyThemeSelectWidth(selectEl, label) {
  if (!selectEl) return;
  selectEl.style.width = `${themeSelectWidthEm(label)}em`;
}

/** 复制与导出共用同一组忙碌状态，两者不能并发。 */
export function actionButtonDisabledState({ isRendering, exporting, copyLocked, hasRender }) {
  const unavailable = Boolean(isRendering || exporting || copyLocked || !hasRender);
  return { copyDisabled: unavailable, exportDisabled: unavailable };
}
