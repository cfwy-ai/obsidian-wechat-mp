import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { load } from 'cheerio';
import { parseThemeManifest } from '../src/theme-package.mjs';
import { materializeQuoteImages } from '../plugin/quote-image.mjs';
import { renderQuoteComposition } from '../plugin/quote-composition.mjs';
import { HeadingImageLruCache, segmentGraphemes, verifyGeneratedHeadingPng } from '../plugin/heading-image.mjs';
import { copyRenderedArticle } from '../plugin/copy.mjs';
import { embedImagesForExport } from '../plugin/export-image.mjs';

const rule = { fontId: 'q', fallbackFontIds: [], fontSize: 20, lineHeight: 1.8, letterSpacing: .3, color: '#251D21',
  maxWidth: 640, fallbackWidth: 220, scale: 3, inlineCodeFont: 'quote', replaceNativeContainer: true,
  illustration: { assetId: 'art', widthPercent: 28, gapPercent: 4, layout: 'image' } };
const asset = { id: 'art', url: 'app://art.png', filePath: 'art.png' };
const raster = (width, height) => PNG.sync.write({width, height, data: Buffer.alloc(width * height * 4, 123)}, {colorType: 6});
const wrap = text => `<section id="nice"><blockquote style="margin:28px 8%;padding:8px 0;border:none">${text}</blockquote></section>`;
const paragraph = text => `<p style="font-size:20px;line-height:1.8;margin:0 0 14px">${text}</p>`;
const document = { createElement() {
  const c = { width: 0, height: 0 };
  c.getContext = () => ({ clearRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(c.width * c.height * 4) }) });
  return c;
} };
async function generate(html, overrides = {}) {
  return materializeQuoteImages({ html, images: [], themeId: 'dune-test', quoteImages: rule,
    fonts: [{ id: 'q' }], assets: [asset], layoutWidth: 390,
    loadFont: async () => ({ runtimeFamily: 'q', hash: 'font', weight: 400, style: 'normal',
      coverage: new Set([...html].map(c => c.codePointAt(0))), coverageHash: 'all', document }),
    loadIllustration: async () => ({ image: {}, width: 500, height: 700 }),
    cache: new HeadingImageLruCache(), measureFactory: () => () => 20,
    renderPng: ({layout, rule}) => ({bytes:raster(layout.width*rule.scale,layout.height*rule.scale)}),
    verifyPng: verifyGeneratedHeadingPng, segmentGraphemes, ...overrides });
}

test('image layout is explicit; old quote themes do not change', () => {
  const manifest = {schema_version:3,theme_id:'quote',name:'q',components:[],
    assets:[{asset_id:'art',file:'透明装饰素材/art.png'}],
    fonts:[{font_id:'q',file:'配套字体资源/q.woff2',family:'q',sha256:'a'.repeat(64)}],
    quote_images:{font_id:'q',illustration:{asset_id:'art',layout:'image'}}};
  assert.equal(parseThemeManifest(JSON.stringify(manifest)).quoteImages.illustration.layout,'image');
  delete manifest.quote_images.illustration.layout;
  assert.equal(parseThemeManifest(JSON.stringify(manifest)).quoteImages.illustration.layout,undefined);
});

test('320/390/430/677: one image fixes art at 28 percent and preserves original 20px glyph pixels', async () => {
  for (const width of [320,390,430,677]) {
    const html=wrap(paragraph('引用块，放金句。')+paragraph('里面也可能出现<strong>加粗</strong>和<code>行内代码</code>。'));
    const glyphs=[];
    const result=await generate(html,{layoutWidth:width,renderPng:({layout,rule})=>{
      const bytes=raster(layout.width*rule.scale,layout.height*rule.scale);glyphs.push(bytes);return {bytes};
    }});
    assert.deepEqual(result.warnings,[]);
    assert.equal(result.generatedCount,1);
    const $=load(result.html), record=result.images[0], geometry=record.quoteComposition;
    assert.equal($('blockquote,table,td').length,0);
    assert.equal($('[data-wechat-quote-composite]').length,1);
    assert.equal($('img').length,1);
    assert.ok(Math.abs(geometry.art.width/geometry.width-.28)<1e-9);
    assert.deepEqual(geometry.fontSizes,[20]);
    assert.equal(geometry.glyphScale,1);
    const combined=PNG.sync.read(record.bytes), first=PNG.sync.read(glyphs[0]);
    const x=Math.round(geometry.text.x*3), y=Math.round(geometry.text.y*3);
    // The original glyph rows must survive byte-for-byte, without a resize.
    for(let row=0;row<first.height;row++) {
      assert.deepEqual(combined.data.subarray(((y+row)*combined.width+x)*4,((y+row)*combined.width+x+first.width)*4),first.data.subarray(row*first.width*4,(row+1)*first.width*4));
    }
    const again=await generate(result.html,{images:result.images});
    assert.equal(again.html,result.html);
    assert.equal(again.images,result.images);
  }
});

