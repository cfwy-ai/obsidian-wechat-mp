import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio/slim';
import postcss from 'postcss';
import { materializeNestedLists } from '../src/nested-lists.mjs';
import { renderArticle } from '../src/pipeline.mjs';

const GROUP = '[data-wechat-list-group]';
const ITEM = '[data-wechat-list-item]';
const ROW = '[data-wechat-list-row]';
const MARKER = '[data-wechat-list-marker]';
const parse = html => load(html, {}, false);
const wrap = html => `<section id="nice">${html}</section>`;
const pipeline = (source, themeCss = '') => renderArticle({ source, themeCss, resolve: () => null });
const textWithoutMarkers = element => {
  const copy = element.clone();
  copy.find(MARKER).remove();
  return copy.text().replace(/\s+/g, '');
};

// Resolve only the physical box properties exercised below. Inspect effective
// declarations, rather than assuming the last longhand wins over a shorthand
// or an earlier !important declaration.
function effectiveStyle(element, property) {
  let winner;
  const rule = postcss.parse(`x{${element.attr('style') ?? ''}}`).first;
  rule.walkDecls(declaration => {
    const name = declaration.prop.toLowerCase();
    let value;
    if (name === property) value = declaration.value.trim();
    else {
      const match = /^(padding|margin)-(top|right|bottom|left)$/.exec(property);
      if (match && name === match[1]) {
        const parts = declaration.value.trim().split(/\s+/);
        const expanded = [parts[0], parts[1] ?? parts[0], parts[2] ?? parts[0], parts[3] ?? parts[1] ?? parts[0]];
        value = expanded[['top', 'right', 'bottom', 'left'].indexOf(match[2])];
      }
    }
    if (value !== undefined && (!winner?.important || declaration.important)) {
      winner = { value, important: Boolean(declaration.important) };
    }
  });
  return winner?.value;
}

function pixelStyle(element, property) {
  const value = effectiveStyle(element, property);
  assert.match(value ?? '', /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/, `${property} 必须是可验证的像素长度：${value}`);
  return Number.parseFloat(value);
}

function assertConverted(result, itemCount) {
  assert.deepEqual(result.warnings, []);
  const $ = parse(result.html);
  assert.equal($('#nice ul, #nice ol, #nice li').length, 0, '样本必须走完转换，不能靠保留原树绕过回归');
  if (itemCount !== undefined) assert.equal($(ITEM).length, itemCount);
  return $;
}

test('端到端：隐藏 LI 的整棵子树仍隐藏，后面的可见兄弟不受影响', () => {
  const source = '<ul><li id="hidden-item" class="hidden">隐藏父项<ul><li id="hidden-descendant">隐藏子项</li></ul></li><li id="visible-item">可见兄弟</li></ul>';
  const $ = assertConverted(pipeline(source, '#nice .hidden {display:none}'), 3);
  assert.equal(effectiveStyle($('#hidden-item'), 'display'), 'none');
  assert.equal($('#hidden-descendant').parents('#hidden-item').length, 1);
  assert.notEqual(effectiveStyle($('#visible-item'), 'display'), 'none');
  assert.equal($('#visible-item').parents('#hidden-item').length, 0);
  assert.equal(textWithoutMarkers($('#nice')), textWithoutMarkers(parse(wrap(source))('#nice')));
});

test('端到端：隐藏 UL 组仍隐藏，父项与并列子列表仍可见', () => {
  const source = '<ul><li id="visible-parent">可见父项<ul id="hidden-group" class="hidden"><li>隐藏子项</li></ul><ul id="visible-group"><li>可见子项</li></ul></li></ul>';
  const $ = assertConverted(pipeline(source, '#nice .hidden {display:none}'), 3);
  assert.equal(effectiveStyle($('#hidden-group'), 'display'), 'none');
  assert.notEqual(effectiveStyle($('#visible-parent'), 'display'), 'none');
  assert.notEqual(effectiveStyle($('#visible-group'), 'display'), 'none');
  assert.equal($('#visible-group').parents('#hidden-group').length, 0);
  assert.equal(textWithoutMarkers($('#nice')), textWithoutMarkers(parse(wrap(source))('#nice')));
});

