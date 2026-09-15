import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import html2canvas from 'html2canvas';
import { discoverVaultThemes,loadVaultThemeContent } from '../plugin/theme-registry.mjs';
import { renderArticle } from '../src/pipeline.mjs';
import { buildExportHtml,embedImagesForExport } from '../plugin/export-image.mjs';
import { copyRenderedArticle } from '../plugin/copy.mjs';
import { createClipboardImageTransformer } from '../plugin/copy-image-encoding.mjs';
import { nativeImage } from 'electron';

export const tableSurfaceSample = [
  '| 表头 | 表头 | 表头 |\n| --- | --- | --- |\n| 单元格 | 42 | `行内代码` |\n| 单元格 | 108 | **加粗** |',
  '两列与长文本：',
  '| 项目 | 说明 |\n| --- | --- |\n| 短项 | 这一格用更长的文字触发换行，左右单元格的背景必须同高，不能留下短一截的分隔线。 |\n| 第二项 | 短内容 |\n| 第三项 | 最后一行仍应清楚结束。 |',
  '三列与长标识：',
  '| 比较对象 | 结果 | 解释 |\n| --- | --- | --- |\n| VeryLongIdentifierWithoutSpaces0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ | 108 | 较长的中文解释需要多行排布，同一行底色不能参差。 |\n| 短项 | 42 | `runtime.abcdefghijklmnopqrstuvwxyz0123456789` |',
  '单列：',
  '| 单列表头 |\n| --- |\n| 第一行 |\n| 第二行，两个下圆角同时存在。 |',
  '合并行列：',
  '<table><thead><tr><th colspan="2">合并表头</th><th>第三列</th></tr></thead><tbody><tr><td rowspan="2">跨行内容</td><td>一</td><td>多行<br>多行<br>多行</td></tr><tr><td colspan="2">跨列内容，保留原生的行列信息。</td></tr></tbody></table>',
  '空单元格与多段：',
  '<table><thead><tr><th>空格</th><th>段落</th></tr></thead><tbody><tr><td></td><td><p>第一段。</p><p>第二段。</p></td></tr><tr><td>结尾</td><td><strong>强调仍然清晰。</strong></td></tr></tbody></table>',
].join('\n\n');

