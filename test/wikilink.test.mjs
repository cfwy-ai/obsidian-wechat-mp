import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertEmbeds } from '../src/wikilink.mjs';

// 所有用例共用的解析器：把目标名原样当成 URL，便于断言
const echo = (target) => `RESOLVED/${target}`;

test('把图片嵌入转成 img 标签', () => {
  const { markdown } = convertEmbeds('![[a.png]]', echo);
  assert.equal(markdown, '<img src="RESOLVED/a.png">');
});

test('管道后的单个数字是宽度', () => {
  const { markdown } = convertEmbeds('![[a.png|300]]', echo);
  assert.equal(markdown, '<img src="RESOLVED/a.png" width="300">');
});

test('管道后的 宽x高 同时给出两个尺寸', () => {
  const { markdown } = convertEmbeds('![[a.png|300x200]]', echo);
  assert.equal(markdown, '<img src="RESOLVED/a.png" width="300" height="200">');
});

test('文件名里的空格、括号与中文都能解析', () => {
  const { markdown } = convertEmbeds('![[未命名文件 (1) 3.png]]', echo);
  assert.equal(markdown, '<img src="RESOLVED/未命名文件 (1) 3.png">');
});

test('管道后的非数字内容当作替代文字，不当尺寸', () => {
  const { markdown } = convertEmbeds('![[a.png|封面图]]', echo);
  assert.equal(markdown, '<img src="RESOLVED/a.png" alt="封面图">');
});

test('大小写不同的扩展名一样认作图片', () => {
  const { markdown } = convertEmbeds('![[A.PNG]]', echo);
  assert.equal(markdown, '<img src="RESOLVED/A.PNG">');
});

test('一行里的多个嵌入各自独立转换', () => {
  const { markdown } = convertEmbeds('![[a.png]] 和 ![[b.jpg]]', echo);
  assert.equal(markdown, '<img src="RESOLVED/a.png"> 和 <img src="RESOLVED/b.jpg">');
});

test('普通链接退化成纯文本，因为个人号不能用 a 标签', () => {
  const { markdown } = convertEmbeds('见 [[某篇笔记]] 一文', echo);
  assert.equal(markdown, '见 某篇笔记 一文');
});

test('带别名的普通链接只留别名', () => {
  const { markdown } = convertEmbeds('见 [[某篇笔记|另一个说法]]', echo);
  assert.equal(markdown, '见 另一个说法');
});

test('围栏代码块里的嵌入原样保留', () => {
  const src = '```\n![[a.png]]\n```';
  const { markdown } = convertEmbeds(src, echo);
  assert.equal(markdown, src);
});

test('行内代码里的嵌入原样保留', () => {
  const { markdown } = convertEmbeds('写作 `![[a.png]]` 即可', echo);
  assert.equal(markdown, '写作 `![[a.png]]` 即可');
});

test('四反引号外层里的三反引号代码示例原样保留', () => {
  const src = '````markdown\n```\n![[a.png]]\n```\n````';
  const { markdown, images } = convertEmbeds(src, echo);
  assert.equal(markdown, src);
  assert.equal(images.length, 0);
});

test('四空格缩进代码块里的嵌入原样保留', () => {
  const src = '    ![[a.png]]\n\n正文';
  const { markdown, images } = convertEmbeds(src, echo);
  assert.equal(markdown, src);
  assert.equal(images.length, 0);
});

test('未闭合的围栏一直保护到文件末尾', () => {
  const src = '~~~markdown\n![[a.png]]';
  const { markdown, images } = convertEmbeds(src, echo);
  assert.equal(markdown, src);
  assert.equal(images.length, 0);
});

test('列表容器里的围栏代码不解析嵌入', () => {
  const src = '- ```markdown\n  ![[a.png]]\n  ````\n\n正文';
  const { markdown, images } = convertEmbeds(src, echo);
  assert.equal(markdown, src);
  assert.equal(images.length, 0);
});

test('引用容器里的围栏代码不解析嵌入', () => {
  const src = '> ```markdown\n> ![[a.png]]\n> ```\n\n正文';
  const { markdown, images } = convertEmbeds(src, echo);
  assert.equal(markdown, src);
  assert.equal(images.length, 0);
});

test('收集每一张图片，供上传阶段使用', () => {
  const { images } = convertEmbeds('![[a.png]]\n![[b.jpg|300]]', echo);
  assert.deepEqual(images.map((i) => i.target), ['a.png', 'b.jpg']);
});

test('同一张图出现两次只登记一条', () => {
  const { images } = convertEmbeds('![[a.png]] ![[a.png]]', echo);
  assert.equal(images.length, 1);
});

test('解析不到的图片记一条警告，并且不产出 img', () => {
  const { markdown, warnings } = convertEmbeds('![[缺失.png]]', () => null);
  assert.equal(markdown, '');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /缺失\.png/);
});

test('非图片的嵌入记一条警告，因为公众号无法承载', () => {
  const { markdown, warnings } = convertEmbeds('![[某篇笔记]]', echo);
  assert.equal(markdown, '');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /某篇笔记/);
});

test('没有嵌入时原文一字不动', () => {
  const src = '# 标题\n\n正文一段。';
  const { markdown, images, warnings } = convertEmbeds(src, echo);
  assert.equal(markdown, src);
  assert.equal(images.length, 0);
  assert.equal(warnings.length, 0);
});
