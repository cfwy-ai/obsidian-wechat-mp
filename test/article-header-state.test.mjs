import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const artifact = await build({
  entryPoints: [fileURLToPath(new URL('../plugin/article-header-state.mjs', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['obsidian', 'electron'],
});

const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// JSON is valid YAML. The mock owns parsing/serialization; these tests exercise
// the state layer's use of Obsidian's frontmatter API, not a second YAML parser.
const serialize = (data, body) => `---\n${JSON.stringify(data, null, 2)}\n---\n${body}`;
const parseStoredDocument = source => {
  const opening = /^---\r?\n/.exec(source);
  if (!opening) return { data: {}, body: source };
  const delimiters = /^---[ \t]*\r?$/gm;
  delimiters.lastIndex = opening[0].length;
  const closing = delimiters.exec(source);
  if (!closing) throw new Error('Mock storage received unclosed frontmatter');
  const end = closing.index + closing[0].length;
  return {
    data: JSON.parse(source.slice(opening[0].length, closing.index).trim() || '{}'),
    body: source.slice(end + (source[end] === '\n' ? 1 : 0)),
  };
};
const png = (width = 1200, height = 400, byteLength = 24) => {
  const bytes = new Uint8Array(byteLength);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};
const jpeg = (width = 1200, height = 400) => {
  const bytes = new Uint8Array([255, 216, 255, 192, 0, 7, 8, 0, 0, 0, 0, 255, 217]);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
};
const inputFile = (bytes = png(), name = '我的头图.png') => ({
  name,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

const harness = (initial = {}) => {
  class TFile { constructor(path) { this.path = path; } }
  const events = [];
  const hooks = {};
  const parsedYaml = [];
  const binaries = new Map();
  let data = structuredClone(initial.data ?? { title: '文章标题', tags: ['写作'] });
  let body = initial.body ?? '\n# 正文标题\n\n正文的 ==高亮==、代码 `<br>` 和图片 ![[正文.png]] 保持原样。\n';
  let diskSource = initial.source ?? serialize(data, body);
  if (initial.source !== undefined) ({ data, body } = parseStoredDocument(diskSource));
  let editorSource = diskSource;
  const undo = [];
  const transactions = [];
  let decodeEmpty = false;
  let yamlParser = value => value.trim() ? JSON.parse(value) : null;
  const module = { exports: {} };
  vm.runInNewContext(artifact.outputFiles[0].text, {
    module, exports: module.exports, Buffer, Uint8Array, ArrayBuffer, DataView, TextDecoder,
    require: name => {
      if (name === 'obsidian') return {
        TFile, parseYaml: yaml => { parsedYaml.push(yaml); return yamlParser(yaml); },
        stringifyYaml: value => `${JSON.stringify(value, null, 2)}\n`,
      };
      if (name === 'electron') return { nativeImage: {
        createFromBuffer(bytes) {
          events.push({ type: 'decode', bytes: Buffer.from(bytes) });
          return { isEmpty: () => decodeEmpty };
        },
      } };
      throw new Error(`Unexpected external module: ${name}`);
    },
  });
  const article = new TFile('文章/当前文章.md');
  let current = article;
  let abstractFile = article;
  let selectedTheme = '主题/简笔手绘/manifest.json';
  const context = {
    article, articlePath: article.path, themeId: 'simple-sketch', themePath: selectedTheme,
  };
  const sourceView = {
    file: article,
    getMode: () => 'source',
    editor: {
      getValue: () => editorSource,
      offsetToPos(offset) {
        hooks.offsetToPos?.();
        const prefix = editorSource.slice(0, offset).split('\n');
        return { line: prefix.length - 1, ch: prefix.at(-1).length };
      },
      transaction(transaction, origin) {
        assert.equal(transaction.changes.length, 1);
        const change = transaction.changes[0];
        const offset = position => {
          const lines = editorSource.split('\n');
          return lines.slice(0, position.line).reduce((length, line) => length + line.length + 1, 0) + position.ch;
        };
        const from = offset(change.from), to = offset(change.to);
        transactions.push({ transaction: plain(transaction), origin, from, to });
        undo.push(editorSource);
        editorSource = editorSource.slice(0, from) + change.text + editorSource.slice(to);
        events.push({ type: 'transaction' });
      },
    },
    async save() {
      events.push({ type: 'source-save' });
      await hooks.sourceSave?.();
      diskSource = editorSource;
      ({ data, body } = parseStoredDocument(diskSource));
      events.push({ type: 'write' });
    },
  };
  const view = {
    closed: false, headerSaving: false, headerUploading: false,
    headerContext: { themeId: context.themeId },
    getSelectedThemePath: () => selectedTheme,
    updateActionButtons() {
      events.push({ type: 'buttons', saving: this.headerSaving, uploading: this.headerUploading });
    },
    headerControls: { update() { events.push({ type: 'controls' }); } },
    async refresh(request) { events.push({ type: 'refresh', request: plain(request) }); await hooks.refresh?.(); },
    plugin: {
      getCurrentDocument: () => current,
      getCurrentSourceLeaf: () => ({ view: sourceView }),
    },
    app: {
      vault: {
        getAbstractFileByPath: path => path === article.path ? abstractFile : null,
        async cachedRead(file) {
          assert.equal(file, article);
          events.push({ type: 'read' });
          await hooks.read?.();
          return diskSource;
        },
        async createBinary(path, bytes) {
          events.push({ type: 'create', path });
          await hooks.create?.();
          binaries.set(path, Buffer.from(bytes));
          return new TFile(path);
        },
      },
      fileManager: {
        async processFrontMatter(file, mutate) {
          assert.equal(file, article);
          events.push({ type: 'frontmatter' });
          await hooks.frontmatter?.();
          const next = structuredClone(data);
          mutate(next);
          data = plain(next);
          diskSource = serialize(data, body);
          events.push({ type: 'write' });
        },
        async getAvailablePathForAttachment(filename, sourcePath) {
          events.push({ type: 'attachment-path', filename, sourcePath });
          await hooks.attachmentPath?.();
          return `附件/${filename}`;
        },
      },
    },
  };
  return {
    api: module.exports, view, context, article, sourceView, TFile, events, hooks, binaries, parsedYaml, transactions,
    data: () => structuredClone(data), body: () => body,
    diskText: () => diskSource, editorText: () => editorSource,
    setEditorText: value => { editorSource = value; },
    undo() { assert.ok(undo.length); editorSource = undo.pop(); },
    setBody: value => { body = value; diskSource = serialize(data, body); },
    setData: value => { data = structuredClone(value); diskSource = serialize(data, body); },
    setCurrent: value => { current = value; }, setAbstractFile: value => { abstractFile = value; },
    setTheme: value => { selectedTheme = value; }, setDecodeEmpty: value => { decodeEmpty = value; },
    setYamlParser: value => { yamlParser = value; },
  };
};

test('头图设置读取只解析开头 YAML 并选择当前主题，不把正文分割线当属性', () => {
  const h = harness();
  const data = { title: '原题', wechat_headers: {
    'simple-sketch': { enabled: false, preset: 'research' },
    'cobalt-orbit': { enabled: true, preset: 'orbit' },
  } };
  const result = h.api.readArticleHeaderSelection(serialize(data, '\n正文\n---\n正文后续'), 'simple-sketch');
  assert.deepEqual(plain(result), { selection: data.wechat_headers['simple-sketch'], warnings: [] });
  assert.equal(h.parsedYaml.length, 1);
  assert.deepEqual(JSON.parse(h.parsedYaml[0]), data);
  for (const source of ['正文\n---\nwechat_headers: {}', serialize({ title: '标题' }, '正文')]) {
    const empty = h.api.readArticleHeaderSelection(source, 'simple-sketch');
    assert.equal(empty.selection, undefined);
    assert.equal(empty.warnings.length, 0);
  }
  assert.equal(h.api.readArticleHeaderSelection(serialize(data, '正文'), 'missing-theme').selection, undefined);
});

test('坏 YAML 与非对象 wechat_headers 返回默认头图提示，不修改文章', () => {
  const h = harness();
  for (const value of [null, [], '默认', true, 42]) {
    const result = h.api.readArticleHeaderSelection(serialize({ wechat_headers: value }, '正文'), 'simple-sketch');
    assert.equal(result.selection, undefined);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /默认头图/);
    assert.ok(result.error);
  }
  h.setYamlParser(() => { throw new Error('invalid YAML'); });
  const result = h.api.readArticleHeaderSelection('---\ninvalid: [\n---\n正文', 'simple-sketch');
  assert.match(result.error.message, /invalid YAML/);
  assert.equal(h.events.length, 0);
});

test('保存当前主题头图保留其他 YAML 字段、其他主题和完整正文，保存编辑器新文本后刷新', async () => {
  const initial = { title: '原题', tags: ['写作', 'AI'], nested: { keep: 1 }, wechat_headers: {
    'simple-sketch': { preset: 'old' }, 'cobalt-orbit': { enabled: false, preset: 'orbit' },
  } };
  const h = harness({ data: initial });
  const body = h.body();
  const selection = { enabled: false, preset: 'research', unrelated: '不写入' };
  await h.api.saveArticleHeaderSelection(h.view, selection, h.context);
  assert.deepEqual(h.data(), { ...initial, wechat_headers: {
    'simple-sketch': { enabled: false, preset: 'research' }, 'cobalt-orbit': initial.wechat_headers['cobalt-orbit'],
  } });
  assert.equal(h.body(), body);
  assert.deepEqual(selection, { enabled: false, preset: 'research', unrelated: '不写入' });
  assert.deepEqual(h.events.filter(e => ['source-save', 'write', 'read', 'refresh'].includes(e.type)).map(e => e.type),
    ['source-save', 'write', 'read', 'refresh']);
  assert.deepEqual(h.events.find(e => e.type === 'refresh').request,
    { articlePath: h.article.path, articleSource: serialize(h.data(), body) });
  assert.equal(h.view.headerSaving, false);
  assert.equal(h.events.at(-1).type, 'controls');
});

test('编辑模式读取最新未保存内容，只用一次 transaction 替换 frontmatter 前缀', async () => {
  const h = harness();
  const latestBody = '\n\n# 最新未保存标题\n\n保留  两个空格。\n\n```md\n---\n正文示例\n```\n';
  const latestData = { title: '刚编辑的新题', tags: ['新标签'], extra: { kept: true } };
  const latestSource = serialize(latestData, latestBody);
  h.setEditorText(latestSource);
  await h.api.saveArticleHeaderSelection(h.view, { preset: 'research' }, h.context);
  assert.equal(h.transactions.length, 1);
  const tx = h.transactions[0];
  assert.equal(tx.origin, 'wechat-article-header');
  assert.equal(tx.from, 0);
  assert.equal(tx.to, latestSource.length - latestBody.length);
  assert.equal(h.editorText().slice(tx.transaction.changes[0].text.length), latestBody);
  assert.equal(h.body(), latestBody);
  assert.deepEqual(h.data(), { ...latestData, wechat_headers: { 'simple-sketch': { enabled: true, preset: 'research' } } });
  assert.equal(h.events.some(e => e.type === 'frontmatter'), false);
  assert.deepEqual(h.events.filter(e => ['transaction', 'source-save', 'write', 'read', 'refresh'].includes(e.type)).map(e => e.type),
    ['transaction', 'source-save', 'write', 'read', 'refresh']);
});

test('编辑模式选图后切回阅读模式再自动保存，不会把所选 preset 覆盖成旧值', async () => {
  const h = harness({ data: { title: '原题', wechat_headers: { 'simple-sketch': { preset: 'old' } } } });
  await h.api.saveArticleHeaderSelection(h.view, { preset: 'research' }, h.context);
  const selected = h.diskText();
  assert.equal(h.editorText(), selected);
  h.sourceView.getMode = () => 'preview';
  // Simulate MarkdownView flushing its editor as it leaves source mode.
  await h.sourceView.save();
  assert.equal(h.diskText(), selected);
  assert.equal(h.data().wechat_headers['simple-sketch'].preset, 'research');
});

test('一次头图操作只产生一个可撤销编辑，撤销并保存可恢复完整原文', async () => {
  const h = harness({ data: { title: '原题', wechat_headers: { 'simple-sketch': { enabled: false } } } });
  const original = h.editorText();
  await h.api.saveArticleHeaderSelection(h.view, { preset: 'research' }, h.context);
  assert.equal(h.transactions.length, 1);
  h.undo();
  assert.equal(h.editorText(), original);
  await h.sourceView.save();
  assert.equal(h.diskText(), original);
  assert.deepEqual(h.data().wechat_headers['simple-sketch'], { enabled: false });
});

test('无 frontmatter 时前插属性，空属性和 CRLF 属性都保留正文后缀字节', async () => {
  const plainBody = '# 正文标题\n\n正文从首字开始，末尾空格保留。  \n';
  const cases = [
    { source: plainBody, body: plainBody, prefixLength: 0 },
    { source: `---\n---\n${plainBody}`, body: plainBody, prefixLength: 8 },
    { source: `---\r\n{"title":"保留"}\r\n---\r\n\r\n# 标题\r\n\r\n正文末尾  \r\n`, body: '\r\n# 标题\r\n\r\n正文末尾  \r\n' },
  ];
  for (const fixture of cases) {
    const h = harness({ source: fixture.source });
    await h.api.saveArticleHeaderSelection(h.view, { preset: 'research' }, h.context);
    assert.equal(h.transactions.length, 1);
    assert.equal(h.transactions[0].to, fixture.prefixLength ?? fixture.source.length - fixture.body.length);
    assert.deepEqual(Buffer.from(h.body()), Buffer.from(fixture.body));
    const inserted = h.transactions[0].transaction.changes[0].text;
    assert.equal(h.editorText().slice(inserted.length), fixture.body);
    if (fixture.source.includes('\r\n')) assert.equal(inserted.replaceAll('\r\n', '').includes('\n'), false);
  }
});

test('编辑器 YAML 无法解析、未闭合或根值非对象时，既不 transaction 也不保存', async () => {
  for (const source of ['---\ninvalid: [\n---\n正文', '---\n缺少结束符\n正文', '---\n["数组"]\n---\n正文']) {
    const h = harness();
    h.setEditorText(source);
    await assert.rejects(h.api.saveArticleHeaderSelection(h.view, { preset: 'research' }, h.context), /属性/);
    assert.equal(h.transactions.length, 0);
    assert.equal(h.editorText(), source);
    assert.equal(h.events.some(e => ['source-save', 'frontmatter', 'write'].includes(e.type)), false);
    assert.equal(h.view.headerSaving, false);
  }
});

test('保存包含自定义图时优先写 custom_image，不残留旧预设，也不要求源编辑器存在', async () => {
  const h = harness();
  h.view.plugin.getCurrentSourceLeaf = () => null;
  await h.api.saveArticleHeaderSelection(h.view,
    { custom_image: '[[附件/头图.png]]', preset: 'unused' }, h.context);
  assert.deepEqual(h.data().wechat_headers['simple-sketch'], { enabled: true, custom_image: '[[附件/头图.png]]' });
  assert.equal(h.events.some(e => e.type === 'source-save'), false);
});

test('阅读模式不保存隐藏编辑器旧缓存，保留 Vault 最新正文并据此刷新', async () => {
  const h = harness();
  const latestBody = '\n# Vault 中的新正文\n\n这一段不能被阅读模式下隐藏的旧编辑器覆盖。\n';
  h.setBody(latestBody);
  h.sourceView.getMode = () => 'preview';
  h.sourceView.editor = { getValue: () => '# 隐藏编辑器的旧正文' };
  h.hooks.sourceSave = () => {
    h.setBody('\n# 隐藏编辑器的旧正文\n');
    assert.fail('阅读模式不得调用旧编辑器 save');
  };
  await h.api.saveArticleHeaderSelection(h.view, { preset: 'research' }, h.context);
  assert.equal(h.events.some(e => e.type === 'source-save'), false);
  assert.equal(h.body(), latestBody);
  assert.deepEqual(h.data().wechat_headers['simple-sketch'], { enabled: true, preset: 'research' });
  assert.deepEqual(h.events.find(e => e.type === 'refresh').request,
    { articlePath: h.article.path, articleSource: serialize(h.data(), latestBody) });
});

test('恢复默认仅移除当前主题设置，最后一个设置清除时删除空 wechat_headers', async () => {
  for (const other of [undefined, { enabled: false }]) {
    const headers = { 'simple-sketch': { enabled: true, preset: 'research' } };
    if (other) headers['cobalt-orbit'] = other;
    const h = harness({ data: { title: '保留', wechat_headers: headers } });
    const body = h.body();
    await h.api.saveArticleHeaderSelection(h.view, null, h.context);
    assert.deepEqual(h.data(), other ? { title: '保留', wechat_headers: { 'cobalt-orbit': other } } : { title: '保留' });
    assert.equal(h.body(), body);
  }
});

test('已有坏属性不能被保存覆盖，保存失败后清除锁并更新操作状态', async () => {
  const h = harness({ data: { title: '保留', wechat_headers: ['错误但不能清空'] } });
  const before = h.data();
  await assert.rejects(h.api.saveArticleHeaderSelection(h.view, { preset: 'research' }, h.context), /格式不正确/);
  assert.deepEqual(h.data(), before);
  assert.equal(h.events.some(e => e.type === 'write'), false);
  assert.equal(h.view.headerSaving, false);
  assert.equal(h.events.at(-1).type, 'controls');
});

test('文章、主题、文件身份改变或预览关闭时，过期头图操作不得写入', async () => {
  const changes = [
    h => { h.view.closed = true; },
    h => h.setCurrent(null),
    h => h.setCurrent(new h.TFile('另一篇.md')),
    h => h.setAbstractFile(null),
    h => h.setAbstractFile(new h.TFile(h.article.path)),
    h => h.setAbstractFile({ path: h.article.path }),
    h => h.setTheme('主题/另一主题/manifest.json'),
    h => { h.view.headerContext.themeId = 'cobalt-orbit'; },
  ];
  for (const change of changes) {
    const h = harness();
    assert.equal(h.api.assertHeaderContext(h.view, h.context), h.article);
    change(h);
    await assert.rejects(h.api.saveArticleHeaderSelection(h.view, { preset: 'research' }, h.context), /已切换/);
    await assert.rejects(h.api.uploadArticleHeader(h.view, inputFile(), h.context), /已切换/);
    assert.equal(h.events.length, 0);
    assert.equal(h.binaries.size, 0);
  }
});

test('提交编辑器 transaction 和进入 FrontMatter 回调前都会再次核对文章与主题', async () => {
  for (const phase of ['offsetToPos', 'frontmatter']) {
    const h = harness();
    if (phase === 'frontmatter') h.sourceView.getMode = () => 'preview';
    h.hooks[phase] = () => h.setTheme('已切换/manifest.json');
    await assert.rejects(h.api.saveArticleHeaderSelection(h.view, { preset: 'research' }, h.context), /已切换/);
    assert.equal(h.events.some(e => e.type === 'write'), false);
    assert.equal(h.view.headerSaving, false);
  }
});

test('提交前再次核验编辑器引用、文件身份、模式和原文版本', async () => {
  const changes = [
    h => { h.sourceView.editor = { ...h.sourceView.editor }; },
    h => { h.sourceView.file = new h.TFile(h.article.path); },
    h => { h.sourceView.getMode = () => 'preview'; },
    h => { h.view.plugin.getCurrentSourceLeaf = () => ({ view: { ...h.sourceView } }); },
    h => h.setEditorText(`${h.editorText()}\n刚输入的新正文`),
  ];
  for (const change of changes) {
    const h = harness();
    h.hooks.offsetToPos = () => change(h);
    await assert.rejects(h.api.saveArticleHeaderSelection(h.view, { preset: 'research' }, h.context), /已切换|已变化/);
    assert.equal(h.transactions.length, 0);
    assert.equal(h.events.some(e => e.type === 'write'), false);
  }
});

test('阅读模式的 FrontMatter 写回前若已切进编辑模式，拒绝磁盘单独写回', async () => {
  const h = harness();
  h.sourceView.getMode = () => 'preview';
  h.hooks.frontmatter = () => { h.sourceView.getMode = () => 'source'; };
  await assert.rejects(h.api.saveArticleHeaderSelection(h.view, { preset: 'research' }, h.context), /编辑模式已切换/);
  assert.equal(h.events.some(e => e.type === 'write'), false);
  assert.equal(h.transactions.length, 0);
});

test('编辑器已提交后保存期间切换文章，目标文章保留新值且不刷新新上下文', async () => {
  const h = harness();
  h.hooks.sourceSave = () => h.setCurrent(new h.TFile('新文章.md'));
  await assert.rejects(h.api.saveArticleHeaderSelection(h.view, { preset: 'research' }, h.context), /已切换/);
  assert.equal(h.transactions.length, 1);
  assert.equal(h.data().wechat_headers['simple-sketch'].preset, 'research');
  assert.equal(h.events.some(e => e.type === 'refresh'), false);
  assert.equal(h.view.headerSaving, false);
});

test('保存锁阻止第二次保存和上传，异步失败后锁恢复', async () => {
  const h = harness();
  const gate = deferred();
  h.hooks.sourceSave = () => gate.promise;
  const first = h.api.saveArticleHeaderSelection(h.view, { preset: 'first' }, h.context);
  assert.equal(h.view.headerSaving, true);
  await assert.rejects(h.api.saveArticleHeaderSelection(h.view, { preset: 'second' }, h.context), /正在保存/);
  await assert.rejects(h.api.uploadArticleHeader(h.view, inputFile(), h.context), /正在保存/);
  gate.reject(new Error('编辑器保存失败'));
  await assert.rejects(first, /编辑器保存失败/);
  assert.equal(h.view.headerSaving, false);
  assert.equal(h.events.some(e => e.type === 'write'), false);
  assert.equal(h.binaries.size, 0);
});

test('上传验证支持 PNG/JPEG 大小写扩展名并按真实内容返回扩展名', () => {
  const h = harness();
  assert.deepEqual(plain(h.api.validateHeaderUpload(png(), '图.PNG')), { width: 1200, height: 400, extension: 'png' });
  assert.deepEqual(plain(h.api.validateHeaderUpload(jpeg(900, 300), '图.JPEG')), { width: 900, height: 300, extension: 'jpg' });
  assert.equal(h.api.validateHeaderUpload(jpeg(), '误命名.png').extension, 'jpg');
  assert.equal(h.api.validateHeaderUpload(png(8000, 5000), '边界.png').width, 8000);
});

test('上传验证拒绝不支持类型、伪造内容、超字节上限、无效尺寸及超像素上限', () => {
  const h = harness();
  for (const name of ['a.gif', 'a.webp', 'a.svg', 'a.png.exe', '没有扩展名']) {
    assert.throws(() => h.api.validateHeaderUpload(png(), name), /PNG 或 JPG/);
  }
  assert.throws(() => h.api.validateHeaderUpload(new Uint8Array(30), '假图.png'), /内容不是/);
  assert.throws(() => h.api.validateHeaderUpload(new Uint8Array([137, 80, 78, 71]), '不完整.png'), /尺寸无法读取/);
  assert.throws(() => h.api.validateHeaderUpload(png(0, 100), '零宽.png'), /尺寸无法读取/);
  assert.throws(() => h.api.validateHeaderUpload(png(8000, 5001), '超像素.png'), /4000 万/);
  assert.throws(() => h.api.validateHeaderUpload(png(1200, 400, 24 * 1024 * 1024 + 1), '大图.png'), /24 MiB/);
});

test('成功上传保存到 Vault 附件目录并只写该附件的 wikilink', async () => {
  const h = harness();
  const bytes = jpeg(1500, 500);
  const created = await h.api.uploadArticleHeader(h.view, inputFile(bytes, '我的:新#头[图].PNG'), h.context);
  assert.equal(created.path, '附件/头图-我的-新-头-图-.jpg');
  assert.deepEqual(h.binaries.get(created.path), Buffer.from(bytes));
  assert.deepEqual(h.data().wechat_headers['simple-sketch'], { enabled: true, custom_image: `[[${created.path}]]` });
  assert.deepEqual(h.events.find(e => e.type === 'attachment-path'), {
    type: 'attachment-path', filename: '头图-我的-新-头-图-.jpg', sourcePath: h.article.path,
  });
  assert.equal(h.events.filter(e => e.type === 'decode').length, 1);
  assert.equal(h.view.headerUploading, false);
  assert.equal(h.view.headerSaving, false);
  assert.equal(h.events.at(-1).type, 'buttons');
});

test('有图片头但原生解码失败时，既不新建附件也不修改文章属性', async () => {
  const h = harness();
  h.setDecodeEmpty(true);
  const before = h.data();
  await assert.rejects(h.api.uploadArticleHeader(h.view, inputFile(png()), h.context), /无法解码/);
  assert.equal(h.events.filter(e => e.type === 'decode').length, 1);
  assert.equal(h.events.some(e => ['attachment-path', 'create', 'frontmatter', 'write'].includes(e.type)), false);
  assert.deepEqual(h.data(), before);
  assert.equal(h.view.headerUploading, false);
});

test('上传锁阻止重复选择，读取失败会释放上传锁', async () => {
  const h = harness();
  const gate = deferred();
  const first = h.api.uploadArticleHeader(h.view, { name: '图.png', arrayBuffer: () => gate.promise }, h.context);
  assert.equal(h.view.headerUploading, true);
  await assert.rejects(h.api.uploadArticleHeader(h.view, inputFile(), h.context), /正在保存/);
  gate.reject(new Error('文件读取失败'));
  await assert.rejects(first, /文件读取失败/);
  assert.equal(h.view.headerUploading, false);
  assert.equal(h.binaries.size, 0);
});

test('上传期间公开保存与伪造 owner 均被拒绝，上传内部仍可完成附件引用保存', async () => {
  const h = harness();
  const gate = deferred();
  const uploading = h.api.uploadArticleHeader(h.view,
    { name: '图.png', arrayBuffer: () => gate.promise }, h.context);
  assert.equal(h.view.headerUploading, true);
  await assert.rejects(h.api.saveArticleHeaderSelection(h.view, { preset: '不能插队' }, h.context), /正在保存/);
  await assert.rejects(h.api.saveArticleHeaderSelection(h.view, { preset: '不能插队' }, h.context,
    Symbol('article-header-upload')), /正在保存/);
  assert.equal(h.events.some(e => e.type === 'write'), false);
  gate.resolve(png().buffer);
  const created = await uploading;
  assert.deepEqual(h.data().wechat_headers['simple-sketch'],
    { enabled: true, custom_image: `[[${created.path}]]` });
  assert.equal(h.events.filter(e => e.type === 'write').length, 1);
  assert.equal(h.view.headerSaving, false);
  assert.equal(h.view.headerUploading, false);
});

test('上传在读取后或附件路径解析后切换上下文，不创建附件也不写属性', async () => {
  for (const phase of ['read', 'attachmentPath']) {
    const h = harness();
    let input = inputFile();
    if (phase === 'read') input = { ...input, async arrayBuffer() {
      h.setCurrent(new h.TFile('另一篇.md'));
      return png().buffer;
    } };
    else h.hooks.attachmentPath = () => { h.view.closed = true; };
    await assert.rejects(h.api.uploadArticleHeader(h.view, input, h.context), /已切换/);
    assert.equal(h.binaries.size, 0);
    assert.equal(h.events.some(e => e.type === 'write'), false);
    assert.equal(h.view.headerUploading, false);
  }
});

test('附件成功导入后若主题切换，保留可恢复图片并说明路径，不改文章设置', async () => {
  const h = harness();
  h.hooks.create = () => h.setTheme('另一主题/manifest.json');
  await assert.rejects(h.api.uploadArticleHeader(h.view, inputFile(), h.context), /已切换.*图片已保存在 附件\/头图-我的头图\.png/);
  assert.equal(h.binaries.size, 1);
  assert.equal(h.events.some(e => e.type === 'write'), false);
  assert.equal(h.view.headerUploading, false);
});

test('附件路径或写入失败会释放上传锁，不产生文章头图引用', async () => {
  for (const phase of ['attachmentPath', 'create']) {
    const h = harness();
    h.hooks[phase] = () => { throw new Error('附件写入失败'); };
    await assert.rejects(h.api.uploadArticleHeader(h.view, inputFile(), h.context), /附件写入失败/);
    assert.equal(h.binaries.size, 0);
    assert.equal(h.events.some(e => e.type === 'write'), false);
    assert.equal(h.view.headerUploading, false);
  }
});