export async function verifyTableSurfaces({app,directory,policy={strategy:'preserve-table-surfaces'}}) {
  await mkdir(directory,{recursive:true});
  const p=app.plugins.plugins['changfeng-wechat-mp'];
  const d=await discoverVaultThemes({vault:app.vault,metadataCache:app.metadataCache,themeFolder:p.settings.themeFolder});
  const selected=d.themes.find(t=>t.themeId==='cobalt-orbit');
  const theme=await loadVaultThemeContent(selected,{vault:app.vault});
  const r=renderArticle({source:tableSurfaceSample,themeCss:theme.css,themeAssets:theme.assets,themeDarkMode:policy,resolve:()=>null});
  const e=await embedImagesForExport({html:r.html,images:r.images,resolveFile:(_ref,image)=>app.vault.getAbstractFileByPath(image.filePath),readBinary:f=>app.vault.readBinary(f),transformImage:async bytes=>({bytes,mimeType:'image/png'})});
  const html=buildExportHtml({articleHtml:e.html,showTitle:false,showAuthor:false});
  await writeFile(join(directory,'表格测试输入.md'),tableSurfaceSample);
  const results=[];
  for(const width of [320,390,677]) {
    const f=document.createElement('iframe');f.style.cssText=`position:fixed;left:-15000px;top:0;width:${width}px;height:900px;border:0`;
    const loaded=new Promise(resolve=>f.onload=resolve);f.srcdoc=html.replaceAll('677px',width+'px');document.body.append(f);
    try {
      await loaded;const doc=f.contentDocument;await doc.fonts.ready;
      await Promise.all([...doc.images].map(i=>i.decode().catch(()=>{})));
      const root=doc.getElementById('wechat-long-image-root');
      const edge=root.getBoundingClientRect().right;
      const cells=[...root.querySelectorAll('th,td')].map(cell=>{
        const surface=cell.querySelector(':scope > [data-wechat-table-surface]');
        const box=cell.getBoundingClientRect(), sb=surface?.getBoundingClientRect();
        const style=doc.defaultView.getComputedStyle(cell), ss=surface&&doc.defaultView.getComputedStyle(surface);
        return {tag:cell.tagName,text:cell.textContent,cellHeight:box.height,surfaceHeight:sb?.height,
          equalHeight:Boolean(sb&&Math.abs(sb.height-cell.clientHeight)<=1.1),
          overflow:box.right>edge+1||cell.scrollWidth>cell.clientWidth+2,
          nativeBackground:style.backgroundColor,surfaceBackground:ss?.backgroundColor,
          noDark:surface?.hasAttribute('data-no-dark'),watermark:ss?.backgroundImage!=='none',
          borders:[style.borderTopWidth,style.borderRightWidth,style.borderBottomWidth,style.borderLeftWidth],
          radii:ss?[ss.borderTopLeftRadius,ss.borderTopRightRadius,ss.borderBottomRightRadius,ss.borderBottomLeftRadius]:[]};
      });
      const tables=[...root.querySelectorAll('table')].map(t=>({columns:t.rows[0]?.cells.length,rows:t.rows.length,width:t.getBoundingClientRect().width,spacing:t.cellSpacing,padding:t.cellPadding}));
      const main=root.querySelector('table');
      const header=[...main.querySelectorAll('th')],last=[...main.querySelectorAll('tbody tr:last-child td')];
      const get=(node,property)=>doc.defaultView.getComputedStyle(node)[property];
      const outerEdgesClear=header.every(c=>get(c,'borderTopWidth')==='0px')&&last.every(c=>get(c,'borderBottomWidth')==='0px')
        && [...main.rows].every(row=>get(row.cells[0],'borderLeftWidth')==='0px'&&get(row.cells[row.cells.length-1],'borderRightWidth')==='0px');
      const calibration=doc.createElement('section');calibration.style.borderRight='1px solid #000';doc.body.append(calibration);
      const onePixel=get(calibration,'borderRightWidth');calibration.remove();
      const bodyRules=[...main.querySelectorAll('tbody tr:first-child td')].slice(0,-1).every(c=>get(c,'borderRightWidth')===onePixel);
      const result={width,tables,cells,outerEdgesClear,bodyRules,
        pass:cells.every(c=>c.equalHeight&&!c.overflow&&c.noDark)&&outerEdgesClear&&bodyRules};
      results.push(result);
      await writeFile(join(directory,`表格-${width}.html`),f.srcdoc);
      if(width===390||width===677){
        const canvas=await html2canvas(root,{scale:2,backgroundColor:null,useCORS:true,logging:false});
        await writeFile(join(directory,`表格-${width}.png`),Buffer.from(canvas.toDataURL('image/png').split(',')[1],'base64'));
        if(width===390){
          const detailHeight=Math.ceil(main.getBoundingClientRect().bottom-root.getBoundingClientRect().top+24);
          const detail=await html2canvas(root,{height:detailHeight,scale:2,backgroundColor:null,useCORS:true,logging:false});
          await writeFile(join(directory,'表格-局部-390.png'),Buffer.from(detail.toDataURL('image/png').split(',')[1],'base64'));
        }
      }
    }finally{f.remove();}
  }
  let clipboardValue;
  const textRoot=document.createElement('div');textRoot.innerHTML=r.html;
  const copied=await copyRenderedArticle({html:r.html,text:textRoot.textContent,images:r.images,embedImages:true,
    _clipboard:{write:value=>{clipboardValue=value;}},
    resolveFile:(_ref,image)=>app.vault.getAbstractFileByPath(image.filePath),
    readBinary:file=>app.vault.readBinary(file),
    transformImage:createClipboardImageTransformer({nativeImage})});
  const report={installedVersion:p.manifest.version,policy,warnings:[...r.warnings,...e.warnings],results,copied,
    wechatAcceptance:'待用户粘贴、保存重开与手机实测；本工具不访问微信、不写系统剪贴板。'};
  if(clipboardValue?.html)await writeFile(join(directory,'复制输出.html'),clipboardValue.html);
  await writeFile(join(directory,'表格验证.json'),JSON.stringify(report,null,2));
  return report;
}
