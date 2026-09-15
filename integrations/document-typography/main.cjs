'use strict';

const { MarkdownView, Plugin, Notice } = require('obsidian');
const { documentTitleForDisplay, saveDocumentTitle } = require('../../src/document-title.mjs');

const PLUGIN_ID = 'changfeng-document-typography';
const HEADER_CLASS = 'cf4c-document-header';
const VIEW_CLASS = 'cf4c-document-view';
const ACTIVE_CLASS = 'cf4c-has-document-header';
const VIEW_SWITCHES_KEY = '__cf4cDocumentFieldSwitches';
const RELEVANT_DOM_SELECTOR = [
  '.inline-title',
  '.metadata-container',
  '.markdown-preview-sizer',
  '.cm-sizer',
].join(',');

function normalizeText(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).join(' · ');
  }

  return String(value).replace(/\r\n?/g, '\n').trim();
}

function normalizeCssClasses(frontmatter) {
  const raw = frontmatter?.cssclasses ?? frontmatter?.cssclass ?? [];
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof raw === 'string') {
    return raw.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  }

  return [];
}

function nodeContainsRelevantDom(node) {
  if (!(node instanceof Element)) {
    return false;
  }

  if (node.closest(`.${HEADER_CLASS}`)) {
    return false;
  }

  return node.matches(RELEVANT_DOM_SELECTOR) || Boolean(node.querySelector(RELEVANT_DOM_SELECTOR));
}

function nodeContainsOwnedHeader(node) {
  if (!(node instanceof Element)) {
    return false;
  }

  const selector = `.${HEADER_CLASS}[data-cf4c-owned="${PLUGIN_ID}"]`;
  return node.matches(selector) || Boolean(node.querySelector(selector));
}

