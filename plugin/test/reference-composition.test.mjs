import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio/slim';
import { parseThemeManifest } from '../src/theme-package.mjs';
import { renderArticle } from '../src/pipeline.mjs';
import { planReferenceComposition, applyReferenceComposition, scaleReferenceCss, scaleReferenceHeadingRule, scaleReferenceQuoteRule, referenceSceneOverlapPolicy } from '../src/reference-composition.mjs';
import { createReferenceLayoutSource, replayReferenceLayout, referenceCopyLayoutWidth } from '../plugin/reference-layout.mjs';

const composition = { strategy: 'opening-feature', designWidth: 390 };
const documentFlow = { strategy: 'document-flow', designWidth: 390 };
const manifest = (patch = {}) => JSON.stringify({ schema_version: 3, theme_id: 'scene-test', name: '场景排版', assets: [], components: [], ...patch });
const source = [
  '# 沙海中的<br>选择', '导语甲。', '导语乙。',
  '## 留在沙面上的痕迹', '> 命运尚未写定，<br>选择已经开始。',
  '说明保留 **强调** 与 & 符号。', '```json\n{\n  "value": "<>&"\n}\n```',
  '| 意象 | 形状 |\n| --- | --- |\n| 沙丘 | 曲线 |',
].join('\n\n');
const components = [
  { id: 'brand', slot: 'before_article', html: '<section class="brand"><p>沙丘菲林</p></section>', assetIds: [] },
  { id: 'code-head', slot: 'before_codeblock', html: '<section class="code-head"><span>三个刻印</span></section>', assetIds: [] },
  { id: 'table-head', slot: 'before_table', html: '<section class="table-head"></section>', assetIds: [] },
];
const css = '#nice{font-size:13px;padding:0}#nice [data-wechat-scene="opening"]>h1{margin-left:10%;width:44%}#nice [data-wechat-scene="feature"]>blockquote{margin-left:40%;width:50%}#nice pre{padding:10px;border:1px solid #333333}#nice p{margin-bottom:16px}';
const render = (patch = {}) => renderArticle({ source, themeCss: css, themeComponents: components, resolve: () => null, referenceComposition: composition, layoutWidth: 390, ...patch });

test('reference composition schema is explicit, strict, and absent from legacy metadata', () => {
  assert.equal(Object.hasOwn(parseThemeManifest(manifest()), 'referenceComposition'), false);
  assert.deepEqual(parseThemeManifest(manifest({ reference_composition: { strategy: 'opening-feature', design_width: 390 } })).referenceComposition, composition);
  assert.deepEqual(parseThemeManifest(manifest({ reference_composition: { strategy: 'document-flow', design_width: 390 } })).referenceComposition, documentFlow);
  for (const value of [true, { strategy: 'other', design_width: 390 }, { strategy: 'opening-feature', design_width: 0 }, { strategy: 'opening-feature', design_width: 390, arbitrary_selector: 'body' }]) {
    assert.throws(() => parseThemeManifest(manifest({ reference_composition: value })), /reference_composition/);
  }
});

test('original block groups include brand and code slots while table stays a root sibling', () => {
  const result = render();
  const $ = load(result.html, null, false);
  assert.equal($('#nice > [data-wechat-scene]').length, 2);
  const opening = $('[data-wechat-scene="opening"]');
  assert.deepEqual(opening.children().toArray().map(n => n.name), ['section', 'h1', 'p', 'p']);
  assert.equal(opening.find('.brand').text(), '沙丘菲林');
  const feature = $('[data-wechat-scene="feature"]');
  assert.deepEqual(feature.children().toArray().map(n => n.name), ['h2', 'blockquote', 'p', 'section', 'pre']);
  assert.equal(feature.find('.code-head').length, 1);
  assert.equal(feature.find('pre code').text(), '{\n  "value": "<>&"\n}');
  assert.equal(feature.find('strong').text(), '强调');
  assert.equal($('#nice > table').length, 1);
  assert.equal($('#nice > table').attr('cellspacing'), '0');
  assert.equal($('#nice > table').attr('cellpadding'), '0');
  assert.equal($('#nice > .table-head').length, 1);
  assert.doesNotMatch(result.html, /data-wechat-reference-block/);
  assert.deepEqual(result.warnings, []);
});

