import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio/slim';
import { applyWechatDarkMode } from '../src/dark-mode.mjs';
import { materializeNestedLists } from '../src/nested-lists.mjs';
import { copyRenderedArticle } from '../plugin/copy.mjs';

const parse = html => load(html, {}, false);
const policy = { strategy: 'preserve-backgrounds', tableBorderColor: '#C9A45C' };
const imageRecord = id => ({
  target: id,
  origin: 'theme',
  filePath: `/fixture/${id}.png`,
  url: `file:///fixture/${id}.png`,
  wechatUrl: `https://mmbiz.qpic.cn/mmbiz_png/${id}/640?wx_fmt=png&from=appmsg`,
});
const images = [imageRecord('todo-empty'), imageRecord('todo-done')];
const markerStyle = image => `display:inline-block;width:21px;height:21px;margin-right:7px;padding:0;border:none;border-radius:0;vertical-align:middle;font-size:0;line-height:0;background-image:url('${image.url}');background-repeat:no-repeat;background-position:center center;background-size:contain`;
const marker = (checked, attributes = '') => {
  const image = images[checked ? 1 : 0];
  return `<span class="wechat-task-marker ${checked ? 'is-checked' : 'is-unchecked'}" role="img" aria-label="${checked ? '已完成' : '未完成'}" style="${markerStyle(image)}" ${attributes}>${checked ? '✓' : '☐'}</span>`;
};
const task = (checked, extra = '') => `<li class="wechat-task-item ${checked ? 'is-checked' : 'is-unchecked'}" style="list-style-type:none;margin:8px 0;padding-left:0"><p class="wechat-task-line" style="margin:0;padding:0">${marker(checked)}${checked ? '已完成' : '未完成'}<strong style="color:#EFD078">重点</strong><code style="background-color:#11172A;color:#F3E2AE">行内代码</code></p>${extra}</li>`;
const flat = `<section id="nice"><ul style="list-style-type:none;padding-left:0">${task(false)}${task(true)}</ul></section>`;
const run = (html, extra = {}) => applyWechatDarkMode(html, { policy, backgroundImages: images, ...extra });
const markerCopies = $ => $('span.wechat-task-marker').toArray().map(node => ({
  attrs: Object.fromEntries(Object.entries($(node).attr()).filter(([key]) => key !== 'data-no-dark')),
  html: $(node).html(),
}));

test('平铺待办两状态只保护受管图片 marker 自身，其他任务节点不变', () => {
  const before = parse(flat), result = run(flat), after = parse(result.html);
  assert.equal(after('span.wechat-task-marker[data-no-dark]').length, 2);
  assert.equal(after('li[data-no-dark],li p[data-no-dark],li strong[data-no-dark],li code[data-no-dark]').length, 0);
  assert.deepEqual(markerCopies(after), markerCopies(before));
  after('span.wechat-task-marker').removeAttr('data-no-dark');
  assert.deepEqual(after('li').map((_,node)=>after.html(node)).get(), before('li').map((_,node)=>before.html(node)).get());
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(new Set(result.backgroundImageUrls), new Set(images.map(image => image.url)));
});

test('已有嵌套列表转换后的 task scope 内，图标仍受保护而其他作用域内容保持原样', () => {
  const source = `<section id="nice"><ul style="padding-left:0;list-style-type:none">${task(false, `<ul style="padding-left:0;list-style-type:none">${task(true)}</ul>`)}</ul></section>`;
  const nested = materializeNestedLists(source);
  assert.deepEqual(nested.warnings, []);
  const before = parse(nested.html);
  assert(before('[data-wechat-list-task-scope="true"]').length > 0);
  assert.equal(before('li').length, 0, 'Fixture exercises converted section list items, not the old li branch');
  const result = run(nested.html), after = parse(result.html);
  assert.equal(after('[data-wechat-list-task-scope="true"] span.wechat-task-marker[data-no-dark]').length, 2);
  assert.deepEqual(markerCopies(after), markerCopies(before));
  after('span.wechat-task-marker').removeAttr('data-no-dark');
  const topScope = $ => $('[data-wechat-list-task-scope="true"]').filter((_,node)=>$(node).parents('[data-wechat-list-task-scope="true"]').length===0);
  assert.deepEqual(topScope(after).map((_,node)=>after.html(node)).get(), topScope(before).map((_,node)=>before.html(node)).get());
});

test('无背景图片的 CSS 复选框及原生 checkbox 不添加例外标记', () => {
  const html = '<section id="nice"><ul><li class="wechat-task-item" style="padding:0"><p style="margin:0"><span class="wechat-task-marker is-unchecked" role="img" aria-label="未完成" style="display:inline-block;width:16px;height:16px;border:2px solid #FFCE2E;background-color:transparent">☐</span>未完成</p></li><li class="task-list-item" style="padding:0"><input type="checkbox" checked><span style="color:#333">原生待办</span></li></ul></section>';
  const before=parse(html), after=parse(run(html).html);
  assert.equal(after('span.wechat-task-marker[data-no-dark]').length, 0);
  assert.equal(after('ul').html(), before('ul').html());
});

