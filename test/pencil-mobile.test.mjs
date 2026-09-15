import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio/slim';
import { renderArticle } from '../src/pipeline.mjs';
import { materializeIllustratedSurfaces } from '../src/illustrated-surfaces.mjs';
import { parseThemeManifest } from '../src/theme-package.mjs';
import { referenceCopyLayoutWidth } from '../plugin/reference-layout.mjs';

const records=['leaf','single','line','wash'].map(id=>({id,target:id,url:`app://theme/${id}.png`,filePath:`theme/${id}.png`,origin:'theme'}));
const bg=id=>`background-image:url("app://theme/${id}.png");background-size:18px 18px;background-color:transparent`;
const policy={strategy:'preserve-illustrated-surfaces',materializeDecorations:true,rasterizeInlinePaint:true,tableRuleImages:true};

test('composed quotes copy at the phone preview width; existing reference and native quote rules keep their widths',()=>{
 const input=layoutWidth=>({quoteImageSource:{layoutWidth,quoteImages:{illustration:{layout:'image'}}}});
 assert.equal(referenceCopyLayoutWidth(input(390),320),390);
 assert.equal(referenceCopyLayoutWidth(input(430),320),430);
 assert.equal(referenceCopyLayoutWidth(input(677),320),390);
 assert.equal(referenceCopyLayoutWidth({quoteImageSource:{layoutWidth:390,quoteImages:{}}},320),320);
 assert.equal(referenceCopyLayoutWidth({...input(390),referenceLayoutSource:{renderInput:{referenceComposition:{designWidth:375}}}},320),375);
});

test('nested UL and OL head rows lose painted backdrops and keep explicit depth and hanging text',()=>{
 const source='- 第一项\n- 第二项\n  - 嵌套的长行需要保持缩进\n\n1. 第一步\n2. 第二步\n   1. 子步骤\n';
 const css='#nice{padding:24px;font-size:16px}#nice ul{padding:0;list-style-type:none}#nice li{padding-left:25px;background-image:url("theme-asset://leaf");background-size:18px 18px}';
 const rendered=renderArticle({source,themeCss:css,themeAssets:records,themeDarkMode:policy,resolve:()=>null});
 const $=load(rendered.html),rows=$('[data-wechat-list-row="head"]');
 assert.equal(rows.length,6);
 assert.equal(rows.find('img[data-wechat-illustrated="list-marker"]').length,6);
 for(const row of rows.toArray()){
  assert.doesNotMatch($(row).attr('style'),/background-image/);
  assert.match($(row).children('p').first().attr('style'),/text-indent:\s*-25px/);
 }
 assert.equal($('[data-wechat-list-depth="2"][data-wechat-list-row]').length,2);
 assert.match(rows.last().text(),/子步骤/);
});

test('table pencil rules become real image rows while cells keep contents, colspan and rowspan',()=>{
 const input=`<section id="nice"><table><tbody><tr style='${bg('line')}'><td rowspan="2">跨行</td><td>A</td><td>B</td></tr><tr style='${bg('line')}'><td colspan="2">合并内容</td></tr></tbody></table></section>`;
 const r=materializeIllustratedSurfaces(input,{policy,backgroundImages:records});
 assert.deepEqual(r.warnings,[]);
 const $=load(r.html),separators=$('tr[data-wechat-table-rule]');
 assert.equal(separators.length,2);
 assert.equal(separators.eq(0).children('td').attr('colspan'),'2');
 assert.equal(separators.eq(1).children('td').attr('colspan'),'3');
 assert.equal($('td[rowspan]').attr('rowspan'),'3');
 assert.equal($('td[colspan="2"]').filter((_,n)=>$(n).text()==='合并内容').length,1);
 assert.equal($('tr[style*="background-image"]').length,0);
 assert.equal($('img[data-wechat-illustrated="table-rule"]').length,2);
 const again=materializeIllustratedSurfaces(r.html,{policy,backgroundImages:records});
 assert.equal(again.html,r.html);
});

test('inline paint opt-in marks all original texture types and skips code contents',()=>{
 const input=`<section id="nice"><p><mark style='${bg('wash')}'>高亮</mark><u style='${bg('line')}'>下划线</u><del style='${bg('line')}'>删除</del></p><pre><code><mark style='${bg('wash')}'>代码原文</mark></code></pre></section>`;
 const r=materializeIllustratedSurfaces(input,{policy,backgroundImages:records}),$=load(r.html);
 assert.equal($('[data-wechat-raster-inline]').length,3);
 assert.equal($('pre [data-wechat-raster-inline]').length,0);
 assert.match($('mark').first().attr('style'),/wash/);
});

test('new surface options are explicit booleans; old manifests retain their normalized shape',()=>{
 const manifest=wechat_dark_mode=>JSON.stringify({schema_version:3,theme_id:'demo',name:'示例',assets:[],components:[],wechat_dark_mode});
 assert.deepEqual(parseThemeManifest(manifest({strategy:policy.strategy})).wechatDarkMode,{strategy:policy.strategy});
 assert.equal(parseThemeManifest(manifest({strategy:policy.strategy,rasterize_inline_paint:true,table_rule_images:true})).wechatDarkMode.tableRuleImages,true);
 assert.throws(()=>parseThemeManifest(manifest({strategy:policy.strategy,table_rule_images:'true'})),/布尔/);
});
