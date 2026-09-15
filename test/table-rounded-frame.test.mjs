import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio/slim';
import postcss from 'postcss';
import { materializeTableSurfaces } from '../src/table-surfaces.mjs';
import { parseThemeManifest } from '../src/theme-package.mjs';

const policy = { strategy:'preserve-table-surfaces', roundedFrame:true };
const parse = html => load(html, {}, false);
const styles = e => new Map(postcss.parse(`x{${e.attr('style') || ''}}`).first.nodes.filter(d=>d.type==='decl').map(d=>[d.prop,d.value]));
const fixture = '<section id="nice"><p id="outside">正文</p><table id="table" style="width:100%;margin:30px 0;border:2px solid #B8B8B6;border-radius:12px;background-color:#E7E7E5;font-size:14px"><thead><tr><th style="padding:12px;background-color:#F2D16D;border-bottom:1px solid #D1D1CE;border-top-left-radius:8px">项目</th><th style="padding:12px;background-color:#F2D16D;border-top-right-radius:8px">结果</th></tr></thead><tbody><tr><td rowspan="2" style="padding:12px;background-color:#E7E7E5;border-bottom:1px solid #C8C8C6">合并行</td><td style="padding:12px;background-color:#E7E7E5"><strong style="color:#A96808">加粗</strong> 与 <code style="border:3px solid #DBAC36">代码</code></td></tr><tr><td style="padding:12px;background-color:#E7E7E5;border-bottom-right-radius:8px">内容<br>第二行</td></tr></tbody></table><blockquote>引用不变</blockquote></section>';
const run = (html=fixture, p=policy) => materializeTableSurfaces(html, { policy:p });

test('rounded table frame is an explicit boolean opt-in, leaving old manifests unchanged', () => {
  const manifest = mode => JSON.stringify({schema_version:3,theme_id:'rounded',name:'测试',assets:[],components:[],wechat_dark_mode:mode});
  assert.deepEqual(parseThemeManifest(manifest({strategy:policy.strategy})).wechatDarkMode,{strategy:policy.strategy});
  assert.deepEqual(parseThemeManifest(manifest({strategy:policy.strategy,rounded_frame:true})).wechatDarkMode,policy);
  for (const value of ['true', 1, {}, null]) assert.throws(()=>parseThemeManifest(manifest({strategy:policy.strategy,rounded_frame:value})),/布尔值/);
  const old = run(fixture,{strategy:policy.strategy});
  assert.equal(run(fixture,{strategy:policy.strategy,roundedFrame:false}).html,old.html);
});

test('rounded border and gray surface move to a protected section, not the collapsed native table', () => {
  const result=run(), $=parse(result.html), frame=$('[data-wechat-table-frame="rounded"]'), table=$('#table');
  assert.deepEqual(result.warnings,[]);
  assert.equal(frame.length,1); assert.equal(frame.children('table').length,1);
  assert.equal(frame.attr('data-no-dark'),'');
  const f=styles(frame), t=styles(table);
  for (const [k,v] of [['border','2px solid #B8B8B6'],['border-radius','12px'],['background-color','#E7E7E5'],['margin','30px 0'],['overflow','hidden']]) assert.equal(f.get(k),v);
  for (const [k,v] of [['border','0'],['border-radius','0'],['background-color','transparent'],['margin','0'],['border-collapse','separate'],['border-spacing','0'],['width','100%']]) assert.equal(t.get(k),v);
  assert.equal(frame.attr('style').includes('width:100%'),false,'auto block width includes the frame border');
  assert.equal(table.attr('cellspacing'),'0'); assert.equal(table.attr('cellpadding'),'0');
  assert.equal(table.attr('data-no-dark'),undefined,'native table is not the color protection carrier');
});

test('cell default grid is reset, explicit bottom rules and original text/row spans remain', () => {
  const $=parse(run().html), before=parse(fixture);
  for (const tag of ['table','thead','tbody','tr','th','td']) assert.equal($(tag).length,before(tag).length);
  assert.equal($('td[rowspan]').attr('rowspan'),'2');
  assert.deepEqual($('th,td').map((_,n)=>$(n).text()).get(),before('th,td').map((_,n)=>before(n).text()).get());
  assert.equal(styles($('th').first()).get('border'),'0');
  assert.equal(styles($('th').first()).get('border-bottom'),'1px solid #D1D1CE');
  assert.equal(styles($('th > section').first()).get('background-color'),'#F2D16D');
  assert.equal(styles($('th > section').first()).get('border-top-left-radius'),'8px');
  assert.equal(styles($('td > section').first()).get('background-color'),'#E7E7E5');
  assert.equal($('strong').attr('data-no-dark'),'');
  assert.equal($('code').toString(),before('code').toString());
  assert.equal($('#outside').toString(),before('#outside').toString());
  assert.equal($('blockquote').toString(),before('blockquote').toString());
});

test('rounded frame and cell surface conversion are idempotent', () => {
  const first=run(); assert.equal(run(first.html).html,first.html);
});

test('unsafe table background does not cause a partially converted table', () => {
  const bad=fixture.replace('width:100%;','background-image:url("https://unknown.example/a.png");width:100%;').replace('url("https://unknown.example/a.png")','url(&quot;https://unknown.example/a.png&quot;)');
  const result=run(bad); assert.equal(result.html,bad); assert.ok(result.warnings.length);
});

test('managed table watermark retains exact identity and geometry in the protected surface', () => {
  const asset={origin:'theme',filePath:'/fixture/paw.png',url:'file:///fixture/paw.png'};
  const html=fixture.replace('border-top-right-radius:8px','background-image:url(file:///fixture/paw.png);background-size:44px 42px;background-position:right top;background-repeat:no-repeat;border-top-right-radius:8px');
  const result=materializeTableSurfaces(html,{policy,backgroundImages:[asset]}), $=parse(result.html), surface=$('th').last().children('section');
  assert.deepEqual(result.warnings,[]);
  assert.equal(styles(surface).get('background-image'),'url(file:///fixture/paw.png)');
  assert.equal(styles(surface).get('background-size'),'44px 42px');
  assert.equal(styles(surface).get('background-position'),'right top');
  assert.equal(surface.attr('data-no-dark'),'');
});
