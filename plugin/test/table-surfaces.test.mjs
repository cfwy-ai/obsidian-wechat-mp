import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio/slim';
import postcss from 'postcss';
import { materializeTableSurfaces } from '../src/table-surfaces.mjs';
import { parseThemeManifest } from '../src/theme-package.mjs';
import { renderArticle } from '../src/pipeline.mjs';
import { applyWechatDarkMode } from '../src/dark-mode.mjs';

const parse = html => load(html, {}, false);
const policy = { strategy: 'preserve-table-surfaces' };
const themeManifest = patch => JSON.stringify({schema_version:3,theme_id:'test-surface',name:'测试表格',assets:[],components:[],wechat_dark_mode:patch});

test('table surfaces: manifest opts in without inheriting whole-article dark-mode policy', () => {
  assert.deepEqual(parseThemeManifest(themeManifest(policy)).wechatDarkMode,policy);
  for (const mixed of [{...policy,native_table_borders:true},{...policy,table_frame:{}},{...policy,transparent_code_blocks:true}]) {
    assert.throws(()=>parseThemeManifest(themeManifest(mixed)),/只接受 strategy/);
  }
  const sample='<section id="nice"><blockquote style="color:#111">文字</blockquote></section>';
  assert.equal(applyWechatDarkMode(sample,{policy}).html,sample);
});

test('table surfaces: complete pipeline preserves watermark registration and non-table fragments', () => {
  const config={source:'正文\n\n> 引用。\n\n- 父项\n  - 子项\n\n| 表头 |\n| --- |\n| **内容** |',
    themeCss:'#nice {color:#303030} #nice th {background-image:url("theme-asset://orbit");background-color:#303030;padding:11px 9px} #nice td {background-color:#EAEAEA;color:#414141;padding:11px 9px}',
    themeAssets:[{id:'orbit',url:'file:///fixture/orbit.png',filePath:'fixture/orbit.png',wechatUrl:'https://mmbiz.qpic.cn/example/orbit.png'}],resolve:()=>null};
  const before=renderArticle(config),after=renderArticle({...config,themeDarkMode:policy});
  assert.deepEqual(after.warnings,[]);
  assert.deepEqual(after.images,before.images);
  const $=parse(after.html), b=parse(before.html);
  assert.equal($('[data-wechat-table-surface]').length,2);
  assert.match($('th > section').attr('style'),/orbit\.png/);
  assert.equal($('blockquote').toString(),b('blockquote').toString());
  assert.equal($('[data-wechat-list-root]').toString(),b('[data-wechat-list-root]').toString());
  assert.equal($('#nice > p').toString(),b('#nice > p').toString());
});
const asset = {
  target: 'table-orbit', origin: 'theme', filePath: '/fixture/table-orbit.png',
  url: 'file:///fixture/table-orbit.png',
};
const run = (html, overrides = {}) => materializeTableSurfaces(html, { policy, backgroundImages: [asset], ...overrides });
const wrap = body => `<section id="nice">${body}</section>`;
const surfaceSelector = 'section[data-wechat-table-surface="cell"]';
const contentSelector = 'section[data-wechat-table-content]';
const style = element => {
  const declarations = new Map();
  postcss.parse(`x{${element.attr('style') ?? ''}}`).first.walkDecls(decl => declarations.set(decl.prop.toLowerCase(), decl.value.trim()));
  return declarations;
};
const structuralTags = $ => $('table,thead,tbody,tr,th,td').toArray().map(node => node.name);
const rows = $ => $('tr').toArray().map(row => $(row).children('th,td').map((_, node) => ({
  tag: node.name, rowspan: $(node).attr('rowspan'), colspan: $(node).attr('colspan'), align: $(node).attr('align'),
})).get());
const cell = ($, selector) => {
  const native = $(selector);
  assert.equal(native.length, 1, `One native cell expected for ${selector}`);
  const surface = native.children(surfaceSelector);
  assert.equal(surface.length, 1, `Exactly one direct surface expected for ${selector}`);
  assert.equal(native.children().length, 1, 'No text or layout sibling may escape the surface');
  const content = surface.children(contentSelector);
  assert.equal(content.length, 1, 'Exactly one direct content section required');
  assert.equal(surface.children().length, 1, 'Content must be the sole child of the paint surface');
  return { native, surface, content };
};

