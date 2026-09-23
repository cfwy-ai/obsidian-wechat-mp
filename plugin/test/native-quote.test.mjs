import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceNativeQuoteContainers } from '../src/native-quote.mjs';

test('把原生引用换成 section，属性与内部结构一字不动', () => {
  const html = '<section id="nice"><blockquote style="border:none;color:#405C49"><p>金句。</p></blockquote></section>';
  const result = replaceNativeQuoteContainers(html);
  assert.equal(result.replaced, 1);
  assert.equal(result.html,
    '<section id="nice"><section data-wechat-quote-container="true" style="border:none;color:#405C49">'
    + '<p>金句。</p></section></section>');
});

test('没有引用时原样返回，不重新序列化正文', () => {
  const html = '<section id="nice"><p>正文&amp;符号</p><table><tr><td>格</td></tr></table></section>';
  const result = replaceNativeQuoteContainers(html);
  assert.equal(result.replaced, 0);
  assert.equal(result.html, html);
});

test('嵌套引用逐层替换，不漏内层', () => {
  const html = '<blockquote class="a"><p>外</p><blockquote class="b"><p>内</p></blockquote></blockquote>';
  const result = replaceNativeQuoteContainers(html);
  assert.equal(result.replaced, 2);
  assert.equal(result.html.includes('<blockquote'), false);
  assert.match(result.html, /<section data-wechat-quote-container="true" class="a">/);
  assert.match(result.html, /<section data-wechat-quote-container="true" class="b">/);
  assert.equal(result.html.includes('外'), true);
  assert.equal(result.html.includes('内'), true);
});

test('已经换过的容器不再重复处理', () => {
  const once = replaceNativeQuoteContainers('<blockquote><p>金句</p></blockquote>');
  const twice = replaceNativeQuoteContainers(once.html);
  assert.equal(twice.replaced, 0);
  assert.equal(twice.html, once.html);
});

test('属性里带尖括号的引号内容不会把标签截断', () => {
  const html = '<blockquote data-note="a>b" style="color:#111"><p>金句</p></blockquote>';
  const result = replaceNativeQuoteContainers(html);
  assert.equal(result.replaced, 1);
  assert.match(result.html, /data-note="a>b"/);
  assert.match(result.html, /style="color:#111"/);
});

test('空输入与非字符串不报错', () => {
  for (const value of [undefined, null, '', 0]) {
    const result = replaceNativeQuoteContainers(value);
    assert.equal(result.replaced, 0);
    assert.equal(typeof result.html, 'string');
  }
});
