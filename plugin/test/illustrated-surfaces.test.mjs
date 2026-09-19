import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio/slim';
import { materializeIllustratedSurfaces } from '../src/illustrated-surfaces.mjs';
import { parseThemeManifest } from '../src/theme-package.mjs';
import { renderArticle } from '../src/pipeline.mjs';
import { copyRenderedArticle } from '../plugin/copy.mjs';

const policy={strategy:'preserve-illustrated-surfaces'};
const quotePolicy={...policy,replaceNativeQuotes:true};
const quotePolicySource={...policy,replace_native_quotes:true};
const decorationPolicy={...policy,materializeDecorations:true};
const decorationPolicySource={...policy,materialize_decorations:true};
const ids=['sides','top','bottom','fruit','girl','frame','watermark','line','quote'];
const records=ids.map(id=>({target:id,id,url:`app://theme/${id}.png`,origin:'theme',filePath:`theme/${id}.png`,wechatUrl:`https://mmbiz.qpic.cn/mmbiz_png/${id}/640?wx_fmt=png`}));
const bg=id=>`background-color:transparent;background-image:url('app://theme/${id}.png');background-repeat:no-repeat;background-size:100% 10px`;
const marker=(id,w='100%',h='10px')=>`<span style="display:block;width:${w};height:${h};${bg(id)}"></span>`;
const codeText='  const text = "<span>";\n\n\treturn 12;';
const code=`<pre style="margin:26px 0;padding:0;${bg('sides')}">${marker('top')}<code class="language-js" style="padding:48px 24px 4px 36px;font-size:13px;line-height:1.8;white-space:pre-wrap;${bg('fruit')}">  const text = "&lt;span&gt;";\n\n\treturn <span class="hljs-number">12</span>;${marker('girl','24px','30px')}</code>${marker('bottom')}</pre>`;
const table=`<table style="width:100%;margin:26px 0;${bg('frame')}"><thead><tr style="${bg('line')}"><th colspan="2" style="padding:18px 24px">表头</th></tr></thead><tbody style="${bg('watermark')}"><tr style="${bg('line')}"><td rowspan="2" style="padding:13px 12px 14px 34px">跨行</td><td style="padding:13px 12px">42</td></tr><tr><td style="padding:13px 12px">108</td></tr></tbody></table>`;
const article=body=>`<!--prefix--><section id="nice">${body}</section><!--suffix-->`;
const run=html=>materializeIllustratedSurfaces(html,{policy,backgroundImages:records});
const parse=html=>load(html,{},false);

test('inline paint protection keeps the original watercolor bitmap and text with transparent marked spans',()=>{
 const input=article(`<p><mark style="${bg('fruit')}"><strong>高亮</strong></mark>与<u style="${bg('line')}">笔绘</u></p>`);
 const opted={...policy,protectInlinePaint:true};
 const result=materializeIllustratedSurfaces(input,{policy:opted,backgroundImages:records}), $=parse(result.html);
 assert.equal($('mark,u').length,0);
 assert.equal($('[data-wechat-illustrated="inline-paint"][data-no-dark]').length,2);
 assert.equal($('p').text(),'高亮与笔绘');
 assert.equal($('strong').text(),'高亮');
 assert.match($('[data-wechat-illustrated="inline-paint"]').first().attr('style'),/fruit.png/);
 assert.match($('[data-wechat-illustrated="inline-paint"]').last().attr('style'),/line.png/);
 assert.equal(materializeIllustratedSurfaces(result.html,{policy:opted,backgroundImages:records}).html,result.html);
 assert.equal(parse(run(input).html)('mark,u').length,2);
});