test('adding paragraphs grows the canvas, never the art width or shrinks text; entities and manual breaks remain', async () => {
  const short=await generate(wrap(paragraph('甲。')));
  const content=paragraph('甲<br>乙 &amp; 丙。')+paragraph('字'.repeat(250));
  const longer=await generate(wrap(content));
  assert.deepEqual(longer.warnings,[]);
  assert.equal(longer.images[0].quoteComposition.art.width,short.images[0].quoteComposition.art.width);
  assert.ok(longer.images[0].quoteComposition.height>short.images[0].quoteComposition.height);
  assert.match(longer.images[0].alt,/甲\n乙 & 丙。/);
  assert.equal(longer.images[0].fallbackHtml,content);
});

test('copy and export preserve one composite; capacity fallback restores every rich paragraph without nesting a p', async () => {
  const result=await generate(wrap(paragraph('甲<strong>乙</strong>。')+paragraph('<code>A &amp; B</code>。')));
  const io={resolveFile(){throw Error('composite is already in memory');},readBinary(){throw Error('no local asset read');}};
  let payload;
  await copyRenderedArticle({html:result.html,images:result.images,embedImages:true,text:'',...io,_clipboard:{write:v=>{payload=v;}}});
  assert.equal(load(payload.html)('img').length,1);
  assert.equal(load(payload.html)('blockquote,table,td').length,0);
  const exported=await embedImagesForExport({html:result.html,images:result.images,...io,transformImage:async bytes=>({bytes,mimeType:'image/png'})});
  assert.equal(load(exported.html)('img').length,1);
  const fallback=await copyRenderedArticle({html:result.html,images:result.images,embedImages:true,text:'',maxSingleImageBytes:1,...io,_clipboard:{write:v=>{payload=v;}}});
  assert.equal(fallback.stats.quoteImages.textFallbacks,1);
  const $=load(payload.html);
  assert.equal($('img,blockquote,table,p p').length,0);
  assert.equal($('p').length,2);
  assert.equal($('strong').text(),'乙');assert.equal($('code').text(),'A & B');
});

test('drawing or composition failure is atomic; original quote remains complete',async()=>{
  const html=wrap(paragraph('第一句。')+paragraph('第二句。'));
  for(const overrides of [
    {loadIllustration:async()=>({width:500,height:700})},
    {renderPng:()=>{throw Error('draw failed');}},
    {verifyPng:()=>{throw Error('invalid PNG');}},
  ]) {
    const failed=await generate(html,overrides);
    assert.equal(failed.html,html);assert.equal(failed.generatedCount,0);assert.equal(failed.images.length,0);assert.ok(failed.warnings.length);
  }
  const nested=wrap('<p>甲</p><blockquote><p>乙</p></blockquote>');
  assert.equal((await generate(nested)).html,nested);
});

test('oversized art ratio and oversized quote fail before allocating composite canvas',()=>{
  let allocations=0;
  const doc={createElement(){allocations++;throw Error('must not allocate');}};
  const input={content:'<p><img data-wechat-generated-quote="true" src="q"></p>',records:[{url:'q',bytes:raster(210,60),alt:'字'}],
    illustration:{image:{},width:1,height:100000},width:320,rule,document:doc};
  assert.throws(()=>renderQuoteComposition(input),/过长/);assert.equal(allocations,0);
});
