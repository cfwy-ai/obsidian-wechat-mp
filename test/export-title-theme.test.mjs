import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildExportHtml, normalizeExportOptions } from '../plugin/export-image.mjs';
import { prepareExportTitleTheme } from '../plugin/export-title-theme.mjs';

test('文首与 banner 在同一背景内，主标题不增加正文章节 H1 数量', () => {
  const body='<section id="nice" style="background-image:url(test.png)"><section class="banner">配图</section><h1>章节一</h1><p>正文</p></section>';
  const html=buildExportHtml({articleHtml:body,title:'文章\n主标题',author:'作者',titleTheme:{align:'center',color:'#253246'}});
  const fragment=html.slice(html.indexOf('<body>'));
  assert.match(fragment, /<section id="nice"[^>]*><header/);
  assert.match(fragment, /文章<br>主标题/);
  assert.match(fragment, /<\/header><section class="banner">/);
  assert.equal((fragment.match(/<h1>/g)||[]).length,1);
  assert.equal((fragment.match(/background-image:url\(test.png\)/g)||[]).length,1);
  assert.match(html,/background:transparent;text-align:center/);
  assert.equal(normalizeExportOptions({showAuthor:false,scale:1}).scale,2);
});

test('主题字体校验后嵌入导出页，字体损坏会明确回退', async () => {
  const bytes=Buffer.from('fixture-font');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const args={fonts:[{id:'headline',file:{stat:{size:bytes.length}},sha256,weight:400,style:'normal'}],
    headingImages:[{headingLevels:[1],fontId:'headline',align:'center',color:'#253246'}],readBinary:async()=>bytes};
  const theme=await prepareExportTitleTheme(args);
  assert.equal(theme.align,'center');
  assert.equal(theme.weight,400);
  assert.match(theme.fontCss,/data:font\/ttf;base64/);
  assert.deepEqual(theme.warnings,[]);
  const noFont=await prepareExportTitleTheme({...args,includeFont:false,readBinary:()=>{throw new Error('不应读取');}});
  assert.equal(noFont.align,'center');
  assert.deepEqual(noFont.warnings,[]);
  const fallback=await prepareExportTitleTheme({...args,readBinary:async()=>Buffer.from('bad')});
  assert.equal(fallback.family,'inherit');
  assert.match(fallback.warnings[0],/校验不一致/);
});
