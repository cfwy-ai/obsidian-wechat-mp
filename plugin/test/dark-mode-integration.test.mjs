import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from 'cheerio/slim';
import {parseThemeManifest} from '../src/theme-package.mjs';
import {renderArticle} from '../src/pipeline.mjs';
import {copyRenderedArticle,formatCopyResultNotice} from '../plugin/copy.mjs';

const rawPolicy={strategy:'preserve-backgrounds',table_border_color:'#c9a45c'};
const manifest=patch=>JSON.stringify({schema_version:3,theme_id:'night-test',name:'星夜测试',...patch});
const policy=parseThemeManifest(manifest({wechat_dark_mode:rawPolicy})).wechatDarkMode;
const asset={id:'moon',url:'file:///fixture/moon.png',filePath:'/fixture/moon.png',wechatUrl:'https://mmbiz.qpic.cn/mmbiz_png/fixture/640?wx_fmt=png&from=appmsg'};
const source='# 标题\n\n## 次级\n\n> 引用 **重点** 与 `代码`。\n\n- 第一项\n  - 子项\n- [ ] 待办\n\n| 项目 | 结果 |\n| --- | --- |\n| A | 42 |\n\n---\n\n```js\nconst x = 1;\n```';
const css=`#nice{background-color:#07080C;color:#D8D3C9;background-image:url("theme-asset://moon");font-size:16px;line-height:1.8}
#nice h1{font-size:0;background-image:url("theme-asset://moon");padding:8% 7%} #nice h1 .content{font-size:28px}
#nice h2{background-image:url("theme-asset://moon")} #nice blockquote{background-color:transparent;background-image:url("theme-asset://moon");padding:20px 12px 20px 90px;border:1px solid #66532E} #nice blockquote p{font-size:19px}
#nice ul>li:not(.wechat-task-item){background-image:url("theme-asset://moon");padding-left:25px}
#nice th,#nice td{background-image:url("theme-asset://moon");padding:14px 10px}
#nice hr{background-image:url("theme-asset://moon");height:78px;width:100%}
#nice pre{background-image:url("theme-asset://moon");border:1px solid #8E6A29} #nice pre code{color:#EAE5DA;background-color:#0A0D14;white-space:pre-wrap;word-break:break-all}`;
const render=extra=>renderArticle({source,themeCss:css,themeAssets:[asset],resolve:()=>null,...extra});

test('manifest深色背景适配必须显式启用，策略和颜色严格验证',()=>{
  assert.deepEqual(policy,{strategy:'preserve-backgrounds',tableBorderColor:'#C9A45C'});
  assert.equal(parseThemeManifest(manifest({})).wechatDarkMode,null);
  assert.equal(parseThemeManifest(manifest({wechat_dark_mode:null})).wechatDarkMode,null);
  for(const value of [true,[],{strategy:'force-dark',table_border_color:'#C9A45C'},{strategy:'preserve-backgrounds'},{...rawPolicy,table_border_color:'red'},{...rawPolicy,table_border_color:'#fff;background:url(x)'}]){
    assert.throws(()=>parseThemeManifest(manifest({wechat_dark_mode:value})),/wechat_dark_mode/);
  }
});