test('未登记背景、非主题记录、近似地址和缺本地文件记录不获得保护标记', () => {
  const html=`<section id="nice"><ul>${task(false)}</ul></section>`;
  for(const backgroundImages of [[], [{...images[0],origin:'article'}], [{...images[0],url:images[0].url+'?v=1'}], [{...images[0],filePath:null}]]) {
    const result=run(html,{backgroundImages}), after=parse(result.html);
    assert.equal(after('.wechat-task-marker').attr('data-no-dark'), undefined);
    assert.deepEqual(markerCopies(after), markerCopies(parse(html)));
  }
});

test('pre/code 内即使伪装为任务作用域和受管 marker 也保持原样', () => {
  const html=`<section id="nice"><pre style="padding:16px;background-color:#0A0D14"><code style="white-space:pre-wrap"><span data-wechat-list-task-scope="true">${marker(false)}</span></code></pre><p>正文 <code style="background-color:#11172A"><span data-wechat-list-task-scope="true">${marker(true)}</span></code></p></section>`;
  const before=parse(html), after=parse(run(html).html);
  assert.equal(after('span.wechat-task-marker[data-no-dark]').length, 0);
  assert.equal(after.html(after('pre')[0]), before.html(before('pre')[0]));
  assert.equal(after.html(after('p > code')[0]), before.html(before('p > code')[0]));
});

test('policy 默认值/null 不改变任何字节，也不影响已存在的其他功能开关默认值', () => {
  for(const options of [undefined, {}, {policy:null,backgroundImages:images}]) {
    const result=applyWechatDarkMode(flat,options);
    assert.equal(result.html,flat);
    assert.deepEqual(result.images,[]);
    assert.deepEqual(result.warnings,[]);
  }
  const result=run(flat,{policy:{...policy,transparentCodeBlocks:false,nativeTableBorders:false}});
  assert.equal(parse(result.html)('.wechat-task-marker[data-no-dark]').length,2);
  assert.deepEqual(result.warnings,[]);
});

test('重复保护幂等；图标文字、21px 尺寸、间距、URL、角色和替代文本都保持不变', () => {
  const first=run(flat), second=run(first.html), $=parse(second.html);
  assert.equal(first.html,second.html);
  assert.deepEqual(first.backgroundImageUrls,second.backgroundImageUrls);
  assert.deepEqual(first.images,second.images);
  assert.deepEqual(markerCopies($),markerCopies(parse(flat)));
  $('.wechat-task-marker').each((index,node)=>{
    const element=$(node);
    assert.match(element.attr('style'),/width:21px;height:21px;margin-right:7px/);
    assert(element.attr('style').includes(images[index].url));
    assert.equal(element.attr('role'),'img');
    assert.equal(element.attr('aria-label'),index?'已完成':'未完成');
    assert.equal(element.text(),index?'✓':'☐');
  });
});

test('#nice 外的任务标记不被例外扫描处理，前后原文保持字节不变', () => {
  const prefix=`<aside data-kind='outside'><ul>${task(false)}</ul></aside>\n`;
  const suffix=`\n<footer><ul>${task(true)}</ul></footer>`;
  const result=run(prefix+flat+suffix), $=parse(result.html);
  assert(result.html.startsWith(prefix));
  assert(result.html.endsWith(suffix));
  assert.equal($('aside .wechat-task-marker[data-no-dark],footer .wechat-task-marker[data-no-dark]').length,0);
  assert.equal($('#nice .wechat-task-marker[data-no-dark]').length,2);
});

test('例外只处理 span.wechat-task-marker[style]，不放开任务内的任意背景元素', () => {
  const html=`<section id="nice"><ul><li class="wechat-task-item"><p style="margin:0"><span class="wechat-task-marker" role="img">☐</span><span class="other-decoration" style="${markerStyle(images[0])}">点缀</span><section class="wechat-task-marker" style="${markerStyle(images[1])}">非span</section></p></li></ul></section>`;
  const before=parse(html), after=parse(run(html).html);
  assert.equal(after('li [data-no-dark]').length,0);
  assert.equal(after('li').html(),before('li').html());
});

test('复制管线保留图标自身保护标记，并使用原登记微信 CDN，不读取本地图或触真实剪贴板', async () => {
  const output=run(flat);
  let captured, writes=0;
  const copied=await copyRenderedArticle({
    html:output.html,text:'未完成\n已完成',images,embedImages:true,
    resolveFile:()=>{throw Error('Registered marker backgrounds must not read a local image');},
    readBinary:()=>{throw Error('No binary read is permitted in this test');},
    _clipboard:{write:value=>{writes++;captured=value;}},
  });
  assert.equal(writes,1);
  assert.equal(captured.html,copied.html);
  assert.equal(copied.sourceBytesRead,0);
  assert.equal(copied.remoteBackgroundCount,2);
  assert.deepEqual(copied.warnings,[]);
  const $=parse(captured.html);
  assert.equal($('.wechat-task-marker[data-no-dark]').length,2);
  $('.wechat-task-marker').each((index,node)=>{
    const element=$(node), before=parse(flat)('.wechat-task-marker').eq(index);
    assert(element.attr('style').includes(images[index].wechatUrl));
    assert.doesNotMatch(element.attr('style'),/background-color|file:\/\/|app:\/\//);
    assert.match(element.attr('style'),/width:21px;height:21px;margin-right:7px/);
    assert.equal(element.text(),before.text());
    assert.equal(element.attr('role'),before.attr('role'));
    assert.equal(element.attr('aria-label'),before.attr('aria-label'));
  });
});
