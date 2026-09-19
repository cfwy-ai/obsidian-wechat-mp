import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontmatter, renderMarkdown } from '../src/markdown.mjs';

test('剥掉 frontmatter，只留正文', () => {
  const { body } = splitFrontmatter('---\ntype: 文章\n---\n\n正文');
  assert.equal(body, '正文');
});

test('frontmatter 原文一并返回，供标题与摘要使用', () => {
  const { frontmatter } = splitFrontmatter('---\ntype: 文章\n---\n\n正文');
  assert.equal(frontmatter, 'type: 文章');
});

test('没有 frontmatter 时正文原样返回', () => {
  const { body, frontmatter } = splitFrontmatter('正文');
  assert.equal(body, '正文');
  assert.equal(frontmatter, '');
});

test('正文里的分隔线不会被误当成 frontmatter', () => {
  const { body } = splitFrontmatter('第一段\n\n---\n\n第二段');
  assert.equal(body, '第一段\n\n---\n\n第二段');
});

test('渲染结果包在 nice 容器里，主题选择器才挂得上', () => {
  assert.match(renderMarkdown('正文'), /^<section id="nice">[\s\S]*<\/section>$/);
});

test('标题内容包一层 content span，与主题的 h2 .content 对应', () => {
  assert.match(renderMarkdown('## 小标题'), /<h2><span class="content">小标题<\/span><\/h2>/);
});

test('三级标题同样包 content span', () => {
  assert.match(renderMarkdown('### 三级'), /<h3><span class="content">三级<\/span><\/h3>/);
});

test('标题里的行内格式保留在 content span 内', () => {
  assert.match(renderMarkdown('## 带**重点**的标题'), /<span class="content">带<strong>重点<\/strong>的标题<\/span>/);
});

test('一级标题里的显式 br 保留在同一个 content span 内', () => {
  const html = renderMarkdown('# Codex 与 Agent<br>如何共享上下文');
  assert.match(
    html,
    /<h1><span class="content">Codex 与 Agent<br>如何共享上下文<\/span><\/h1>/,
  );
  assert.equal((html.match(/<h1>/g) ?? []).length, 1);
});

test('font 标签原样透传，不被转义', () => {
  const html = renderMarkdown('这是<font color="#c3d69b">彩色</font>文字');
  assert.match(html, /<font color="#c3d69b">彩色<\/font>/);
});

test('加粗渲染成 strong', () => {
  assert.match(renderMarkdown('**重点**'), /<strong>重点<\/strong>/);
});

test('分割线渲染成 hr', () => {
  assert.match(renderMarkdown('---'), /<hr\s*\/?>/);
});

test('引用渲染成 blockquote', () => {
  assert.match(renderMarkdown('> 引文'), /<blockquote>/);
});

test('有序列表渲染成 ol', () => {
  assert.match(renderMarkdown('1. 甲\n2. 乙'), /<ol[\s\S]*<li>甲<\/li>/);
});

test('表格渲染成 table', () => {
  const html = renderMarkdown('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |');
  assert.match(html, /<table>[\s\S]*<th>甲<\/th>/);
});

test('代码块带语言 class，供高亮样式使用', () => {
  const html = renderMarkdown('```js\nconst a = 1;\n```');
  assert.match(html, /<code class="[^"]*language-js/);
});

test('代码块内容被高亮标记包裹', () => {
  const html = renderMarkdown('```js\nconst a = 1;\n```');
  assert.match(html, /<span class="hljs-/);
});

test('未标注语言的代码块不报错', () => {
  assert.match(renderMarkdown('```\n纯文本\n```'), /<pre>/);
});

test('标注了未知语言的代码块不报错', () => {
  assert.match(renderMarkdown('```不存在的语言\nabc\n```'), /<pre>/);
});

test('已经是 img 标签的图片原样透传', () => {
  const html = renderMarkdown('<img src="local://a.png">');
  assert.match(html, /<img src="local:\/\/a\.png">/);
});
