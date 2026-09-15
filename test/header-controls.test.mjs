import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const artifact = await build({
  entryPoints: [fileURLToPath(new URL('../plugin/header-controls.mjs', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'],
});

const flush = async () => { for (let count = 0; count < 5; count += 1) await Promise.resolve(); };
const plain = value => JSON.parse(JSON.stringify(value));

const harness = () => {
  const notices = [];
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.attributes = {};
      this.handlers = new Map();
      this.style = {};
      this.hidden = false;
      this.disabled = false;
      this.className = '';
      this.classList = { toggle: (name, enabled) => {
        const classes = new Set(this.className.split(' ').filter(Boolean));
        if (enabled) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' ');
      } };
    }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren() { this.children = []; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(key, callback) { this.handlers.set(key, [...(this.handlers.get(key) ?? []), callback]); }
    removeEventListener(key, callback) {
      this.handlers.set(key, (this.handlers.get(key) ?? []).filter(item => item !== callback));
    }
    dispatch(key, event = {}) { for (const callback of this.handlers.get(key) ?? []) callback(event); }
    click() { if (!this.disabled) this.dispatch('click'); }
    focus() { document.activeElement = this; }
    contains(element) { return this === element || this.children.some(child => child.contains(element)); }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
      this.parent = null;
    }
    get isConnected() { return this === document.body || Boolean(this.parent?.isConnected); }
    getBoundingClientRect() {
      return { left: 600, right: 666, bottom: 42, top: 16,
        width: Number.parseInt(this.style.width, 10) || 330, height: 390 };
    }
  }
  const document = new Element('document');
  document.body = new Element('body');
  document.documentElement = { clientWidth: 700, clientHeight: 700 };
  document.createElement = tag => new Element(tag);
  const window = new Element('window');
  Object.assign(window, { innerWidth: 700, innerHeight: 700,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const module = { exports: {} };
  vm.runInNewContext(artifact.outputFiles[0].text, {
    module, exports: module.exports, document, window, console,
    require: name => {
      assert.equal(name, 'obsidian');
      return { Notice: class { constructor(message) { notices.push(message); } }, setIcon() {} };
    },
  });
  let context = {
    articlePath: '文章甲.md', themeId: 'simple-sketch', themeName: '简笔手绘',
    definition: { componentId: 'opening', defaultAssetId: 'default', presets: [
      { assetId: 'default', label: '主题默认' }, { assetId: 'notes', label: '整理想法' },
      { assetId: 'writing', label: '写作桌面' }, { assetId: 'ideas', label: '灵感记录' },
    ] },
    assets: ['default', 'notes', 'writing', 'ideas'].map(id => ({ id, url: `asset://${id}` })),
    selection: {}, available: true,
  };
  let saveHandler;
  let uploadHandler;
  const saves = [];
  const uploads = [];
  const ui = module.exports.createArticleHeaderControls({
    getContext: () => context,
    applySelection: async (selection, captured) => {
      saves.push({ selection, captured });
      if (saveHandler) await saveHandler(selection, captured);
      else context = { ...context, selection: selection ?? {} };
    },
    uploadFile: async (file, captured) => {
      uploads.push({ file, captured });
      if (uploadHandler) await uploadHandler(file, captured);
    },
  });
  document.body.append(ui.element);
  const descendants = element => [element, ...element.children.flatMap(descendants)];
  const find = className => descendants(document.body)
    .find(element => element.className.split(' ').includes(className));
  const findAll = className => descendants(document.body)
    .filter(element => element.className.split(' ').includes(className));
  const trigger = find('wechat-mp-header-trigger');
  const open = () => { trigger.click(); return find('wechat-mp-header-popover'); };
  return { ui, document, window, notices, saves, uploads, trigger, find, findAll, open,
    context: () => context, setContext: value => { context = value; },
    onSave: callback => { saveHandler = callback; }, onUpload: callback => { uploadHandler = callback; } };
};

test('头图入口仅在可用文章和主题定义中启用，四个预设以默认项选中', () => {
  const h = harness();
  assert.equal(h.trigger.disabled, false);
  assert.equal(h.trigger.textContent, '更换头图');
  assert.equal(h.trigger.title, '点击展开头图选项');
  assert.equal(h.trigger.children.length, 0);
  assert.equal(h.trigger.getAttribute('aria-haspopup'), 'dialog');
  const panel = h.open();
  assert.equal(panel.hidden, false);
  assert.equal(panel.getAttribute('aria-label'), '头图选项');
  assert.equal(panel.getAttribute('aria-labelledby'), null);
  assert.equal(panel.children[0].className, 'wechat-mp-header-visibility');
  assert.equal(h.find('wechat-mp-header-panel-head'), undefined);
  assert.equal(h.find('wechat-mp-header-scope'), undefined);
  assert.equal(h.trigger.getAttribute('aria-expanded'), 'true');
  const presets = h.findAll('wechat-mp-header-preset');
  assert.equal(presets.length, 4);
  assert.equal(presets[0].getAttribute('aria-pressed'), 'true');
  h.setContext({ ...h.context(), definition: null });
  h.ui.update();
  assert.equal(h.trigger.disabled, true);
  assert.match(h.trigger.title, /未提供/);
  assert.equal(panel.hidden, true);
  h.setContext(null); h.ui.update();
  assert.match(h.trigger.title, /先打开/);
  h.ui.dispose();
});

test('展示开关保留已有选择，关闭时禁用选择上传，重新开启恢复可用', async () => {
  const h = harness();
  h.setContext({ ...h.context(), selection: { preset: 'notes' } }); h.ui.update(); h.open();
  h.find('wechat-mp-header-switch').click(); await flush();
  assert.deepEqual(plain(h.saves.at(-1).selection), { preset: 'notes', enabled: false });
  assert.equal(h.find('wechat-mp-header-upload').disabled, true);
  assert.ok(h.findAll('wechat-mp-header-preset').every(button => button.disabled));
  h.find('wechat-mp-header-switch').click(); await flush();
  assert.equal(h.saves.at(-1).selection.preset, 'notes');
  assert.equal(h.saves.at(-1).selection.enabled, true);
  assert.equal(h.find('wechat-mp-header-upload').disabled, false);
  assert.equal(h.find('wechat-mp-header-popover').hidden, false);
  h.ui.dispose();
});

test('选择预设清除自定义指向，恢复默认传null且不依赖剪贴板或编辑器', async () => {
  const h = harness();
  h.setContext({ ...h.context(), selection: { enabled: true, custom_image: '附件/头图.png' }, customUrl: 'asset://custom' });
  h.ui.update(); h.open();
  assert.equal(h.find('wechat-mp-header-custom-preview').hidden, false);
  assert.equal(h.find('wechat-mp-header-upload').textContent, '更换自定义图片');
  h.findAll('wechat-mp-header-preset')[2].click(); await flush();
  assert.deepEqual(plain(h.saves.at(-1).selection), { enabled: true, preset: 'writing' });
  assert.equal(h.find('wechat-mp-header-custom-preview').hidden, true);
  h.find('wechat-mp-header-reset').click(); await flush();
  assert.equal(h.saves.at(-1).selection, null);
  assert.equal(h.find('wechat-mp-header-reset').disabled, true);
  h.ui.dispose();
});

test('异步保存期间忽略重复点击，使用捕获的文章上下文，失败解除busy并提示', async () => {
  const h = harness(); h.open();
  let finish;
  h.onSave(() => new Promise((resolve, reject) => { finish = reject; }));
  const presets = h.findAll('wechat-mp-header-preset');
  presets[1].click(); presets[2].click();
  assert.equal(h.saves.length, 1);
  assert.equal(h.trigger.disabled, true);
  h.setContext({ ...h.context(), articlePath: '文章乙.md' }); h.ui.update();
  assert.equal(h.find('wechat-mp-header-popover').hidden, true);
  assert.equal(h.saves[0].captured.articlePath, '文章甲.md');
  finish(new Error('测试保存失败')); await flush();
  assert.match(h.notices.at(-1), /测试保存失败/);
  assert.equal(h.trigger.disabled, false);
  h.ui.dispose();
});

test('原生上传仅接受PNG/JPEG，支持同文件重选，过期文章chooser不执行上传', async () => {
  const h = harness(); h.open();
  const input = h.find('wechat-mp-header-file-input');
  assert.equal(input.accept, 'image/png,image/jpeg');
  h.find('wechat-mp-header-upload').click();
  input.files = [{ name: '头图.jpg', type: 'image/jpeg' }]; input.dispatch('change'); await flush();
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].captured.articlePath, '文章甲.md');
  assert.equal(input.value, '');
  h.find('wechat-mp-header-upload').click();
  input.files = [{ name: '图片.svg', type: 'image/svg+xml' }]; input.dispatch('change'); await flush();
  assert.equal(h.uploads.length, 1);
  assert.match(h.notices.at(-1), /PNG 或 JPG/);
  h.find('wechat-mp-header-upload').click();
  h.setContext({ ...h.context(), themeId: 'another-theme' });
  input.files = [{ name: '头图.png', type: 'image/png' }]; input.dispatch('change'); await flush();
  assert.equal(h.uploads.length, 1);
  assert.match(h.notices.at(-1), /已切换/);
  h.ui.dispose();
});

test('弹层在窗口边界内定位，Esc回到入口，外部点击关闭，销毁移除监听和portal', () => {
  const h = harness();
  const panel = h.open();
  assert.equal(panel.style.left, '362px');
  assert.equal(panel.style.width, '330px');
  h.document.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(panel.hidden, true);
  assert.equal(h.document.activeElement, h.trigger);
  h.open();
  h.document.dispatch('pointerdown', { target: h.document.body });
  assert.equal(panel.hidden, true);
  h.document.documentElement.clientWidth = 280;
  h.open();
  assert.equal(panel.style.width, '264px');
  assert.equal(panel.style.left, '8px');
  h.ui.dispose();
  assert.equal(h.document.body.children.length, 0);
  assert.equal(h.document.handlers.get('pointerdown').length, 0);
  assert.equal(h.document.handlers.get('keydown').length, 0);
  assert.equal(h.window.handlers.get('resize').length, 0);
});