test('nested headings do not become opening scenes; only the first direct quote gains the feature scene', () => {
  const text = ['> # 嵌套标题', '# 真正开篇', '导语。', '## 未匹配小标题', '中间正文。', '> 随后引用。', '## 匹配场景', '> 外层引用。\n>\n> > 内层引用。', '- 列表终止场景', '结尾正文。'].join('\n\n');
  const result = render({ source: text });
  const $ = load(result.html, null, false);
  assert.equal($('[data-wechat-scene="opening"] > h1').text(), '真正开篇');
  assert.equal($('[data-wechat-scene="feature"]').length, 1);
  assert.equal($('[data-wechat-scene="feature"]').attr('data-wechat-scene-variant'), 'standalone');
  assert.equal($('[data-wechat-scene="feature"] > blockquote h1').text(), '嵌套标题');
  assert.equal($('[data-wechat-scene="feature"] > h2').length, 0);
  assert.equal($('#nice > blockquote blockquote').length, 1);
  assert.equal($('#nice > ul').length, 1);
  assert.ok($('#nice').text().indexOf('中间正文。') < $('#nice').text().indexOf('随后引用。'));
});

test('long articles keep later paragraphs and long code in ordinary root flow without truncation or duplicated components', () => {
  const paragraphs = Array.from({ length: 25 }, (_, i) => `导语段落${i}。`);
  const lines = Array.from({ length: 60 }, (_, i) => `  item_${i}: ${i}`).join('\n');
  const result = render({ source: ['# 长文章', ...paragraphs, '## 小标题', '> 金句。', ...paragraphs, '```text\n' + lines + '\n```', '## 下一章节', '后续正文。'].join('\n\n') });
  const $ = load(result.html, null, false);
  assert.equal($('[data-wechat-scene="opening"] > p').length, 2);
  assert.equal($('[data-wechat-scene="feature"] > p').length, 1);
  assert.equal($('#nice > p').length, 48);
  assert.equal($('#nice > pre code').text(), lines);
  assert.equal($('.code-head').length, 1);
  assert.equal($('#nice > h2').text(), '下一章节');
});

test('composition is idempotent and opt-out leaves legacy render byte-for-byte unchanged', () => {
  const once = render().html;
  const secondPlan = planReferenceComposition(once, composition);
  assert.equal(applyReferenceComposition(secondPlan.html, secondPlan), once);
  const legacy = render({ referenceComposition: undefined });
  const explicitOff = render({ referenceComposition: null, layoutWidth: 887 });
  assert.deepEqual(legacy, explicitOff);
  assert.doesNotMatch(legacy.html, /data-wechat-scene/);
});

test('reference scaling changes every px declaration while preserving ratios, strings, URLs and caller rules', () => {
  const input = '#nice{font-size:13px;margin:10px 5%;line-height:1.8;border:1px solid #000;background-image:url("theme-asset://tile12px");font-family:"Font12px"}';
  const scaled = scaleReferenceCss(input, composition, 780);
  assert.match(scaled, /font-size:26px/);
  assert.match(scaled, /margin:20px 5%/);
  assert.match(scaled, /line-height:1.8/);
  assert.match(scaled, /border:2px/);
  assert.match(scaled, /tile12px/);
  assert.match(scaled, /Font12px/);
  assert.equal(scaleReferenceCss(input, null, 780), input);
  const rule = { fontSize: 40, letterSpacing: 3.5, maxWidth: 354, minDisplayWidth: 284, minEffectiveFontSize: 40, paddingX: 4, paddingY: 6, maxLines: 5, lineHeight: 1.2, scale: 3 };
  const copied = scaleReferenceHeadingRule(rule, composition, 780);
  assert.equal(copied.fontSize, 80); assert.equal(copied.paddingX, 0); assert.equal(copied.paddingY, 12);
  assert.equal(copied.maxLines, 5); assert.equal(copied.scale, 3); assert.equal(copied.lineHeight, 1.2);
  assert.equal(rule.fontSize, 40); assert.equal(rule.paddingX, 4);
  assert.equal(scaleReferenceQuoteRule({ fontSize: 28, maxWidth: 640, lineHeight: 1.4, scale: 3 }, composition, 780).fontSize, 56);
});

