import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'htmlparser2';
import { Marked } from 'marked';
import { renderMarkdown } from '../src/markdown.mjs';
import { renderArticle } from '../src/pipeline.mjs';
import { copyRenderedArticle } from '../plugin/copy.mjs';

const hasClass = (node, name) => (node.attribs?.class ?? '').split(/\s+/).includes(name);
const elements = node => (node.children ?? []).filter(child => child.type === 'tag');
const walk = node => [node, ...(node.children ?? []).flatMap(walk)];
const find = (root, predicate) => walk(root).filter(predicate);
const tags = (root, name) => find(root, node => node.type === 'tag' && node.name === name);
const text = node => node.type === 'text' ? node.data : (node.children ?? []).map(text).join('');
const withoutMarkerText = node => hasClass(node, 'wechat-task-marker') ? ''
  : node.type === 'text' ? node.data : (node.children ?? []).map(withoutMarkerText).join('');
const styles = node => Object.fromEntries((node.attribs?.style ?? '').split(';').filter(Boolean).map(value => {
  const split = value.indexOf(':');
  return [value.slice(0, split).trim(), value.slice(split + 1).trim()];
}));
const documentFor = source => parseDocument(renderMarkdown(source));
const tasks = root => find(root, node => hasClass(node, 'wechat-task-item'));
const markers = root => find(root, node => hasClass(node, 'wechat-task-marker'));
const firstTaskLine = item => {
  const firstChild = elements(item)[0];
  // Nested-list compatibility adds a row, but the task marker and its text
  // must still occupy the same original paragraph inside that row.
  const adapted = Object.hasOwn(item.attribs ?? {}, 'data-wechat-list-item');
  if (adapted) {
    assert.equal(firstChild?.name, 'section');
    assert.equal(firstChild.attribs['data-wechat-list-row'], 'head');
    assert.equal(firstChild.attribs['data-wechat-list-depth'], item.attribs['data-wechat-list-depth']);
  }
  const first = adapted ? elements(firstChild)[0] : firstChild;
  assert.equal(first?.name, 'p', '任务首行必须是明确的段落');
  assert.equal(hasClass(first, 'wechat-task-line'), true);
  assert.equal(markers(first).length, 1);
  assert.equal(elements(first)[0], markers(first)[0], 'marker 与文字必须共用首段，且 marker 在文字前');
  return first;
};

test('紧凑任务的完成和未完成标记与正文共用一个明确首段', () => {
  const root = documentFor('- [ ] 未完成\n- [x] 已完成\n- [X] 大写完成');
  const items = tasks(root);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(item => withoutMarkerText(firstTaskLine(item))), ['未完成', '已完成', '大写完成']);
  assert.deepEqual(markers(root).map(node => text(node)), ['☐', '✓', '✓']);
  assert.deepEqual(markers(root).map(node => node.attribs['aria-label']), ['未完成', '已完成', '已完成']);
  assert.equal(tags(root, 'input').length, 0);
});

test('松散任务仅首段包入 task-line，后续段落与嵌套列表保持兄弟结构', () => {
  const root = documentFor('- [ ] 第一段 **重点**\n\n  第二段说明\n\n  - 普通子项\n  - [x] 子任务\n\n- [x] 下一项');
  const first = tasks(root)[0];
  assert.equal(withoutMarkerText(firstTaskLine(first)), '第一段 重点');
  const children = elements(first);
  assert.deepEqual(children.map(node => node.name), ['p', 'p', 'ul']);
  assert.equal(text(children[1]), '第二段说明');
  assert.equal(hasClass(children[1], 'wechat-task-line'), false);
  assert.equal(markers(children[1]).length, 0);
  assert.equal(tasks(root).length, 3);
  assert.equal(markers(root).length, 3);
  assert.equal(tags(firstTaskLine(first), 'ul').length, 0);
});

test('多层紧凑任务保留层级，每层各有一枚标记且不把子列表塞入首段', () => {
  const root = documentFor('- [ ] 父任务\n  - [x] 子任务\n    - [ ] 孙任务\n  - 普通子项\n- 普通同级项');
  const items = tasks(root);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(item => withoutMarkerText(firstTaskLine(item))), ['父任务', '子任务', '孙任务']);
  for (const item of items) assert.equal(tags(firstTaskLine(item), 'li').length, 0);
  assert.equal(tags(root, 'ul').length, 3);
  assert.ok(tags(root, 'li').some(item => !hasClass(item, 'wechat-task-item') && text(item) === '普通同级项'));
});

