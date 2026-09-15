import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import {
  DEFAULT_MOBILE_PREVIEW_WIDTH,
  DEFAULT_PREVIEW_WIDTH,
  DEFAULT_SETTINGS,
  VIEW_TYPE,
} from './constants.mjs';
import { migrateLegacyThemeSettings } from './settings-migration.mjs';
import { WechatMpSettingTab } from './settings.mjs';
import { WechatPreviewView } from './view.mjs';
import { HeadingBreakTools } from './heading-break-tools.mjs';
import {
  focusMarkdownDocument,
  handleCurrentDocumentDeletion,
  refreshThemeDocument,
  rememberMarkdownDocument,
  renderedArticleUsesFile,
} from './document-state.mjs';
import {
  isConfiguredThemePath,
  isPreviewableMarkdownDocument,
  isThemeDocument,
} from './document-role.mjs';
import { cleanVaultFolder } from '../src/vault-path.mjs';
import {
  InternalThemeResourcesVisibility,
  isConfiguredThemeRepositoryChange,
} from './internal-theme-resources.mjs';

export default class ChangfengWechatMpPlugin extends Plugin {
  async onload() {
    const loadedSettings = await this.loadData();
    const migration = migrateLegacyThemeSettings(loadedSettings ?? {});
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...migration.settings,
    };
    this.settings.themeFolder = cleanVaultFolder(this.settings.themeFolder);
    this.settings.showInternalThemeResources = Boolean(
      this.settings.showInternalThemeResources,
    );
    this.settings.previewWidth = this.normalizePreviewWidth(this.settings.previewWidth);
    this.settings.mobilePreview = Boolean(this.settings.mobilePreview);
    this.settings.mobilePreviewWidth = this.normalizeMobilePreviewWidth(
      this.settings.mobilePreviewWidth,
    );
    if (migration.migrated) await this.saveData(this.settings);

    this.currentDocument = null;
    this.currentSourceLeaf = null;
    this.refreshTimer = null;
    this.pendingRefresh = {};
    this.restoreRightSidebar = false;
    this.internalThemeResourcesVisibility = new InternalThemeResourcesVisibility({
      vault: this.app.vault,
      document: this.app.workspace.containerEl?.ownerDocument ?? globalThis.document,
    });
    this.refreshInternalThemeResourcesVisibility();

    this.headingBreakTools = new HeadingBreakTools(this);
    this.registerView(VIEW_TYPE, (leaf) => new WechatPreviewView(leaf, this));

    this.addRibbonIcon('columns-2', '切换公众号排版模式', () => {
      void this.togglePreviewMode(true);
    });

    this.addCommand({
      id: 'toggle-wechat-mp-preview',
      name: '切换左右排版模式',
      callback: () => this.togglePreviewMode(true),
    });

    // 保留旧命令 ID，避免用户已绑定的快捷键失效。
    this.addCommand({
      id: 'open-wechat-mp-preview',
      name: '打开左右排版模式',
      callback: () => this.openPreviewMode(true),
    });

