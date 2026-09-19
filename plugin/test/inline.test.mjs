import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineCss, quoteFontNames, dropUndefinedStyles } from '../src/inline.mjs';

test('把样式表内联到元素的 style 属性上', () => {
  const { html } = inlineCss('<div id="nice"><p>x</p></div>', '#nice p { color: red; }');
  assert.match(html, /<p style="color: red;">x<\/p>/);
});

test('伪元素转成真实 span，这是微信里唯一能活的形态', () => {
  const { html } = inlineCss(
    '<div id="nice"><h1>标题</h1></div>',
    '#nice h1::before { content: ""; display: block; height: 2px; background-color: #6B8E9B; }'
  );
  assert.match(html, /<span style="[^"]*background-color: #6B8E9B[^"]*"><\/span>标题/);
});

test('CSS 变量展平成字面值，因为微信会丢弃 var()', () => {
  const { html } = inlineCss(
    '<div id="nice"><p>x</p></div>',
    ':root { --brand: #07C160; } #nice p { color: var(--brand); }'
  );
  assert.match(html, /color: #07C160/);
  assert.doesNotMatch(html, /var\(/);
});

test('成功时报告用的是全量档', () => {
  const { level } = inlineCss('<div id="nice"><p>x</p></div>', '#nice p { color: red; }');
  assert.equal(level, 'full');
});

// ---- 前置清洗 ----

test('未加引号的多词字体名补上引号', () => {
  assert.match(quoteFontNames('a { font-family: Open Sans, sans-serif; }'), /"Open Sans"/);
});

test('未加引号的中文字体名补上引号', () => {
  assert.match(quoteFontNames('a { font-family: PingFang SC, sans-serif; }'), /"PingFang SC"/);
});

test('已经加了引号的字体名不重复加', () => {
  const css = 'a { font-family: "Open Sans", sans-serif; }';
  assert.equal(quoteFontNames(css), css);
});

test('单词字体名与通用族不加引号', () => {
  const css = 'a { font-family: Georgia, serif; }';
  assert.equal(quoteFontNames(css), css);
});

test('清掉 undefined 样式值，它会让内联器直接抛错', () => {
  assert.doesNotMatch(dropUndefinedStyles('<p style="undefined;">x</p>'), /undefined/);
});

// ---- 降级阶梯 ----
// 注入一个可控的内联器，确定性地验证每一级

const failTimes = (n) => {
  let calls = 0;
  const fn = (html) => {
    calls++;
    if (calls <= n) throw new Error(`第 ${calls} 次失败`);
    return html.replace('<p>', '<p style="ok">');
  };
  fn.calls = () => calls;
  return fn;
};

test('全量档失败后退到关闭伪元素档', () => {
  const { level, html } = inlineCss('<div id="nice"><p>x</p></div>', '#nice p{color:red}', {
    _juice: failTimes(1),
  });
  assert.equal(level, 'no-pseudo');
  assert.match(html, /style="ok"/);
});

test('前两档都失败后退到剥离字体档', () => {
  const { level } = inlineCss('<div id="nice"><p>x</p></div>', '#nice p{color:red}', {
    _juice: failTimes(2),
  });
  assert.equal(level, 'no-font');
});

test('三档全失败时返回未内联原文，绝不整篇报错', () => {
  const src = '<div id="nice"><p>x</p></div>';
  const { level, html } = inlineCss(src, '#nice p{color:red}', { _juice: failTimes(3) });
  assert.equal(level, 'none');
  assert.equal(html, src);
});

test('降级时留下警告，说明发生过什么', () => {
  const { warnings } = inlineCss('<div id="nice"><p>x</p></div>', '#nice p{color:red}', {
    _juice: failTimes(1),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /伪元素/);
});

test('三档全失败时警告说明样式没有内联', () => {
  const { warnings } = inlineCss('<div id="nice"><p>x</p></div>', '#nice p{color:red}', {
    _juice: failTimes(3),
  });
  assert.match(warnings.at(-1), /未能内联/);
});

test('真实 CSS 语法错误会降级并显示可定位的警告', () => {
  const src = '<div id="nice"><p>x</p></div>';
  const { level, html, warnings } = inlineCss(src, '#nice p { color: red;');
  assert.equal(level, 'none');
  assert.equal(html, src);
  assert.match(warnings[0], /CSS 语法错误/);
  assert.match(warnings[0], /第 1 行/);
  assert.match(warnings[0], /Unclosed block/);
});

test('剥离字体档确实拿掉了 font-family', () => {
  // 只在收到的样式仍带 font-family 时失败，逼它一路降到剥字体那一档
  const spy = (doc) => {
    if (doc.includes('font-family')) throw new Error('还带着字体');
    return doc;
  };
  const { level } = inlineCss('<div id="nice"><p>x</p></div>', '#nice p{font-family:X;color:red}', {
    _juice: spy,
  });
  assert.equal(level, 'no-font');
});
