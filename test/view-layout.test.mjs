import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionButtonDisabledState,
  applyPreviewWidth,
  applyThemeSelectWidth,
  MOBILE_EDITOR_CANVAS_EXTRA_WIDTH,
  previewLayoutForMode,
  previewScaleForWidth,
  themeSelectWidthEm,
  WECHAT_EDITOR_CANVAS_EXTRA_WIDTH,
} from '../plugin/view-layout.mjs';

test('每次应用预览宽度时同步正文与微信编辑器画布，不生成悬浮提示', () => {
  const properties = new Map();
  const attributes = new Map();
  const contentEl = { style: { setProperty: (name, value) => properties.set(name, value) } };
  const shellEl = {
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  };
  attributes.set('aria-label', '旧提示');
  attributes.set('aria-labelledby', '旧关联提示');

  applyPreviewWidth(contentEl, shellEl, 720);

  assert.equal(properties.get('--wechat-preview-width'), '720px');
  assert.equal(
    properties.get('--wechat-editor-canvas-width'),
    `${720 + WECHAT_EDITOR_CANVAS_EXTRA_WIDTH}px`,
  );
  assert.equal(attributes.has('aria-label'), false);
  assert.equal(attributes.has('aria-labelledby'), false);
  assert.equal(attributes.get('data-preview-width'), '720');
});

test('手机预览使用可配置窄宽和轻量外框，桌面预览保持 677px 基准', () => {
  assert.deepEqual(previewLayoutForMode({
    desktopWidth: 677,
    mobileWidth: 390,
    mobilePreview: false,
  }), {
    mode: 'desktop',
    previewWidth: 677,
    canvasExtraWidth: WECHAT_EDITOR_CANVAS_EXTRA_WIDTH,
    canvasWidth: 900,
  });
  assert.deepEqual(previewLayoutForMode({
    desktopWidth: 677,
    mobileWidth: 386,
    mobilePreview: true,
  }), {
    mode: 'mobile',
    previewWidth: 386,
    canvasExtraWidth: MOBILE_EDITOR_CANVAS_EXTRA_WIDTH,
    canvasWidth: 418,
  });
});

test('手机预览宽度应用到正文和手机外框，不把桌面 223px 留白带过去', () => {
  const properties = new Map();
  const contentEl = { style: { setProperty: (name, value) => properties.set(name, value) } };
  const shellEl = { setAttribute() {}, removeAttribute() {} };

  applyPreviewWidth(contentEl, shellEl, 390, MOBILE_EDITOR_CANVAS_EXTRA_WIDTH);

  assert.equal(properties.get('--wechat-preview-width'), '390px');
  assert.equal(properties.get('--wechat-editor-canvas-width'), '422px');
});

test('900px 编辑画布按面板宽度等比缩放且不放大', () => {
  assert.equal(previewScaleForWidth(707, 900), 707 / 900);
  assert.equal(previewScaleForWidth(900, 900), 1);
  assert.equal(previewScaleForWidth(1200, 900), 1);
  assert.equal(previewScaleForWidth('bad', 900), 1);
});

test('风格选择框按当前名称自适应宽度并限制极值', () => {
  assert.equal(themeSelectWidthEm('经典蓝调风格'), 8.4);
  assert.equal(themeSelectWidthEm('A'), 6);
  assert.equal(themeSelectWidthEm('这是一个非常非常非常长的公众号排版模板名称'), 20);

  const selectEl = { style: {} };
  applyThemeSelectWidth(selectEl, '微信读书风格');
  assert.equal(selectEl.style.width, '8.4em');
});

test('复制与导出共用忙碌状态并互相禁用', () => {
  assert.deepEqual(actionButtonDisabledState({
    isRendering: false,
    exporting: false,
    copyLocked: false,
    hasRender: true,
  }), { copyDisabled: false, exportDisabled: false });
  assert.deepEqual(actionButtonDisabledState({
    isRendering: false,
    exporting: false,
    copyLocked: true,
    hasRender: true,
  }), { copyDisabled: true, exportDisabled: true });
  assert.deepEqual(actionButtonDisabledState({
    isRendering: false,
    exporting: true,
    copyLocked: false,
    hasRender: true,
  }), { copyDisabled: true, exportDisabled: true });
});
