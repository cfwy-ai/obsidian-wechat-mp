import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderArticle } from '../src/pipeline.mjs';
import { sanitizeRenderedHtml } from '../src/sanitize.mjs';

test('移除可执行事件、嵌入页面、SVG 与原文行内样式', () => {
  const html = [
    '<img src="app://local/a.png" onerror="alert(1)">',
    '<svg onload="alert(2)"><circle></circle></svg>',
    '<iframe srcdoc="<script>alert(3)</script>"></iframe>',
    '<div id="nice" class="content" style="background:url(https://example.com/track)">ok</div>',
  ].join('');
  const safe = sanitizeRenderedHtml(html);

  assert.match(safe, /<img src="app:\/\/local\/a\.png"/);
  assert.match(safe, /<div id="nice" class="content">ok<\/div>/);
  assert.doesNotMatch(safe, /onerror|onload|iframe|srcdoc|script|svg|style=|example\.com/);
});

test('保留主题选择器与文章彩字需要的安全结构', () => {
  const safe = sanitizeRenderedHtml(
    '<div id="nice"><h2><span class="content">标题</span></h2><font color="#c3d69b">彩字</font></div>',
  );
  assert.match(safe, /id="nice"/);
  assert.match(safe, /class="content"/);
  assert.match(safe, /<font color="#c3d69b">彩字<\/font>/);
});

test('共用管线不会把原文中的危险 HTML 交给预览或推送', () => {
  const result = renderArticle({
    source: '<img src="app://local/a.png" onerror="globalThis.pwned=true"><iframe srcdoc="x"></iframe>',
    themeCss: '#nice img { width: 100%; }',
    resolve: () => null,
  });
  assert.match(result.html, /<img[^>]*style="width:\s*100%;?"/);
  assert.doesNotMatch(result.html, /onerror|iframe|srcdoc|pwned/);
});

test('javascript 与 data 图片地址不会保留', () => {
  const safe = sanitizeRenderedHtml(
    '<img src="javascript:alert(1)"><img src="data:text/html,boom"><img src="https://example.com/a.png">',
  );
  assert.doesNotMatch(safe, /javascript:|data:text/);
  assert.match(safe, /https:\/\/example\.com\/a\.png/);
});
