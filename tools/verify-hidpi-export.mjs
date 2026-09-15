import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { buildExportHtml, renderLongImagePng, verifyPng } from '../plugin/export-image.mjs';

/** 在 Obsidian 的真实 Chromium 中验证原生像素绘制和物理分片边界。 */
export async function verifyHiDpiExport({ directory, nativeImage }) {
  await mkdir(directory, { recursive: true });
  const articleHtml = `<section style="width:677px;background:#f7f7f2;color:#253246;">${Array.from({length:43},(_,i)=>
    `<div style="box-sizing:border-box;height:139px;padding:12px 22px;border-top:1px solid #245bda;background:${i%2?'#eef3ff':'#ffffff'};"><h2 style="font-size:24px;margin:0 0 8px;">${String(i+1).padStart(2,'0')} · 高清长图与原比例排版</h2><p style="font-size:16px;line-height:1.8;margin:0;">中文细节、标点与文字边缘：字体会在更高分辨率下重新绘制。<br>PNG · JPEG · 0123456789 · 保持段落和图片的相对比例。</p></div>`).join('')}<div style="height:6px;background:#c80028"></div></section>`;
  const html=buildExportHtml({articleHtml,showTitle:false,showAuthor:false});
  const outputs=[];
  for (const scale of [1,1.5,2]) {
    const started=performance.now();
    const result=await renderLongImagePng(html,{scale});
    const file=join(directory,`高清导出-${scale}x.png`);
    await writeFile(file,result.bytes);
    verifyPng(result.bytes,{expectedWidth:result.width,expectedHeight:result.height});
    const decoded=PNG.sync.read(result.bytes);
    const top=nativeImage.createFromBuffer(result.bytes).crop({x:0,y:0,width:result.width,height:Math.min(result.height,Math.round(139*result.width/677))});
    await writeFile(join(directory,`文字细节-${scale}x.png`),top.toPNG());
    const bottom=((result.height-3)*result.width+Math.floor(result.width/2))*4;
    if(decoded.data[bottom]!==200||decoded.data[bottom+1]!==0||decoded.data[bottom+2]!==40) throw new Error('文章尾部标记缺失');
    // 对照较小测试片段和生产 8192px 分片，报告浏览器抗锯齿差异。
    const small=await renderLongImagePng(html,{scale,tileHeight:2048});
    const smallDecoded=PNG.sync.read(small.bytes);
    let differentPixels=0;
    let maxChannelDifference=0;
    for(let i=0;i<decoded.data.length;i+=4) {
      let changed=false;
      for(let c=0;c<4;c++){const delta=Math.abs(decoded.data[i+c]-smallDecoded.data[i+c]);if(delta)changed=true;maxChannelDifference=Math.max(maxChannelDifference,delta);}
      if(changed)differentPixels++;
    }
    outputs.push({scale,file,width:result.width,height:result.height,layoutHeight:result.layoutHeight,tiles:result.tileCount,bytes:result.bytes.length,ms:performance.now()-started,differentPixels,maxChannelDifference});
  }
  return outputs;
}