test('list marker backgrounds become real transparent images and leave li surfaces unpainted',()=>{
 const listStyle=id=>`margin:8px 0;padding-left:25px;background-color:transparent;background-image:url('app://theme/${id}.png');background-repeat:no-repeat;background-position:1px 7px;background-size:18px 18px`;
 const input=article(`<ul><li style="${listStyle('fruit')}">第一项<ul><li style="${listStyle('girl')}">嵌套项</li></ul></li></ul>`);
 const result=materializeIllustratedSurfaces(input,{policy:decorationPolicy,backgroundImages:records});
 const $=parse(result.html),items=$('li'),markers=$('img[data-wechat-illustrated="list-marker"]');
 assert.equal(markers.length,2);
 assert.equal(markers.eq(0).attr('src'),'app://theme/fruit.png');
 assert.equal(markers.eq(1).attr('src'),'app://theme/girl.png');
 for(const item of items.toArray()){
  assert.doesNotMatch($(item).attr('style'),/background-image/);
  assert.match($(item).attr('style'),/padding-left:0/);
  assert.match($(item).attr('style'),/background-color:transparent/);
 }
 assert.deepEqual(result.images.map(image=>image.target).sort(),['fruit','girl']);
});

test('默认与其他策略不改动任何字节',()=>{
 const html=article(code+table);
 for(const p of [null,{strategy:'preserve-backgrounds'},{strategy:'preserve-table-surfaces'}])assert.equal(materializeIllustratedSurfaces(html,{policy:p,backgroundImages:records}).html,html);
});
test('显式启用后用透明 section 取代简单原生引用，默认策略与复杂引用不变',()=>{
 const simple=article(`<blockquote style="margin:24px 0;padding:10px 0 10px 78px;border-left:4px solid #333333;${bg('quote')}"><p style="background-color:transparent">引用块。</p></blockquote>`);
 const converted=materializeIllustratedSurfaces(simple,{policy:quotePolicy,backgroundImages:records});const $=parse(converted.html);
 assert.equal($('blockquote').length,0);assert.equal($('[data-wechat-illustrated="quote"]').length,1);
 assert.equal($('[data-wechat-illustrated="quote"]').text(),'引用块。');
 assert.match($('[data-wechat-illustrated="quote"]').attr('style'),/border:none/);
 assert.match($('[data-wechat-illustrated="quote"]').attr('style'),/background-color:transparent/);
 assert.equal(converted.warnings.length,0);
 const plain=article('<blockquote style="margin:24px 0;padding:6px 0;border:none;background:none"><span></span><p>无背景金句。</p><span></span></blockquote>');
 const plainResult=materializeIllustratedSurfaces(plain,{policy:quotePolicy,backgroundImages:records}), plain$=parse(plainResult.html);
 assert.equal(plain$('blockquote').length,0);assert.equal(plain$('[data-wechat-illustrated="quote"]').text(),'无背景金句。');
 assert.equal(plainResult.warnings.length,0);
 assert.equal(parse(run(simple).html)('blockquote').toString(),parse(simple)('blockquote').toString(),'未请求替换时保留现有引用与金句图片化路径');
 const nested=simple.replace('<p style="background-color:transparent">引用块。</p>','<p>外层。</p><blockquote><p>内层。</p></blockquote>');
 const nestedResult=materializeIllustratedSurfaces(nested,{policy:quotePolicy,backgroundImages:records});
 assert.equal(parse(nestedResult.html)('blockquote').first().toString(),parse(nested)('blockquote').first().toString());
});
test('行内小装饰保持 inline-block，使图片与后续文字留在同一行',()=>{
 const source=article(`<p>${marker('quote','18px','27px').replace('display:block','display:inline-block')}列表文字</p>`);
 const $=parse(run(source).html), carrier=$('[data-wechat-illustrated="decoration"]');
 assert.match(carrier.attr('style'),/display:inline-block/);
 assert.equal(carrier.parent().text(),'列表文字');
 assert.equal(carrier.children('img').length,1);
});
test('代码装饰离开 pre/code，代码文字、空行、缩进和高亮保留',()=>{
 const result=run(article(code));const $=parse(result.html);
 assert.equal($('pre > code').text(),codeText);
 assert.equal($('pre > code .hljs-number').text(),'12');
 assert.equal($('pre img,pre section,code img,code section').length,0);
 assert.equal($('[data-wechat-illustrated="code"] img').length,3);
 assert.equal($('[data-wechat-illustrated="code-content"] > pre').length,1);
  assert.equal($('[data-wechat-illustrated="code-content"] > [data-wechat-illustrated="decoration"] img').attr('height'),'30');
 assert(result.html.startsWith('<!--prefix-->'));assert(result.html.endsWith('<!--suffix-->'));
 assert(!/background-image/.test($('pre').attr('style')));assert(!/background-image/.test($('pre > code').attr('style')));
 assert.equal(result.warnings.length,0);
});
test('删空节点和清除原生标签背景的模拟中，边框及小图仍有独立载体',()=>{
 const $=parse(run(article(code+table+marker('quote','20px','18px'))).html);
 $('span,section').each((_,node)=>{const e=$(node);if(!e.children().length&&!e.text().trim())e.remove();});
 $('pre,code,table,thead,tbody,tr,th,td').each((_,node)=>{$(node).attr('style',($(node).attr('style')??'').replace(/background[^;]*;?/g,''));});
 assert.equal($('img').length,4);
 assert.match($('[data-wechat-illustrated="code"]').attr('style'),/sides/);
 assert.match($('[data-wechat-illustrated="table-frame"]').attr('style'),/frame/);
 assert.equal($('table').length,1);assert.equal($('th').attr('colspan'),'2');assert.equal($('td').first().attr('rowspan'),'2');
 assert.equal($('table').text(),'表头跨行42108');
 assert.equal($('[data-wechat-illustrated="table-cell-content"][style*="watermark"]').length,1);
});
test('重复执行不重复包裹，也不会丢失图片登记',()=>{
 const once=run(article(code+table+marker('quote','20px','18px')));const twice=run(once.html);
 assert.equal(twice.html,once.html);assert.deepEqual(twice.images,once.images);
 assert.equal(twice.backgroundImageUrls.includes('app://theme/top.png'),false);
});
test('显式开启后把待办图标与分割线背景转换为真实图片，默认策略保持原结构',()=>{
 const task=`<ul><li class="wechat-task-item"><p><span class="wechat-task-marker is-checked" role="img" aria-label="已完成" style="display:inline-block;margin:0 7px 0 0;vertical-align:middle;background-image:url('app://theme/girl.png');background-size:24px 30px">✓</span>待办</p></li></ul>`;
 const divider=`<hr style="width:100%;height:34px;margin:20px auto;background-image:url('app://theme/line.png');background-repeat:no-repeat">`;
 const source=article(task+divider);
 assert.equal(parse(run(source).html)('span.wechat-task-marker').length,1);
 assert.equal(parse(run(source).html)('hr').length,1);
 const result=materializeIllustratedSurfaces(source,{policy:decorationPolicy,backgroundImages:records}), $=parse(result.html);
 assert.equal($('span.wechat-task-marker').length,0);
 assert.equal($('img.wechat-task-marker').attr('src'),'app://theme/girl.png');
 assert.equal($('img.wechat-task-marker').attr('width'),undefined);
 assert.match($('img.wechat-task-marker').attr('style'),/width:24px/);
 assert.equal($('hr').length,0);
 assert.equal($('[data-wechat-illustrated="separator"] > img').attr('src'),'app://theme/line.png');
 assert.equal(result.images.length,2);assert.equal(result.warnings.length,0);
 const twice=materializeIllustratedSurfaces(result.html,{policy:decorationPolicy,backgroundImages:records});
 assert.equal(twice.html,result.html);assert.deepEqual(twice.images,result.images);
});
test('带水印的窄表格只应用一次文章宽度，保留列结构',()=>{
 const source=table.replace('width:100%;margin:26px 0','width:84%;margin:28px 8%');
 const $=parse(run(article(source)).html);
 const frame=$('[data-wechat-illustrated="table-frame"]');
 assert.match(frame.attr('style'),/width:\s*84%/);
 assert.match(frame.attr('style'),/margin:\s*28px 8%/);
 assert.match(frame.attr('style'),/box-sizing:\s*border-box/);
 assert.match($('table').attr('style'),/width:\s*100%/);
 assert.equal($('th').attr('colspan'),'2');
 assert.equal($('td').first().attr('rowspan'),'2');
 assert.equal($('table').text(),'表头跨行42108');
});
test('未登记背景使组件完整退回，任务与正文行内代码保持原样',()=>{
 const task='<li class="wechat-task-item">'+marker('girl','24px','30px')+'待办<code>item</code></li>';
 const inline='<p>正文<code style="color:red">a</code></p>';
 const source=article(code.replace('app://theme/sides.png','app://unknown.png')+'<ul>'+task+'</ul>'+inline);
 const result=run(source);const $=parse(result.html),before=parse(source);
 assert.equal($('pre').toString(),before('pre').toString());assert.equal($('ul').toString(),before('ul').toString());assert.equal($('p').toString(),before('p').toString());
 assert(result.warnings.length>0);
});
test('清单策略显式启用并拒绝混入其他策略字段',()=>{
 const manifest=extra=>JSON.stringify({schema_version:3,theme_id:'crayon-sketch',name:'蜡笔手绘',assets:[],components:[],wechat_dark_mode:extra});
 assert.deepEqual(parseThemeManifest(manifest(policy)).wechatDarkMode,policy);
 assert.deepEqual(parseThemeManifest(manifest(quotePolicySource)).wechatDarkMode,quotePolicy);
 assert.deepEqual(parseThemeManifest(manifest(decorationPolicySource)).wechatDarkMode,decorationPolicy);
 assert.throws(()=>parseThemeManifest(manifest({...policy,replace_native_quotes:'true'})),/布尔/);
 assert.throws(()=>parseThemeManifest(manifest({...policy,materialize_decorations:'true'})),/布尔/);
 assert.throws(()=>parseThemeManifest(manifest({...policy,table_border_color:'#FFFFFF'})),/只接受 strategy/);
});
test('完整渲染和复制保留微信图片地址，不把小装饰降成图位',async()=>{
 const rendered=renderArticle({source:'```js\n  keep();\n```\n\n> 金句',themeCss:`#nice pre{${bg('sides').replace('app://theme/sides.png','theme-asset://sides')}} #nice pre::before{content:"";display:block;height:10px;background-image:url("theme-asset://top")} #nice blockquote::before{content:"";display:block;width:20px;height:18px;background-image:url("theme-asset://quote")}`,themeAssets:records,themeDarkMode:policy,resolve:()=>null});
 let written;const copied=await copyRenderedArticle({html:rendered.html,images:rendered.images,text:'',embedImages:true,resolveFile:()=>{throw Error('remote assets must not resolve files')},_clipboard:{write:value=>{written=value}}});
 const $=parse(written.html);
 assert.equal($('pre > code').text(),'  keep();');
 assert.equal($('img').length,2);assert([...$('img')].every(node=>$(node).attr('src').startsWith('https://mmbiz.qpic.cn/')));
 assert(!written.html.includes('app://'));assert.equal(copied.warnings.length,0);
});
test('未登记微信地址的小装饰直接内嵌本地图，不产生地址缺失告警',async()=>{
 const localRecords=records.map(({wechatUrl,...record})=>record);
 const result=materializeIllustratedSurfaces(article(marker('girl','24px','30px')),{policy,backgroundImages:localRecords});
 assert.equal(result.images[0].preferWechatUrl,false);
 let payload;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
 const copied=await copyRenderedArticle({html:result.html,images:result.images,text:'',embedImages:true,resolveFile:(_ref,image)=>({path:image.filePath}),readBinary:async()=>png,_clipboard:{write:value=>{payload=value}}});
 assert.equal(copied.warnings.length,0);
 assert.match(parse(payload.html)('img').attr('src'),/^data:image\/png;base64,/);
});