test('copy/export/resize replay uses frozen source, theme, and resolved images and rerenders CSS for each width', async () => {
  let lookups = 0;
  const resolvedImage = { url: 'app://frozen.png', filePath: 'frozen.png', width: 100, height: 60 };
  const renderInput = { source: source + '\n\n![[picture.png]]', themeCss: css, themeComponents: components, resolve: () => { lookups++; return resolvedImage; }, referenceComposition: composition, layoutWidth: 390 };
  const rendered = renderArticle(renderInput);
  const typography = { themeId: 'scene-test', headingImages: [{ fontSize: 40 }], quoteImages: { fontSize: 28 }, fonts: [], assets: [] };
  const frozen = createReferenceLayoutSource({ renderInput, rendered, materializeInput: typography });
  const count = lookups;
  renderInput.source = 'changed'; renderInput.themeCss = '#nice{font-size:99px}';
  resolvedImage.url = 'app://changed.png'; typography.headingImages[0].fontSize = 99;
  for (const width of [320, 390, 677, 887]) {
    let received;
    const result = await replayReferenceLayout({ source: frozen, layoutWidth: width, materialize: async (input) => {
      received = input; return { html: input.html, images: input.images, warnings: [] };
    } });
    const $ = load(result.html, null, false);
    const size = Number($('#nice').attr('style').match(/font-size:\s*([\d.]+)px/)[1]);
    assert.ok(Math.abs(size - 13 * width / 390) < 0.00001);
    assert.equal($('[data-wechat-scene]').length, 2);
    assert.match(result.html, /app:\/\/frozen.png/); assert.doesNotMatch(result.html, /changed/);
    assert.equal(received.layoutWidth, width); assert.equal(received.headingImages[0].fontSize, 40);
    assert.deepEqual(received.referenceComposition, composition);
  }
  assert.equal(lookups, count);
});

test('responsive reference copy keeps design-width text sizes while ordinary copy and chosen export widths retain their paths', async () => {
  for (const renderState of [null, {}, { quoteImageSource: {} }, { referenceLayoutSource: { renderInput: { referenceComposition: { designWidth: '390' } } } }]) {
    assert.equal(referenceCopyLayoutWidth(renderState, 320), 320);
  }
  const input = { source, themeCss: '#nice{font-size:11px}#nice p{font-size:11px;margin-bottom:20px}', resolve: () => null, referenceComposition: composition, layoutWidth: 677 };
  const rendered = renderArticle(input);
  const frozen = createReferenceLayoutSource({ renderInput: input, rendered, materializeInput: { themeId: 'reference', headingImages: [], fonts: [], assets: [] } });
  const renderState = { referenceLayoutSource: frozen };
  assert.equal(referenceCopyLayoutWidth(renderState, 320), 390);
  const passthrough = async input => ({ html: input.html, images: input.images, warnings: [] });
  const copied = await replayReferenceLayout({ source: frozen, layoutWidth: referenceCopyLayoutWidth(renderState, 320), materialize: passthrough });
  const copyDom = load(copied.html, null, false);
  assert.match(copyDom('#nice').attr('style'), /font-size:\s*11px/);
  assert.match(copyDom('[data-wechat-scene="opening"] > p').attr('style'), /margin-bottom:\s*20px/);
  const exported = await replayReferenceLayout({ source: frozen, layoutWidth: 677, materialize: passthrough });
  const exportDom = load(exported.html, null, false);
  const exportSize = Number(exportDom('#nice').attr('style').match(/font-size:\s*([\d.]+)px/)[1]);
  assert.ok(Math.abs(exportSize - 11 * 677 / 390) < 0.00001);
  assert.equal(frozen.renderInput.layoutWidth, 677);
});

const overlapSource = '# 沙海中的<br>选择\n\n沙丘越过视野的边界，<br>人只剩一道很小的影子。<br>风把声音带走，<br>也把沙推向远方。\n\n## 留在沙面上的痕迹\n\n> 命运尚未写定。';
const overlapCss = css + '\n#nice [data-wechat-scene="opening"]{padding:40px 0 72px;min-height:214px}#nice [data-wechat-scene="opening"]>h1{width:44%}#nice h1 .content{font-size:40px;letter-spacing:3.5px}#nice [data-wechat-scene="opening"]>p{font-size:13px;width:44%;letter-spacing:.3px}#nice [data-wechat-scene="feature"]{margin:0;padding-top:82px}#nice [data-wechat-scene="opening"]+[data-wechat-scene="feature"]:not([data-wechat-scene-variant="standalone"]){margin-top:-106px}';

