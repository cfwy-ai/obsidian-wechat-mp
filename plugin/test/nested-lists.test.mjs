import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio/slim';
import postcss from 'postcss';
import { materializeNestedLists } from '../src/nested-lists.mjs';
import { applyWechatDarkMode } from '../src/dark-mode.mjs';

const parse = html => load(html, {}, false);
const wrap = content => `<section id="nice">${content}</section>`;
const ITEM = '[data-wechat-list-item]';
const ROW = '[data-wechat-list-row]';
const MARKER = '[data-wechat-list-marker]';
const TASK_SCOPE = '[data-wechat-list-task-scope="true"]';
const compact = text => text.replace(/\s+/g, ' ').trim();
const styles = element => {
  const values = new Map();
  postcss.parse(`x{${element.attr('style') ?? ''}}`).walkDecls(declaration => {
    values.set(declaration.prop.toLowerCase(), declaration.value.trim());
  });
  return values;
};
const marginLeft = element => {
  const value = styles(element).get('margin-left');
  assert.match(value ?? '', /^(?:0|\d+(?:\.\d+)?px)$/, '可见行须带明确的左外边距');
  return Number.parseFloat(value);
};
const withoutGeneratedMarkers = element => {
  const copy = element.clone();
  copy.find(MARKER).remove();
  return compact(copy.text());
};
const headRows = $ => $(`${ROW}[data-wechat-list-row="head"]`);
const markerTexts = $ => $(MARKER).toArray().map(node => compact($(node).text()));

test('nested list roots preserve zero, px and percentage page margins while descendant depth remains controlled', () => {
  for (const kind of ['ul', 'ol']) for (const [left, right] of [['0', '0'], ['24px', '12px'], ['10%', '7%']]) {
    const childKind = kind === 'ul' ? 'ol' : 'ul';
    const source = wrap(`<${kind} style="margin:8px ${right} 12px ${left};padding-left:18px"><li>第一项<${childKind} style="margin-left:99px;margin-right:0;padding-left:18px"><li>子项</li></${childKind}></li><li>第二项</li></${kind}>`);
    const result = materializeNestedLists(source);
    const $ = parse(result.html);
    const group = $('[data-wechat-list-root]');
    assert.equal(styles(group).get('margin-left'), left);
    assert.equal(styles(group).get('margin-right'), right);
    assert.equal(styles(group).get('padding-left'), '0');
    const nested = $('[data-wechat-list-group][data-wechat-list-depth="2"]');
    assert.equal(styles(nested).get('margin-left'), '0');
    assert.deepEqual(headRows($).toArray().map(node => marginLeft($(node))), [0, 24, 0]);
    assert.equal(withoutGeneratedMarkers(group), '第一项子项第二项');
    const flat = wrap(`<${kind} style="margin-left:${left};margin-right:${right};padding-left:18px"><li>平铺项</li></${kind}>`);
    assert.equal(materializeNestedLists(flat).html, flat);
  }
});
const assertSectionStructure = $ => {
  $(ITEM).each((_, node) => {
    assert.equal(node.tagName, 'section');
    assert.equal($(node).attr('role'), 'listitem');
    assert.ok(['ul', 'ol'].includes($(node).attr('data-wechat-list-item')));
  });
  $('[role="list"]').each((_, node) => assert.equal(node.tagName, 'section'));
};

test('没有待转换的嵌套列表时整个输入逐字节不变，包括 #nice 外的嵌套列表', () => {
  const source = `<aside data-quote='single'><ul><li>外面<ul><li>外部子项</li></ul></li></ul></aside>\n<section id='nice'><p>正文 &amp; 原样</p>\n<ul style='list-style-type:disc'><li>甲</li><li>乙</li></ul><ol start='3'><li value='7'>七</li></ol></section>\n<!-- tail -->`;
  const result = materializeNestedLists(source);
  assert.equal(result.html, source);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.listCount, 0);
  assert.equal(result.itemCount, 0);
  assert.equal(result.maxDepth, 0);
});