test('共用管线只为开启主题迁移装饰，预览保持本地图片和原生内容',()=>{
  const off=render({}),disabled=render({themeDarkMode:null}),on=render({themeDarkMode:policy});
  assert.equal(disabled.html,off.html);
  assert.deepEqual(disabled.images,off.images);
  assert.deepEqual(on.warnings,[]);
  const a=load(off.html,null,false),b=load(on.html,null,false);
  assert.equal(b('#nice').length,1);
  assert.equal(b('blockquote').length,1);
  assert.equal(b('th').length,2);assert.equal(b('td').length,2);
  assert.equal(b('li').length,a('li').length);
  assert.equal(b('[data-wechat-list-item]').length,3);
  assert.deepEqual(b('[data-wechat-list-item]').toArray().map(n=>b(n).attr('data-wechat-list-depth')),['1','2','1']);
  const protectedListRows=b('[data-wechat-list-row][data-no-dark]').toArray()
    .filter(n=>(b(n).attr('style')||'').includes(asset.url));
  assert.equal(protectedListRows.length,2);
  assert.equal(b('[data-wechat-darkmode-surface="list"]').length,0,'已适配列表不再二次包装');
  assert.equal(b('[role="separator"] img').attr('src'),asset.url);
  for(const n of b('blockquote,li:not(.wechat-task-item),th,td').get())assert(!/background-image/.test(b(n).attr('style')||''));
  assert.equal(b.html(b('pre')[0]),a.html(a('pre')[0]));
  assert.equal(b.html(b('.wechat-task-item')[0]),a.html(a('.wechat-task-item')[0]));
  assert.equal(on.images.length,1);
  assert.equal(on.images[0].preferWechatUrl,true);
  assert.equal(on.images[0].wechatUrl,asset.wechatUrl);
  assert(on.compatibility.backgroundImageUrls.includes(asset.url));
});

test('仅分割线素材转换后仍进入图片清单，且不伪报为剩余CSS背景',()=>{
  const out=renderArticle({source:'---',themeCss:'#nice hr{background-image:url("theme-asset://moon");height:78px}',themeAssets:[asset],themeDarkMode:policy,resolve:()=>null});
  assert.deepEqual(out.warnings,[]);
  assert.equal(out.images.length,1);
  assert.equal(out.images[0].preferWechatUrl,true);
  assert.deepEqual(out.compatibility.backgroundImageUrls,[]);
});