test('only the generated adjacent reference feature can keep a bounded vertical overlap at any design scale', () => {
  for (const width of [390, 887]) {
    const result = render({ source: overlapSource, themeCss: overlapCss, layoutWidth: width });
    const $ = load(result.html, null, false);
    const value = Number($('[data-wechat-scene="feature"]').attr('style').match(/margin-top:\s*(-[\d.]+)px/)[1]);
    assert.ok(Math.abs(value + 106 * width / 390) < 0.00001);
    assert.deepEqual(result.warnings, []);
  }
  const ordinary = render({ source: overlapSource, themeCss: overlapCss + '#nice h1{margin-top:-106px}', referenceComposition: null });
  assert.doesNotMatch(ordinary.html, /margin-top:\s*-/);
  const excessive = render({ source: overlapSource, themeCss: overlapCss.replace('margin-top:-106px', 'margin-top:-150px') });
  assert.doesNotMatch(excessive.html, /margin-top:\s*-/);
  const unrelated = render({ source: overlapSource + '\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n## 另一场景\n\n> 另一引用。', themeCss: overlapCss });
  const $ = load(unrelated.html, null, false);
  assert.match($('[data-wechat-scene="feature"]').first().attr('style'), /margin-top:\s*-/);
  assert.equal($('[data-wechat-scene="feature"]').length, 1);
  assert.equal($('#nice > h2').text(), '另一场景');
  assert.equal($('#nice > blockquote').text().trim(), '另一引用。');
});

test('a standalone H1 followed by H2/H3 still receives an opening without swallowing later headings', () => {
  const result = render({ source: '# 一级标题\n\n## 二级标题\n\n### 三级标题\n\n正文。\n\n> 独立引用。\n\n后续正文。' });
  const $ = load(result.html, null, false);
  const opening = $('[data-wechat-scene="opening"]');
  assert.equal(opening.attr('data-wechat-scene-variant'), 'standalone');
  assert.deepEqual(opening.children().toArray().map(n => n.name), ['section', 'h1']);
  assert.equal($('#nice > h2').text(), '二级标题');
  assert.equal($('#nice > h3').text(), '三级标题');
  const feature = $('[data-wechat-scene="feature"]');
  assert.equal(feature.attr('data-wechat-scene-variant'), 'standalone');
  assert.deepEqual(feature.children().toArray().map(n => n.name), ['blockquote']);
  assert.equal($('#nice > p').last().text(), '后续正文。');
});

test('no-H1 articles keep the before_article fallback outside the first feature and never repeat large quote scenery', () => {
  for (const text of [
    '> 第一引用。\n\n正文。\n\n## 后续小标题\n\n> 第二引用。',
    '## 第一小标题\n\n> 第一引用。\n\n说明。\n\n```text\ncode\n```\n\n## 后续小标题\n\n> 第二引用。',
  ]) {
    const result = render({ source: text });
    const $ = load(result.html, null, false);
    assert.equal($('[data-wechat-scene="opening"]').length, 0);
    assert.equal($('#nice > .brand').length, 1);
    assert.equal($('[data-wechat-scene="feature"]').length, 1);
    assert.equal($('[data-wechat-scene="feature"] .brand').length, 0);
    assert.equal($('#nice > blockquote').text().trim(), '第二引用。');
    assert.equal($('blockquote').length, 2);
  }
  const plain = load(render({ source: '只有正文。\n\n后续正文。' }).html, null, false);
  assert.equal(plain('#nice > .brand').length, 1);
  assert.equal(plain('[data-wechat-scene]').length, 0);
});