test('文字容器自带颜色，不靠继承——微信会给叶子节点补 color', () => {
  const html = wrap("<table><thead><tr><th style='background-color:#303030;color:#F7F7F7;padding:11px 9px'>表头</th></tr></thead>"
    + "<tbody><tr><td style='color:#414141;padding:11px 9px'>单元格</td></tr></tbody></table>");
  const $ = load(run(html).html);
  const head = cell($, 'th');
  assert.equal(style(head.surface).get('color'), '#F7F7F7', '底色层仍要带颜色');
  assert.equal(style(head.content).get('color'), '#F7F7F7', '深底表头的文字必须自带浅色，否则微信会盖成深色');
  const body = cell($, 'td');
  assert.equal(style(body.content).get('color'), '#414141');
  // 只补颜色，不把字号行高一并下放，避免改变原有排版。
  assert.equal(style(head.content).has('font-size'), false);
  assert.equal(style(head.content).has('line-height'), false);
});

test('table surfaces: opt-in only; null/default/other strategy return original HTML byte-for-byte', () => {
  const html = `<section id='nice'>\n<table class='probe'><tr><td style='padding:9px;background-color:#e8e8e8'>值 &amp; 内容</td></tr></table>\n</section>`;
  for (const options of [undefined, {}, { policy: null }, { policy: { strategy: 'preserve-backgrounds' } }, { policy: { strategy: 'disabled' } }]) {
    const result = materializeTableSurfaces(html, options);
    assert.equal(result.html, html);
    assert.deepEqual(result.warnings, []);
  }
});

test('table surfaces: missing or non-unique #nice does not pick an arbitrary article', () => {
  const table = '<table><tr><td style="padding:6px;background-color:#ddd">值</td></tr></table>';
  for (const html of [table, `<section id="other">${table}</section>`, wrap(table) + wrap(table)]) {
    assert.equal(run(html).html, html);
  }
});

test('table surfaces: native cell retains internal borders while surface and content own paint and padding separately', () => {
  const html = wrap('<table><thead><tr><th id="header" style="padding:11px 13px;background-color:#303030;color:#f8f8f8;border-right:1px solid #888;border-bottom:1px solid #aaa;border-top-left-radius:10px;font-size:14px;line-height:1.7;font-weight:700;text-align:left;vertical-align:top">表头</th></tr></thead></table>');
  const result = run(html), $ = parse(result.html), { native, surface, content } = cell($, '#header');
  assert.deepEqual(result.warnings, []);
  assert.equal($('table').attr('cellspacing'), '0');
  assert.equal($('table').attr('cellpadding'), '0');
  const ns = style(native), ss = style(surface), cs = style(content);
  assert.equal(ns.get('height'), '1px');
  assert.equal(ns.get('padding'), '0');
  assert.equal(ns.get('background-color'), 'transparent');
  assert.equal(ns.get('border-right'), '1px solid #888');
  assert.equal(ns.get('border-bottom'), '1px solid #aaa');
  assert.equal(ns.get('border-top-left-radius'), undefined);
  assert.equal(ss.get('height'), '100%');
  assert.equal(ss.get('border'), 'none');
  assert.equal(ss.get('padding'), '0');
  assert.equal(ss.get('background-color'), '#303030');
  assert.equal(ss.get('border-top-left-radius'), '10px');
  assert.equal(ss.get('color'), '#f8f8f8');
  for (const [property, value] of [['font-size', '14px'], ['line-height', '1.7'], ['font-weight', '700'], ['text-align', 'left']]) assert.equal(ss.get(property), value);
  assert.equal(cs.get('padding'), '11px 13px');
  assert.equal(surface.attr('data-no-dark') !== undefined, true);
  assert.equal(content.attr('data-no-dark') !== undefined, true);
  assert.equal(content.text(), '表头');
});