test('仅转换 #nice 内的嵌套树，保留外部字节与并列平铺列表的原生结构', () => {
  const prefix = `<aside data-quote='single'><ul><li>外<ul><li>外子</li></ul></li></ul></aside>\n`;
  const suffix = `\n<footer data-quote='single'>末尾</footer>`;
  const source = prefix + wrap('<ul><li>甲<ul><li>子项</li></ul></li></ul><ol id="flat" start="8" style="padding-left:20px"><li value="11">平铺项</li></ol>') + suffix;
  const result = materializeNestedLists(source);
  const $ = parse(result.html);
  assert.ok(result.html.startsWith(prefix));
  assert.ok(result.html.endsWith(suffix));
  assert.equal($('#nice > ol#flat').length, 1);
  assert.equal($('#flat').attr('start'), '8');
  assert.equal($('#flat > li').attr('value'), '11');
  assert.equal($('#flat').find(ITEM).length, 0);
  assert.equal($('aside ul').length, 2);
  assert.equal(result.listCount, 2);
  assert.equal(result.itemCount, 2);
  assert.equal(result.maxDepth, 2);
});

test('三级 UL/OL 混合树保留父子关系，每条行使用独立的 0/24/48px 缩进', () => {
  const source = wrap('<ul style="list-style-type:disc;padding-left:0"><li>甲<ol start="3" style="list-style-type:decimal"><li>乙<ul style="list-style-type:square"><li>丙</li></ul></li><li>丁</li></ol></li><li>戊</li></ul>');
  const result = materializeNestedLists(source);
  const $ = parse(result.html);
  assert.equal($('#nice ul,#nice ol,#nice li').length, 0);
  assertSectionStructure($);
  assert.deepEqual($(ITEM).toArray().map(node => $(node).attr('data-wechat-list-item')), ['ul', 'ol', 'ul', 'ol', 'ul']);
  assert.deepEqual($(ITEM).toArray().map(node => Number($(node).attr('data-wechat-list-depth'))), [1, 2, 3, 2, 1]);
  $(ITEM).each((_, node) => {
    assert.equal($(node).parents(ITEM).length + 1, Number($(node).attr('data-wechat-list-depth')));
  });
  assert.deepEqual(headRows($).toArray().map(node => marginLeft($(node))), [0, 24, 48, 24, 0]);
  assert.deepEqual(headRows($).toArray().map(node => Number($(node).attr('data-wechat-list-depth'))), [1, 2, 3, 2, 1]);
  assert.deepEqual(markerTexts($), ['•', '3.', '▪', '4.', '•']);
  assert.equal(result.listCount, 3);
  assert.equal(result.itemCount, 5);
  assert.equal(result.maxDepth, 3);
  assert.deepEqual(result.warnings, []);
});

test('OL 从 3 开始、LI value 改号、子列表从 8 开始，计数互不影响', () => {
  const source = wrap('<ol start="3"><li>甲<ol start="8"><li>子甲</li><li>子乙</li></ol></li><li value="11">乙</li><li>丙</li></ol>');
  const $ = parse(materializeNestedLists(source).html);
  assert.deepEqual(markerTexts($), ['3.', '8.', '9.', '11.', '12.']);
  assert.deepEqual(headRows($).toArray().map(node => withoutGeneratedMarkers($(node))), ['甲', '子甲', '子乙', '乙', '丙']);
});

test('已内联的 lower-alpha 优先于 type，字母编号支持 z 后续 aa 与 LI value', () => {
  const source = wrap('<ol start="3" type="i"><li>父<ol start="26" type="I" style="list-style-type:lower-alpha"><li>子一</li><li>子二</li><li value="28">子三</li><li>子四</li></ol></li><li>父二</li></ol>');
  const $ = parse(materializeNestedLists(source).html);
  assert.deepEqual(markerTexts($), ['iii.', 'z.', 'aa.', 'ab.', 'ac.', 'iv.']);
});

test('没有 CSS 类型时保留 HTML type 指定的大小写罗马编号', () => {
  const source = wrap('<ol start="8" type="I"><li>父<ol start="4" type="i"><li>子一</li><li>子二</li></ol></li><li>父二</li></ol>');
  assert.deepEqual(markerTexts(parse(materializeNestedLists(source).html)), ['VIII.', 'iv.', 'v.', 'IX.']);
});

