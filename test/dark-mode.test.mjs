import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio/slim';
import { applyWechatDarkMode } from '../src/dark-mode.mjs';

const policy = { strategy: 'preserve-backgrounds', tableBorderColor: '#C9A45C' };
const url = id => `app://vault/${id}.png`;
const background = (id, extra = '') => `background-color:transparent;background-image:url('${url(id)}');background-size:72px 72px;background-position:10px 20px;background-repeat:no-repeat;${extra}`;
const record = id => ({ target: id, url: url(id), origin: 'theme', filePath: `/vault/${id}.png`, wechatUrl: `https://mmbiz.qpic.cn/mmbiz_png/${id}/640?wx_fmt=png` });
const assets = ['paper', 'heading', 'crescent', 'quote', 'bullet', 'table-line', 'divider', 'code'].map(record);
const run = html => applyWechatDarkMode(html, { policy, backgroundImages: assets });
const parse = html => load(html, {}, false);

test('默认未启用时 HTML 字节不变，也不会产生图片或警告', () => {
  const html = `<section id='nice' style="${background('paper')}"><hr style="${background('divider')}"></section>`;
  for (const options of [undefined, {}, { policy: null, backgroundImages: assets }]) {
    const result = applyWechatDarkMode(html, options);
    assert.equal(result.html, html);
    assert.deepEqual(result.images, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.backgroundImageUrls, undefined);
  }
});

test('仅改变 #nice，外部片段字节不变且根属性顺序与所在位置保留', () => {
  const prefix = `<header data-a='one' style="${background('quote')}">外面</header>\n<!-- before -->`;
  const suffix = `<!-- after -->\n<footer data-b='two'>尾部</footer>`;
  const result = run(`${prefix}<section id="nice" class="article" style="${background('paper')}"><p style="color:#fff">正文</p></section>${suffix}`);
  assert(result.html.startsWith(prefix));
  assert(result.html.endsWith(suffix));
  assert.match(result.html, /<section id="nice" class="article"/);
  assert.equal(parse(result.html)('#nice').length, 1);
  assert.equal(parse(result.html)('header').attr('data-no-dark'), undefined);
  assert.equal(parse(result.html)('#nice > p').attr('data-no-dark'), '');
});

test('保留 H1/H2/下划线结构与所有 CSS，只添加保护标记', () => {
  const html = `<section id="nice"><h1 style="${background('heading', 'font-size:0')}"><span style="font-size:28px">一级</span></h1><h2 style="${background('crescent', 'font-size:0')}"><span style="font-size:21px">二级</span></h2><u style="${background('divider')}">下划线</u></section>`;
  const before = parse(html), after = parse(run(html).html);
  after('[data-no-dark]').removeAttr('data-no-dark');
  for (const selector of ['h1', 'h2', 'u']) assert.equal(after.html(after(selector)[0]), before.html(before(selector)[0]));
});

test('引用保留 blockquote 语义、19px 活文字与左图顶部对齐，外边距仅在外壳', () => {
  const html = `<section id="nice"><blockquote cite="https://example.test/quote" style="margin:38px 0;min-height:114px;padding:20px 12px 20px 90px;border:1px solid #66532E;border-radius:6px;color:#F2E7D0;${background('quote')}text-align:left;"><p style="font-size:19px;line-height:1.8;margin:0 0 14px">引用<strong style="color:#EFD078">加粗</strong></p><p style="font-size:19px;line-height:1.8">第二段</p></blockquote></section>`;
  const result = run(html), $ = parse(result.html);
  const outer = $('blockquote'), inner = outer.children('section');
  assert.equal(outer.length, 1);
  assert.equal(outer.attr('cite'), 'https://example.test/quote');
  assert.equal(outer.attr('data-no-dark'), undefined);
  assert.match(outer.attr('style'), /margin:38px 0/);
  assert.doesNotMatch(outer.attr('style'), /background-image|padding:20/);
  assert.equal(inner.attr('data-no-dark'), '');
  assert.match(inner.attr('style'), /padding:20px 12px 20px 90px/);
  assert.match(inner.attr('style'), /background-position:10px 20px/);
  assert.match(inner.attr('style'), /text-align:left/);
  assert.match(inner.attr('style'), /margin:0(?:;|$)/);
  assert.doesNotMatch(inner.attr('style'), /margin:38/);
  assert.equal(inner.children('p').length, 2);
  assert.match(inner.children('p').first().attr('style'), /font-size:19px;line-height:1.8/);
  assert.equal(outer.text(), '引用加粗第二段');
  assert.deepEqual(result.backgroundImageUrls, [url('quote')]);
});