test('table surfaces: style-bearing inline descendants are protected without changing text, images, or inline structure', () => {
  const html = wrap('<p id="outside" style="color:#333">表外文本</p><table><tbody><tr><td id="body" style="padding:8px;background-color:#e9e9e9;color:#333"><p style="margin:0">首段 <strong style="color:#222">加粗</strong> 与 <em>斜体</em>、<a href="https://example.com/" style="color:#555">链接</a><br>第二行 &amp; 标点。</p><p>次段 <img src="file:///fixture/diagram.png" alt="图示" width="120" height="80" data-probe="unchanged"> <code style="background-color:#eee;color:#111"><span style="color:#888">内联代码</span></code></p></td></tr></tbody></table>');
  const before = parse(html), result = run(html), $ = parse(result.html), { content } = cell($, '#body');
  assert.equal($('#outside').attr('data-no-dark'), undefined);
  assert.equal(content.find('p[style][data-no-dark],strong[data-no-dark],a[data-no-dark]').length, 3);
  assert.equal(content.find('em[data-no-dark],code[data-no-dark],code [data-no-dark]').length, 0);
  assert.equal(content.text(), before('#body').text());
  assert.deepEqual(content.find('img').attr(), before('#body img').attr());
  assert.equal(content.find('code').toString(), before('#body code').toString());
  const payload = content.clone();
  payload.find('[data-no-dark]').removeAttr('data-no-dark');
  assert.equal(payload.html(), before('#body').html());
  assert.deepEqual(result.warnings, []);
});

test('table surfaces: managed single watermark transfers to the surface with exact geometry and URL', () => {
  const html = wrap(`<table><tr><th id="watermark" style="padding:12px;background-color:#303030;background-image:url('${asset.url}');background-repeat:no-repeat;background-size:42px 32px;background-position:right 8px top 4px;border-top-right-radius:8px;color:#fff">星轨表头</th></tr></table>`);
  const result = run(html), $ = parse(result.html), { native, surface } = cell($, '#watermark');
  assert.deepEqual(result.warnings, []);
  assert.equal(style(native).get('background-image'), undefined);
  const ss = style(surface);
  assert.equal(ss.get('background-image'), `url('${asset.url}')`);
  assert.equal(ss.get('background-repeat'), 'no-repeat');
  assert.equal(ss.get('background-size'), '42px 32px');
  assert.equal(ss.get('background-position'), 'right 8px top 4px');
  assert.equal(ss.get('border-top-right-radius'), '8px');
  assert.equal(surface.attr('data-no-dark') !== undefined, true);
});

test('table surfaces: unknown or unsafe backgrounds preserve the whole affected root table and warn', () => {
  const backgrounds = [
    'url("https://unknown.example/watermark.png")',
    `url('${asset.url}'),url('${asset.url}')`,
    'url("javascript:alert(1)")',
    'linear-gradient(#fff,#333)',
  ];
  for (const background of backgrounds) {
    const html = wrap(`<table><tr><td id="unsafe" style='padding:9px;background-color:#ddd;background-image:${background.replaceAll("'", '&apos;')};color:#111'><strong>不可丢</strong></td><td id="safe" style="padding:7px;background-color:#eee">正常单元格</td></tr></table>`);
    const before = parse(html), result = run(html), $ = parse(result.html);
    assert(result.warnings.length > 0, `Expected a warning for ${background}`);
    assert.equal($('table').toString(), before('table').toString());
    assert.equal($(surfaceSelector).length, 0, 'Do not leave a partially upgraded table');
    assert.equal($('#safe').text(), '正常单元格');
  }
  const malformed = wrap('<table id="malformed"><tr><td style="padding:8px;background-color:#ddd;broken:">无效声明</td></tr></table><table id="independent"><tr><td style="padding:7px;background-color:#eee">独立表格</td></tr></table>');
  const before = parse(malformed), result = run(malformed), $ = parse(result.html);
  assert(result.warnings.length > 0, 'Invalid declarations must not silently enter the protected surface');
  assert.equal($('#malformed').toString(), before('#malformed').toString());
  assert.equal($('#malformed').find(surfaceSelector).length, 0);
  assert.equal($('#independent').find(surfaceSelector).length, 1, 'One rejected table must not block another table');
});

test('table surfaces: managed record must be theme-owned with exact URL and a nonempty file path', () => {
  const html = wrap(`<table><tr><td id="probe" style="background-image:url('${asset.url}');background-color:#ddd;padding:8px">原样保留</td></tr></table>`);
  for (const backgroundImages of [[], [{ ...asset, origin: 'article' }], [{ ...asset, filePath: '' }], [{ ...asset, filePath: null }], [{ ...asset, url: `${asset.url}?v=2` }]]) {
    const before = parse(html), result = run(html, { backgroundImages }), $ = parse(result.html);
    assert(result.warnings.length > 0);
    assert.equal($('#probe').toString(), before('#probe').toString());
    assert.equal($(surfaceSelector).length, 0);
  }
});