test('段落、强调、链接、图片和子列表后的父段完整保留，续段不重复标记', () => {
  const source = wrap('<ul style="list-style-type:disc"><li style="color:#123456;font-size:16px;line-height:1.8"><p style="margin:0 0 10px">首段<strong style="color:#654321">加粗</strong><a href="https://example.test/?a=1&amp;b=2" title="原链接">链接</a></p><p>第二段<img src="https://example.test/photo.png" width="120" alt="原图">图后文字</p><ul style="list-style-type:circle"><li><p>子项<em style="font-style:italic">斜体</em></p></li></ul><p style="margin:0 0 10px">返回父段</p></li></ul>');
  const before = parse(source);
  const $ = parse(materializeNestedLists(source).html);
  assert.equal(withoutGeneratedMarkers($('#nice')), compact(before('#nice').text()));
  assert.equal($('strong').length, 1);
  assert.equal(styles($('strong')).get('color'), '#654321');
  assert.equal($('a').attr('href'), 'https://example.test/?a=1&b=2');
  assert.equal($('a').attr('title'), '原链接');
  assert.equal($('em').text(), '斜体');
  assert.equal($('img').length, 1);
  assert.equal($('img').attr('src'), 'https://example.test/photo.png');
  assert.equal($('img').attr('width'), '120');
  assert.equal($('img').attr('alt'), '原图');
  assert.deepEqual($(ROW).toArray().map(node => $(node).attr('data-wechat-list-row')), ['head', 'continuation', 'head', 'continuation']);
  assert.deepEqual($(ROW).toArray().map(node => marginLeft($(node))), [0, 0, 24, 0]);
  assert.deepEqual(markerTexts($), ['•', '◦']);
  assert.equal($(`${ROW}[data-wechat-list-row="continuation"]`).find(MARKER).length, 0);
  assert.equal($(ROW).last().text(), '返回父段');
});

test('待办保留原 marker、首段和悬挂缩进，任务整树带作用范围且不增加普通符号', () => {
  const source = wrap('<ul><li class="wechat-task-item is-unchecked" style="padding-left:0;list-style-type:none"><p class="wechat-task-line" style="margin:0;padding:0 0 0 30px;text-indent:-30px"><span class="wechat-task-marker is-unchecked" role="img" aria-label="未完成" style="display:inline-block;width:21px;height:21px;margin-right:9px;color:transparent;background-image:url(\'app://vault/open.png\')">&nbsp;&nbsp;&nbsp;</span>父任务</p><ul style="list-style-type:disc"><li>普通子项</li><li class="wechat-task-item is-checked" style="list-style-type:none"><p class="wechat-task-line"><span class="wechat-task-marker is-checked" role="img" aria-label="已完成" style="display:inline;padding:10px;margin-right:8px;background-image:url(\'app://vault/done.png\');font-size:0">✓</span>已完成子任务</p></li></ul><p>父任务续段</p></li></ul>');
  const before = parse(source);
  const $ = parse(materializeNestedLists(source).html);
  assert.deepEqual($('.wechat-task-marker').toArray().map(node => $.html(node)), before('.wechat-task-marker').toArray().map(node => before.html(node)));
  assert.equal($('.wechat-task-line').length, 2);
  assert.equal(styles($('.wechat-task-line').first()).get('padding'), '0 0 0 30px');
  assert.equal(styles($('.wechat-task-line').first()).get('text-indent'), '-30px');
  assert.equal($(ITEM).first().attr('data-wechat-list-task-scope'), 'true');
  $(ITEM).each((_, node) => assert.ok($(node).closest(TASK_SCOPE).length > 0));
  assert.deepEqual(markerTexts($), ['•']);
  assert.equal(withoutGeneratedMarkers($('#nice')), compact(before('#nice').text()));
});