test('普通 li 将背景和占位移入 section，嵌套 UL/OL 与多段内容保持合法', () => {
  const html = `<section id="nice"><ul><li style="margin:8px 0;color:#D8D3C9;font-size:16px;padding-left:25px;${background('bullet')}"><p>第一段</p><p>第二段</p><ul><li style="padding-left:25px;${background('bullet')}">嵌套<ol start="3"><li>有序项</li></ol></li></ul><p>末尾段</p></li></ul></section>`;
  const before = parse(html), result = run(html), $ = parse(result.html);
  const listShape = dom => dom('ul,ol,li').toArray().map(el => ({ tag: el.tagName, lists: dom(el).parents('ul,ol,li').toArray().map(p => p.tagName) }));
  assert.deepEqual(listShape($), listShape(before));
  assert.equal($.root().text(), before.root().text());
  assert.equal($('span ul,span ol').length, 0);
  assert.equal($('[data-wechat-darkmode-surface="list"]').length, 2);
  assert.equal($('ol').attr('start'), '3');
  assert.match($('li').first().attr('style'), /padding:0/);
  assert.doesNotMatch($('li').first().attr('style'), /background-image/);
  assert.match($('li').first().children('section').attr('style'), /padding-left:25px/);
});

test('嵌套引用从内向外处理，普通内层引用不强行重复月亮图标', () => {
  const html = `<section id="nice"><blockquote style="margin:38px 0;padding:20px;${background('quote')}"><p style="font-size:19px">外层</p><blockquote style="margin:14px 0;padding:14px 16px;background-color:transparent"><p style="font-size:16px">普通内层</p></blockquote><blockquote style="margin:18px 0;padding:20px;${background('quote')}"><p style="font-size:19px">带图内层</p></blockquote></blockquote></section>`;
  const result = run(html), $ = parse(result.html);
  assert.equal($('blockquote').length, 3);
  assert.equal($('[data-wechat-darkmode-surface="quote"]').length, 2);
  assert.equal($('blockquote').eq(1).children('section').length, 0);
  assert.equal($.root().text(), '外层普通内层带图内层');
  assert.equal(run(result.html).html, result.html);
});

test('任务子树仅为受管图片 marker 添加保护，不误改状态、文字和行内代码', () => {
  const tasks = `<li class="wechat-task-item" data-task="x" style="padding:0;${background('bullet')}"><span class="wechat-task-marker is-checked" style="${background('crescent')}">✓</span><p style="font-size:16px">已完成<code style="background-color:#111">x</code></p></li><li class="task-list-item" style="padding:0"><input type="checkbox"><span style="color:#fff">未完成</span></li>`;
  const html = `<section id="nice"><ul>${tasks}</ul></section>`;
  const before = parse(html), after = parse(run(html).html);
  assert.equal(after('ul [data-no-dark]').length, 1);
  assert.equal(after('.wechat-task-marker').attr('data-no-dark'), '');
  after('.wechat-task-marker').removeAttr('data-no-dark');
  assert.equal(after('ul').html(), before('ul').html());
});