test('table surfaces: article scope is isolated and pre, code, and task-scope tables stay unchanged', () => {
  const table = id => `<table id="${id}"><tr><td style="padding:7px;background-color:#ddd"><span style="color:#333">${id}</span></td></tr></table>`;
  const prefix = `<aside data-a='1'>${table('outside-before')}</aside>\n`;
  const suffix = `\n<footer data-z='2'>${table('outside-after')}</footer>`;
  const html = prefix + wrap(`<pre>${table('pre-table')}</pre><code>${table('code-table')}</code><section data-wechat-list-task-scope="true">${table('task-table')}</section>${table('inside-table')}`) + suffix;
  const before = parse(html), result = run(html), $ = parse(result.html);
  assert(result.html.startsWith(prefix));
  assert(result.html.endsWith(suffix));
  for (const id of ['outside-before', 'outside-after', 'pre-table', 'code-table', 'task-table']) assert.equal($(`#${id}`).toString(), before(`#${id}`).toString());
  assert.equal($('#inside-table').find(surfaceSelector).length, 1);
  assert.equal($(surfaceSelector).length, 1);
  const nestedExcluded = wrap(`<table id="host"><tr><td style="padding:8px;background-color:#eee">正常内容<pre>${table('nested-pre')}</pre><section data-wechat-list-task-scope="true">${table('nested-task')}</section></td></tr></table>`);
  const nestedBefore = parse(nestedExcluded), nestedAfter = parse(run(nestedExcluded).html);
  for (const id of ['nested-pre', 'nested-task']) assert.equal(nestedAfter(`#${id}`).toString(), nestedBefore(`#${id}`).toString(), 'Excluded tables remain unchanged even when embedded inside a transformed cell');
});

test('table surfaces: repeating the transformation is byte-idempotent and never nests duplicate surfaces', () => {
  const html = wrap('<table><tr><td style="padding:8px;background-color:#ddd"><strong style="color:#222">甲</strong></td><td style="padding:8px;background-color:transparent">乙</td></tr></table>');
  const first = run(html), second = run(first.html), $ = parse(second.html);
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(second.warnings, []);
  assert.equal(second.html, first.html);
  assert.equal($(surfaceSelector).length, 2);
  assert.equal($(contentSelector).length, 2);
  assert.equal($(`${surfaceSelector} ${surfaceSelector}`).length, 0);
});

test('table surfaces: single cell and absent tbody preserve the original native structure', () => {
  for (const markup of [
    '<table><tr><td id="only" style="padding:6px;background-color:#eee;border-radius:8px">单格</td></tr></table>',
    '<table><thead><tr><th id="only" style="padding:6px;background-color:#303030;color:#fff;border-radius:8px">仅表头</th></tr></thead></table>',
  ]) {
    const html = wrap(markup), before = parse(html), result = run(html), $ = parse(result.html);
    assert.deepEqual(structuralTags($), structuralTags(before));
    assert.equal($('tbody').length, 0);
    assert.equal(cell($, '#only').content.text(), before('#only').text());
    assert.equal(style($('#only').children(surfaceSelector)).get('border-radius'), '8px');
    assert.deepEqual(result.warnings, []);
  }
});

test('table surfaces: rowspan, colspan, alignment and row/cell ordering retain native table semantics', () => {
  const html = wrap('<table aria-label="跨行跨列表"><thead><tr><th colspan="2" align="center" style="padding:9px;color:#fff;background-color:#333">合并表头</th></tr></thead><tbody><tr><td rowspan="2" align="right" style="padding:8px;background-color:#eee">跨两行</td><td align="left" style="padding:8px">第一行</td></tr><tr><td style="padding:8px">第二行</td></tr></tbody></table>');
  const before = parse(html), result = run(html), $ = parse(result.html);
  assert.deepEqual(structuralTags($), structuralTags(before));
  assert.deepEqual(rows($), rows(before));
  assert.equal($('table').attr('aria-label'), '跨行跨列表');
  assert.deepEqual($('th,td').map((_, node) => $(node).text()).get(), before('th,td').map((_, node) => before(node).text()).get());
  assert.equal($(surfaceSelector).length, 4);
  assert.equal($(contentSelector).length, 4);
  assert.deepEqual(result.warnings, []);
});