test('有序任务保留起始编号与普通混合项，普通列表输出不变', () => {
  const root = documentFor('3. [ ] 第三项\n4. 普通步骤\n5. [x] 第五项\n   - [ ] 嵌套任务');
  assert.equal(tags(root, 'ol')[0].attribs.start, '3');
  assert.equal(tasks(root).length, 3);
  assert.equal(text(elements(tags(root, 'ol')[0])[1]), '普通步骤');
  for (const item of tasks(root)) firstTaskLine(item);
  const ordinary = '- 普通甲\n  - 普通子项\n- 普通乙\n\n2. 第二步\n3. 第三步';
  assert.equal(renderMarkdown(ordinary), `<section id="nice">${new Marked({ gfm: true }).parse(ordinary).trim()}</section>`);
});

test('任务首段保留 strong、行内代码、Obsidian 高亮和链接 token', () => {
  const root = documentFor('- [ ] **重点**、`a==b`、==高亮==、[详情](https://example.test/path)');
  const line = firstTaskLine(tasks(root)[0]);
  assert.equal(text(tags(line, 'strong')[0]), '重点');
  assert.equal(text(tags(line, 'code')[0]), 'a==b');
  assert.equal(text(tags(line, 'mark')[0]), '高亮');
  assert.equal(tags(line, 'a')[0].attribs.href, 'https://example.test/path');
  assert.equal(markers(root).length, 1);
  assert.equal(withoutMarkerText(line), '重点、a==b、高亮、详情');
});

test('松散任务首段同样保留行内格式和引用式链接解析', () => {
  const root = documentFor('- [ ] **首段** ==高亮== [参考][ref]\n\n  后续段落\n\n- [x] 完成\n\n[ref]: https://example.test/ref');
  const line = firstTaskLine(tasks(root)[0]);
  assert.equal(text(tags(line, 'strong')[0]), '首段');
  assert.equal(text(tags(line, 'mark')[0]), '高亮');
  assert.equal(tags(line, 'a')[0].attribs.href, 'https://example.test/ref');
  assert.equal(text(elements(tasks(root)[0])[1]), '后续段落');
});

test('显式 br 与 Markdown 双空格换行留在同一个任务首段', () => {
  for (const source of ['- [ ] 第一行<br>第二行', '- [ ] 第一行  \n  第二行']) {
    const root = documentFor(source);
    const line = firstTaskLine(tasks(root)[0]);
    assert.equal(tags(line, 'br').length, 1);
    assert.match(withoutMarkerText(line), /第一行\s*第二行/);
    assert.equal(markers(root).length, 1);
  }
});

test('任务内代码围栏保持独立块，代码中的伪待办不生成任务标记', () => {
  const source = '- [ ] 真任务\n\n  ```text\n  - [x] 围栏里的伪任务\n  ==代码高亮字面量==\n  ```\n\n- [x] 第二个真任务';
  const root = documentFor(source);
  assert.equal(tasks(root).length, 2);
  const first = tasks(root)[0];
  assert.deepEqual(elements(first).map(node => node.name), ['p', 'pre']);
  assert.equal(withoutMarkerText(firstTaskLine(first)), '真任务');
  const pre = tags(first, 'pre')[0];
  assert.match(text(pre), /- \[x\] 围栏里的伪任务/);
  assert.match(text(pre), /==代码高亮字面量==/);
  assert.equal(markers(pre).length, 0);
  assert.equal(tags(pre, 'mark').length, 0);
});

test('围栏、行内代码、转义与普通方括号文本不误识别为任务', () => {
  const root = documentFor('```text\n- [ ] 围栏伪任务\n```\n\n`- [x] 行内伪任务`\n\n\\- [x] 转义伪任务\n\n- [ ]\n- [a] 普通方括号\n\n- [x] 唯一真任务');
  assert.equal(tasks(root).length, 1);
  assert.equal(markers(root).length, 1);
  assert.equal(withoutMarkerText(firstTaskLine(tasks(root)[0])), '唯一真任务');
  assert.match(text(root), /围栏伪任务/);
  assert.match(text(root), /行内伪任务/);
  assert.match(text(root), /转义伪任务/);
  assert.match(text(root), /\[a\] 普通方括号/);
});

