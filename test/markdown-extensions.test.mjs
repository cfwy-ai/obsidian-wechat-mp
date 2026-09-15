import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';
import juice from 'juice';
import { MARKDOWN_BASE_CSS, renderMarkdown } from '../src/markdown.mjs';
import { sanitizeRenderedHtml } from '../src/sanitize.mjs';

test('Obsidian 高亮语法转换为 mark，并保留内部行内格式', () => {
  const html = renderMarkdown('前文 ==高亮 **加粗** 与 [链接](https://example.com)==，==另一处==。');
  assert.match(html, /<mark class="wechat-inline-highlight">高亮 <strong>加粗<\/strong> 与 <a href="https:\/\/example.com">链接<\/a><\/mark>/);
  assert.match(html, /<mark class="wechat-inline-highlight">另一处<\/mark>/);
  assert.doesNotMatch(html, /==/);
});

test('标题、引用、列表与表格中的高亮同样可用', () => {
  const html = renderMarkdown('# ==标题==\n\n> ==引用==\n\n- ==列表==\n\n| 甲 |\n| --- |\n| ==表格== |');
  for (const text of ['标题', '引用', '列表', '表格']) assert.ok(html.includes(`<mark class="wechat-inline-highlight">${text}</mark>`));
  assert.equal((html.match(/<mark\b[^>]*>/g) ?? []).length, 4);
});

test('高亮不会改写代码块、行内代码、转义或原始 HTML 属性', () => {
  const markdown = '```text\n==代码块==\n```\n\n`==行内代码==`\n\n\\==转义\\==\n\n<span title="==属性==">普通内容</span>\n\n<code>==原始代码==</code>';
  const html = renderMarkdown(markdown);
  assert.doesNotMatch(html, /<mark\b[^>]*>/);
  assert.match(html, /==代码块==/);
  assert.match(html, /<code>==行内代码==<\/code>/);
  assert.match(html, /title="==属性=="/);
  assert.match(html, /<code>==原始代码==<\/code>/);
});

test('高亮结束符避开内部代码、HTML 属性、链接地址及转义', () => {
  const html = renderMarkdown('==前 `a==b` [链接](https://example.com/?q==x) <span title="a==b">文字</span> a\\==b 后==');
  assert.equal((html.match(/<mark\b[^>]*>/g) ?? []).length, 1);
  assert.match(html, /<mark class="wechat-inline-highlight">前 <code>a==b<\/code>/);
  assert.match(html, /href="https:\/\/example.com\/\?q==x"/);
  assert.match(html, /title="a==b"/);
  assert.match(html, /a==b 后<\/mark>/);
});

test('raw HTML 代码内容中的等号不提前结束外层高亮', () => {
  assert.match(renderMarkdown('==前 <code>a==b</code> 后=='), /<mark class="wechat-inline-highlight">前 <code>a==b<\/code> 后<\/mark>/);
});

test('链接属性不做高亮替换，链接文字可以高亮', () => {
  const html = renderMarkdown('[==名称==](https://example.com/?q==value "==说明==")');
  assert.match(html, /href="https:\/\/example.com\/\?q==value" title="==说明=="><mark class="wechat-inline-highlight">名称<\/mark>/);
  const bareUrl = renderMarkdown('https://example.com/?q==value==');
  assert.doesNotMatch(bareUrl, /<mark\b[^>]*>/);
  assert.match(bareUrl, /href="https:\/\/example.com\/\?q==value=="/);
});

test('空内容、边界空格、未闭合、跨行和连续三个以上等号保持字面值', () => {
  for (const markdown of ['====', '== ==', '== 内容==', '==内容 ==', '==未闭合', '==跨\n行==', '==跨\n\n段==', '===内容===', '====内容====', '===内容==', '==内容===']) {
    assert.doesNotMatch(renderMarkdown(markdown), /<mark\b[^>]*>/, markdown);
  }
  assert.match(renderMarkdown('===普通===，==有效=='), /===普通===，<mark class="wechat-inline-highlight">有效<\/mark>/);
});