test('table surfaces: nested tables transform each native cell once without reparenting rows or losing surrounding text', () => {
  const html = wrap('<table id="outer"><tr><td id="outer-cell" style="padding:12px;background-color:#eee">外层前文<table id="inner"><tr><td id="inner-cell" style="padding:5px;background-color:#ddd">内层<strong style="color:#222">重点</strong></td></tr></table><p>外层后文</p></td><td id="sibling-cell" style="padding:8px">同级</td></tr></table>');
  const before = parse(html), result = run(html), $ = parse(result.html);
  assert.deepEqual(structuralTags($), structuralTags(before));
  assert.equal($('table').length, 2);
  assert.equal($('#outer > tr').length, 1);
  assert.equal($('#outer > tr > td').length, 2);
  assert.equal($('#inner > tr > td').length, 1);
  const outer = cell($, '#outer-cell'), inner = cell($, '#inner-cell');
  assert.equal(outer.content.children('#inner').length, 1);
  assert.equal(outer.content.text(), before('#outer-cell').text());
  assert.equal(inner.content.html().replace(/ data-no-dark(?:="[^"]*")?/g, ''), before('#inner-cell').html());
  assert.equal($(surfaceSelector).length, 3);
  assert.equal($(contentSelector).length, 3);
  assert.equal(run(result.html).html, result.html);
  assert.deepEqual(result.warnings, []);
});

test('table surfaces: paragraphs, explicit breaks, empty cells and code blocks remain in their original content order', () => {
  const html = wrap('<table><tbody><tr><td id="long" style="padding-top:10px;padding-right:12px;padding-bottom:14px;padding-left:16px;background-color:#eee"><p style="margin:0 0 8px">第一段<br>强制换行</p><p>第二段</p><pre style="padding:7px;background-color:#222"><code style="color:#fff">const x = 1;\nconst y = 2;</code></pre><p>结尾</p></td><td id="empty" style="padding:8px;background-color:transparent"></td></tr></tbody></table>');
  const before = parse(html), result = run(html), $ = parse(result.html), { content } = cell($, '#long');
  assert.equal(content.text(), before('#long').text());
  assert.deepEqual(content.children().toArray().map(node => node.name), ['p', 'p', 'pre', 'p']);
  assert.equal(content.find('br').length, 1);
  assert.equal(content.find('pre').toString(), before('#long pre').toString());
  assert.equal(content.find('pre[data-no-dark],pre [data-no-dark]').length, 0);
  for (const [property, value] of [['padding-top', '10px'], ['padding-right', '12px'], ['padding-bottom', '14px'], ['padding-left', '16px']]) assert.equal(style(content).get(property), value);
  assert.equal(cell($, '#empty').content.html(), '');
  assert.equal($('#empty').text(), '');
  assert.deepEqual(result.warnings, []);
});

test('table surfaces: transparent middle row gains no invented paint, borders, content, or whole-article protection', () => {
  const html = wrap('<p style="color:#444;background-color:#fafafa">保持正文</p><table style="border:none"><tbody><tr><td id="middle" style="padding:10px;border-right:1px solid #aaa;border-bottom:1px solid #bbb;background-color:transparent;color:#333">中间行</td></tr><tr><td id="last" style="padding:10px;border-bottom:none;border-bottom-left-radius:9px;border-bottom-right-radius:9px;background-color:#e9e9e9;color:#333">灰色末行</td></tr></tbody></table>');
  const before = parse(html), result = run(html), $ = parse(result.html);
  assert.equal($('#nice > p').toString(), before('#nice > p').toString());
  assert.equal($('#nice').attr('data-no-dark'), undefined);
  const middle = cell($, '#middle'), last = cell($, '#last');
  assert.equal(style(middle.surface).get('background-color'), 'transparent');
  assert.equal(style(middle.native).get('border-right'), '1px solid #aaa');
  assert.equal(style(middle.native).get('border-bottom'), '1px solid #bbb');
  assert.equal(style(last.native).get('border-bottom'), 'none');
  assert.equal(style(last.surface).get('background-color'), '#e9e9e9');
  assert.equal(style(last.surface).get('border-bottom-left-radius'), '9px');
  assert.equal(style(last.surface).get('border-bottom-right-radius'), '9px');
  assert.equal(style(last.surface).get('border'), 'none');
  assert.deepEqual($('td').map((_, node) => $(node).text()).get(), ['中间行', '灰色末行']);
  assert.deepEqual(result.warnings, []);
});
