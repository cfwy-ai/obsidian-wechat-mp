import { MarkdownView, Notice } from 'obsidian';
import { VIEW_TYPE } from './constants.mjs';
import { getHeadingBreakContext, planHeadingBreakEdit } from './heading-break-edit.mjs';

const samePosition = (a, b) => a?.line === b?.line && a?.ch === b?.ch;
const makeButton = (className, label) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `wechat-mp-tool-button ${className}`;
  if (label) button.append(document.createTextNode(label));
  return button;
};

/** Owns editor targeting; UI controls never mutate a cached file by path. */
export class HeadingBreakTools {
  constructor(plugin) {
    this.plugin = plugin;
    this.controls = new Set();
    this.frame = null;
    const refresh = () => this.scheduleUpdate();
    for (const event of ['keyup', 'pointerup', 'focusin', 'selectionchange']) {
      plugin.registerDomEvent(document, event, refresh, true);
    }
    for (const event of ['active-leaf-change', 'editor-change', 'layout-change']) {
      plugin.registerEvent(plugin.app.workspace.on(event, refresh));
    }
    plugin.registerEvent(plugin.app.workspace.on('editor-menu', (menu, editor, info) => {
      const view = info instanceof MarkdownView ? info : null;
      const target = this.capture({ sourceView: view, editor });
      if (!target.ok) return;
      menu.addSeparator();
      menu.addItem(item => item.setTitle('标题内换行').setIcon('corner-down-left')
        .onClick(() => this.apply('insert', target)));
      menu.addItem(item => item.setTitle('取消手动换行').setIcon('rotate-ccw')
        .setDisabled(!target.context.hasBreak).onClick(() => this.apply('reset', target)));
    }));
    for (const [action, id, name] of [
      ['insert', 'insert-heading-line-break', '标题内换行'],
      ['reset', 'reset-heading-line-breaks', '取消当前标题手动换行'],
    ]) {
      plugin.addCommand({ id, name, editorCheckCallback: (checking, editor, info) => {
        const target = this.capture({ sourceView: info instanceof MarkdownView ? info : null, editor });
        const enabled = target.ok && (action !== 'reset' || target.context.hasBreak);
        if (!checking && enabled) this.apply(action, target);
        return enabled;
      } });
    }
  }

  capture({ preview, sourceView, editor } = {}) {
    const plugin = this.plugin;
    if (plugin.settings?.headingBreakToolsEnabled === false) return { ok: false, reason: '标题换行工具已关闭' };
    const view = sourceView ?? plugin.getCurrentSourceLeaf()?.view;
    if (!(view instanceof MarkdownView) || view.leaf?.view !== view
        || !plugin.app.workspace.getLeavesOfType('markdown').includes(view.leaf)
        || view.getMode() !== 'source'
        || !plugin.isPreviewableFile(view.file)) {
      return { ok: false, reason: '请先在左侧编辑区将光标放到一至六级标题中' };
    }
    if (editor && editor !== view.editor) return { ok: false, reason: '编辑器已切换，请重新定位标题' };
    const active = plugin.app.workspace.activeLeaf?.view;
    const previews = plugin.app.workspace.getLeavesOfType(VIEW_TYPE).map(leaf => leaf.view);
    const currentPreview = preview ?? previews.find(p => p.lastRender?.articlePath === view.file.path);
    if (currentPreview?.isRendering) return { ok: false, reason: '预览正在更新，请稍后再操作' };
    if (!currentPreview || !previews.includes(currentPreview)
        || currentPreview.lastRender?.articlePath !== view.file.path
        || plugin.currentDocument?.path !== view.file.path
        || (active !== view && !previews.includes(active))) {
      return { ok: false, reason: '请在公众号预览对应的文章中定位标题' };
    }
    const selections = view.editor.listSelections();
    if (selections.length !== 1 || !samePosition(selections[0].anchor, selections[0].head)) {
      return { ok: false, reason: '请取消文字选区，只保留一个换行光标' };
    }
    const source = view.editor.getValue();
    const cursor = view.editor.getCursor();
    const context = getHeadingBreakContext(source, cursor);
    if (!context.ok) return context;
    const rule = currentPreview.lastRender.exportTitleTheme?.headingImages
      ?.find(item => item.headingLevels?.includes(context.level));
    return { ok: true, view, editor: view.editor, file: view.file, source, cursor,
      context, preview: currentPreview, maxLines: rule?.maxLines, maxBreaks: rule ? 2 : undefined,
      themePath: currentPreview.getSelectedThemePath() };
  }

  apply(action, target) {
    if (!target?.ok) {
      new Notice(target?.reason || '请先在左侧标题中定位光标');
      return false;
    }
    const current = this.capture({ preview: target.preview, sourceView: target.view, editor: target.editor });
    if (!current.ok || target.file !== current.file || target.source !== current.source
        || !samePosition(target.cursor, current.cursor) || target.themePath !== current.themePath) {
      new Notice('文章、主题或光标位置已变化，请重新定位标题后再操作');
      this.scheduleUpdate();
      return false;
    }
    const edit = planHeadingBreakEdit({ source: current.source, cursor: current.cursor,
      action, maxLines: current.maxLines, maxBreaks: current.maxBreaks });
    if (!edit.ok) {
      new Notice(edit.reason);
      return false;
    }
    try {
      current.editor.transaction({ changes: [edit.change], selection: { from: edit.cursor } }, 'wechat-heading-break');
      this.plugin.app.workspace.setActiveLeaf(current.view.leaf, { focus: true });
      current.editor.focus();
      this.plugin.scheduleRefresh({ articlePath: current.file.path, articleSource: current.editor.getValue() });
      new Notice(action === 'reset' ? '当前标题已恢复自动换行' : '已插入标题换行，可用撤销恢复', 2500);
      this.scheduleUpdate();
      return true;
    } catch (error) {
      new Notice(`标题换行未完成：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  mount(preview) {
    const group = document.createElement('div');
    group.className = 'wechat-mp-heading-break-control';
    const insert = makeButton('wechat-mp-heading-break-insert', '标题换行');
    group.append(insert);
    let pendingTarget = null;
    const snapshot = event => {
      pendingTarget = this.capture({ preview });
      // Keep the source editor's caret when a pointer activates a toolbar action.
      if (event.button === 0) event.preventDefault();
    };
    insert.addEventListener('pointerdown', snapshot);
    const takeTarget = () => {
      const target = pendingTarget ?? this.capture({ preview });
      pendingTarget = null;
      return target;
    };
    insert.addEventListener('click', () => this.apply('insert', takeTarget()));
    const controls = { element: group, update: () => {
      group.hidden = this.plugin.settings?.headingBreakToolsEnabled === false;
      const target = this.capture({ preview });
      insert.disabled = !target.ok;
      group.title = target.ok ? '在光标处换行；可撤销，或在标题右键菜单中取消手动换行' : target.reason;
      insert.title = target.ok ? '在光标处插入标题内换行' : target.reason;
      group.classList.toggle('has-manual-break', Boolean(target.ok && target.context.hasBreak));
    }, dispose: () => {
      this.controls.delete(controls);
    } };
    this.controls.add(controls);
    controls.update();
    return controls;
  }

  scheduleUpdate() {
    if (this.frame !== null) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      for (const control of this.controls) control.update();
    });
  }

  dispose() {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.controls.clear();
  }
}