test('显式 mark 与 Obsidian 高亮经过净化后都有标记', () => {
  const html = sanitizeRenderedHtml(renderMarkdown('==高亮== 和 <mark>标签高亮</mark>'));
  assert.equal((html.match(/<mark\b[^>]*>/g) ?? []).length, 2);
  assert.doesNotMatch(html, /==高亮==/);
  assert.match(html, /<mark class="wechat-inline-highlight">高亮<\/mark>/);
  assert.match(html, /<mark>标签高亮<\/mark>/);
});

test('主题可分别装饰两种高亮，旧的 mark 选择器仍同时生效', () => {
  const html = sanitizeRenderedHtml(renderMarkdown('==普通高亮== 和 <mark>圈注标签</mark>'));
  const themed = juice.inlineContent(html, '#nice mark { color:#222222; } #nice .wechat-inline-highlight { background-color:#DDE4F0; } #nice mark:not(.wechat-inline-highlight) { border:1px solid #666666; }');
  assert.match(themed, /class="wechat-inline-highlight"[^>]*background-color: #DDE4F0/);
  assert.match(themed, /<mark style="[^"]*border: 1px solid #666666[^"]*">圈注标签/);
  assert.equal((themed.match(/color: #222222/g) ?? []).length, 2);
});

test('任务列表在净化前即静态化，净化后仍能区分未完成与已完成', () => {
  const html = sanitizeRenderedHtml(renderMarkdown('- [ ] 未完成\n- [x] 已完成\n- [X] 大写完成'));
  assert.doesNotMatch(html, /<input/);
  assert.equal((html.match(/class="wechat-task-item is-unchecked"/g) ?? []).length, 1);
  assert.equal((html.match(/class="wechat-task-item is-checked"/g) ?? []).length, 2);
  assert.match(html, /aria-label="未完成">☐<\/span>未完成/);
  assert.match(html, /aria-label="已完成">✓<\/span>已完成/);
  assert.equal((html.match(/class="wechat-task-marker /g) ?? []).length, 3);
});

test('松散任务列表的 marker 留在首段，后续段落与嵌套列表保持原结构', () => {
  const html = renderMarkdown('- [ ] 第一段 **加粗**\n\n  第二段 [链接](https://example.com)\n\n  - 普通子项\n  - [x] 已完成子项\n\n- [x] 另一项');
  assert.match(html, /<li class="wechat-task-item is-unchecked"><p class="wechat-task-line"><span class="wechat-task-marker is-unchecked"[^>]*>☐<\/span>第一段 <strong>加粗<\/strong><\/p>/);
  assert.match(html, /<p>第二段 <a href="https:\/\/example.com">链接<\/a><\/p>/);
  assert.match(html, /<ul>\n<li>普通子项<\/li>/);
  assert.equal((html.match(/class="wechat-task-marker /g) ?? []).length, 3);
});

test('混合任务和普通项不改变普通列表，有序列表编号起点保持不变', () => {
  const html = renderMarkdown('3. [ ] 待办\n4. 普通项\n5. [x] 完成');
  assert.match(html, /<ol start="3">/);
  assert.match(html, /<li>普通项<\/li>/);
  assert.equal((html.match(/class="wechat-task-item /g) ?? []).length, 2);
  const ordinary = '- 甲\n  - 子项\n- 乙\n\n2. 丙\n3. 丁';
  assert.equal(renderMarkdown(ordinary), `<section id="nice">${new Marked({ gfm: true }).parse(ordinary).trim()}</section>`);
});

test('通用任务样式可内联，移除原生项目符号并保留静态状态', () => {
  const html = juice.inlineContent(sanitizeRenderedHtml(renderMarkdown('- 普通\n- [ ] 待办\n- [x] 完成')), MARKDOWN_BASE_CSS);
  assert.match(html, /class="wechat-task-item is-unchecked" style="list-style-type: none;"/);
  assert.match(html, /class="wechat-task-marker is-checked"[^>]*style="margin-right: 8px;"[^>]*>✓/);
  assert.match(html, /<li>普通<\/li>/);
});
