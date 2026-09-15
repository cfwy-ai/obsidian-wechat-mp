import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const artifact = await build({
  entryPoints: [fileURLToPath(new URL('../plugin/heading-break-tools.mjs', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'],
});

const harness = () => {
  const notices = [];
  const events = new Map();
  const commands = [];
  class MarkdownView {}
  const module = { exports: {} };
  vm.runInNewContext(artifact.outputFiles[0].text, {
    module, exports: module.exports,
    require: name => {
      assert.equal(name, 'obsidian');
      return { MarkdownView, Menu: class {}, Notice: class { constructor(message) { notices.push(message); } }, setIcon() {} };
    },
    document: {}, window: { requestAnimationFrame() { return 1; }, cancelAnimationFrame() {} },
    console,
  });
  let source = '# 多开对话很爽，难的是它们怎么配合\n\n正文不会改动';
  let cursor = { line: 0, ch: 9 };
  let selections;
  const transactions = [];
  const undoHistory = [];
  const editor = {
    getValue: () => source, getCursor: () => ({ ...cursor }),
    listSelections: () => selections || [{ anchor: { ...cursor }, head: { ...cursor } }],
    focus() {},
    transaction(tx, origin) {
      undoHistory.push({ source, cursor: { ...cursor } });
      transactions.push({ tx, origin });
      const lines = source.split('\n');
      assert.equal(tx.changes.length, 1);
      const change = tx.changes[0];
      lines[change.from.line] = change.text;
      source = lines.join('\n');
      cursor = { ...tx.selection.from };
    },
  };
  const file = { path: '文章.md' };
  const view = new MarkdownView();
  Object.assign(view, { editor, file, getMode: () => 'source', leaf: {} });
  view.leaf.view = view;
  const preview = {
    lastRender: { articlePath: file.path, exportTitleTheme: { headingImages: [{ headingLevels: [1], maxLines: 2 }] } },
    getSelectedThemePath: () => '主题/manifest.json',
  };
  const plugin = {
    currentDocument: file, getCurrentSourceLeaf: () => view.leaf,
    isPreviewableFile: f => f === file,
    scheduleRefresh() {}, registerDomEvent() {}, registerEvent() {},
    addCommand: c => commands.push(c),
    app: { workspace: {
      activeLeaf: view.leaf, getLeavesOfType: type => type === 'markdown' ? [view.leaf] : [{ view: preview }],
      on: (name, callback) => { events.set(name, callback); return {}; },
      setActiveLeaf(leaf) { this.activeLeaf = leaf; },
    } },
  };
  const tools = new module.exports.HeadingBreakTools(plugin);
  return { tools, plugin, view, preview, editor, file, notices, transactions, events, commands,
    source: () => source, setSource: v => { source = v; }, setCursor: p => { cursor = p; },
    setSelections: s => { selections = s; },
    undo: () => { const state = undoHistory.pop(); assert.ok(state); source = state.source; cursor = state.cursor; } };
};

test('点击预览工具栏后仍使用保存的编辑光标，一次 transaction 只修改当前 H1', () => {
  const h = harness();
  const target = h.tools.capture({ preview: h.preview });
  assert.equal(target.ok, true);
  h.plugin.app.workspace.activeLeaf = { view: h.preview };
  assert.equal(h.tools.apply('insert', target), true);
  assert.equal(h.source(), '# 多开对话很爽，<br>难的是它们怎么配合\n\n正文不会改动');
  assert.equal(h.transactions.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.transactions[0].tx.selection.from)), { line: 0, ch: 13 });
  assert.equal(h.plugin.app.workspace.activeLeaf, h.view.leaf);
});

test('菜单打开后文章或光标变化，拒绝写回过期目标', () => {
  for (const mutate of [
    h => h.setSource(h.source() + '\n新内容'),
    h => h.setCursor({ line: 1, ch: 0 }),
    h => { h.preview.lastRender.articlePath = '另一篇.md'; },
    h => { h.preview.getSelectedThemePath = () => '另一主题/manifest.json'; },
    h => { h.view.file = { path: '文章.md' }; },
    h => { h.plugin.app.workspace.getLeavesOfType = type => type === 'markdown' ? [] : [{ view: h.preview }]; },
    h => { h.plugin.app.workspace.getLeavesOfType = type => type === 'markdown' ? [h.view.leaf] : []; },
  ]) {
    const h = harness(), target = h.tools.capture({ preview: h.preview });
    mutate(h);
    assert.equal(h.tools.apply('insert', target), false);
    assert.equal(h.transactions.length, 0);
    assert.match(h.notices.at(-1), /已变化/);
  }
});

test('普通段落、阅读模式、选区、多光标和其他活动文档都不能触发编辑', () => {
  for (const mutate of [
    h => h.setCursor({ line: 2, ch: 2 }),
    h => { h.view.getMode = () => 'preview'; },
    h => h.setSelections([{ anchor: { line: 0, ch: 2 }, head: { line: 0, ch: 5 } }]),
    h => h.setSelections([{ anchor: { line: 0, ch: 2 }, head: { line: 0, ch: 2 } }, { anchor: { line: 0, ch: 5 }, head: { line: 0, ch: 5 } }]),
    h => { h.plugin.app.workspace.activeLeaf = { view: {} }; },
  ]) {
    const h = harness(); mutate(h);
    assert.equal(h.tools.capture({ preview: h.preview }).ok, false);
    assert.equal(h.transactions.length, 0);
  }
});

test('恢复操作只清除当前标题断点，主题行数传递给编辑算法', () => {
  const h = harness();
  h.setSource('# 多开对话很爽，<br>难的是它们怎么配合\n\n# 第二个<br>标题');
  h.setCursor({ line: 0, ch: 17 });
  assert.equal(h.tools.apply('insert', h.tools.capture()), false);
  assert.equal(h.transactions.length, 0);
  assert.equal(h.tools.apply('reset', h.tools.capture()), true);
  assert.equal(h.source(), '# 多开对话很爽，难的是它们怎么配合\n\n# 第二个<br>标题');
  assert.equal(h.transactions.length, 1);
});

test('右键菜单与命令面板复用同一编辑入口', () => {
  const h = harness();
  const items = [];
  const menu = { addSeparator() {}, addItem(fn) {
    const item = { setTitle(v) { this.title = v; return this; }, setIcon() { return this; },
      setDisabled(v) { this.disabled = v; return this; }, onClick(v) { this.action = v; return this; } };
    fn(item); items.push(item);
  } };
  h.events.get('editor-menu')(menu, h.editor, h.view);
  assert.deepEqual(items.map(i => i.title), ['标题内换行', '取消手动换行']);
  assert.equal(items[1].disabled, true);
  assert.equal(h.commands.length, 2);
  assert.equal(h.commands[0].editorCheckCallback(true, h.editor, h.view), true);
  items[0].action();
  assert.equal(h.transactions.length, 1);
});

test('关闭试用开关后不再允许命令或过期菜单修改文章', () => {
  const h = harness();
  const target = h.tools.capture();
  h.plugin.settings = { headingBreakToolsEnabled: false };
  assert.equal(h.tools.capture().ok, false);
  assert.equal(h.commands[0].editorCheckCallback(true, h.editor, h.view), false);
  assert.equal(h.tools.apply('insert', target), false);
  assert.equal(h.transactions.length, 0);
});

test('H1–H6 经同一工具入口插入和取消，每次一个 transaction 可撤销', () => {
  for (let level = 1; level <= 6; level += 1) {
    const h = harness();
    const heading = `${'#'.repeat(level)} 重复标题`;
    const original = `${heading}\n\n${heading}\n\n正文不动`;
    h.setSource(original);
    h.setCursor({ line: 2, ch: level + 3 });
    const target = h.tools.capture();
    assert.equal(target.context.level, level);
    assert.equal(h.tools.apply('insert', target), true);
    assert.equal(h.source(), `${heading}\n\n${'#'.repeat(level)} 重复<br>标题\n\n正文不动`);
    assert.equal(h.transactions.length, 1);
    assert.equal(h.transactions[0].tx.changes.length, 1);
    assert.equal(h.transactions[0].tx.changes[0].from.line, 2);
    h.undo();
    assert.equal(h.source(), original);
    const withBreak = `${heading}\n\n${'#'.repeat(level)} 重复<br>标题\n\n正文不动`;
    h.setSource(withBreak);
    h.setCursor({ line: 2, ch: level + 4 });
    assert.equal(h.tools.apply('reset', h.tools.capture()), true);
    assert.equal(h.source(), original);
    assert.equal(h.transactions.length, 2);
    assert.equal(h.transactions[1].tx.changes.length, 1);
    h.undo();
    assert.equal(h.source(), withBreak);
  }
});

test('普通 H2 不继承 H1 图片规则或两个断点上限，允许第五处手动换行', () => {
  const h = harness();
  h.setSource('## 甲<br>乙<br>丙<br>丁<br>戊己');
  h.setCursor({ line: 0, ch: h.source().indexOf('己') });
  const target = h.tools.capture();
  assert.equal(target.context.level, 2);
  assert.equal(target.maxLines, undefined);
  assert.equal(target.maxBreaks, undefined);
  assert.equal(h.tools.apply('insert', target), true);
  assert.equal((h.source().match(/<br>/g) ?? []).length, 5);
});

test('没有图片规则的 H1 也按普通活字处理，不默认套三行或两个断点限制', () => {
  const h = harness();
  h.preview.lastRender.exportTitleTheme.headingImages = [];
  h.setSource('# 甲<br>乙<br>丙<br>丁<br>戊己');
  h.setCursor({ line: 0, ch: h.source().indexOf('己') });
  const target = h.tools.capture();
  assert.equal(target.maxLines, undefined);
  assert.equal(target.maxBreaks, undefined);
  assert.equal(h.tools.apply('insert', target), true);
  assert.equal((h.source().match(/<br>/g) ?? []).length, 5);
});

test('H2 匹配自身图片规则的 maxLines，且仍受图片渲染器最多两处断点保护', () => {
  const h = harness();
  h.preview.lastRender.exportTitleTheme.headingImages = [
    { headingLevels: [1], maxLines: 1 },
    { headingLevels: [2, 3], maxLines: 5 },
  ];
  h.setSource('## 甲<br>乙丙丁');
  h.setCursor({ line: 0, ch: h.source().indexOf('丙') });
  const target = h.tools.capture();
  assert.equal(target.maxLines, 5);
  assert.equal(target.maxBreaks, 2);
  assert.equal(h.tools.apply('insert', target), true);
  h.setCursor({ line: 0, ch: h.source().indexOf('丁') });
  assert.equal(h.tools.apply('insert', h.tools.capture()), false);
  assert.match(h.notices.at(-1), /最多支持 2 处/);
  assert.equal(h.transactions.length, 1);
  h.preview.lastRender.exportTitleTheme.headingImages[1].maxLines = 1;
  h.setSource('## 二级标题');
  h.setCursor({ line: 0, ch: 5 });
  assert.equal(h.tools.apply('insert', h.tools.capture()), false);
  assert.match(h.notices.at(-1), /只允许单行/);
});

test('六级标题可用命令与右键菜单，嵌套标题和 Setext 均不开放操作', () => {
  const h = harness();
  h.setSource('###### 六级标题');
  h.setCursor({ line: 0, ch: 9 });
  assert.equal(h.commands[0].editorCheckCallback(true, h.editor, h.view), true);
  const titles = [];
  const menu = { addSeparator() {}, addItem(fn) {
    const item = { setTitle(value) { titles.push(value); return this; }, setIcon() { return this; },
      setDisabled() { return this; }, onClick() { return this; } };
    fn(item);
  } };
  h.events.get('editor-menu')(menu, h.editor, h.view);
  assert.deepEqual(titles, ['标题内换行', '取消手动换行']);
  for (const [source, line, ch] of [
    ['> ### 引用标题', 0, 7], ['- 项目\n  #### 列表标题', 1, 9],
    ['```md\n###### 代码标题\n```', 1, 9], ['Setext标题\n-------', 0, 3],
  ]) {
    h.setSource(source); h.setCursor({ line, ch });
    assert.equal(h.commands[0].editorCheckCallback(true, h.editor, h.view), false);
  }
});