test('背景图和原占位放在整条行上，二级图标随 margin-left 一起移动而非只移动文字', () => {
  const source = wrap('<ul style="padding-left:0"><li style="margin:9px 0;padding-left:24px;list-style-type:none;color:#353535;background-image:url(\'app://vault/first.png\');background-repeat:no-repeat;background-position:left 7px;background-size:18px 12px">一级<ul style="padding-left:5px"><li style="padding-left:19px;list-style-type:none;background-image:url(\'app://vault/second.png\');background-repeat:no-repeat;background-position:left 9px;background-size:11px 11px">二级</li></ul></li></ul>');
  const $ = parse(materializeNestedLists(source).html);
  const rows = headRows($);
  assert.equal(rows.length, 2);
  for (const [index, expected] of [
    { padding: '24px', url: 'first.png', position: 'left 7px', size: '18px 12px', left: 0 },
    { padding: '19px', url: 'second.png', position: 'left 9px', size: '11px 11px', left: 24 },
  ].entries()) {
    const row = rows.eq(index), style = styles(row);
    assert.equal(style.get('padding-left'), expected.padding);
    assert.ok(style.get('background-image')?.includes(expected.url));
    assert.equal(style.get('background-position'), expected.position);
    assert.equal(style.get('background-size'), expected.size);
    assert.equal(style.get('background-repeat'), 'no-repeat');
    assert.equal(marginLeft(row), expected.left);
  }
  $(ITEM).each((_, node) => {
    const style = styles($(node));
    assert.ok(!style.has('padding-left') || /^0(?:px)?$/.test(style.get('padding-left')));
    assert.ok(!style.has('padding') || /^0(?:px)?(?: 0(?:px)?){0,3}$/.test(style.get('padding')));
    assert.ok(!style.has('background-image'));
  });
  assert.equal($(MARKER).length, 0);
});

test('嵌套列表组的左侧点线只保留一次，不复制到每条子项', () => {
  const source = wrap('<ul style="list-style-type:disc"><li>父<ul style="list-style-type:circle;margin:7px 0 2px;padding-left:14px;border-left:1px dotted #E9D5AB"><li>甲</li><li>乙</li><li>丙</li></ul></li></ul>');
  const $ = parse(materializeNestedLists(source).html);
  const borders = $('[style]').toArray().filter(node => [...styles($(node)).keys()].some(name => name.startsWith('border-left')));
  assert.equal(borders.length, 1);
  assert.equal(styles($(borders[0])).get('border-left'), '1px dotted #E9D5AB');
  assert.equal($(borders[0]).is(ROW), false);
  assert.deepEqual(markerTexts($), ['•', '◦', '◦', '◦']);
});

test('再次转换逐字节不变，不增加包装、标记或层级', () => {
  const source = wrap('<ul><li>父<ol start="3"><li>子</li></ol><p>返回父段</p></li></ul>');
  const once = materializeNestedLists(source);
  const twice = materializeNestedLists(once.html);
  assert.equal(twice.html, once.html);
  assert.deepEqual(twice.warnings, []);
  assert.equal(parse(twice.html)(ITEM).length, 2);
  assert.equal(parse(twice.html)(MARKER).length, 2);
});

test('子列表位于多层 section 容器内时保持所有前后内容与条目归属', () => {
  const source = wrap('<ul style="list-style-type:disc"><li><section class="rich-wrapper" style="color:#246813"><p>前文<strong style="color:#135724">强调</strong></p><section data-caption="原容器"><p>列表之前</p><ul style="list-style-type:circle"><li><span style="font-style:italic">包裹子项</span></li></ul><p>列表之后<a href="https://example.test/end">链接</a></p></section><p>外容器之后<img src="https://example.test/image.png" alt="图"></p></section><p>父项末尾</p></li></ul>');
  const before = parse(source);
  const result = materializeNestedLists(source);
  const $ = parse(result.html);
  assert.equal(withoutGeneratedMarkers($('#nice')), compact(before('#nice').text()));
  assert.equal($('#nice ul,#nice ol,#nice li').length, 0);
  assert.equal($(ITEM).length, 2);
  assert.equal($(ITEM).eq(1).parents(ITEM).length, 1);
  for (const text of ['前文', '列表之前', '包裹子项', '列表之后', '外容器之后', '父项末尾']) {
    assert.equal(withoutGeneratedMarkers($('#nice')).split(text).length - 1, 1, `${text} 不得丢失或重复`);
  }
  assert.equal(styles($('strong')).get('color'), '#135724');
  assert.equal($('a').attr('href'), 'https://example.test/end');
  assert.equal($('img').attr('src'), 'https://example.test/image.png');
  assert.equal(result.listCount, 2);
  assert.equal(result.maxDepth, 2);
});