// A portable copy-path fixture matching the simple-sketch marker design.
// Live-theme verification is separate; tests must not depend on a user's Vault.
const taskTheme = `
#nice p { margin: 20px 0; padding: 7px; color: #37352F; }
#nice li.wechat-task-item { padding-left:24px; text-indent:-24px; }
#nice li.wechat-task-item > p { text-indent:0; }
#nice li.wechat-task-item > p:first-child { text-indent:-24px; }
#nice li.wechat-task-item > p > .wechat-task-marker {
 display:inline; padding:0 1.5px; margin:0 8px 0 0;
 border:1.5px solid #1A1A19; border-radius:3px 2px 4px 1px;
 color:#1A1A19; font-family:Arial,sans-serif; font-size:14px;
 font-weight:700; line-height:14px; vertical-align:baseline;
}
#nice li.wechat-task-item.is-unchecked > p > .wechat-task-marker { color:transparent; }
#nice li.wechat-task-item.is-checked > p > .wechat-task-marker {
 background-image:url("theme-asset://task-brush"); background-repeat:no-repeat;
 background-position:center center; background-size:100% 100%;
}`;

test('共用首段基础样式覆盖普通 p 外边距，主题 marker 保持 inline 无固定宽高', () => {
  const result = renderArticle({ source: '- [ ] 未办\n- [x] 已办', themeCss: taskTheme,
    themeAssets: [{ id: 'task-brush', url: 'file:///fixture/task-brush.png', filePath: 'fixture/task-brush.png' }], resolve: () => null });
  const root = parseDocument(result.html);
  for (const item of tasks(root)) {
    const line = firstTaskLine(item);
    assert.equal(styles(line).margin, '0');
    assert.equal(styles(line).padding, '0');
    assert.equal(styles(line)['text-indent'], '-24px');
    const marker = markers(line)[0];
    assert.equal(styles(marker).display, 'inline');
    assert.equal(styles(marker).padding, '0 1.5px');
    assert.equal(styles(marker).width, undefined);
    assert.equal(styles(marker).height, undefined);
  }
  assert.equal(result.compatibility.removedStyleCount, 0);
  assert.deepEqual(result.warnings, []);
});

test('生产复制路径保留任务同段、主题 inline 标记样式与微信笔刷地址，使用内存剪贴板', async () => {
  const source = '- [ ] **未完成** 与 `行内代码`\n\n  第二段仍独立。\n\n- [x] ==已完成==<br>明确换行\n  - [ ] 子任务';
  const wechatUrl = 'https://mmbiz.qpic.cn/mmbiz_png/task-fixture/640?wx_fmt=png&from=appmsg';
  const rendered = renderArticle({ source, themeCss: taskTheme,
    themeAssets: [{ id: 'task-brush', url: 'file:///fixture/task-brush.png', filePath: 'fixture/task-brush.png', wechatUrl }],
    themeComponents: [], resolve: () => null });
  let writes = 0;
  let copied;
  const result = await copyRenderedArticle({ html: rendered.html, text: source, images: rendered.images,
    embedImages: true, resolveFile: () => assert.fail('已登记背景无需读取本地附件'),
    readBinary: () => assert.fail('已登记背景无需读取本地字节'),
    _clipboard: { write(value) { writes += 1; copied = value; } },
  });
  assert.equal(writes, 1);
  assert.equal(copied.text, source);
  const before = parseDocument(rendered.html), after = parseDocument(copied.html);
  assert.equal(tasks(after).length, 3);
  assert.equal(markers(after).length, 3);
  assert.equal(tags(after, 'input').length, 0);
  assert.equal(text(after), text(before));
  for (const item of tasks(after)) firstTaskLine(item);
  const removeBackground = style => Object.fromEntries(Object.entries(style).filter(([key]) => key !== 'background-image'));
  assert.deepEqual(markers(after).map(node => removeBackground(styles(node))),
    markers(before).map(node => removeBackground(styles(node))));
  for (const marker of markers(after)) {
    assert.equal(marker.parent.name, 'p');
    assert.equal(styles(marker).display, 'inline');
    assert.equal(styles(marker).width, undefined);
    assert.equal(styles(marker).height, undefined);
  }
  const checked = markers(after).find(node => hasClass(node, 'is-checked'));
  assert.ok(styles(checked)['background-image'].includes(wechatUrl));
  assert.doesNotMatch(copied.html, /(?:app|file|theme-asset):\/\//);
  assert.equal(result.stats.themeBackgrounds.removed, 0);
  assert.equal(result.stats.themeBackgrounds.remote, 1);
  assert.deepEqual(result.warnings, []);
});
