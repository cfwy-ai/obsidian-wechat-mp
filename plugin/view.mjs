import { Buffer } from 'node:buffer';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { clipboard, nativeImage, remote } from 'electron';
import { ItemView, MarkdownView, Notice, setIcon, TFile } from 'obsidian';
import { VIEW_TYPE } from './constants.mjs';
import {
  copyRenderedArticle,
  createCopyLock,
  createCopySnapshot,
  formatCopyResultNotice,
} from './copy.mjs';
import { createClipboardImageTransformer } from './copy-image-encoding.mjs';
import { ExportLongImageModal } from './export-modal.mjs';
import { resolveGalleryImageRecords } from './gallery-images.mjs';
import { HeadingImageRuntime } from './heading-image.mjs';
import { createReferenceLayoutSource, replayReferenceLayout, referenceCopyLayoutWidth } from './reference-layout.mjs';
import {
  EXPORT_LAYOUT_MODE_LABELS,
  MIN_EXPORT_LAYOUT_WIDTH,
  buildExportHtml,
  buildExportFilename,
  buildExportPath,
  createExportSnapshot,
  embedImagesForExport,
  renderLongImagePng,
  resolveDownloadsDirectory,
  saveVerifiedExportPng,
  verifyPng,
} from './export-image.mjs';
import { syncScrollPosition } from './scroll-sync.mjs';
import { themeMatchesQuery } from './theme-metadata.mjs';
import { themeSwatches, themeSwatchClass } from './theme-swatches.mjs';
import { createPluginThemeVault, createThemeAwareReader } from './plugin-theme-vault.mjs';
import {
  discoverVaultThemes,
  loadVaultThemeContent,
  selectThemeDescriptor,
} from './theme-registry.mjs';
import {
  actionButtonDisabledState,
  applyPreviewWidth,
  previewLayoutForMode,
  previewScaleForWidth,
} from './view-layout.mjs';
import { renderArticle } from '../src/pipeline.mjs';
import { documentTitleForDisplay } from '../src/document-title.mjs';
import { prepareExportTitleTheme } from './export-title-theme.mjs';
import { createArticleHeaderControls } from './header-controls.mjs';
import { readArticleHeaderSelection, saveArticleHeaderSelection, uploadArticleHeader } from './article-header-state.mjs';

const makeElement = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

let viewInstanceCount = 0;

const makeButton = ({ className, icon, text, label }) => {
  const button = makeElement('button', className);
  button.type = 'button';
  if (icon) {
    const iconEl = makeElement('span', 'wechat-mp-button-icon');
    setIcon(iconEl, icon);
    button.append(iconEl);
  }
  if (text) button.append(makeElement('span', 'wechat-mp-button-text', text));
  else if (label) {
    button.append(makeElement('span', 'wechat-mp-sr-only', label));
  }
  return button;
};