test('reference paragraph-plus-table articles get zero table spacing without creating scenes or leaking source markers', () => {
  const text = '只有正文与表格。\n\n| 意象 | 内容 |\n| --- | --- |\n| 沙丘 | 保留全部数据 |';
  const result = render({ source: text });
  const $ = load(result.html, null, false);
  assert.equal($('[data-wechat-scene]').length, 0);
  assert.equal($('#nice > .brand').length, 1);
  assert.equal($('#nice > table').attr('cellspacing'), '0');
  assert.equal($('#nice > table').attr('cellpadding'), '0');
  assert.equal($('#nice > table td').last().text(), '保留全部数据');
  assert.doesNotMatch(result.html, /data-wechat-reference-block/);
  const legacy = load(render({ source: text, referenceComposition: null }).html, null, false);
  assert.equal(legacy('table').attr('cellspacing'), undefined);
  assert.equal(legacy('table').attr('cellpadding'), undefined);
});

test('adjacent raw blocks create sibling scenes and standalone quotes never gain negative overlap', () => {
  const result = render({ source: '<h1>标题</h1><h2>小标题</h2><blockquote><p>引语。</p></blockquote>' });
  const $ = load(result.html, null, false);
  assert.equal($('#nice > [data-wechat-scene="opening"]').length, 1);
  assert.equal($('#nice > [data-wechat-scene="feature"]').length, 1);
  assert.equal($('[data-wechat-scene] [data-wechat-scene]').length, 0);
  const standalone = render({ source: '# 开篇\n\n导语。\n\n> 独立引用。', themeCss: overlapCss });
  const s = load(standalone.html, null, false);
  assert.equal(s('[data-wechat-scene="feature"]').attr('data-wechat-scene-variant'), 'standalone');
  assert.doesNotMatch(s('[data-wechat-scene="feature"]').attr('style'), /margin-top:\s*-/);
});

test('long intro/title or insufficient scene clearance automatically restores natural flow without losing content', () => {
  for (const [text, style] of [
    [overlapSource.replace('## 留在', '新增的长导语'.repeat(40) + '。\n\n## 留在'), overlapCss],
    [overlapSource.replace('沙海中的<br>选择', '标题延长之后不应该被后方图案压住而丢失任何文字'), overlapCss],
    [overlapSource, overlapCss.replace('padding:40px 0 72px', 'padding:40px 0 0').replace('padding-top:82px', 'padding-top:0')],
  ]) {
    const result = render({ source: text, themeCss: style });
    const $ = load(result.html, null, false);
    assert.match($('[data-wechat-scene="feature"]').attr('style'), /margin:\s*0|margin-top:\s*0px/);
    assert.doesNotMatch(result.html, /margin-top:\s*-/);
    assert.deepEqual(result.warnings, []);
    assert.equal($('[data-wechat-scene="opening"] > h1').length, 1);
    assert.equal($('[data-wechat-scene="feature"] > blockquote').length, 1);
  }
});

test('opening groups stop at two paragraphs or 160 visible characters without skipping the first excess paragraph', () => {
  for (const [lengths, expected] of [[[160], 1], [[161], 0], [[100, 60], 2], [[100, 61], 1], [[50, 50, 50], 2]]) {
    const paragraphs = lengths.map((n, i) => String.fromCharCode(0x7532 + i).repeat(n));
    const result = render({ source: ['# 开篇', ...paragraphs].join('\n\n') });
    const $ = load(result.html, null, false);
    const opening = $('[data-wechat-scene="opening"]');
    assert.equal(opening.children('p').length, expected);
    assert.equal($('#nice > p').length, lengths.length - expected);
    assert.equal([...opening.children('p').toArray(), ...$('#nice > p').toArray()].map(n => $(n).text()).join(''), paragraphs.join(''));
    assert.equal(opening.attr('data-wechat-scene-variant'), expected === 0 ? 'standalone' : undefined);
  }
  const markup = '**' + '甲'.repeat(80) + '** <span>' + '乙'.repeat(80) + '</span>';
  const $ = load(render({ source: '# 开篇\n\n' + markup }).html, null, false);
  assert.equal($('[data-wechat-scene="opening"] > p').length, 1);
});