test('端到端：LI 的后置 padding 简写不能覆盖生成的标记占位', () => {
  const $ = assertConverted(pipeline('- 父项\n  - 子项', '#nice li {padding-left:60px;padding:0}'), 2);
  $(`${ROW}[data-wechat-list-row="head"]`).each((_, node) => {
    const row = $(node);
    const marker = row.find(MARKER).first();
    const gutter = pixelStyle(marker, 'width');
    assert.ok(gutter > 0 && gutter < 60, '最终原始 padding 是 0，不能误取已被简写覆盖的 60px');
    assert.equal(pixelStyle(row, 'padding-left'), gutter, '有效左 padding 必须为标记及续行留位');
    assert.equal(pixelStyle(marker.parent(), 'text-indent'), -gutter);
  });
});

test('端到端：UL 的后置 padding 简写生效，转换后组左 padding 归零且不重复累加', () => {
  const $ = assertConverted(pipeline('- 父项\n  - 子项', '#nice ul {padding-left:80px;padding:10px}'), 2);
  $(GROUP).each((_, node) => {
    const group = $(node);
    assert.equal(pixelStyle(group, 'padding-left'), 0);
    for (const side of ['top', 'right', 'bottom']) assert.equal(pixelStyle(group, `padding-${side}`), 10);
  });
  $(MARKER).each((_, node) => assert.ok(pixelStyle($(node), 'width') < 80, '被简写覆盖的 80px 不能成为 marker 槽宽'));
});

for (const [name, declarations, expectedLargeGutter] of [
  ['先出现的 important longhand 覆盖后置普通 shorthand', 'padding-left:80px!important;padding:10px', true],
  ['先出现的 important shorthand 覆盖后置普通 longhand', 'padding:10px!important;padding-left:80px', false],
]) {
  test(`端到端：${name}，生成的组缩进仍能覆盖旧左 padding`, () => {
    const $ = assertConverted(pipeline('- 父项\n  - 子项', `#nice ul {${declarations}}`), 2);
    $(GROUP).each((_, node) => {
      assert.equal(pixelStyle($(node), 'padding-left'), 0);
      for (const side of ['top', 'right', 'bottom']) assert.equal(pixelStyle($(node), `padding-${side}`), 10);
    });
    $(MARKER).each((_, node) => {
      const gutter = pixelStyle($(node), 'width');
      assert.ok(expectedLargeGutter ? gutter >= 80 : gutter < 80, `有效原始左 padding 的 important 优先级错误：${gutter}`);
    });
  });
}

test('模块：重复声明中先出现的 important 字号与颜色仍是最终值', () => {
  const source = wrap('<ul><li style="font-size:20px!important;font-size:12px;color:#123456!important;color:#654321">父项<ul><li>子项</li></ul></li></ul>');
  const $ = assertConverted(materializeNestedLists(source), 2);
  $(ROW).each((_, node) => {
    assert.equal(pixelStyle($(node), 'font-size'), 20);
    assert.equal(effectiveStyle($(node), 'color'), '#123456');
  });
});

test('端到端：details 的 summary 保持直属首子节点，子列表及后文按原顺序保留', () => {
  const source = '<ul><li><details id="details"><summary id="summary">目录<strong>标题</strong></summary><p>列表之前</p><ul><li>内部子项</li></ul><p>列表之后</p></details><p>父项末尾</p></li></ul>';
  const $ = assertConverted(pipeline(source), 2);
  assert.equal($('#summary').parent().attr('id'), 'details');
  assert.equal($('#details').children().first().attr('id'), 'summary');
  assert.equal($('#details > summary').length, 1);
  assert.equal($('#summary').find('strong').text(), '标题');
  assert.equal($('#details').find(`${GROUP}[data-wechat-list-depth="2"]`).length, 1);
  assert.equal(textWithoutMarkers($('#nice')), textWithoutMarkers(parse(wrap(source))('#nice')));
});