export class WechatPreviewView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.navigation = false;
    this.plugin = plugin;
    this.refreshId = 0;
    this.sourceLeaf = null;
    this.sourceScrollEl = null;
    this.sourceScrollRoot = null;
    this.scrollFrame = null;
    this.syncingScroll = false;
    this.lastRender = null;
    this.galleryImageDimensionCache = new Map();
    this.copyLock = createCopyLock();
    this.copyImageTransformer = createClipboardImageTransformer({ nativeImage });
    this.headingImageRuntime = new HeadingImageRuntime({ vault: plugin.app.vault });
    this.isRendering = false;
    this.exporting = false;
    this.headerSaving = false;
    this.headerUploading = false;
    this.headerContext = null;
    this.closed = false;
    this.themeFiles = new Map();
    this.themeMenuThemes = [];
    this.selectedThemePath = plugin.settings.selectedThemeFile ?? '';
    this.themeMenuOpen = false;
    this.previewResizeObserver = null;
    this.themeSearchId = `wechat-mp-theme-search-${++viewInstanceCount}`;
    this.onThemeDocumentPointerDown = (event) => {
      if (!this.themeControlEl?.contains(event.target)) this.closeThemeMenu();
    };
    this.onThemeDocumentKeyDown = (event) => {
      if (event.key !== 'Escape' || !this.themeMenuOpen) return;
      event.preventDefault();
      this.closeThemeMenu({ restoreFocus: true });
    };
    this.onSourceScroll = (event) => {
      if (event.target instanceof HTMLElement) this.sourceScrollEl = event.target;
      this.queueScrollSync(this.sourceScrollEl, this.viewportEl);
    };
    this.onPreviewScroll = () => this.queueScrollSync(this.viewportEl, this.sourceScrollEl);
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return '公众号排版（本地预览）';
  }

  getIcon() {
    return 'columns-2';
  }

  async onOpen() {
    this.buildFrame();
    this.setSourceLeaf(this.plugin.getCurrentSourceLeaf());
    await this.refresh();
  }

  async onClose() {
    this.closed = true;
    this.headerContext = null;
    this.headerControls?.dispose();
    this.refreshId += 1;
    this.headingBreakControls?.dispose();
    this.closeThemeMenu();
    document.removeEventListener('pointerdown', this.onThemeDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onThemeDocumentKeyDown, true);
    this.unbindSourceScroll();
    this.previewResizeObserver?.disconnect();
    this.previewResizeObserver = null;
    this.viewportEl?.removeEventListener('scroll', this.onPreviewScroll);
    if (this.scrollFrame !== null) window.cancelAnimationFrame(this.scrollFrame);
    this.headingImageRuntime.dispose();
    this.galleryImageDimensionCache.clear();
    this.copyImageTransformer.clearCache();
  }

  buildFrame() {
    this.contentEl.replaceChildren();
    this.contentEl.classList.add('wechat-mp-view');

    const header = makeElement('header', 'wechat-mp-toolbar');
    const toolbarFrame = makeElement('div', 'wechat-mp-toolbar-frame');
    const controls = makeElement('div', 'wechat-mp-toolbar-controls');

    this.themeControlEl = makeElement('div', 'wechat-mp-theme-control');
    this.themeTriggerEl = makeElement('button', 'wechat-mp-theme-trigger');
    this.themeTriggerEl.type = 'button';
    this.themeTriggerEl.setAttribute('aria-haspopup', 'listbox');
    this.themeTriggerEl.setAttribute('aria-expanded', 'false');
    this.themeLabelEl = makeElement('span', 'wechat-mp-theme-label', '风格');
    this.themeNameEl = makeElement('span', 'wechat-mp-theme-name', '暂无风格');
    this.themeTriggerEl.append(this.themeLabelEl, this.themeNameEl);
    this.themeTriggerEl.addEventListener('click', () => this.toggleThemeMenu());

    this.themePopoverEl = makeElement('div', 'wechat-mp-theme-popover');
    this.themePopoverEl.hidden = true;
    this.themePopoverEl.setAttribute('role', 'dialog');
    const popoverHead = makeElement('div', 'wechat-mp-popover-head');
    popoverHead.append(makeElement('strong', null, '选择排版风格'));
    this.themeCountEl = makeElement('span', null, '0 个模板');
    popoverHead.append(this.themeCountEl);

    const searchWrap = makeElement('div', 'wechat-mp-theme-search-wrap');
    const searchLabel = makeElement('label', 'wechat-mp-sr-only', '搜索主题');
    searchLabel.htmlFor = this.themeSearchId;
    this.themeSearchEl = makeElement('input', 'wechat-mp-theme-search');
    this.themeSearchEl.id = this.themeSearchId;
    this.themeSearchEl.type = 'search';
    this.themeSearchEl.placeholder = '搜索主题';
    this.themeSearchEl.autocomplete = 'off';
    this.themeSearchEl.addEventListener('input', () => this.renderThemeMenuOptions());
    searchWrap.append(searchLabel, this.themeSearchEl);

    this.themeListEl = makeElement('div', 'wechat-mp-theme-list');
    this.themeListEl.setAttribute('role', 'listbox');
    this.themeEmptyEl = makeElement('div', 'wechat-mp-theme-empty', '没有匹配的主题');
    this.themeEmptyEl.hidden = true;
    this.themePopoverEl.append(popoverHead, searchWrap, this.themeListEl, this.themeEmptyEl);
    this.themeControlEl.append(this.themeTriggerEl, this.themePopoverEl);

    this.headingBreakControls = this.plugin.headingBreakTools.mount(this);

    this.copyButtonEl = makeButton({
      className: 'wechat-mp-tool-button wechat-mp-copy-action',
      text: '复制图文',
    });
    this.copyButtonEl.disabled = true;
    this.copyButtonEl.addEventListener('click', () => void this.copyCurrent());

    this.headerControls = createArticleHeaderControls({
      getContext: () => this.headerContext,
      applySelection: (selection, context) => saveArticleHeaderSelection(this, selection, context),
      uploadFile: (file, context) => uploadArticleHeader(this, file, context),
    });

    this.exportButtonEl = makeButton({
      className: 'wechat-mp-tool-button wechat-mp-export-action',
      text: '导出长图',
    });
    this.exportButtonEl.disabled = true;
    this.exportButtonEl.addEventListener('click', () => void this.openExportDialog());

    this.mobilePreviewButtonEl = makeElement(
      'button',
      'wechat-mp-toggle-control wechat-mp-mobile-control',
    );
    this.mobilePreviewButtonEl.type = 'button';
    this.mobilePreviewButtonEl.setAttribute('role', 'switch');
    this.mobilePreviewButtonEl.setAttribute('aria-checked', 'false');
    this.mobilePreviewButtonEl.append(
      makeElement('span', 'wechat-mp-toggle-label', '手机预览'),
    );
    const mobilePreviewTrack = makeElement('span', 'wechat-mp-toggle-track');
    mobilePreviewTrack.append(makeElement('span', 'wechat-mp-toggle-knob'));
    this.mobilePreviewButtonEl.append(mobilePreviewTrack);
    this.mobilePreviewButtonEl.addEventListener('click', async () => {
      await this.plugin.setMobilePreview(!this.plugin.settings.mobilePreview);
    });

    this.syncButtonEl = makeElement(
      'button',
      'wechat-mp-toggle-control wechat-mp-sync-control',
    );
    this.syncButtonEl.type = 'button';
    this.syncButtonEl.setAttribute('role', 'switch');
    this.syncButtonEl.setAttribute('aria-checked', 'false');
    this.syncButtonEl.append(makeElement('span', 'wechat-mp-toggle-label', '联动滚动'));
    const syncTrack = makeElement('span', 'wechat-mp-toggle-track');
    syncTrack.append(makeElement('span', 'wechat-mp-toggle-knob'));
    this.syncButtonEl.append(syncTrack);
    this.syncButtonEl.addEventListener('click', async () => {
      await this.plugin.setScrollSync(!this.plugin.settings.syncScroll);
    });

    controls.append(
      this.themeControlEl,
      this.copyButtonEl,
      this.headerControls.element,
      this.headingBreakControls.element,
      this.exportButtonEl,
      this.mobilePreviewButtonEl,
      this.syncButtonEl,
    );
    toolbarFrame.append(controls);
    header.append(toolbarFrame);

    this.warningEl = makeElement('div', 'wechat-mp-warnings');
    this.warningEl.setAttribute('aria-live', 'polite');

    this.viewportEl = makeElement('div', 'wechat-mp-viewport');
    this.viewportEl.addEventListener('scroll', this.onPreviewScroll, { passive: true });
    this.canvasEl = makeElement('div', 'wechat-mp-canvas');
    this.shellEl = makeElement('article', 'wechat-mp-shell');
    this.shellEl.setAttribute('role', 'document');
    // 主题已经全部内联；放进 ShadowRoot 只为隔离 Obsidian 主题和 snippet，
    // 避免宿主的 h1 / p / ol 默认样式把本地预览二次美化。
    this.articleRootEl = this.shellEl.attachShadow({ mode: 'open' });
    this.canvasEl.append(this.shellEl);
    this.viewportEl.append(header, this.warningEl, this.canvasEl);

    this.contentEl.append(this.viewportEl);
    this.applyCurrentPreviewLayout();
    this.updatePreviewScale();
    this.previewResizeObserver = new ResizeObserver(() => this.updatePreviewScale());
    this.previewResizeObserver.observe(this.contentEl);
    this.setMobilePreviewState(this.plugin.settings.mobilePreview);
    this.setScrollSync(this.plugin.settings.syncScroll);
  }

  getCurrentPreviewLayout() {
    return previewLayoutForMode({
      desktopWidth: this.plugin.settings.previewWidth,
      mobileWidth: this.plugin.settings.mobilePreviewWidth,
      mobilePreview: this.plugin.settings.mobilePreview,
    });
  }

  applyCurrentPreviewLayout() {
    if (!this.contentEl || !this.shellEl) return;
    const layout = this.getCurrentPreviewLayout();
    applyPreviewWidth(
      this.contentEl,
      this.shellEl,
      layout.previewWidth,
      layout.canvasExtraWidth,
    );
    this.contentEl.classList.toggle('is-mobile-preview', layout.mode === 'mobile');
    this.shellEl.setAttribute('data-preview-mode', layout.mode);
  }

  updatePreviewScale() {
    if (!this.contentEl || !this.viewportEl) return;
    const { previewWidth, canvasWidth } = this.getCurrentPreviewLayout();
    const availableWidth = this.viewportEl.clientWidth || this.contentEl.clientWidth || canvasWidth;
    const scale = previewScaleForWidth(availableWidth, canvasWidth);
    this.contentEl.style.setProperty('--wechat-preview-scale', String(scale));
    this.contentEl.style.setProperty(
      '--wechat-preview-display-width',
      `${previewWidth * scale}px`,
    );
    if (this.viewportEl.scrollLeft !== 0) this.viewportEl.scrollLeft = 0;
  }

  setBusy(isBusy) {
    this.isRendering = isBusy;
    this.contentEl.setAttribute('aria-busy', String(isBusy));
    this.contentEl.classList.toggle('is-rendering', isBusy);
    this.updateActionButtons();
  }

  updateActionButtons() {
    this.headingBreakControls?.update();
    this.headerControls?.update();
    const state = actionButtonDisabledState({
      isRendering: this.isRendering || this.headerSaving || this.headerUploading,
      exporting: this.exporting,
      copyLocked: this.copyLock.locked,
      hasRender: Boolean(this.lastRender),
    });
    this.copyButtonEl.disabled = state.copyDisabled;
    this.exportButtonEl.disabled = state.exportDisabled;
  }

  renderMessage(message) {
    const empty = makeElement('div', null, message);
    empty.style.cssText = [
      'display:grid',
      'min-height:320px',
      'padding:42px',
      'place-items:center',
      'color:#777',
      'font-size:14px',
      'line-height:1.75',
      'text-align:center',
    ].join(';');
    this.articleRootEl.replaceChildren(empty);
  }

  renderWarnings(warnings) {
    this.warningEl.replaceChildren();
    this.warningEl.classList.toggle('is-visible', warnings.length > 0);
    for (const warning of warnings) {
      const item = makeElement('div', 'wechat-mp-warning', warning);
      item.setAttribute('role', 'status');
      this.warningEl.append(item);
    }
  }

  openThemeMenu() {
    if (this.themeMenuOpen || this.themeTriggerEl?.disabled) return;
    this.themeMenuOpen = true;
    this.themePopoverEl.hidden = false;
    this.themePopoverEl.classList.add('is-open');
    this.themeTriggerEl.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', this.onThemeDocumentPointerDown, true);
    document.addEventListener('keydown', this.onThemeDocumentKeyDown, true);
    window.requestAnimationFrame(() => this.themeSearchEl?.focus());
  }

  closeThemeMenu({ restoreFocus = false } = {}) {
    this.themeMenuOpen = false;
    this.themePopoverEl?.classList.remove('is-open');
    if (this.themePopoverEl) this.themePopoverEl.hidden = true;
    this.themeTriggerEl?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.onThemeDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onThemeDocumentKeyDown, true);
    if (this.themeSearchEl?.value) {
      this.themeSearchEl.value = '';
      this.renderThemeMenuOptions();
    }
    if (restoreFocus) this.themeTriggerEl?.focus();
  }

  toggleThemeMenu() {
    if (this.themeMenuOpen) this.closeThemeMenu();
    else this.openThemeMenu();
  }

  getSelectedThemePath() {
    return (
      this.selectedThemePath ||
      this.plugin.settings.selectedThemeFile ||
      this.lastRender?.themePath ||
      ''
    );
  }

  renderThemeMenuOptions() {
    if (!this.themeListEl) return;
    const query = this.themeSearchEl?.value ?? '';
    const matches = this.themeMenuThemes.filter((theme) => themeMatchesQuery(theme, query));
    this.themeListEl.replaceChildren();

    for (const theme of matches) {
      const selected = theme.path === this.selectedThemePath;
      const option = makeElement(
        'button',
        `wechat-mp-theme-option${selected ? ' is-selected' : ''}`,
      );
      option.type = 'button';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(selected));
      option.dataset.themePath = theme.path;
      option.dataset.themeId = theme.themeId ?? '';
      const text = makeElement('span', 'wechat-mp-theme-option-text');
      const title = makeElement('span', 'wechat-mp-theme-option-title');
      title.append(makeElement('strong', null, theme.name));
      const colors = themeSwatches(theme.themeId);
      if (colors.length) {
        const swatches = makeElement('span', 'wechat-mp-theme-swatches');
        swatches.setAttribute('aria-hidden', 'true');
        for (const color of colors) {
          const swatch = makeElement('span', `wechat-mp-theme-swatch ${themeSwatchClass(color)}`.trim());
          swatch.style.backgroundColor = color;
          swatches.append(swatch);
        }
        title.append(swatches);
      }
      text.append(
        title,
        makeElement('small', null, theme.summary || '未填写配色、风格与适用场景'),
      );
      option.append(text);
      option.addEventListener('click', () => void this.selectThemeFromMenu(theme));
      this.themeListEl.append(option);
    }

    const empty = matches.length === 0;
    this.themeEmptyEl.hidden = !empty;
    this.themeEmptyEl.classList.toggle('is-visible', empty);
  }

  async selectThemeFromMenu(theme) {
    const path = theme?.path;
    if (!path) return;
    this.selectedThemePath = path;
    this.themeNameEl.textContent = theme.name;
    this.renderThemeMenuOptions();
    this.closeThemeMenu();
    try {
      await this.plugin.selectTheme({
        path,
        themeId: theme.themeId,
      });
      await this.refresh();
    } catch (error) {
      new Notice(`切换风格失败：${error instanceof Error ? error.message : String(error)}`);
      await this.refresh();
    }
  }

  renderThemeMenu(themes, selected) {
    this.themeFiles = new Map(themes.map((theme) => [theme.path, theme]));
    this.themeMenuThemes = themes;
    this.selectedThemePath = selected?.path ?? themes[0]?.path ?? '';
    this.themeNameEl.textContent = selected?.name ?? themes[0]?.name ?? '暂无风格';
    this.themeTriggerEl.disabled = themes.length === 0;
    this.themeCountEl.textContent = `${themes.length} 个模板`;
    this.renderThemeMenuOptions();
    if (themes.length === 0) this.closeThemeMenu();
  }

  /**
   * 双源解析主题：优先插件目录（发布形态，左侧文件树零新增），
   * 没装主题包时回退 vault 配置目录（开发形态，主题正本仍在库里可编辑）。
   * 两种形态共用同一套加载器，下游复制、导出与标题图片逻辑不受影响。
   */
  async resolveThemeSource() {
    const packaged = await createPluginThemeVault(this.app, this.plugin.manifest?.dir);
    // 读取器按文件分派：主题文件走主题源，正文图片始终走真实 vault
    this.themeReader = createThemeAwareReader(this.app.vault, packaged);
    this.headingImageRuntime.vault = this.themeReader;
    if (packaged) {
      return {
        vault: packaged,
        themeFolder: packaged.themeFolder,
        requireAuthoringDocs: false,
      };
    }
    return {
      vault: this.app.vault,
      themeFolder: this.plugin.settings.themeFolder,
      requireAuthoringDocs: true,
    };
  }

  /** 主题感知读取器；主题状态尚未加载时退化为真实 vault */
  getThemeReader() {
    return this.themeReader ?? this.app.vault;
  }

  async loadThemeState(context) {
    const source = await this.resolveThemeSource();
    const discovered = await discoverVaultThemes({
      vault: source.vault,
      metadataCache: this.app.metadataCache,
      themeFolder: source.themeFolder,
      requireAuthoringDocs: source.requireAuthoringDocs,
    });
    const selected = selectThemeDescriptor(discovered.themes, this.plugin.settings);
    if (!selected) {
      return {
        themes: discovered.themes,
        selected: null,
        css: '',
        components: [],
        assets: [],
        fonts: [],
        headingImages: [],
        problems: discovered.problems,
      };
    }
    const content = await loadVaultThemeContent(selected, {
      vault: source.vault,
      context,
    });
    return {
      themes: discovered.themes,
      selected,
      ...content,
      problems: [...discovered.problems, ...content.problems],
    };
  }

  resolveImageFile(target, article) {
    const file = this.app.metadataCache.getFirstLinkpathDest(target, article.path);
    return file instanceof TFile ? file : null;
  }

  resolveImage(target, article) {
    const file = this.resolveImageFile(target, article);
    return file
      ? { url: this.app.vault.getResourcePath(file), filePath: file.path }
      : null;
  }

  resolveImageRecordFile(image, article) {
    if (image?.filePath) {
      const exact = this.app.vault.getAbstractFileByPath(image.filePath);
      return exact instanceof TFile ? exact : null;
    }
    return image?.target ? this.resolveImageFile(image.target, article) : null;
  }

  setSourceLeaf(leaf) {
    if (this.sourceLeaf === leaf) return;
    this.sourceLeaf = leaf;
    this.rebindScrollSync();
  }

  getSourceScrollElement() {
    const view = this.sourceLeaf?.view;
    if (!(view instanceof MarkdownView)) return null;
    const preferred = [
      '.cm-scroller',
      '.markdown-preview-view',
      '.markdown-reading-view',
      '.view-content',
    ].flatMap((selector) => [...view.containerEl.querySelectorAll(selector)]);
    return (
      preferred.find((element) => element.scrollHeight > element.clientHeight + 2) ??
      preferred[0] ??
      null
    );
  }

  unbindSourceScroll() {
    if (this.sourceScrollRoot) {
      this.sourceScrollRoot.removeEventListener('scroll', this.onSourceScroll, true);
    }
    this.sourceScrollEl = null;
    this.sourceScrollRoot = null;
  }

  rebindScrollSync() {
    this.unbindSourceScroll();
    if (!this.plugin.settings.syncScroll) return;
    const view = this.sourceLeaf?.view;
    if (!(view instanceof MarkdownView)) return;

    this.sourceScrollEl = this.getSourceScrollElement();
    this.sourceScrollRoot = view.containerEl;
    this.sourceScrollRoot.addEventListener('scroll', this.onSourceScroll, {
      capture: true,
      passive: true,
    });
  }

  setScrollSync(enabled) {
    const active = Boolean(enabled);
    this.syncButtonEl?.classList.toggle('is-active', active);
    this.syncButtonEl?.setAttribute('aria-checked', String(active));
    this.rebindScrollSync();
    if (active) this.queueScrollSync(this.sourceScrollEl, this.viewportEl);
  }

  setMobilePreviewState(enabled) {
    const active = Boolean(enabled);
    this.mobilePreviewButtonEl?.classList.toggle('is-active', active);
    this.mobilePreviewButtonEl?.setAttribute('aria-checked', String(active));
    this.applyCurrentPreviewLayout();
    this.updatePreviewScale();
    if (this.lastRender?.quoteImageSource || this.lastRender?.referenceLayoutSource) void this.refresh();
  }

  async materializeRenderForLayout(render, layoutWidth) {
    if (render?.referenceLayoutSource) {
      return { ...render, ...await replayReferenceLayout({
        source: render.referenceLayoutSource,
        layoutWidth,
        materialize: (input) => this.headingImageRuntime.materialize(input),
      }) };
    }
    if (!render?.quoteImageSource) return render;
    const result = await this.headingImageRuntime.materialize({ ...render.quoteImageSource, layoutWidth });
    return { ...render, html: result.html, images: result.images, imageWarnings: result.warnings };
  }

  queueScrollSync(source, target) {
    if (!this.plugin.settings.syncScroll || !source || !target || this.syncingScroll) return;
    if (this.scrollFrame !== null) window.cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = window.requestAnimationFrame(() => {
      this.scrollFrame = null;
      this.syncingScroll = true;
      syncScrollPosition(source, target);
      window.requestAnimationFrame(() => { this.syncingScroll = false; });
    });
  }

  async transformClipboardImage(bytes) {
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (image.isEmpty()) throw new Error('图片无法解码');
    const size = image.getSize();
    const largest = Math.max(size.width, size.height);
    const resized = largest > 1080
      ? image.resize({
          width: Math.max(1, Math.round(size.width * 1080 / largest)),
          height: Math.max(1, Math.round(size.height * 1080 / largest)),
          quality: 'best',
        })
      : image;
    return { bytes: resized.toPNG(), mimeType: 'image/png' };
  }

  async copyCurrent() {
    if (this.headerSaving || this.headerUploading || this.exporting || !this.copyLock.acquire()) return;
    this.updateActionButtons();
    try {
      let snapshot = null;
      for (let attempt = 0; attempt < 2 && !snapshot; attempt += 1) {
        const article = this.plugin.getCurrentDocument();
        if (!article) return;
        const themePath = this.getSelectedThemePath();
        snapshot = createCopySnapshot({ render: this.lastRender, article, themePath });
        if (!snapshot) await this.refresh();
      }

      if (!snapshot) {
        const article = this.plugin.getCurrentDocument();
        const themePath = this.getSelectedThemePath();
        snapshot = createCopySnapshot({ render: this.lastRender, article, themePath });
      }
      if (!snapshot) {
        new Notice('活动文档仍在切换，未写入剪贴板，请稍后重试');
        return;
      }

      const { article, render } = snapshot;
      const copyRender = await this.materializeRenderForLayout(render, referenceCopyLayoutWidth(render, MIN_EXPORT_LAYOUT_WIDTH));
      const result = await copyRenderedArticle({
        html: copyRender.html,
        text:
          render.text ??
          this.articleRootEl.querySelector('#nice')?.innerText ??
          this.articleRootEl.textContent ??
          '',
        images: copyRender.images,
        resolveFile: (_reference, image) => this.resolveImageRecordFile(image, article),
        readBinary: (file) => this.getThemeReader().readBinary(file),
        transformImage: this.copyImageTransformer,
        embedImages: true,
        _clipboard: clipboard,
      });

      if (copyRender.imageWarnings?.length) result.warnings.push(...copyRender.imageWarnings);

      new Notice(formatCopyResultNotice(result));
      if (result.warnings.length > 0) console.warn('[长风·公众号排版]', result.warnings);
    } catch (error) {
      new Notice(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.copyLock.release();
      this.updateActionButtons();
    }
  }

  async getFreshExportSnapshot() {
    let snapshot = null;
    for (let attempt = 0; attempt < 2 && !snapshot; attempt += 1) {
      const article = this.plugin.getCurrentDocument();
      const themePath = this.getSelectedThemePath();
      snapshot = createExportSnapshot({ render: this.lastRender, article, themePath });
      if (!snapshot) await this.refresh();
    }
    return snapshot;
  }

  async openExportDialog() {
    if (this.headerSaving || this.headerUploading || this.exporting || this.copyLock.locked) return;
    const snapshot = await this.getFreshExportSnapshot();
    if (!snapshot) {
      new Notice('活动文档仍在切换，请稍后重试');
      return;
    }
    const defaultDirectory = resolveDownloadsDirectory(
      (name) => remote?.app?.getPath?.(name),
    );
    new ExportLongImageModal(this.app, {
      defaultDirectory,
      suggestedFilename: buildExportFilename(snapshot.article.basename),
      mobileWidth: this.plugin.settings.mobilePreviewWidth,
      chooseDestination: (request) => this.chooseExportDestination(request),
      onSubmit: (options) => this.exportLongImage(snapshot, options),
    }).open();
  }

  /**
   * 必须由「选择…」的点击回调直接调用，才能保留系统文件选择器的用户手势。
   * Electron 原生 Save As 不可用时，安全回退到默认下载目录。
   */
  async chooseExportDestination({ defaultDirectory, suggestedFilename }) {
    let nativeError = null;
    const nativeDialog = remote?.dialog;
    if (typeof nativeDialog?.showSaveDialog === 'function') {
      try {
        const result = await nativeDialog.showSaveDialog({
          title: '选择长图保存位置',
          defaultPath: join(defaultDirectory, suggestedFilename),
          buttonLabel: '选择',
          filters: [{ name: 'PNG 图片', extensions: ['png'] }],
          properties: ['createDirectory', 'showOverwriteConfirmation'],
        });
        if (result?.canceled || !result?.filePath) return null;
        return { path: result.filePath };
      } catch (error) {
        nativeError = error;
      }
    }

    const detail = nativeError instanceof Error ? `：${nativeError.message}` : '';
    new Notice(`保存位置选择器不可用${detail}，将使用默认的下载文件夹`);
    return null;
  }

  async exportLongImage(snapshot, options) {
    if (this.headerSaving || this.headerUploading || this.exporting || this.copyLock.locked) return;
    this.exporting = true;
    this.updateActionButtons();
    const progress = new Notice('正在生成长图…', 0);
    try {
      const { article, render } = snapshot;

      const exportRender = await this.materializeRenderForLayout(render, options.layoutWidth);

      progress.setMessage('正在处理文章图片…');
      const embedded = await embedImagesForExport({
        html: exportRender.html,
        images: exportRender.images,
        resolveFile: (_reference, image) => this.resolveImageRecordFile(image, article),
        readBinary: (file) => this.getThemeReader().readBinary(file),
        transformImage: (bytes) => this.transformClipboardImage(bytes),
      });
      const titleTheme = await prepareExportTitleTheme({
        ...render.exportTitleTheme,
        includeFont: options.showTitle !== false,
        readBinary: (file) => this.getThemeReader().readBinary(file),
      });
      const frontmatter = this.app.metadataCache.getFileCache(article)?.frontmatter ?? {};
      const exportHtml = buildExportHtml({
        articleHtml: embedded.html,
        title: documentTitleForDisplay(article.basename, frontmatter),
        titleTheme,
        ...options,
      });

      progress.setMessage('正在分片生成 PNG…');
      const image = await renderLongImagePng(exportHtml, {
        scale: options.scale,
        layoutWidth: options.layoutWidth,
      });
      verifyPng(image.bytes, { expectedWidth: image.width, expectedHeight: image.height });

      const downloadsDirectory = resolveDownloadsDirectory(
        (name) => remote?.app?.getPath?.(name),
      );
      const targetPath = options.destinationPath ?? buildExportPath(
        downloadsDirectory,
        article.basename,
      );
      await mkdir(dirname(targetPath), { recursive: true });

      progress.setMessage('正在保存并校验长图…');
      const path = await saveVerifiedExportPng({
        targetPath,
        bytes: image.bytes,
        expectedWidth: image.width,
        expectedHeight: image.height,
        exists: async (candidate) => {
          try {
            await access(candidate);
            return true;
          } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
          }
        },
        write: (candidate, bytes) => writeFile(candidate, bytes, { flag: 'wx' }),
        read: (candidate) => readFile(candidate),
        remove: (candidate) => rm(candidate, { force: true }),
      });

      progress.hide();
      const imageWarning = embedded.warnings.length > 0
        ? `；${embedded.warnings.length} 张图使用了失败图位`
        : '';
      const fontWarning = titleTheme.warnings?.length ? `；${titleTheme.warnings.join('；')}` : '';
      const quoteWarning = exportRender.imageWarnings?.length ? `；${exportRender.imageWarnings.length} 项字体图片保留了活文字，请查看警告` : '';
      const layoutLabel = EXPORT_LAYOUT_MODE_LABELS[options.layoutMode] ?? '';
      new Notice(`已导出${layoutLabel} ${image.scale}× 长图（${image.width}×${image.height} px）：${path}${imageWarning}${fontWarning}${quoteWarning}`, 8000);
      if (embedded.warnings.length > 0) {
        console.warn('[长风·公众号排版] 长图图片警告', embedded.warnings);
      }
      if (exportRender.imageWarnings?.length) console.warn('[长风·公众号排版] 字体图片警告', exportRender.imageWarnings);
    } catch (error) {
      progress.hide();
      new Notice(`长图导出失败：${error instanceof Error ? error.message : String(error)}`, 8000);
    } finally {
      this.exporting = false;
      this.updateActionButtons();
    }
  }

  async refresh(context = {}) {
    if (!this.shellEl) this.buildFrame();
    this.applyCurrentPreviewLayout();
    const refreshId = ++this.refreshId;
    const article = this.plugin.getCurrentDocument();
    if (this.headerContext?.articlePath !== article?.path
        || this.headerContext?.themePath !== this.getSelectedThemePath()) this.headerContext = null;
    const sameArticle = this.lastRender?.articlePath === article?.path;
    const oldScrollTop = sameArticle ? this.viewportEl.scrollTop : 0;
    const oldScrollLeft = sameArticle ? this.viewportEl.scrollLeft : 0;
    this.lastRender = null;
    this.setBusy(true);

    try {
      if (!(article instanceof TFile)) {
        this.renderThemeMenu([], null);
        this.renderWarnings([]);
        this.renderMessage('请在左侧打开一篇 Markdown 文档。');
        this.setBusy(false);
        return;
      }

      const {
        themes,
        selected,
        css,
        components,
        assets,
        fonts,
        headingImages,
        quoteImages,
        orderedListImages,
        articleHeader,
        wechatDarkMode,
        referenceComposition,
        problems,
      } = await this.loadThemeState(context);
      if (refreshId !== this.refreshId) return;
      this.renderThemeMenu(themes, selected);

      if (!selected || !css) {
        this.headerContext = null;
        this.renderWarnings(problems);
        this.renderMessage(
          selected
            ? selected.kind === 'v3'
              ? '当前风格无法读取，请检查 manifest.json、theme.css 与组件文件。'
              : '当前风格无法读取，请检查 CSS 代码块。'
            : `没有在「${this.plugin.settings.themeFolder}」找到可用风格。`,
        );
        this.setBusy(false);
        return;
      }

      const sourceView = this.plugin.getCurrentSourceLeaf()?.view;
      const source =
        context.articlePath === article.path && typeof context.articleSource === 'string'
          ? context.articleSource
          : sourceView instanceof MarkdownView && sourceView.file?.path === article.path
              && sourceView.getMode() === 'source'
            ? sourceView.editor.getValue()
            : await this.app.vault.cachedRead(article);
      const galleryImages = await resolveGalleryImageRecords({
        source,
        resolveFile: (target) => this.resolveImageFile(target, article),
        getResourcePath: (file) => this.getThemeReader().getResourcePath(file),
        readBinary: (file) => this.getThemeReader().readBinary(file),
        cache: this.galleryImageDimensionCache,
      });
      if (refreshId !== this.refreshId) return;
      const headerState = readArticleHeaderSelection(source, selected.themeId);
      const renderInput = {
        source,
        themeCss: css,
        resolve: (target) => galleryImages.get(target) ?? this.resolveImage(target, article),
        themeComponents: components,
        themeAssets: assets,
        themeHeader: articleHeader,
        themeDarkMode: wechatDarkMode,
        orderedListImages,
        headerSelection: headerState.selection,
        referenceComposition,
        layoutWidth: this.getCurrentPreviewLayout().previewWidth,
      };
      const result = renderArticle(renderInput);
      if (refreshId !== this.refreshId) return;

      // 图片化前先从活文字 DOM 取得纯文本；img.alt 不会进入 innerText。
      this.articleRootEl.innerHTML = result.html;
      // Rich HTML uses blank placeholders inside theme-drawn empty boxes.
      // Restore the semantic checkbox only while reading the plain-text fallback.
      const emptyTaskMarkers = [...this.articleRootEl.querySelectorAll('.wechat-task-marker.is-unchecked')]
        .filter(marker => !marker.textContent.trim())
        .map(marker => [marker, marker.textContent]);
      let plainText;
      try {
        for (const [marker] of emptyTaskMarkers) marker.textContent = '☐';
        plainText = this.articleRootEl.querySelector('#nice')?.innerText
          ?? this.articleRootEl.textContent ?? '';
      } finally {
        for (const [marker, text] of emptyTaskMarkers) marker.textContent = text;
      }
      const materialized = await this.headingImageRuntime.materialize({
        html: result.html,
        images: result.images,
        themeId: selected.themeId,
        headingImages,
        fonts,
        assets,
        quoteImages,
        orderedListImages,
        referenceComposition,
        layoutWidth: this.getCurrentPreviewLayout().previewWidth,
      });
      if (refreshId !== this.refreshId) return;

      this.renderWarnings([...problems, ...headerState.warnings, ...result.warnings, ...materialized.warnings]);
      this.articleRootEl.innerHTML = materialized.html;
      this.lastRender = {
        articlePath: article.path,
        themePath: selected.path,
        themeId: selected.themeId,
        html: materialized.html,
        images: materialized.images,
        text: plainText,
        inlineLevel: result.inlineLevel,
        exportTitleTheme: { fonts, headingImages },
        ...(referenceComposition ? { referenceLayoutSource: createReferenceLayoutSource({
          renderInput,
          rendered: result,
          materializeInput: { themeId: selected.themeId, headingImages, quoteImages, orderedListImages, fonts, assets, referenceComposition },
        }) } : {}),
        ...((quoteImages || headingImages.some((rule) => rule.widthMode === 'container'))
          ? { quoteImageSource: { html: result.html, images: result.images, themeId: selected.themeId, headingImages, quoteImages, orderedListImages, fonts, assets, layoutWidth:this.getCurrentPreviewLayout().previewWidth } } : {}),
      };
      const customPath = typeof headerState.selection?.custom_image === 'string'
        ? headerState.selection.custom_image.replace(/^\[\[|\]\]$/g, '') : '';
      this.headerContext = {
        article, articlePath: article.path, themePath: selected.path,
        themeId: selected.themeId, themeName: selected.name,
        definition: articleHeader, assets, selection: headerState.selection ?? {},
        customUrl: customPath ? this.resolveImage(customPath, article)?.url : undefined,
        available: Boolean(articleHeader && !headerState.error),
      };
      this.viewportEl.scrollTop = oldScrollTop;
      this.updatePreviewScale();
      this.viewportEl.scrollLeft = oldScrollLeft;
      this.setBusy(false);
      this.rebindScrollSync();
      this.headingBreakControls?.update();
      if (this.plugin.settings.syncScroll) {
        window.requestAnimationFrame(() => this.queueScrollSync(this.sourceScrollEl, this.viewportEl));
      }
    } catch (error) {
      if (refreshId !== this.refreshId) return;
      this.headerContext = null;
      const message = error instanceof Error ? error.message : String(error);
      this.renderWarnings([`渲染失败：${message}`]);
      this.renderMessage('请修正上方问题后重试。');
      this.setBusy(false);
    }
  }
}