test('full features respect exact short-heading, quote, caption and code-line bounds while excess blocks stay in place', () => {
  for (const [h, q, p, codeLines, full, caption, code] of [
    [18, 100, 100, 12, true, true, true],
    [19, 100, 100, 12, false, false, false],
    [18, 101, 100, 12, false, false, false],
    [18, 100, 101, 12, true, false, false],
    [18, 100, 100, 13, true, true, false],
    [18, 100, 0, 12, true, false, true],
  ]) {
    const heading = '题'.repeat(h), quote = '引'.repeat(q), paragraph = '说'.repeat(p);
    const codeText = Array.from({ length: codeLines }, (_, i) => `  line_${i}`).join('\n');
    const result = render({ source: ['# 开篇', '导语。', '## ' + heading, '> ' + quote, ...(p ? [paragraph] : []), '```text\n' + codeText + '\n```'].join('\n\n') });
    const $ = load(result.html, null, false), feature = $('[data-wechat-scene="feature"]');
    assert.equal(feature.attr('data-wechat-scene-variant'), full ? undefined : 'standalone');
    assert.equal(feature.children('h2').length, full ? 1 : 0);
    assert.equal(feature.children('p').length, caption ? 1 : 0);
    assert.equal(feature.children('pre').length, code ? 1 : 0);
    assert.equal($('h2').text(), heading); assert.equal($('blockquote').text().trim(), quote);
    assert.equal($('pre code').text(), codeText);
    assert.equal($('.code-head').length, 1);
    if (p && !caption) assert.equal($('#nice > p').last().text(), paragraph);
  }
  const result = render({ source: '## 短标题\n\n> 短引用。\n\n第一说明。\n\n第二说明。\n\n```text\n保留代码\n```' });
  const $ = load(result.html, null, false);
  assert.equal($('[data-wechat-scene="feature"] > p').text(), '第一说明。');
  assert.equal($('#nice > p').text(), '第二说明。');
  assert.equal($('#nice > pre code').text(), '保留代码');
});

const flowCss = '#nice{font-size:16px;padding:0}#nice p{font-size:16px;margin:0 10% 20px}#nice h1{margin:24px 10% 16px}#nice h1>.content{font-size:26px;line-height:1.3;letter-spacing:1px}#nice h2{margin:22px 10% 14px}#nice h2>.content{font-size:21px;line-height:1.4;letter-spacing:.5px}#nice blockquote{width:80%;margin:24px 10%;padding:0}#nice blockquote p{font-size:17px;margin:0;line-height:1.7}#nice pre{margin:24px 10%;padding:12px}#nice pre code{font-size:13px;white-space:pre-wrap;word-break:break-all}';
const renderFlow = (body, layoutWidth = 390) => render({ source: body, themeCss: flowCss, referenceComposition: documentFlow, layoutWidth });
const roleStyles = $ => Object.fromEntries(['h1', 'h1>.content', 'h2', 'h2>.content', '#nice>p', 'blockquote', 'blockquote>p', 'pre', 'pre>code'].map(selector => [selector, $(selector).first().attr('style')]));

test('document-flow ignores 100/101 and 160/161 character thresholds for paragraphs, headings and quotes', () => {
  let expected;
  for (const length of [100, 101, 160, 161]) {
    const text = ['# 固定标题', '正文' + '甲'.repeat(length), '## 小标题' + '乙'.repeat(length), '> 引用' + '丙'.repeat(length), '```text\n固定代码\n```'].join('\n\n');
    const result = renderFlow(text), $ = load(result.html, null, false);
    assert.doesNotMatch(result.html, /data-wechat-scene|data-wechat-reference-block/);
    assert.equal($('#nice > h1').length, 1);
    assert.equal($('#nice > h2').length, 1);
    assert.equal($('#nice > p').length, 1);
    assert.equal($('#nice > blockquote').length, 1);
    assert.equal($('#nice > pre').length, 1);
    assert.equal($('#nice > p').text(), '正文' + '甲'.repeat(length));
    const styles = roleStyles($);
    if (expected) assert.deepEqual(styles, expected); else expected = styles;
  }
});