test('端到端：表格含列表时 tbody/tr/td 保持直属关系，普通单元格不包入非法行容器', () => {
  const source = '<ul><li>父项<table id="table"><tbody id="body"><tr id="row1"><td id="a1">一行 A</td><td id="b1">一行 B<ul><li>单元格子项</li></ul>单元格尾部</td></tr><tr id="row2"><td id="a2">二行 A</td><td id="b2">二行 B</td></tr></tbody></table><p>表格之后</p></li></ul>';
  const $ = assertConverted(pipeline(source), 2);
  assert.deepEqual($('#table').children().toArray().map(node => node.tagName), ['tbody']);
  assert.deepEqual($('#body').children().toArray().map(node => node.attribs.id), ['row1', 'row2']);
  assert.deepEqual($('#row1').children().toArray().map(node => node.attribs.id), ['a1', 'b1']);
  assert.deepEqual($('#row2').children().toArray().map(node => node.attribs.id), ['a2', 'b2']);
  assert.equal($('#b1').find(`${GROUP}[data-wechat-list-depth="2"]`).length, 1);
  assert.equal($('table > section, tbody > section, tr > section, table > p, tbody > p, tr > p').length, 0);
  assert.equal(textWithoutMarkers($('#nice')), textWithoutMarkers(parse(wrap(source))('#nice')));
});

test('端到端：定义列表的 dt/dd 保持直属关系，定义内子列表及后续定义不移位', () => {
  const source = '<ul><li>父项<dl id="definitions"><dt id="term1">第一名词</dt><dd id="definition1">第一解释<ul><li>解释子项</li></ul>解释尾部</dd><dt id="term2">第二名词</dt><dd id="definition2">第二解释</dd></dl><p>定义列表之后</p></li></ul>';
  const $ = assertConverted(pipeline(source), 2);
  assert.deepEqual($('#definitions').children().toArray().map(node => node.attribs.id), ['term1', 'definition1', 'term2', 'definition2']);
  for (const id of ['term1', 'definition1', 'term2', 'definition2']) assert.equal($(`#${id}`).parent().attr('id'), 'definitions');
  assert.equal($('#definition1').find(`${GROUP}[data-wechat-list-depth="2"]`).length, 1);
  assert.equal($('p > dt, p > dd, dl > section, dl > p').length, 0);
  assert.equal(textWithoutMarkers($('#nice')), textWithoutMarkers(parse(wrap(source))('#nice')));
});

for (const [name, start, type, expected] of [
  ['9 到 10', 9, '', ['9.', '10.']],
  ['99 到 100', 99, '', ['99.', '100.']],
  ['z 到 aa', 26, 'a', ['z.', 'aa.']],
]) {
  test(`端到端：同一 OL 组 ${name} 使用一致的标记槽宽与正文起点`, () => {
    const source = `<ol start="${start}"${type ? ` type="${type}"` : ''}><li>第一项<ul><li>子项</li></ul></li><li>第二项</li></ol>`;
    const $ = assertConverted(pipeline(source), 3);
    const siblings = $('[data-wechat-list-root="ol"]').children(ITEM).toArray();
    assert.equal(siblings.length, 2);
    const rows = siblings.map(node => $(node).find(`${ROW}[data-wechat-list-row="head"]`).first());
    const markers = rows.map(row => row.find(MARKER).first());
    assert.deepEqual(markers.map(marker => marker.text().trim()), expected);
    const gutters = markers.map(marker => pixelStyle(marker, 'width'));
    assert.ok(gutters.every(width => width > 0));
    assert.equal(gutters[0], gutters[1], '位数变化不能让同组正文左右跳动');
    assert.equal(pixelStyle(rows[0], 'padding-left'), pixelStyle(rows[1], 'padding-left'));
    assert.equal(pixelStyle(rows[0], 'margin-left'), pixelStyle(rows[1], 'margin-left'));
  });
}