test('代码块和行内代码连保护标记也不改，不将代码包装为 section', () => {
  const html = `<section id="nice"><pre style="${background('code')}"><code style="background-color:#0A0D14;padding:16px"><span style="color:#ffe">const a = 1;</span></code></pre><p style="color:#fff">行内<code style="background-color:#111;color:#eee">a</code></p></section>`;
  const before = parse(html), after = parse(run(html).html);
  for (const selector of ['pre', 'p > code']) assert.equal(after.html(after(selector)[0]), before.html(before(selector)[0]));
  assert.equal(after('pre section,code section').length, 0);
});

test('表格背景线变为纯 CSS 金线，原生层级、colspan/rowspan、width 和 padding 保留', () => {
  const html = `<section id="nice"><table style="width:100%;margin:34px 0"><thead><tr><th colspan="2" scope="colgroup" style="width:60%;padding:14px 10px 16px;border-top:1px solid #73603B;${background('table-line')}">表头</th></tr></thead><tbody><tr><td rowspan="2" style="padding:14px 0 20px;border-left:10px solid transparent;${background('table-line')}"><section>跨行</section></td><td>42</td></tr><tr><td>108</td></tr></tbody></table></section>`;
  const result = run(html), $ = parse(result.html);
  assert.equal($('table > thead > tr > th').attr('colspan'), '2');
  assert.equal($('th').attr('scope'), 'colgroup');
  assert.equal($('tbody > tr').length, 2);
  assert.equal($('td').first().attr('rowspan'), '2');
  assert.match($('th').attr('style'), /width:60%;padding:14px 10px 16px/);
  assert.match($('th').attr('style'), /border-bottom:2px solid #C9A45C/);
  assert.match($('td').first().attr('style'), /padding:14px 0 20px/);
  assert.match($('td').first().attr('style'), /border-bottom:1px solid #C9A45C/);
  assert.equal($('th[data-no-dark],td[data-no-dark]').length, 0);
  assert.equal($('th,td').toArray().filter(el => ($(el).attr('style') || '').includes('background-image')).length, 0);
  assert(!result.backgroundImageUrls.includes(url('table-line')));
});

test('分割线改真实 img：本地 URL、原比例、role 与复制 CDN 优先记录全部保留', () => {
  const html = `<section id="nice"><hr id="break-1" style="width:100%;max-width:560px;height:78px;margin:44px auto;${background('divider')}"></section>`;
  const result = run(html), $ = parse(result.html), separator = $('[role="separator"]');
  assert.equal($('hr').length, 0);
  assert.equal(separator.attr('id'), 'break-1');
  assert.equal(separator.attr('aria-orientation'), 'horizontal');
  assert.match(separator.attr('style'), /width:100%;max-width:560px/);
  assert.match(separator.attr('style'), /margin:44px auto/);
  assert.doesNotMatch(separator.attr('style'), /(?:^|;)(?:height|min-height|max-height|overflow|object-fit|background-image)\s*:/);
  assert.equal(separator.children('img').attr('src'), url('divider'));
  assert.equal(separator.children('img').attr('alt'), '');
  assert.match(separator.children('img').attr('style'), /width:100%;max-width:100%;height:auto/);
  assert.deepEqual(result.images, [{ ...record('divider'), preferWechatUrl: true }]);
  assert.deepEqual(result.backgroundImageUrls, []);
});

test('支持精确受管 file/app/local 位图 URL，不强行把本地 URL 改为远程地址', () => {
  for (const assetUrl of ['file:///vault/%E6%9C%88.png', 'app://vault/moon.png?rev=2', 'local://asset/moon.png']) {
    const image = { target: 'moon', url: assetUrl, origin: 'theme', filePath: '/vault/moon.png' };
    const result = applyWechatDarkMode(`<section id="nice"><hr style="background-image:url('${assetUrl}')"></section>`, { policy, backgroundImages: [image] });
    assert.equal(parse(result.html)('[role="separator"] img').attr('src'), assetUrl);
    assert.deepEqual(result.images, [{ ...image, preferWechatUrl: true }]);
  }
});

test('已经转换的 HTML 再执行不会重复包装；图片记录与实际背景集合仍然完整', () => {
  const html = `<section id="nice" style="${background('paper')}"><blockquote style="padding:20px;${background('quote')}"><p style="font-size:19px">引用</p></blockquote><ul><li style="padding-left:25px;${background('bullet')}">列表</li></ul><table><tr><td style="${background('table-line')}">表格</td></tr></table><hr style="height:78px;${background('divider')}"><hr style="height:78px;${background('divider')}"></section>`;
  const first = run(html), second = run(first.html);
  assert.equal(second.html, first.html);
  assert.deepEqual(second.images, first.images);
  assert.equal(second.images.length, 1);
  assert.deepEqual(second.backgroundImageUrls, first.backgroundImageUrls);
  assert.deepEqual(new Set(second.backgroundImageUrls), new Set([url('paper'), url('quote'), url('bullet')]));
});

test('移除表格/分割线背景后，相同素材在其他真实背景仍使用时不能误删元数据', () => {
  const html = `<section id="nice"><h2 style="${background('divider')}">标题</h2><hr style="${background('divider')}"><pre style="${background('table-line')}"><code>code</code></pre><table><tr><td style="${background('table-line')}">内容</td></tr></table></section>`;
  const result = run(html);
  assert.deepEqual(new Set(result.backgroundImageUrls), new Set([url('divider'), url('table-line')]));
  assert.equal(result.images[0].target, 'divider');
});

test('未登记、近似 URL、非主题记录和缺 filePath 的背景不会升级', () => {
  const unknown = url('unknown');
  const html = `<section id="nice"><hr style="background-image:url('${unknown}')"></section>`;
  for (const backgroundImages of [[], [{ ...record('unknown'), url: `${unknown}?revision=1` }], [{ ...record('unknown'), origin: 'article' }], [{ ...record('unknown'), filePath: undefined }]]) {
    const result = applyWechatDarkMode(html, { policy, backgroundImages });
    assert.equal(parse(result.html)('hr').length, 1);
    assert.equal(parse(result.html)('[role="separator"]').length, 0);
    assert.deepEqual(result.images, []);
    assert(result.warnings.some(w => w.includes('未登记')));
  }
});

test('危险 URL、伪造 allowlist、多重图片和损坏 CSS 不会被提升为 img', () => {
  for (const assetUrl of ['javascript:alert(1)', 'https://example.test/unregistered.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'file:///vault/moon.png" onerror="alert(1)']) {
    const safeAttributeUrl = assetUrl.replaceAll('"', '&quot;');
    const html = `<section id="nice"><hr style="background-image:url('${safeAttributeUrl}')"></section>`;
    const result = applyWechatDarkMode(html, { policy, backgroundImages: [{ target: 'x', url: assetUrl, origin: 'theme', filePath: '/vault/x.png' }] });
    assert.equal(parse(result.html)('[role="separator"] img').length, 0);
    assert.deepEqual(result.images, []);
  }
  for (const badStyle of [`background-image:url('${url('divider')}'),url('${url('quote')}')`, `background-image:url('${url('divider')}');color:`, `color:#fff}evil{background:red`]) {
    const result = run(`<section id="nice"><hr style="${badStyle}"></section>`);
    assert.equal(parse(result.html)('[role="separator"] img').length, 0);
  }
});

test('策略与输入错误安全降级；缺根、重复根和未闭合根返回原 HTML 加警告', () => {
  const html = '<section id="nice"><p>文字</p></section>';
  for (const invalid of [false, 'preserve-backgrounds', {}, { strategy: 'unknown' }, { strategy: 'preserve-backgrounds', tableBorderColor: '#fff;position:fixed' }]) {
    const result = applyWechatDarkMode(html, { policy: invalid });
    assert.equal(result.html, html);
    assert.equal(result.warnings.length, 1);
  }
  for (const malformed of ['<section><p>没根</p></section>', '<section id="nice"></section><section id="nice"></section>', '<section id="nice"><p>没闭合</p>']) {
    const result = run(malformed);
    assert.equal(result.html, malformed);
    assert.equal(result.warnings.length, 1);
  }
  assert.equal(applyWechatDarkMode(html, null).html, html);
  assert.equal(applyWechatDarkMode(null, { policy }).html, '');
});

const tableFrame = { borderAssetId: 'table-line', surfaceAssetId: 'paper', borderWidth: 2, borderRadius: 10 };
const framed = (html, frame = tableFrame, backgroundImages = assets) => applyWechatDarkMode(html, {
  policy: { ...policy, tableFrame: frame }, backgroundImages,
});

test('表格外框只使用两层有保护标记的 section，继承夜空参数，不使用裁切或多背景', () => {
  const html = `<section id="nice" style="background-color:#07080C;background-image:url('${url('paper')}');background-size:627px 627px;background-repeat:repeat;background-position:left top"><table style="width:100%;margin:24px 0 12px;color:#E2DCCD;font-size:14px"><tr><th style="padding:16px 6px 14px;color:#F0CD70;font-size:16px;border-bottom:1px solid #B69A57">金色表头</th></tr><tr><td style="padding:12px 6px 14px;border-bottom:none">内容</td></tr></table></section>`;
  const result = framed(html), $ = parse(result.html);
  const outer = $('[data-wechat-darkmode-surface="table-frame"]');
  const inner = outer.children('[data-wechat-darkmode-surface="table-surface"]');
  assert.equal(outer.length, 1);
  assert.equal(inner.length, 1);
  assert.equal(outer.attr('data-no-dark'), '');
  assert.equal(inner.attr('data-no-dark'), '');
  assert.match(outer.attr('style'), /padding:2px/);
  assert.match(outer.attr('style'), /border-radius:10px/);
  assert.match(outer.attr('style'), /margin:24px 0 12px/);
  assert.match(inner.attr('style'), /padding:6px 8px 8px/);
  assert.match(inner.attr('style'), /border-radius:8px/);
  assert.match(inner.attr('style'), /background-color:#07080C/);
  assert.match(inner.attr('style'), /background-size:627px 627px/);
  assert.match(inner.attr('style'), /background-repeat:repeat/);
  assert.match(inner.attr('style'), /background-position:left top/);
  assert.equal(inner.children('table').length, 1);
  assert.match($('table').attr('style'), /margin:0/);
  assert.doesNotMatch(result.html, /overflow|position:absolute|border-image|object-fit|linear-gradient|radial-gradient|<svg/);
  assert.equal($('table,th,td').toArray().filter(node => ($(node).attr('style') || '').includes('background-image')).length, 0);
  assert.equal($('table,th,td').filter('[data-no-dark]').length, 0);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.images, []);
  assert.deepEqual(new Set(result.backgroundImageUrls), new Set([url('paper'), url('table-line')]));
});

test('框架不覆盖表头字号/配色/单元格 padding 或已设置的淡金线、末行无底线', () => {
  const table = `<table class="original" style="width:100%;margin:24px 0 12px"><caption>表格标题</caption><colgroup><col width="40%"><col width="60%"></colgroup><thead><tr><th colspan="2" scope="colgroup" style="padding:16px 6px 14px;font-size:16px;color:#F0CD70;border-bottom:1px solid #B69A57">长标题仍自然换行</th></tr></thead><tbody><tr><td rowspan="2" style="padding:12px 6px 14px;color:#D8D3C9;border-bottom:1px solid #5D4C2D"><p>第一格</p></td><td style="padding:4px">42</td></tr><tr><td style="border-bottom:none">末行</td></tr></tbody></table>`;
  const before = parse(table), after = parse(framed(`<section id="nice">${table}</section>`).html);
  assert.equal(after('table').attr('class'), 'original');
  assert.equal(after('caption').text(), '表格标题');
  assert.equal(after('colgroup').html(), before('colgroup').html());
  assert.equal(after('th').attr('style'), before('th').attr('style'));
  assert.deepEqual(after('td').map((_,n) => after(n).attr('style')).get(), before('td').map((_,n) => before(n).attr('style')).get());
  assert.equal(after('th').attr('colspan'), '2');
  assert.equal(after('td').first().attr('rowspan'), '2');
  assert.equal(after('thead > tr > th > span').length, 0, 'Do not add short-heading layout rules');
});

test('table 的 margin 简写和覆盖长写只移到外框一次，来源 width/padding 留在 table', () => {
  const html = '<section id="nice"><table style="width:80%;padding:3px;margin:30px auto;margin-top:12px;margin-bottom:9px"><tr><td>文本</td></tr></table></section>';
  const result = framed(html), $ = parse(result.html);
  assert.match($('[data-wechat-darkmode-surface="table-frame"]').attr('style'), /margin:30px auto;margin-top:12px;margin-bottom:9px/);
  assert.match($('table').attr('style'), /width:80%;padding:3px/);
  assert.match($('table').attr('style'), /margin:0/);
  assert.doesNotMatch($('table').attr('style'), /margin-top|margin-bottom|margin:30/);
  assert.equal(framed(result.html).html, result.html);
});

test('surfacePadding 支持 1–4 个安全数值，内圆角跟随外圆角减线宽', () => {
  const html = '<section id="nice"><table><tr><td>文字</td></tr></table></section>';
  for (const padding of [[0], [6,8], [6,8,8], [0,1.5,24,3]]) {
    const result = framed(html, { ...tableFrame, borderWidth:3, borderRadius:12, surfacePadding:padding });
    const inner = parse(result.html)('[data-wechat-darkmode-surface="table-surface"]');
    assert(inner.attr('style').includes(`padding:${padding.map(v=>`${v}px`).join(' ')}`));
    assert.match(inner.attr('style'), /border-radius:9px/);
    assert.deepEqual(result.warnings, []);
  }
});

test('根纹理的合法比例/平铺/位置和背景色完整带入内面板，不改 root 自身样式', () => {
  const rootStyle = `background-color:#11151C;background-image:url('${url('paper')}');background-size:314px 60%;background-repeat:repeat-x;background-position:12px 20%`;
  const result = framed(`<section id="nice" style="${rootStyle}"><table><tr><td>内容</td></tr></table></section>`);
  const $=parse(result.html), inner=$('[data-wechat-darkmode-surface="table-surface"]');
  assert.equal($('#nice').attr('style'), rootStyle);
  for(const text of ['background-color:#11151C','background-size:314px 60%','background-repeat:repeat-x','background-position:12px 20%']) assert(inner.attr('style').includes(text));
});

test('框架重复执行幂等，多表格不重复嵌套，背景记录只收实际出现的 URL', () => {
  const html = `<section id="nice" style="${background('paper')}"><p style="color:#fff">前文</p><table><tr><td>一</td></tr></table><p>中间</p><table><tr><td>二</td></tr></table><hr style="${background('divider')}"></section>`;
  const first = framed(html), second = framed(first.html), $ = parse(second.html);
  assert.equal(first.html, second.html);
  assert.deepEqual(first.images, second.images);
  assert.deepEqual(first.backgroundImageUrls, second.backgroundImageUrls);
  assert.equal($('[data-wechat-darkmode-surface="table-frame"]').length,2);
  assert.equal($('table').length,2);
  assert.equal($('#nice > p').length,2);
  assert.equal(new Set(first.backgroundImageUrls).size,first.backgroundImageUrls.length);
});

test('frame 资产用 target 独立索引，两个 ID 共用 URL 以及边框/表面同 asset 都可用', () => {
  const common = {url:url('shared'),origin:'theme',filePath:'/vault/shared.png'};
  const backgroundImages=[{...common,target:'frame-a'},{...common,target:'surface-b'}];
  const html='<section id="nice"><table><tr><td>内容</td></tr></table></section>';
  for(const config of [{borderAssetId:'frame-a',surfaceAssetId:'surface-b'},{borderAssetId:'frame-a',surfaceAssetId:'frame-a'}]){
    const result=framed(html,config,backgroundImages);
    assert.equal(parse(result.html)('[data-wechat-darkmode-surface="table-frame"]').length,1);
    assert.deepEqual(result.backgroundImageUrls,[url('shared')]);
    assert.deepEqual(result.warnings,[]);
  }
});

test('缺失或非法 frame 仅跳过表格框，引用/列表/分割线 C 处理继续生效', () => {
  const html=`<section id="nice"><blockquote style="${background('quote')}"><p>引用</p></blockquote><ul><li style="${background('bullet')}">列表</li></ul><table><tr><td>内容</td></tr></table><hr style="${background('divider')}"></section>`;
  const invalidFrames = [false,'frame',{}, {...tableFrame,borderWidth:0},{...tableFrame,borderWidth:5},{...tableFrame,borderWidth:2.5},{...tableFrame,borderRadius:3},{...tableFrame,borderWidth:4,borderRadius:4},{...tableFrame,borderRadius:21},{...tableFrame,surfacePadding:[]},{...tableFrame,surfacePadding:[25]},{...tableFrame,surfacePadding:[Infinity]},{...tableFrame,surfacePadding:['6']},{...tableFrame,surfacePadding:[1,2,3,4,5]},{...tableFrame,borderAssetId:'missing'}];
  for(const frame of invalidFrames){
    const result=framed(html,frame), $=parse(result.html);
    assert.equal($('[data-wechat-darkmode-surface="table-frame"]').length,0);
    assert.equal($('[data-wechat-darkmode-surface="quote"]').length,1);
    assert.equal($('[data-wechat-darkmode-surface="list"]').length,1);
    assert.equal($('[role="separator"] img').length,1);
    assert.equal($('table td').text(),'内容');
    assert(result.warnings.some(w=>w.includes('表格外框')));
  }
});

test('不安全 frame 背景记录不能变成新 section 背景图；无表格时不产生框背景元数据', () => {
  const unsafe={target:'unsafe',url:'javascript:alert(1)',origin:'theme',filePath:'/vault/unsafe.png'};
  const result=framed('<section id="nice"><table><tr><td>内容</td></tr></table></section>',{...tableFrame,borderAssetId:'unsafe'},[...assets,unsafe]);
  assert.equal(parse(result.html)('[data-wechat-darkmode-surface="table-frame"]').length,0);
  assert(!result.html.includes('javascript:'));
  assert.deepEqual(result.backgroundImageUrls,[]);
  const noTables=framed('<section id="nice"><p>只有正文</p></section>');
  assert.deepEqual(noTables.backgroundImageUrls,[]);
  assert.deepEqual(noTables.warnings,[]);
});

test('frame 不接管代码或任务中的表格，也不移除不受管的原生背景图', () => {
  const html=`<section id="nice"><pre style="color:#fff"><table><tr><td>代码里的文字</td></tr></table></pre><ul><li class="wechat-task-item"><table><tr><td>任务里的表</td></tr></table></li></ul><table style="background-image:url('${url('unknown')}')"><tr><td>未知背景表</td></tr></table></section>`;
  const before=parse(html), result=framed(html), after=parse(result.html);
  assert.equal(after.html(after('pre')[0]),before.html(before('pre')[0]));
  assert.equal(after.html(after('.wechat-task-item')[0]),before.html(before('.wechat-task-item')[0]));
  assert.equal(after('[data-wechat-darkmode-surface="table-frame"]').length,0);
  assert(result.warnings.some(w=>w.includes('表格外框')));
});
