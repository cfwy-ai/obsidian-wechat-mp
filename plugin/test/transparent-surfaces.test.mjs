import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio/slim';
import { applyWechatDarkMode } from '../src/dark-mode.mjs';
import { parseThemeManifest } from '../src/theme-package.mjs';
import { sanitizeRenderedHtml, transformSanitizedHtmlElements } from '../src/sanitize.mjs';

const policy = { strategy: 'preserve-backgrounds', tableBorderColor: '#A7B99D', transparentCodeBlocks: true, nativeTableBorders: true };
const asset = id => ({ target: id, url: `app://vault/${id}.png`, filePath: `/vault/${id}.png`, origin: 'theme', wechatUrl: `https://mmbiz.qpic.cn/mmbiz_png/${id}/640?wx_fmt=png` });
const assets = ['controls', 'watermark', 'row', 'header'].map(asset);
const bg = id => `background-color:transparent;background-image:url('app://vault/${id}.png');background-size:24px 12px;background-position:right bottom;background-repeat:no-repeat`;
const run = (html, overrides = {}) => applyWechatDarkMode(html, { policy: { ...policy, ...overrides }, backgroundImages: assets });
const parse = html => load(html, {}, false);
const code = `<pre id="snippet" style="margin:28px 0;padding:36px 16px 14px;border:1px solid #A7B99D;border-radius:11px;${bg('controls')}"><code class="language-js" style="display:block;font-size:13px;line-height:1.9;white-space:pre-wrap;padding:0 0 30px;${bg('watermark')}"><span style="color:#34503E">  const x = 1;</span>\n    return x;\n</code></pre>`;

test('透明代码装饰移到 pre 外的两层 section，文字、缩进及圆角不变', () => {
  const before = parse(code), result = run(`<section id="nice">${code}</section>`), $ = parse(result.html);
  const outer = $('[data-wechat-darkmode-surface="code"]'), content = outer.children('[data-wechat-darkmode-surface="code-content"]');
  assert.equal(outer.length, 1);
  assert.equal(content.children('pre').children('code').length, 1);
  assert.equal($('pre').attr('id'), 'snippet');
  assert.equal($('pre > code').attr('class'), 'language-js');
  assert.equal($('pre > code').text(), before('pre > code').text());
  assert.match(outer.attr('style'), /margin:28px 0/);
  assert.match(outer.attr('style'), /padding:36px 16px 14px/);
  assert.match(outer.attr('style'), /border-radius:11px/);
  assert.match(content.attr('style'), /padding:0 0 30px/);
  assert.doesNotMatch($('pre').attr('style'), /background-image|border-radius/);
  assert.doesNotMatch($('pre > code').attr('style'), /background-image/);
  assert.match($('pre > code').attr('style'), /white-space:pre-wrap/);
  assert.equal($('pre section,code section').length, 0);
  assert.equal(outer.attr('data-no-dark'), '');
  assert.equal(content.attr('data-no-dark'), '');
  assert.deepEqual(new Set(result.backgroundImageUrls), new Set(assets.slice(0, 2).map(a => a.url)));
  assert.deepEqual(result.warnings, []);
  assert.equal(run(result.html).html, result.html);
});

test('默认策略、实色代码、行内代码和任务子树均不改变', () => {
  const colored = code.replace('background-color:transparent', 'background-color:#111111');
  for (const html of [colored, `<p>行内<code style="${bg('controls')}">x</code></p>`, `<section data-wechat-list-task-scope="true">${code}</section>`]) {
    const result = run(`<section id="nice">${html}</section>`);
    const $ = parse(result.html), before = parse(html);
    const selector = html === colored ? 'pre' : html.startsWith('<p>') ? 'code' : '[data-wechat-list-task-scope]';
    assert.equal($.html($(selector)[0]), before.html(before(selector)[0]));
  }
  assert.equal(parse(run(`<section id="nice">${code}</section>`, { transparentCodeBlocks: false }).html).html('pre'), parse(code).html('pre'));
});

test('不受管的代码背景不能升级为带保护标记的 section', () => {
  const html = `<section id="nice">${code.replace('app://vault/controls.png', 'https://example.test/not-managed.png')}</section>`;
  const r = run(html);
  assert.equal(parse(r.html)('[data-wechat-darkmode-surface="code"]').length, 0);
  assert(r.warnings.some(w => w.includes('未登记')));
});

test('原生表格边线模式清除组与行上的图片，保留合并信息和现有 CSS 边框', () => {
  const html = `<section id="nice"><table class="data" style="width:100%;margin:28px 0"><thead style="${bg('header')}"><tr><th colspan="2" scope="colgroup" style="padding:13px 12px;border:1px solid #A7B99D;border-radius:10px">长表头</th></tr></thead><tbody><tr style="${bg('row')}"><td rowspan="2" style="padding:12px;border-bottom:1px solid #AEC0A4">A</td><td>42</td></tr><tr style="${bg('row')}"><td>108</td></tr></tbody></table></section>`;
  const r = run(html), $ = parse(r.html);
  assert.equal($('table').attr('cellspacing'), '0');
  assert.equal($('table').attr('cellpadding'), '0');
  const exported = parse(transformSanitizedHtmlElements(r.html, (tagName, attribs) => ({ tagName, attribs })));
  assert.equal(exported('table').attr('cellspacing'), '0');
  assert.equal(exported('table').attr('cellpadding'), '0');
  assert.equal($('table').attr('class'), 'data');
  assert.equal($('th').attr('colspan'), '2');
  assert.equal($('td').first().attr('rowspan'), '2');
  assert.match($('th').attr('style'), /border-radius:10px/);
  assert.match($('td').first().attr('style'), /border-bottom:1px solid #AEC0A4/);
  assert.equal($('table,thead,tbody,tr,th,td').filter('[data-no-dark]').length, 0);
  assert.equal($('table,thead,tbody,tr,th,td').toArray().some(n => ($(n).attr('style') || '').includes('background-image')), false);
  assert.equal($('th').text(), '长表头');
  assert.equal($('tbody tr').length, 2);
  assert.deepEqual(r.backgroundImageUrls, []);
  assert.equal(run(r.html).html, r.html);
});

test('只允许表格零间距属性通过清洗，不放行任意布局值或事件', () => {
  const $ = parse(sanitizeRenderedHtml('<table cellspacing="1000" cellpadding="-2" onclick="bad()"><tr><td>x</td></tr></table>'));
  assert(!$('table').attr('cellspacing'));
  assert(!$('table').attr('cellpadding'));
  assert.equal($('table').attr('onclick'), undefined);
});

test('扩展开关严格验证，未声明时不改变原策略对象', () => {
  const base = { schema_version: 3, theme_id: 'demo', name: '示例', assets: [], components: [], wechat_dark_mode: { strategy: 'preserve-backgrounds', table_border_color: '#A7B99D' } };
  const parsed = extra => parseThemeManifest(JSON.stringify({ ...base, wechat_dark_mode: { ...base.wechat_dark_mode, ...extra } }));
  assert.deepEqual(parsed({}).wechatDarkMode, { strategy: 'preserve-backgrounds', tableBorderColor: '#A7B99D' });
  assert.equal(parsed({ transparent_code_blocks: true, native_table_borders: true }).wechatDarkMode.transparentCodeBlocks, true);
  for (const field of ['transparent_code_blocks', 'native_table_borders']) for (const bad of ['true', 1, null]) assert.throws(() => parsed({ [field]: bad }), /布尔/);
  assert.throws(() => parsed({ native_table_borders: true, table_frame: {} }), /不能与/);
});
