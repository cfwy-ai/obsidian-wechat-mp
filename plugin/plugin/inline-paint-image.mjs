import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import html2canvas from './export-background-renderer.mjs';

const escape=value=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
const MARK='data-wechat-raster-inline';

/** Only explicitly marked, themed paint is rendered. Text and its original
 * pencil texture share one transparent bitmap; fallback retains the original
 * element, and links/footnotes stay interactive instead of being flattened. */
export async function materializeInlinePaint({html,images=[],layoutWidth=390,
  document:owner=globalThis.document,readAsset,cache=new Map(),render=html2canvas}={}){
  if(!String(html).includes(MARK))return {html,images,warnings:[],generatedCount:0};
  const frame=owner.createElement('iframe');
  frame.style.cssText=`position:fixed;left:-100000px;top:0;width:${layoutWidth}px;height:1000px;border:0;visibility:visible;pointer-events:none;`;
  const loaded=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('行内笔触画布加载超时')),15000);
    frame.onload=()=>{clearTimeout(timer);resolve();};
  });
  frame.srcdoc=`<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}</style></head><body>${html}</body></html>`;
  owner.body.append(frame);
  const warnings=[],records=[],sourceMap=new Map(images.map(i=>[i.url,i]));
  try{
    await loaded;const doc=frame.contentDocument;await doc.fonts.ready;
    const root=doc.querySelector('#nice');
    if(!root)throw new Error('行内笔触缺少正文容器');
    const elements=[...root.querySelectorAll(`[${MARK}]`)]
      .filter(e=>!e.parentElement.closest(`[${MARK}]`));
    for(const element of elements){
      if(element.querySelector('a,img,sup,sub,input')){
        warnings.push('含链接或复杂内容的行内批注保留原文');continue;
      }
      const original=element.outerHTML;
      const style=doc.defaultView.getComputedStyle(element);
      const inherited={font:style.font,color:style.color,letterSpacing:style.letterSpacing,
        wordSpacing:style.wordSpacing,whiteSpace:'normal',wordBreak:style.wordBreak};
      const parentWidth=Math.min(layoutWidth,element.parentElement.getBoundingClientRect().width);
      const key=createHash('sha256').update(JSON.stringify([original,inherited,parentWidth,3])).digest('hex');
      let result=cache.get(key);
      try{
        if(!result){
          const box=doc.createElement('span'),clone=element.cloneNode(true);
          box.style.cssText=`position:absolute;left:0;top:0;display:inline-block;max-width:${Math.max(80,parentWidth-4)}px;padding:1px;margin:0;border:0;background:transparent;`;
          Object.assign(box.style,inherited);box.style.lineHeight='1.45';
          Object.assign(clone.style,inherited);
          clone.style.display='inline';clone.style.maxWidth='none';clone.style.lineHeight='1.45';
          const paints=[clone,...clone.querySelectorAll('[style]')];
          for(const paint of paints){
            const match=/url\(["']?(.+?)["']?\)/.exec(paint.style.backgroundImage||'');
            if(!match)continue;
            const asset=sourceMap.get(match[1]);
            if(!asset)throw new Error('笔触素材未登记');
            const bytes=await readAsset(asset);
            paint.style.backgroundImage=`url("data:image/png;base64,${Buffer.from(bytes).toString('base64')}")`;
          }
          box.append(clone);doc.body.append(box);
          try{
            const bounds=box.getBoundingClientRect();
            const width=Math.ceil(bounds.width),height=Math.ceil(bounds.height);
            if(width<1||height<1||height>1600)throw new Error('行内批注尺寸超出范围');
            const canvas=await render(box,{backgroundColor:null,scale:3,width,height,
              windowWidth:layoutWidth,windowHeight:1000,useCORS:true,logging:false});
            const bytes=Buffer.from(canvas.toDataURL('image/png').split(',')[1],'base64');
            if(bytes.length>1024*1024)throw new Error('行内批注图片超过1MiB');
            result={bytes,width,height};cache.set(key,result);
          }finally{box.remove();}
        }
        const url=`data:image/png;base64,${result.bytes.toString('base64')}`;
        const img=doc.createElement('img');img.src=url;
        img.alt=element.textContent;img.setAttribute('data-wechat-inline-paint-image','true');
        img.setAttribute('data-no-dark','');
        img.style.cssText=`display:inline-block;width:${result.width}px;max-width:100%;height:auto;margin:0;padding:0;border:0;border-radius:0;background:transparent;vertical-align:middle;`;
        element.replaceWith(img);
        records.push({target:`generated-inline-paint-${key.slice(0,16)}.png`,url,
          origin:'generated',generatedKind:'inline-paint',bytes:result.bytes,mimeType:'image/png',
          alt:img.alt,fallbackHtml:original.replace(/ data-wechat-raster-inline="true"/g,'')});
      }catch(error){warnings.push(`行内笔触已保留原文：${error.message}`);}
    }
    // DOM serialization is intentional here: generated image nodes are inserted
    // after normal sanitization, as in the heading and quote image runtimes.
    const output=doc.body.innerHTML;
    const kept=images.filter(i=>!i.url||output.includes(escape(i.url))||output.includes(i.url));
    return {html:output,images:[...kept,...records],warnings,generatedCount:records.length};
  }finally{frame.remove();}
}