class ChangfengDocumentTypographyPlugin extends Plugin {
  async onload() {
    this.updateTimer = null;
    this.settleTimer = null;
    this.updateFrame = null;
    this.fieldTimers = new Map();
    const savedData = await this.loadData();
    this.settings = {
      visibility:
        savedData?.visibility && typeof savedData.visibility === 'object'
          ? savedData.visibility
          : {},
    };

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.scheduleUpdate()),
    );
    this.registerEvent(
      this.app.workspace.on('layout-change', () => this.scheduleUpdate()),
    );
    this.registerEvent(
      this.app.workspace.on('file-open', () => this.scheduleUpdate()),
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => this.updateFile(file)),
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        // A background note or theme edit cannot change an open document header.
        // Keep the settling pass for open notes whose editor DOM is still updating.
        if (file?.extension === 'md' && this.app.workspace.getLeavesOfType('markdown')
          .some((leaf) => leaf.view.file?.path === file.path)) {
          this.scheduleUpdate(20);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => this.handleFileRename(file, oldPath)),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.handleFileDelete(file)),
    );

    this.observer = new MutationObserver((mutations) => {
      const shouldUpdate = mutations.some((mutation) => {
        if (mutation.target instanceof Element && mutation.target.closest(`.${HEADER_CLASS}`)) {
          return false;
        }

        return (
          Array.from(mutation.addedNodes).some(nodeContainsRelevantDom) ||
          Array.from(mutation.removedNodes).some(nodeContainsOwnedHeader)
        );
      });

      if (shouldUpdate) {
        this.scheduleUpdate();
      }
    });
    this.observer.observe(document.body, { childList: true, subtree: true });

    this.register(() => {
      if (this.updateTimer !== null) {
        window.clearTimeout(this.updateTimer);
      }
      if (this.settleTimer !== null) {
        window.clearTimeout(this.settleTimer);
      }
      if (this.updateFrame !== null) {
        window.cancelAnimationFrame(this.updateFrame);
      }
      for (const timer of this.fieldTimers.values()) {
        window.clearTimeout(timer);
      }
      this.fieldTimers.clear();
      this.observer.disconnect();
      this.cleanupAll();
    });

    this.app.workspace.onLayoutReady(() => this.scheduleUpdate(0));
  }

  scheduleUpdate(delay = 40) {
    // Reconcile once quickly, then once more after Obsidian has finished
    // recycling the reading/editor sizer. The trailing pass closes the gap in
    // which the first pass can run before the new host exists.
    if (this.updateTimer === null) {
      this.updateTimer = window.setTimeout(() => {
        this.updateTimer = null;
        this.updateAll();
      }, delay);
    }

    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
    }
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      if (this.updateFrame !== null) {
        window.cancelAnimationFrame(this.updateFrame);
      }
      this.updateFrame = window.requestAnimationFrame(() => {
        this.updateFrame = null;
        this.updateAll();
      });
    }, Math.max(120, delay + 80));
  }

  updateAll() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView) {
        this.updateView(leaf.view);
      }
    }
  }

  updateFile(file) {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
        this.updateView(leaf.view);
      }
    }
  }

  updateView(view) {
    const file = view.file;
    if (!file) {
      this.cleanupView(view);
      return;
    }

    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const cssClasses = normalizeCssClasses(frontmatter);
    const skipView =
      cssClasses.includes('av-homepage') ||
      cssClasses.includes('cf4c-no-header');

    if (skipView) {
      this.cleanupView(view);
      return;
    }

    const fields = {
      title: documentTitleForDisplay(file.basename, frontmatter),
      eyebrow: normalizeText(frontmatter.eyebrow),
      description: normalizeText(frontmatter.description),
    };

    this.ensureViewFieldSwitches(view, file, fields);

    for (const surface of view.containerEl.querySelectorAll(
      '.markdown-source-view.mod-cm6, .markdown-preview-view',
    )) {
      // Obsidian may recycle a hidden preview surface when switching files.
      // The frontmatter is authoritative; clear a stale homepage class here.
      surface.classList.remove('av-homepage');
      if (surface.matches('.markdown-source-view.mod-cm6')) {
        this.renderEditingSurface(surface, fields, file);
      } else {
        this.renderReadingSurface(surface, fields, file, view);
      }
    }
  }

  renderReadingSurface(surface, fields, file, view) {
    const renderer = view?.previewMode?.renderer;

    // The reading renderer virtualizes every direct child of
    // `.markdown-preview-sizer`. Keep our header inside Obsidian's registered
    // `mod-header` section instead of inserting an untracked sibling beside
    // rendered Markdown sections. This also makes the custom header and body
    // appear in the same renderer pass when a background window is resumed.
    if (!renderer?.header?.el) {
      renderer?.addHeader?.();
    }

    const host =
      renderer?.header?.el ??
      surface.querySelector('.markdown-preview-sizer > .mod-header');
    if (!host) {
      surface.classList.remove(VIEW_CLASS, ACTIVE_CLASS);
      return;
    }

    const inlineTitle = host.querySelector(':scope > .inline-title');

    let header = host.querySelector(`:scope > .${HEADER_CLASS}`);
    if (!header) {
      header = surface.ownerDocument.createElement('div');
      header.className = HEADER_CLASS;
      header.setAttribute('data-cf4c-owned', PLUGIN_ID);
      header.setAttribute('data-cf4c-mode', 'reading');
      header.setAttribute('contenteditable', 'false');
    }

    if (inlineTitle) {
      if (inlineTitle.previousElementSibling !== header) {
        host.insertBefore(header, inlineTitle);
      }
    } else if (host.firstElementChild !== header) {
      host.prepend(header);
    }

    header.classList.remove(`${HEADER_CLASS}--editing`);
    header.setAttribute('data-cf4c-mode', 'reading');
    this.populateReadingHeader(header, fields, file);
    surface.classList.add(VIEW_CLASS, ACTIVE_CLASS);
  }

  renderEditingSurface(surface, fields, file) {
    const host = surface.querySelector('.cm-sizer');
    if (!host) {
      surface.classList.remove(VIEW_CLASS, ACTIVE_CLASS);
      return;
    }

    let header = host.querySelector(`:scope > .${HEADER_CLASS}[data-cf4c-owned="${PLUGIN_ID}"]`);
    if (!header) {
      header = surface.ownerDocument.createElement('div');
      header.className = `${HEADER_CLASS} ${HEADER_CLASS}--editing`;
      header.setAttribute('data-cf4c-owned', PLUGIN_ID);
      header.setAttribute('data-cf4c-mode', 'editing');
      header.setAttribute('contenteditable', 'false');
    }

    // Obsidian mounts the native inline title and Properties after the editor.
    // Move our editable header back to the first slot whenever that happens.
    if (host.firstElementChild !== header) {
      host.prepend(header);
    }

    header.classList.add(`${HEADER_CLASS}--editing`);
    header.setAttribute('data-cf4c-mode', 'editing');
    this.populateEditingHeader(header, fields, file);
    surface.classList.add(VIEW_CLASS, ACTIVE_CLASS);
  }

  populateReadingHeader(header, fields, file) {
    const documentRef = header.ownerDocument;
    const fragment = documentRef.createDocumentFragment();

    if (fields.eyebrow && this.getFieldVisibility(file, 'eyebrow', fields)) {
      const eyebrow = documentRef.createElement('p');
      eyebrow.className = 'cf4c-eyebrow';
      eyebrow.textContent = fields.eyebrow;
      fragment.appendChild(eyebrow);
    }

    const title = documentRef.createElement('div');
    title.className = 'cf4c-document-title';
    title.setAttribute('role', 'heading');
    title.setAttribute('aria-level', '1');

    for (const lineText of fields.title.split('\n')) {
      const line = documentRef.createElement('span');
      line.className = 'cf4c-title-line';
      line.textContent = lineText || '\u00a0';
      title.appendChild(line);
    }
    fragment.appendChild(title);

    if (fields.description && this.getFieldVisibility(file, 'description', fields)) {
      const description = documentRef.createElement('p');
      description.className = 'cf4c-document-description';
      description.textContent = fields.description;
      fragment.appendChild(description);
    }

    header.replaceChildren(fragment);
  }

  populateEditingHeader(header, fields, file) {
    const previousPath = header.getAttribute('data-cf4c-file-path');
    if (previousPath && previousPath !== file.path) {
      const previousFile = this.app.vault.getAbstractFileByPath(previousPath);
      for (const field of header.querySelectorAll('[data-cf4c-field][data-cf4c-dirty="true"]')) {
        this.commitField(field, previousFile);
      }
      header.replaceChildren();
    }
    header.setAttribute('data-cf4c-file-path', file.path);

    let controls = header.querySelector(':scope > .cf4c-edit-controls');
    if (!controls) {
      controls = header.ownerDocument.createElement('div');
      controls.className = 'cf4c-edit-controls';
      controls.setAttribute('aria-label', '文首展示字段');
      header.replaceChildren(controls);

      controls.addEventListener('mousedown', (event) => event.stopPropagation());
      controls.addEventListener('keydown', (event) => event.stopPropagation());
    }

    const definitions = [
      {
        field: 'eyebrow',
        tag: 'input',
        className: 'cf4c-eyebrow cf4c-edit-field cf4c-edit-eyebrow',
        value: fields.eyebrow,
        placeholder: '添加上方标签（可选）',
        label: '上方标签',
      },
      {
        field: 'document_title',
        tag: 'textarea',
        className: 'cf4c-document-title cf4c-edit-field cf4c-edit-title',
        value: fields.title,
        placeholder: file.basename,
        label: '文档标题；回车换行，离开输入框时同步文件名',
      },
      {
        field: 'description',
        tag: 'textarea',
        className: 'cf4c-document-description cf4c-edit-field cf4c-edit-description',
        value: fields.description,
        placeholder: '添加一句话介绍（可选）',
        label: '一句话介绍',
      },
    ];

    for (const definition of definitions) {
      let field = controls.querySelector(`[data-cf4c-field="${definition.field}"]`);
      if (!field) {
        field = header.ownerDocument.createElement(definition.tag);
        field.className = definition.className;
        field.setAttribute('data-cf4c-field', definition.field);
        field.setAttribute('aria-label', definition.label);
        field.setAttribute('placeholder', definition.placeholder);
        field.setAttribute('spellcheck', 'false');
        if (definition.tag === 'textarea') {
          field.setAttribute('rows', '1');
        } else {
          field.setAttribute('type', 'text');
        }

        field.addEventListener('input', () => {
          field.setAttribute('data-cf4c-dirty', 'true');
          this.resizeField(field);
          if (definition.field !== 'document_title') this.scheduleFieldCommit(field);
        });
        field.addEventListener('blur', () => this.commitField(field));
        controls.appendChild(field);
      }

      if (header.ownerDocument.activeElement !== field && field.getAttribute('data-cf4c-dirty') !== 'true') {
        field.value = definition.value;
        this.resizeField(field);
      }

      const optionalField = definition.field === 'eyebrow' || definition.field === 'description';
      const fieldIsHidden = optionalField && !this.getFieldVisibility(file, definition.field, fields);
      field.hidden = fieldIsHidden;
      if (fieldIsHidden) {
        field.style.setProperty('display', 'none', 'important');
      } else {
        field.style.removeProperty('display');
      }
    }
  }

  getFieldVisibility(file, field, fields) {
    const saved = this.settings.visibility?.[file.path]?.[field];
    if (typeof saved === 'boolean') {
      return saved;
    }

    return Boolean(fields[field]);
  }

  ensureViewFieldSwitches(view, file, fields) {
    let container = view[VIEW_SWITCHES_KEY];
    let switches = Array.from(
      container?.querySelectorAll?.(':scope > .cf4c-view-field-switch') ?? [],
    );
    const switchesAreLive =
      container?.isConnected &&
      container?.parentElement === view.actionsEl &&
      switches.map((button) => button.getAttribute('data-cf4c-content')).join('|') ===
        'eyebrow|description';

    if (!switchesAreLive) {
      this.removeViewFieldSwitches(view);

      const actionsEl = view.actionsEl;
      if (!actionsEl) {
        return;
      }

      container = actionsEl.ownerDocument.createElement('div');
      container.className = 'cf4c-view-field-switches';
      container.setAttribute('data-cf4c-owned', PLUGIN_ID);
      container.setAttribute('role', 'group');
      container.setAttribute('aria-label', '文首展示字段');

      for (const [field, label] of [
        ['eyebrow', 'Eyebrow'],
        ['description', 'Description'],
      ]) {
        const button = actionsEl.ownerDocument.createElement('button');
        button.type = 'button';
        button.className = 'clickable-icon view-action cf4c-view-field-switch';
        button.setAttribute('data-cf4c-owned', PLUGIN_ID);
        button.setAttribute('data-cf4c-content', field);
        button.setAttribute(
          'aria-label',
          `${label} 显示开关；内容由你在属性或编辑态文首填写`,
        );
        button.textContent = label;
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.toggleOptionalField(view, field);
        });
        container.appendChild(button);
      }

      actionsEl.prepend(container);
      view[VIEW_SWITCHES_KEY] = container;
      switches = Array.from(container.children);
    }

    for (const button of switches) {
      const field = button.getAttribute('data-cf4c-content');
      button.setAttribute('aria-pressed', String(this.getFieldVisibility(file, field, fields)));
    }
  }

  async toggleOptionalField(view, field) {
    const currentFile = view.file;
    if (!currentFile) {
      return;
    }

    const currentFrontmatter = this.app.metadataCache.getFileCache(currentFile)?.frontmatter ?? {};
    const currentFields = {
      title: documentTitleForDisplay(currentFile.basename, currentFrontmatter),
      eyebrow: normalizeText(currentFrontmatter.eyebrow),
      description: normalizeText(currentFrontmatter.description),
    };

    // A switch click can land inside the field's 650 ms YAML debounce window.
    // Prefer the live editor values over a stale metadata-cache snapshot.
    for (const property of ['document_title', 'eyebrow', 'description']) {
      const input = view.containerEl.querySelector(
        `.${HEADER_CLASS}--editing [data-cf4c-field="${property}"]`,
      );
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
        const value = normalizeText(input.value);
        if (property === 'document_title') {
          currentFields.title = value || currentFile.basename;
        } else {
          currentFields[property] = value;
        }
      }
    }
    const nextVisible = !this.getFieldVisibility(currentFile, field, currentFields);
    await this.setFieldVisibility(currentFile, field, nextVisible, currentFields);

    if (nextVisible && !currentFields[field]) {
      await this.revealOptionalField(view, field);
    }
  }

  removeViewFieldSwitches(view) {
    const owned = view?.[VIEW_SWITCHES_KEY];
    if (Array.isArray(owned)) {
      for (const button of owned) {
        button?.remove();
      }
    } else {
      owned?.remove?.();
    }
    if (view) {
      delete view[VIEW_SWITCHES_KEY];
    }

    for (const element of view?.containerEl?.querySelectorAll?.(
      `.cf4c-view-field-switches[data-cf4c-owned="${PLUGIN_ID}"],
       .cf4c-view-field-switch[data-cf4c-owned="${PLUGIN_ID}"]`,
    ) ?? []) {
      element.remove();
    }
  }

  async revealOptionalField(view, field) {
    if (view.getMode?.() !== 'source') {
      await view.setState({ ...view.getState(), mode: 'source' }, { history: false });
    }

    window.requestAnimationFrame(() => {
      this.updateView(view);
      window.requestAnimationFrame(() => {
        const input = view.containerEl.querySelector(
          `.${HEADER_CLASS}--editing [data-cf4c-field="${field}"]`,
        );
        if (input instanceof HTMLElement) {
          input.focus();
        }
      });
    });
  }

  async setFieldVisibility(file, field, visible, fields = null) {
    if (!file) {
      return;
    }

    const resolvedFields = fields ?? (() => {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      return {
        eyebrow: normalizeText(frontmatter.eyebrow),
        description: normalizeText(frontmatter.description),
      };
    })();

    if (!this.settings.visibility[file.path]) {
      this.settings.visibility[file.path] = {};
    }

    if (visible === Boolean(resolvedFields[field])) {
      delete this.settings.visibility[file.path][field];
    } else {
      this.settings.visibility[file.path][field] = visible;
    }
    if (Object.keys(this.settings.visibility[file.path]).length === 0) {
      delete this.settings.visibility[file.path];
    }

    // Make the button and document change in the same interaction frame; disk
    // persistence is deliberately kept off the visual critical path.
    this.applyFieldVisibilityToOpenViews(file, field, visible, resolvedFields);
    this.updateFile(file);
    await this.saveData(this.settings);
    this.scheduleUpdate(0);
  }

  applyFieldVisibilityToOpenViews(file, field, visible, fields) {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file?.path !== file.path) {
        continue;
      }

      for (const button of view.containerEl.querySelectorAll(
        `.cf4c-view-field-switch[data-cf4c-content="${field}"]`,
      )) {
        button.setAttribute('aria-pressed', String(visible));
      }

      for (const header of view.containerEl.querySelectorAll(
        `.${HEADER_CLASS}[data-cf4c-owned="${PLUGIN_ID}"]`,
      )) {
        if (header.classList.contains(`${HEADER_CLASS}--editing`)) {
          const input = header.querySelector(`[data-cf4c-field="${field}"]`);
          if (input instanceof HTMLElement) {
            input.hidden = !visible;
            if (visible) {
              input.style.removeProperty('display');
            } else {
              input.style.setProperty('display', 'none', 'important');
            }
          }
          continue;
        }

        // Rebuild the small reading header synchronously. This avoids leaving
        // an old optional node behind when Obsidian is recycling its preview
        // sizer in the same click frame.
        this.populateReadingHeader(header, fields, file);
      }
    }
  }

  async handleFileRename(file, oldPath) {
    if (!oldPath) {
      this.scheduleUpdate();
      return;
    }

    let changed = false;
    for (const key of Object.keys(this.settings.visibility)) {
      if (key !== oldPath && !key.startsWith(`${oldPath}/`)) {
        continue;
      }
      const nextKey = `${file.path}${key.slice(oldPath.length)}`;
      this.settings.visibility[nextKey] = this.settings.visibility[key];
      delete this.settings.visibility[key];
      changed = true;
    }
    if (changed) {
      await this.saveData(this.settings);
    }
    this.scheduleUpdate();
  }

  async handleFileDelete(file) {
    const deletedPath = file?.path;
    if (!deletedPath) {
      return;
    }

    let changed = false;
    for (const key of Object.keys(this.settings.visibility)) {
      if (key === deletedPath || key.startsWith(`${deletedPath}/`)) {
        delete this.settings.visibility[key];
        changed = true;
      }
    }
    if (changed) {
      await this.saveData(this.settings);
    }
  }

  resizeField(field) {
    if (field.tagName !== 'TEXTAREA') {
      return;
    }

    field.style.height = 'auto';
    field.style.height = `${Math.max(field.scrollHeight, 1)}px`;
  }

  scheduleFieldCommit(field) {
    const previousTimer = this.fieldTimers.get(field);
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
    }

    const timer = window.setTimeout(() => {
      this.fieldTimers.delete(field);
      this.commitField(field);
    }, 650);
    this.fieldTimers.set(field, timer);
  }

  getFileForField(field) {
    const header = field.closest(`.${HEADER_CLASS}--editing`);
    const path = header?.getAttribute('data-cf4c-file-path');
    return path ? this.app.vault.getAbstractFileByPath(path) : null;
  }

  async commitField(field, explicitFile = null) {
    const pendingTimer = this.fieldTimers.get(field);
    if (pendingTimer !== undefined) {
      window.clearTimeout(pendingTimer);
      this.fieldTimers.delete(field);
    }

    if (field.getAttribute('data-cf4c-dirty') !== 'true' || field.getAttribute('data-cf4c-saving') === 'true') {
      return;
    }

    const file = explicitFile ?? this.getFileForField(field);
    if (!file) {
      return;
    }

    const property = field.getAttribute('data-cf4c-field');
    const value = normalizeText(field.value);
    field.setAttribute('data-cf4c-saving', 'true');

    try {
      if (property === 'document_title') {
        await saveDocumentTitle(this.app, file, value);
        field.closest(`.${HEADER_CLASS}--editing`)?.setAttribute('data-cf4c-file-path', file.path);
      } else {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (!value) {
          delete frontmatter[property];
        } else {
          frontmatter[property] = value;
        }
      });
      }
      if (normalizeText(field.value) === value) field.setAttribute('data-cf4c-dirty', 'false');
    } catch (error) {
      console.error(`${PLUGIN_ID}: failed to save ${property}`, error);
      new Notice(`文首保存失败：${error.message || error}`);
    } finally {
      field.removeAttribute('data-cf4c-saving');
      this.scheduleUpdate();
    }
  }

  cleanupSurface(surface) {
    surface.classList.remove(VIEW_CLASS, ACTIVE_CLASS);
    for (const header of surface.querySelectorAll(`.${HEADER_CLASS}[data-cf4c-owned="${PLUGIN_ID}"]`)) {
      header.remove();
    }
  }

  cleanupView(view) {
    this.removeViewFieldSwitches(view);
    for (const surface of view.containerEl.querySelectorAll(
      '.markdown-source-view.mod-cm6, .markdown-preview-view',
    )) {
      this.cleanupSurface(surface);
    }
  }

  cleanupAll() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView) {
        this.cleanupView(leaf.view);
      }
    }

    for (const switches of document.querySelectorAll(
      `.cf4c-view-field-switches[data-cf4c-owned="${PLUGIN_ID}"], .cf4c-view-field-switch[data-cf4c-owned="${PLUGIN_ID}"]`,
    )) {
      switches.remove();
    }
    for (const header of document.querySelectorAll(
      `.${HEADER_CLASS}[data-cf4c-owned="${PLUGIN_ID}"]`,
    )) {
      header.remove();
    }
    for (const surface of document.querySelectorAll(`.${VIEW_CLASS}, .${ACTIVE_CLASS}`)) {
      surface.classList.remove(VIEW_CLASS, ACTIVE_CLASS);
    }
  }
}

module.exports = ChangfengDocumentTypographyPlugin;