    this.addSettingTab(new WechatMpSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => this.handleActiveLeafChange(leaf)),
    );
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => this.handleFileOpen(file)),
    );
    this.registerEvent(
      this.app.workspace.on('layout-change', () => this.rebindPreviewViews()),
    );
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor, info) => {
        const file = info?.file;
        if (!(file instanceof TFile)) return;

        if (this.isThemeFile(file)) {
          refreshThemeDocument(this, {
            file,
            readThemeSource: () => editor.getValue(),
          });
          return;
        }

        if (this.isPreviewableFile(file)) {
          focusMarkdownDocument(this, {
            file,
            sourceLeaf: info instanceof MarkdownView ? info.leaf : null,
            readArticleSource: () => editor.getValue(),
          });
        }
      }),
    );

    const refreshForVaultChange = (file) => {
      if (!file?.path) return;
      if (isConfiguredThemeRepositoryChange(file.path, this.settings.themeFolder)) {
        this.refreshInternalThemeResourcesVisibility();
        this.scheduleRefresh();
        return;
      }
      if (file.path === this.currentDocument?.path || this.previewUsesFile(file.path)) {
        this.scheduleRefresh();
      }
    };
    this.registerEvent(this.app.vault.on('modify', refreshForVaultChange));
    this.registerEvent(this.app.vault.on('create', refreshForVaultChange));
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!handleCurrentDocumentDeletion(this, file)) refreshForVaultChange(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        const wasCurrent = oldPath === this.currentDocument?.path;
        const touchesTheme =
          isConfiguredThemeRepositoryChange(file?.path, this.settings.themeFolder) ||
          isConfiguredThemeRepositoryChange(oldPath, this.settings.themeFolder) ||
          isConfiguredThemePath(oldPath, this.settings.themeFolder);
        const touchesRenderedImage =
          this.previewUsesFile(oldPath) || this.previewUsesFile(file?.path);
        if (wasCurrent && file instanceof TFile && this.isPreviewableFile(file)) {
          this.currentDocument = file;
        }
        if (touchesTheme) this.refreshInternalThemeResourcesVisibility();
        if (wasCurrent || touchesTheme || touchesRenderedImage) this.scheduleRefresh();
      }),
    );

    this.app.workspace.onLayoutReady(() => {
      // v0.1 会恢复右侧栏面板。v0.2 改为用户手动打开的中央分栏。
      this.closePreviewMode(false);
      this.restoreCurrentDocument();
      this.refreshInternalThemeResourcesVisibility();
    });
  }

  onunload() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.headingBreakTools?.dispose();
    this.internalThemeResourcesVisibility?.dispose();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  refreshInternalThemeResourcesVisibility() {
    this.internalThemeResourcesVisibility?.refresh({
      themeFolder: this.settings.themeFolder,
      showInternalThemeResources: this.settings.showInternalThemeResources,
    });
  }

  normalizePreviewWidth(value) {
    const width = Number(value);
    return Number.isFinite(width)
      ? Math.min(900, Math.max(320, Math.round(width)))
      : DEFAULT_PREVIEW_WIDTH;
  }

  normalizeMobilePreviewWidth(value) {
    const width = Number(value);
    return Number.isFinite(width)
      ? Math.min(430, Math.max(320, Math.round(width)))
      : DEFAULT_MOBILE_PREVIEW_WIDTH;
  }

  isThemeFile(file) {
    return file instanceof TFile && isThemeDocument(file, this.settings.themeFolder);
  }

  isPreviewableFile(file) {
    return (
      file instanceof TFile &&
      this.app.vault.getAbstractFileByPath(file.path) === file &&
      isPreviewableMarkdownDocument(file, this.settings.themeFolder)
    );
  }

  hasPreviewView() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).length > 0;
  }

  rememberMarkdownView(view) {
    if (!(view instanceof MarkdownView) || !this.isPreviewableFile(view.file)) return false;
    rememberMarkdownDocument(this, { file: view.file, sourceLeaf: view.leaf });
    return true;
  }

  handleActiveLeafChange(leaf) {
    if (!(leaf?.view instanceof MarkdownView) || !this.isPreviewableFile(leaf.view.file)) return;
    focusMarkdownDocument(this, {
      file: leaf.view.file,
      sourceLeaf: leaf,
      readArticleSource: () => leaf.view.editor.getValue(),
    });
  }

  handleFileOpen(file) {
    if (this.isThemeFile(file)) {
      if (this.hasPreviewView()) this.scheduleRefresh();
      return;
    }
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file !== file || !this.isPreviewableFile(file)) return;
    focusMarkdownDocument(this, {
      file,
      sourceLeaf: active.leaf,
      readArticleSource: () => active.editor.getValue(),
    });
  }

  restoreCurrentDocument() {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (this.rememberMarkdownView(active)) return;
    if (this.isPreviewableFile(this.currentDocument)) return;

    const recentPath = this.app.workspace
      .getLastOpenFiles()
      .find((path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return this.isPreviewableFile(file);
      });
    const recent = recentPath ? this.app.vault.getAbstractFileByPath(recentPath) : null;
    this.currentDocument = this.isPreviewableFile(recent) ? recent : null;
  }

  getCurrentDocument() {
    if (!this.isPreviewableFile(this.currentDocument)) this.restoreCurrentDocument();
    return this.currentDocument;
  }

  getCurrentSourceLeaf() {
    const view = this.currentSourceLeaf?.view;
    return view instanceof MarkdownView && view.file?.path === this.currentDocument?.path
      ? this.currentSourceLeaf
      : null;
  }

  updatePreviewSources() {
    const sourceLeaf = this.getCurrentSourceLeaf();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof WechatPreviewView) leaf.view.setSourceLeaf(sourceLeaf);
    }
  }

  rebindPreviewViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof WechatPreviewView) leaf.view.rebindScrollSync();
    }
  }

  previewUsesFile(filePath) {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).some((leaf) =>
      leaf.view instanceof WechatPreviewView &&
      renderedArticleUsesFile(leaf.view.lastRender, filePath));
  }

  scheduleRefresh(context = {}) {
    if (!this.hasPreviewView()) return;

    if (typeof context.articleSource === 'string') {
      this.pendingRefresh.articlePath = context.articlePath;
      this.pendingRefresh.articleSource = context.articleSource;
    }
    if (typeof context.themeSource === 'string') {
      this.pendingRefresh.themePath = context.themePath;
      this.pendingRefresh.themeSource = context.themeSource;
    }

    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      const pending = this.pendingRefresh;
      this.pendingRefresh = {};
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view instanceof WechatPreviewView) void leaf.view.refresh(pending);
      }
    }, 250);
  }

  async togglePreviewMode(showNotice) {
    if (this.hasPreviewView()) {
      this.closePreviewMode(showNotice);
      return;
    }
    await this.openPreviewMode(showNotice);
  }

  async openPreviewMode(showNotice) {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!this.rememberMarkdownView(active)) {
      if (showNotice) new Notice('请先打开一篇 Markdown 文档');
      return;
    }

    this.closePreviewMode(false);
    const sourceLeaf = active.leaf;
    if (!this.app.workspace.rightSplit.collapsed) {
      this.restoreRightSidebar = true;
      this.app.workspace.rightSplit.collapse();
    }
    const previewLeaf = this.app.workspace.createLeafBySplit(sourceLeaf, 'vertical', false);
    await previewLeaf.setViewState({ type: VIEW_TYPE, active: true });
    await previewLeaf.loadIfDeferred();

    if (previewLeaf.view instanceof WechatPreviewView) {
      previewLeaf.view.setSourceLeaf(sourceLeaf);
      await previewLeaf.view.refresh({
        articlePath: active.file.path,
        articleSource: active.editor.getValue(),
      });
    }

    this.app.workspace.setActiveLeaf(sourceLeaf, { focus: true });
    if (showNotice) new Notice('已打开左右排版模式');
  }

  closePreviewMode(showNotice = true) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) leaf.detach();
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.pendingRefresh = {};
    if (this.restoreRightSidebar) {
      this.restoreRightSidebar = false;
      this.app.workspace.rightSplit.expand();
    }
    if (showNotice && leaves.length > 0) new Notice('已关闭公众号排版模式');
  }

  async selectTheme(selection) {
    const path = typeof selection === 'string' ? selection : selection?.path;
    const themeId = typeof selection === 'object' && selection?.themeId
      ? String(selection.themeId)
      : '';
    if (
      this.settings.selectedThemeFile === path &&
      this.settings.selectedThemeId === themeId
    ) return;
    this.settings.selectedThemeFile = path;
    this.settings.selectedThemeId = themeId;
    await this.saveData(this.settings);
  }

  async setScrollSync(value) {
    this.settings.syncScroll = Boolean(value);
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof WechatPreviewView) leaf.view.setScrollSync(this.settings.syncScroll);
    }
  }

  async setMobilePreview(value) {
    this.settings.mobilePreview = Boolean(value);
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof WechatPreviewView) {
        leaf.view.setMobilePreviewState(this.settings.mobilePreview);
      }
    }
  }

  async updateSettings(patch) {
    this.settings = {
      ...this.settings,
      ...patch,
    };
    this.settings.themeFolder = cleanVaultFolder(this.settings.themeFolder);
    this.settings.showInternalThemeResources = Boolean(
      this.settings.showInternalThemeResources,
    );
    this.settings.previewWidth = this.normalizePreviewWidth(this.settings.previewWidth);
    this.settings.mobilePreview = Boolean(this.settings.mobilePreview);
    this.settings.mobilePreviewWidth = this.normalizeMobilePreviewWidth(
      this.settings.mobilePreviewWidth,
    );
    await this.saveData(this.settings);
    this.refreshInternalThemeResourcesVisibility();
    this.scheduleRefresh();
  }
}