test('正式渲染接复制：分割线与重复背景使用同一已登记CDN且不读取本地图',async()=>{
  const out=render({themeDarkMode:policy});let payload;
  const copied=await copyRenderedArticle({html:out.html,text:source,images:out.images,embedImages:true,
    resolveFile:()=>{throw Error('Registered decoration should not read local image');},
    readBinary:()=>{throw Error('No local binary read expected');},
    _clipboard:{write:value=>{payload=value;}}});
  assert.deepEqual(copied.warnings,[]);
  assert.equal(copied.stats.themeImages.remote,1);
  assert.equal(copied.stats.themeImages.embedded,0);
  assert.equal(copied.sourceBytesRead,0);
  assert.equal(load(payload.html,null,false)('[role="separator"] img').attr('src'),asset.wechatUrl);
  assert.doesNotMatch(payload.html,/file:\/\/|app:\/\/|theme-asset:\/\//);
  assert(load(payload.html,null,false)('[data-no-dark]').length>0);
  assert.match(formatCopyResultNotice(copied),/主题装饰 1\/1/);
});

const rawFrame={border_asset_id:'gold',surface_asset_id:'paper',border_width:2,border_radius:10};
const frameManifest=(frame=rawFrame)=>parseThemeManifest(manifest({
  assets:['moon','gold','paper','unused'].map(id=>({asset_id:id,file:`透明装饰素材/${id}.png`})),
  wechat_dark_mode:{...rawPolicy,table_frame:frame},
}));
const frameAssets=['moon','gold','paper','unused'].map(id=>({
  id,url:`file:///fixture/${id}.png`,filePath:`/fixture/${id}.png`,
  wechatUrl:`https://mmbiz.qpic.cn/mmbiz_png/${id}/640?wx_fmt=png&from=appmsg`,
}));
const tableSource='| 项目 | 结果 |\n| --- | --- |\n| 一 | **42** |';
const plainTableCss='#nice{color:#EAE5DA}#nice table{width:100%;margin:34px 0;border:none;background-color:transparent}#nice th,#nice td{padding:12px;border-bottom:1px solid #C9A45C}';
const framedRender=extra=>renderArticle({source:tableSource,themeCss:plainTableCss,themeAssets:frameAssets,themeDarkMode:frameManifest().wechatDarkMode,resolve:()=>null,...extra});

test('table_frame严格归一资产和有界数值，省略尺寸默认2/10，旧策略对象不新增key',()=>{
  const expected={strategy:'preserve-backgrounds',tableBorderColor:'#C9A45C',tableFrame:{borderAssetId:'gold',surfaceAssetId:'paper',borderWidth:2,borderRadius:10,surfacePadding:[6,8,8]}};
  assert.deepEqual(frameManifest().wechatDarkMode,expected);
  assert.deepEqual(frameManifest({border_asset_id:'gold',surface_asset_id:'paper'}).wechatDarkMode,expected);
  assert.deepEqual(parseThemeManifest(manifest({wechat_dark_mode:rawPolicy})).wechatDarkMode,policy);
  assert(!Object.hasOwn(policy,'tableFrame'));
  for(const frame of [
    null,false,[],{},
    {...rawFrame,border_asset_id:'Gold'}, {...rawFrame,border_asset_id:'../gold'},
    {...rawFrame,border_asset_id:'not-registered'}, {...rawFrame,surface_asset_id:'not-registered'},
    {...rawFrame,extra:'unsupported'},
    ...[0,5,1.5,'2',null].map(border_width=>({...rawFrame,border_width})),
    ...[0,3,21,4.5,'10',null].map(border_radius=>({...rawFrame,border_radius})),
    {...rawFrame,border_width:4,border_radius:4},
    ...[null,[],[1,2,3,4,5],[-1],[25],['6'],[null],true].map(surface_padding=>({...rawFrame,surface_padding})),
  ])assert.throws(()=>frameManifest(frame),/wechat_dark_mode.table_frame/);
  for(const [width,radius] of [[1,4],[4,20]]){
    const p=frameManifest({...rawFrame,border_width:width,border_radius:radius}).wechatDarkMode;
    assert.equal(p.tableFrame.borderWidth,width);assert.equal(p.tableFrame.borderRadius,radius);
  }
  for(const surface_padding of [[0],[6,8],[0.5,8,24],[1,2,3,4]]){
    assert.deepEqual(frameManifest({...rawFrame,surface_padding}).wechatDarkMode.tableFrame.surfacePadding,surface_padding);
  }
});

test('仅manifest引用的框素材进入受管池与复制清单，before_table装饰留在框外',async()=>{
  const out=framedRender({themeComponents:[{id:'before-table',slot:'before_table',assetIds:[],html:'<p class="before-table">表前装饰</p>'}]});
  assert.deepEqual(out.warnings,[]);
  const $=load(out.html,null,false);
  const frame=$('[data-wechat-darkmode-surface="table-frame"]');
  const surface=$('[data-wechat-darkmode-surface="table-surface"]');
  assert.equal(frame.length,1);assert.equal(surface.length,1);
  assert.equal(frame.attr('data-no-dark'),'');assert.equal(surface.attr('data-no-dark'),'');
  assert.match(surface.attr('style'),/padding:\s*6px 8px 8px/);
  assert.equal(surface.children('table').length,1);
  assert.equal(frame.find('.before-table').length,0);
  assert.equal(frame.prev('.before-table').length,1);
  assert.equal($('thead th').length,2);assert.equal($('tbody td').length,2);
  assert.equal($('td strong').text(),'42');
  assert.match(frame.attr('style'),/margin:\s*34px 0/);
  assert.match($('table').attr('style'),/margin:\s*0(?:;|$)/);
  for(const e of $('table,th,td').get())assert(!/background-image/.test($(e).attr('style')||''));
  assert.deepEqual(out.images.map(i=>i.target).sort(),['gold','paper']);
  assert.deepEqual([...out.compatibility.backgroundImageUrls].sort(),['file:///fixture/gold.png','file:///fixture/paper.png']);
  const copied=await copyRenderedArticle({html:out.html,text:tableSource,images:out.images,embedImages:true,
    resolveFile:()=>{throw Error('Frame CDN should not read local data');},
    readBinary:()=>{throw Error('Frame CDN should not read local data');},
    _clipboard:{write:()=>{}}});
  assert.deepEqual(copied.warnings,[]);
  assert.equal(copied.remoteBackgroundCount,2);
  assert.equal(copied.stats.themeBackgrounds.remote,2);
  assert.equal(copied.stats.resources.localProcessed,0);
  assert.doesNotMatch(copied.html,/file:\/\/|app:\/\/|theme-asset:\/\//);
});

test('同一素材供框面及已有分割图使用，图片记录去重且不丢preferWechatUrl',async()=>{
  const sharedPolicy=frameManifest({border_asset_id:'moon',surface_asset_id:'moon'}).wechatDarkMode;
  const out=render({themeDarkMode:sharedPolicy});
  assert.deepEqual(out.warnings,[]);
  assert.equal(load(out.html,null,false)('[data-wechat-darkmode-surface="table-frame"]').length,1);
  assert.equal(out.images.length,1);
  assert.equal(out.images[0].target,'moon');assert.equal(out.images[0].preferWechatUrl,true);
  assert.equal(new Set(out.compatibility.backgroundImageUrls).size,1);
  const copied=await copyRenderedArticle({html:out.html,text:source,images:out.images,embedImages:true,
    resolveFile:()=>{throw Error('Registered shared asset should not read locally');},
    readBinary:()=>{throw Error('No local read expected');},_clipboard:{write:()=>{}}});
  assert.deepEqual(copied.warnings,[]);
  assert.equal(copied.stats.themeImages.remote,1);assert.equal(copied.remoteBackgroundCount,1);
  assert.equal(copied.embeddedCount,1);
});

test('配置缺素材或运行时坏尺寸仅降级表框，C引用列表分割线保护仍执行',()=>{
  const baseline=render({themeDarkMode:policy});
  const brokenPolicies=[
    frameManifest().wechatDarkMode,
    {...policy,tableFrame:{borderAssetId:'moon',surfaceAssetId:'moon',borderWidth:9,borderRadius:10}},
  ];
  for(const themeDarkMode of brokenPolicies){
    const out=render({themeDarkMode});
    assert(out.warnings.length>0);
    const $=load(out.html,null,false);
    assert.equal($('[data-wechat-darkmode-surface="table-frame"]').length,0);
    assert.equal($('[data-wechat-darkmode-surface="quote"]').length,1);
    const rows=$('[data-wechat-list-row][data-no-dark]').toArray()
      .filter(n=>($(n).attr('style')||'').includes(asset.url));
    assert.equal(rows.length,2,'表框降级不能移除嵌套列表的背景保护');
    assert.equal($('[data-wechat-darkmode-surface="list"]').length,0);
    assert.equal($('[data-wechat-darkmode-surface="separator"]').length,1);
    assert.equal(out.html,baseline.html);
    assert.deepEqual(out.images,baseline.images);
  }
  const incomplete=framedRender({themeAssets:frameAssets.map(a=>a.id==='gold'?{...a,filePath:undefined}:a)});
  assert(incomplete.warnings.length>0);
  assert.equal(load(incomplete.html,null,false)('[data-wechat-darkmode-surface="table-frame"]').length,0);
  assert.deepEqual(incomplete.images,[]);
});

test('未使用框素材不进入最终images，未开启策略保留原字节',()=>{
  const noTable=framedRender({source:'只有正文。'});
  assert.deepEqual(noTable.warnings,[]);assert.deepEqual(noTable.images,[]);
  assert.deepEqual(noTable.compatibility.backgroundImageUrls,[]);
  const off=framedRender({themeDarkMode:null});
  const old=renderArticle({source:tableSource,themeCss:plainTableCss,themeAssets:frameAssets,resolve:()=>null});
  assert.equal(off.html,old.html);assert.deepEqual(off.images,old.images);assert.deepEqual(off.warnings,old.warnings);
});