test('document-flow keeps block roles stable when paragraphs, quotes and code are inserted around headings', () => {
  const baseline = ['# 固定标题', '正文。', '## 固定小标题', '> 固定引用。', '```text\n固定代码\n```'];
  const variants = [baseline,
    [baseline[0], '标题后新增正文。', ...baseline.slice(1)],
    [...baseline.slice(0, 2), '小标题前新增正文。', ...baseline.slice(2)],
    [...baseline.slice(0, 2), '```text\n小标题前新增代码\n```', ...baseline.slice(2)],
    [...baseline.slice(0, 3), '小标题后新增正文。', ...baseline.slice(3)],
    [...baseline.slice(0, 3), '```text\n小标题后新增代码\n```', ...baseline.slice(3)],
    [...baseline.slice(0, 2), '> 小标题前新增引用。', ...baseline.slice(2)],
    [...baseline.slice(0, 3), '> 小标题后新增引用。', ...baseline.slice(3)],
  ];
  const expected = roleStyles(load(renderFlow(baseline.join('\n\n')).html, null, false));
  for (const parts of variants) {
    const result = renderFlow(parts.join('\n\n')), $ = load(result.html, null, false);
    assert.doesNotMatch(result.html, /data-wechat-scene|data-wechat-reference-block/);
    assert.deepEqual(roleStyles($), expected);
    const originalBlocks = $('#nice').children().filter((_, n) => !$(n).is('.brand,.code-head,.table-head'));
    const expectedTags = parts.map(text => text.startsWith('## ') ? 'h2' : text.startsWith('# ') ? 'h1' : text.startsWith('> ') ? 'blockquote' : text.startsWith('```') ? 'pre' : 'p');
    assert.deepEqual(originalBlocks.toArray().map(n => n.name), expectedTags);
    assert.equal($('#nice>.brand').length, 1);
    assert.equal($('.code-head').length, expectedTags.filter(tag => tag === 'pre').length);
  }
});

test('document-flow keeps native tables at zero spacing, never generates scenes, and disables legacy overlap policy', () => {
  const result = renderFlow(source), $ = load(result.html, null, false);
  assert.equal($('#nice > table').attr('cellspacing'), '0');
  assert.equal($('#nice > table').attr('cellpadding'), '0');
  assert.equal($('#nice > .brand').length, 1);
  assert.equal($('#nice > blockquote').length, 1);
  assert.doesNotMatch(result.html, /data-wechat-scene|data-wechat-reference-block/);
  const raw = '<section id="nice"><h1>标题</h1><p>导语。</p><h2>小标题</h2><blockquote><p>引语。</p></blockquote></section>';
  assert.deepEqual(planReferenceComposition(raw, documentFlow), { html: raw, groups: [] });
  const legacyPlan = planReferenceComposition(raw, composition);
  assert.equal(legacyPlan.groups.length, 2);
  const legacy = render({ source: overlapSource, themeCss: overlapCss });
  assert.equal(referenceSceneOverlapPolicy(legacy.html, legacyPlan, documentFlow, 390).size, 0);
  assert.match(legacy.html, /data-wechat-scene="opening"/);
  assert.match(legacy.html, /margin-top:\s*-106px/);
});

test('document-flow retains design-width copy, full-width replay and proportional heading/quote image rules', async () => {
  const input = { source, themeCss: flowCss, themeComponents: components, resolve: () => null, referenceComposition: documentFlow, layoutWidth: 390 };
  const rendered = renderArticle(input);
  const frozen = createReferenceLayoutSource({ renderInput: input, rendered, materializeInput: { themeId: 'flow', headingImages: [], quoteImages: null, fonts: [], assets: [] } });
  assert.equal(referenceCopyLayoutWidth({ referenceLayoutSource: frozen }, 320), 390);
  for (const width of [390, 887]) {
    let observed;
    const output = await replayReferenceLayout({ source: frozen, layoutWidth: width, materialize: async value => {
      observed = value; return { html: value.html, images: value.images, warnings: [] };
    } });
    const $ = load(output.html, null, false);
    const fontSize = Number($('#nice').attr('style').match(/font-size:\s*([\d.]+)px/)[1]);
    assert.ok(Math.abs(fontSize - 16 * width / 390) < .00001);
    assert.deepEqual(observed.referenceComposition, documentFlow);
    assert.doesNotMatch(output.html, /data-wechat-scene|data-wechat-reference-block/);
    const heading = scaleReferenceHeadingRule({ fontSize: 26, maxWidth: 354, paddingX: 4 }, documentFlow, width);
    const quote = scaleReferenceQuoteRule({ fontSize: 17, maxWidth: 640 }, documentFlow, width);
    assert.equal(heading.fontSize, 26 * width / 390);
    assert.equal(heading.widthMode, 'container');
    assert.equal(quote.fontSize, 17 * width / 390);
  }
});