test('实际和转义的代码内容都保持原样，代码中的列表不计入转换深度', () => {
  const code = '<pre style="color:#112233"><code class="language-html">&lt;ul&gt;示例&lt;/ul&gt;<ul><li>代码父<ul><li>代码子</li></ul></li></ul></code></pre>';
  const inlineCode = '<code data-demo="inline"><ul><li>内联父<ul><li>内联子</li></ul></li></ul></code>';
  const source = wrap(code + inlineCode + '<ul><li>正文父<ul><li>正文子</li></ul></li></ul>');
  const before = parse(source);
  const result = materializeNestedLists(source);
  const $ = parse(result.html);
  assert.equal($.html($('pre')[0]), before.html(before('pre')[0]));
  assert.equal($.html($('code[data-demo]')[0]), before.html(before('code[data-demo]')[0]));
  assert.equal($('pre').find(ITEM).length, 0);
  assert.equal($('code[data-demo]').find(ITEM).length, 0);
  assert.equal($(ITEM).length, 2);
  assert.equal(result.listCount, 2);
  assert.equal(result.itemCount, 2);
  assert.equal(result.maxDepth, 2);
});

test('十三层列表缩小间距使累计缩进不超过 120px，同时保留完整层级', () => {
  const depth = 13;
  let tree = '';
  for (let level = depth; level >= 1; level -= 1) tree = `<ul><li>层${level}${tree}</li></ul>`;
  const result = materializeNestedLists(wrap(tree));
  const $ = parse(result.html);
  const rows = headRows($).toArray();
  assert.equal(rows.length, depth);
  assert.equal(result.maxDepth, depth);
  assert.equal(result.listCount, depth);
  assert.equal(result.itemCount, depth);
  assert.deepEqual(rows.map(node => Number($(node).attr('data-wechat-list-depth'))), Array.from({ length: depth }, (_, index) => index + 1));
  const offsets = rows.map(node => marginLeft($(node)));
  assert.equal(offsets[0], 0);
  assert.ok(offsets.every(value => value >= 0 && value <= 120), JSON.stringify(offsets));
  for (let index = 1; index < offsets.length; index += 1) {
    assert.ok(offsets[index] > offsets[index - 1], '深层不能靠截断为同一缩进伪装为不同层级');
  }
  assert.ok(offsets[1] < 24, '深层树必须缩小步长');
});

test('深色适配保护普通行和受管任务图标，其余任务子树与代码保持原样', () => {
  const background = id => `background-image:url('app://vault/${id}.png');background-repeat:no-repeat;background-position:left 7px;background-size:16px 16px`;
  const source = wrap(`<ul><li style="padding-left:25px;list-style-type:none;${background('bullet')}">普通父<ul><li>普通子</li></ul></li><li class="wechat-task-item is-unchecked" style="list-style-type:none"><p class="wechat-task-line"><span class="wechat-task-marker is-unchecked" style="font-size:0;${background('task')}">☐</span>任务父</p><ul><li style="padding-left:25px;list-style-type:none;${background('bullet')}">任务内普通子<code style="color:#ffffff;background-color:#112233">代码</code></li></ul></li></ul>`);
  const converted = materializeNestedLists(source);
  const before = parse(converted.html);
  const assets = ['bullet', 'task'].map(id => ({ target: id, origin: 'theme', filePath: `/vault/${id}.png`, url: `app://vault/${id}.png` }));
  const result = applyWechatDarkMode(converted.html, { policy: { strategy: 'preserve-backgrounds' }, backgroundImages: assets });
  const $ = parse(result.html);
  assert.equal(headRows($).first().attr('data-no-dark'), '');
  assert.equal($(TASK_SCOPE).first().find('[data-no-dark]').length, 1);
  assert.equal($(TASK_SCOPE).first().find('.wechat-task-marker').attr('data-no-dark'), '');
  assert.equal($(TASK_SCOPE).first().attr('data-no-dark'), undefined);
  $(TASK_SCOPE).first().find('.wechat-task-marker').removeAttr('data-no-dark');
  assert.equal($.html($(TASK_SCOPE).first()[0]), before.html(before(TASK_SCOPE).first()[0]));
  assert.equal($.html($('code')[0]), before.html(before('code')[0]));
  assert.equal($('[data-wechat-darkmode-surface="list"]').length, 0);
  assert.equal($(ITEM).length, 4);
  assert.deepEqual(result.warnings, []);
});
