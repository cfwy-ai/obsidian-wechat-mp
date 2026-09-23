import { Notice, setIcon } from 'obsidian';

let headerControlCount = 0;

const makeElement = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const makeButton = (className, label) => {
  const button = makeElement('button', className, label);
  button.type = 'button';
  return button;
};

const contextKey = context => context
  ? JSON.stringify([context.articlePath, context.themeId, context.definition?.componentId,
    Boolean(context.footerAvailable)])
  : '';

const copyContext = context => ({
  ...context,
  definition: context.definition ? {
    ...context.definition,
    presets: (context.definition.presets ?? []).map(preset => ({ ...preset })),
  } : null,
  selection: { ...(context.selection ?? {}) },
  footerAvailable: Boolean(context.footerAvailable),
  footerEnabled: context.footerEnabled !== false,
  assets: (context.assets ?? []).map(asset => ({ ...asset })),
});

/** A per-article picker. File persistence and render selection belong to the caller. */
export function createArticleHeaderControls({ getContext, applySelection, applyFooter, uploadFile }) {
  const element = makeElement('div', 'wechat-mp-header-control');
  const trigger = makeButton('wechat-mp-tool-button wechat-mp-header-trigger', '头图尾图');
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');

  const panel = makeElement('div', 'wechat-mp-header-popover');
  const panelId = `wechat-mp-header-panel-${++headerControlCount}`;
  panel.id = panelId;
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '头图与尾图选项');
  trigger.setAttribute('aria-controls', panelId);

  const visibility = makeElement('div', 'wechat-mp-header-visibility');
  const visibilityCopy = makeElement('div', 'wechat-mp-header-visibility-copy');
  visibilityCopy.append(makeElement('span', null, '展示头图'));
  const visibilityDescription = makeElement('small', null, '显示在正文最上方');
  visibilityCopy.append(visibilityDescription);
  const visibilityToggle = makeButton('wechat-mp-header-switch', '');
  visibilityToggle.setAttribute('role', 'switch');
  visibilityToggle.setAttribute('aria-label', '展示文章头图');
  visibilityToggle.setAttribute('aria-checked', 'true');
  visibilityToggle.append(makeElement('span', 'wechat-mp-header-switch-thumb'));
  visibility.append(visibilityCopy, visibilityToggle);

  const presetsTitle = makeElement('div', 'wechat-mp-header-section-label', '预设头图');
  const presetGrid = makeElement('div', 'wechat-mp-header-presets');
  presetGrid.setAttribute('role', 'group');
  presetGrid.setAttribute('aria-label', '选择预设头图');

  const customSection = makeElement('div', 'wechat-mp-header-custom');
  const customPreview = makeElement('div', 'wechat-mp-header-custom-preview');
  customPreview.hidden = true;
  const customImage = makeElement('img');
  customImage.alt = '当前文章的自定义头图';
  customPreview.append(customImage, makeElement('span', null, '当前使用：自定义图片'));
  const uploadButton = makeButton('wechat-mp-header-upload', '上传自己的图片');
  const uploadHelp = makeElement('small', 'wechat-mp-header-upload-help', 'PNG / JPG · 建议使用约 3:1 的横图');
  const fileInput = makeElement('input', 'wechat-mp-header-file-input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg';
  fileInput.hidden = true;
  fileInput.tabIndex = -1;
  customSection.append(customPreview, uploadButton, uploadHelp, fileInput);

  // 尾图是主题成套设计的一段，只开关不换图，所以与头图并列但没有预设网格。
  const footerRow = makeElement('div', 'wechat-mp-header-visibility wechat-mp-footer-visibility');
  const footerCopy = makeElement('div', 'wechat-mp-header-visibility-copy');
  footerCopy.append(makeElement('span', null, '展示尾图'));
  const footerDescription = makeElement('small', null, '显示在正文最下方');
  footerCopy.append(footerDescription);
  const footerToggle = makeButton('wechat-mp-header-switch', '');
  footerToggle.setAttribute('role', 'switch');
  footerToggle.setAttribute('aria-label', '展示文章尾图');
  footerToggle.setAttribute('aria-checked', 'true');
  footerToggle.append(makeElement('span', 'wechat-mp-header-switch-thumb'));
  footerRow.append(footerCopy, footerToggle);

  const foot = makeElement('div', 'wechat-mp-header-panel-foot');
  const resetButton = makeButton('wechat-mp-header-reset', '恢复主题默认');
  const status = makeElement('span', 'wechat-mp-header-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  foot.append(resetButton, status);
  panel.append(visibility, presetsTitle, presetGrid, customSection, footerRow, foot);
  element.append(trigger);

  let currentKey = '';
  let cardsKey = '';
  let presetButtons = [];
  let open = false;
  let busy = false;
  let disposed = false;
  let chooserContext = null;
  let positionFrame = null;

  const hasHeader = context => Boolean(context?.definition && context.available !== false);
  const hasFooter = context => Boolean(context?.footerAvailable);
  const isAvailable = context => Boolean(context?.articlePath)
    && (hasHeader(context) || hasFooter(context));

  const close = ({ restoreFocus = false } = {}) => {
    open = false;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !trigger.disabled) trigger.focus();
  };

  const positionPanel = () => {
    if (!open || disposed) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    panel.style.width = `${Math.max(0, Math.min(330, viewportWidth - margin * 2))}px`;
    panel.style.maxHeight = `${Math.max(0, viewportHeight - margin * 2)}px`;
    const width = panel.getBoundingClientRect().width;
    const height = panel.getBoundingClientRect().height;
    const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin));
    let top = rect.bottom + 7;
    if (top + height > viewportHeight - margin) {
      top = Math.max(margin, viewportHeight - height - margin);
    }
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };

  const schedulePosition = () => {
    if (!open || positionFrame !== null) return;
    positionFrame = window.requestAnimationFrame(() => {
      positionFrame = null;
      positionPanel();
    });
  };

  const capture = () => {
    const context = getContext();
    if (!isAvailable(context)) return null;
    if (contextKey(context) !== currentKey) {
      update();
      return null;
    }
    return copyContext(context);
  };

  const save = async (callback, capturedContext) => {
    if (busy || disposed || !capturedContext) return;
    busy = true;
    status.textContent = '正在保存…';
    update();
    try {
      await callback();
      if (!disposed) status.textContent = contextKey(getContext()) === contextKey(capturedContext) ? '已保存' : '';
    } catch (error) {
      if (!disposed) status.textContent = '未保存';
      new Notice(`设置未完成：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
      if (!disposed) update();
    }
  };

  const choosePreset = assetId => {
    const capturedContext = capture();
    if (!capturedContext || capturedContext.selection.enabled === false) return;
    const selection = { ...capturedContext.selection, enabled: true, preset: assetId };
    delete selection.custom_image;
    void save(() => applySelection(selection, capturedContext), capturedContext);
  };

  const renderPresets = context => {
    const presets = [...(context?.definition?.presets ?? [])];
    const defaultAssetId = context?.definition?.defaultAssetId;
    if (defaultAssetId && !presets.some(preset => preset.assetId === defaultAssetId)) {
      presets.unshift({ assetId: defaultAssetId, label: '主题默认' });
    }
    const assets = context?.assets ?? [];
    const key = JSON.stringify(presets.map(preset => [preset.assetId, preset.label,
      assets.find(asset => asset.id === preset.assetId)?.url]));
    if (key === cardsKey) return;
    cardsKey = key;
    presetButtons = [];
    presetGrid.replaceChildren();
    for (const preset of presets) {
      const asset = assets.find(item => item.id === preset.assetId);
      const button = makeButton('wechat-mp-header-preset', '');
      button.setAttribute('aria-label', preset.label || '主题预设头图');
      button.setAttribute('aria-pressed', 'false');
      const preview = makeElement('span', 'wechat-mp-header-preset-preview');
      const image = makeElement('img');
      image.alt = '';
      if (asset?.url) image.src = asset.url;
      image.addEventListener('load', schedulePosition);
      preview.append(image);
      const label = makeElement('span', 'wechat-mp-header-preset-label', preset.label || '预设头图');
      const check = makeElement('span', 'wechat-mp-header-preset-check');
      check.setAttribute('aria-hidden', 'true');
      setIcon(check, 'check');
      button.append(preview, label, check);
      button.addEventListener('click', () => choosePreset(preset.assetId));
      presetGrid.append(button);
      presetButtons.push({ button, assetId: preset.assetId, hasImage: Boolean(asset?.url) });
    }
  };

  function update() {
    if (disposed) return;
    const context = getContext();
    const key = contextKey(context);
    if (key !== currentKey) {
      close();
      status.textContent = '';
    }
    currentKey = key;
    const available = isAvailable(context);
    const headerReady = hasHeader(context);
    const footerReady = hasFooter(context);
    trigger.disabled = busy || !available;
    trigger.title = available ? '点击展开页首页尾选项'
      : !context?.articlePath ? '请先打开一篇文章'
        : context.definition ? '预览正在更新，请稍后再调整' : '当前主题未提供可调整的头图或尾图';
    // 主题只有其中一项时，另一块整段隐藏，而不是留个点不动的开关。
    visibility.hidden = !headerReady;
    presetsTitle.hidden = !headerReady;
    presetGrid.hidden = !headerReady;
    customSection.hidden = !headerReady;
    footerRow.hidden = !footerReady;
    element.title = trigger.title;
    panel.setAttribute('aria-busy', String(busy));
    if (!available && !busy) close();
    renderPresets(context);
    const selection = context?.selection ?? {};
    const enabled = selection.enabled !== false;
    const custom = Boolean(selection.custom_image);
    const presetId = selection.preset || context?.definition?.defaultAssetId;
    visibilityToggle.setAttribute('aria-checked', String(enabled));
    visibilityToggle.disabled = busy || !headerReady;
    visibilityDescription.textContent = enabled ? '显示在正文最上方' : '已隐藏，重新打开会保留所选图片';
    presetGrid.classList.toggle('is-disabled', !enabled);
    for (const { button, assetId, hasImage } of presetButtons) {
      const selected = !custom && assetId === presetId;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = busy || !headerReady || !enabled || !hasImage;
    }
    customPreview.hidden = !custom;
    if (custom && context?.customUrl) {
      if (customImage.getAttribute('src') !== context.customUrl) customImage.src = context.customUrl;
      customImage.hidden = false;
    } else {
      customImage.removeAttribute('src');
      customImage.hidden = true;
    }
    uploadButton.textContent = custom ? '更换自定义图片' : '上传自己的图片';
    uploadButton.disabled = busy || !headerReady || !enabled;
    fileInput.disabled = busy || !headerReady || !enabled;
    resetButton.disabled = busy || !headerReady || !Object.keys(selection).length;
    const footerEnabled = context?.footerEnabled !== false;
    footerToggle.setAttribute('aria-checked', String(footerEnabled));
    footerToggle.disabled = busy || !footerReady;
    footerDescription.textContent = footerEnabled ? '显示在正文最下方' : '已隐藏，重新打开即恢复主题尾图';
    schedulePosition();
  }

  trigger.addEventListener('click', () => {
    if (open) return close();
    update();
    if (trigger.disabled) return;
    if (!panel.isConnected) document.body.append(panel);
    panel.hidden = false;
    open = true;
    trigger.setAttribute('aria-expanded', 'true');
    positionPanel();
    (visibility.hidden ? footerToggle : visibilityToggle).focus();
  });

  visibilityToggle.addEventListener('click', () => {
    const capturedContext = capture();
    if (!capturedContext) return;
    const selection = { ...capturedContext.selection, enabled: capturedContext.selection.enabled === false };
    void save(() => applySelection(selection, capturedContext), capturedContext);
  });

  footerToggle.addEventListener('click', () => {
    const capturedContext = capture();
    if (!capturedContext || !capturedContext.footerAvailable) return;
    const next = capturedContext.footerEnabled === false;
    void save(() => applyFooter(next, capturedContext), capturedContext);
  });

  uploadButton.addEventListener('click', () => {
    if (busy) return;
    chooserContext = capture();
    if (!chooserContext || chooserContext.selection.enabled === false) return;
    fileInput.value = '';
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    const capturedContext = chooserContext;
    chooserContext = null;
    fileInput.value = '';
    if (!file || !capturedContext || busy || disposed) return;
    if (contextKey(getContext()) !== contextKey(capturedContext)) {
      new Notice('文章或主题已切换，请在当前文章重新选择头图');
      update();
      return;
    }
    const allowedType = ['image/png', 'image/jpeg'].includes(file.type);
    const allowedExtension = /\.(png|jpe?g)$/i.test(file.name);
    if ((!allowedType && file.type !== '') || !allowedExtension) {
      new Notice('请选择 PNG 或 JPG 图片');
      return;
    }
    void save(() => uploadFile(file, capturedContext), capturedContext);
  });

  resetButton.addEventListener('click', () => {
    const capturedContext = capture();
    if (capturedContext) void save(() => applySelection(null, capturedContext), capturedContext);
  });

  const onPointerDown = event => {
    if (open && !element.contains(event.target) && !panel.contains(event.target)) close();
  };
  const onKeyDown = event => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    close({ restoreFocus: true });
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', schedulePosition);
  document.addEventListener('scroll', schedulePosition, true);
  customImage.addEventListener('load', schedulePosition);
  update();

  return {
    element,
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      close();
      chooserContext = null;
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', schedulePosition);
      document.removeEventListener('scroll', schedulePosition, true);
      if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
      panel.remove();
      element.remove();
    },
  };
}
