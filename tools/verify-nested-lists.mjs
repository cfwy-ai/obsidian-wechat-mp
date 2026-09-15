// Run the bundled export inside Obsidian's renderer. This never uses a real
// clipboard and never opens WeChat; every rendered image is a local data URL.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import html2canvas from 'html2canvas';
import { nativeImage } from 'electron';
import { discoverVaultThemes, loadVaultThemeContent } from '../plugin/theme-registry.mjs';
import { buildExportHtml, embedImagesForExport } from '../plugin/export-image.mjs';
import { copyRenderedArticle } from '../plugin/copy.mjs';
import { createClipboardImageTransformer } from '../plugin/copy-image-encoding.mjs';
import { renderArticle } from '../src/pipeline.mjs';
import { renderMarkdown, MARKDOWN_BASE_CSS } from '../src/markdown.mjs';
import { convertEmbeds } from '../src/wikilink.mjs';
import { sanitizeRenderedHtml } from '../src/sanitize.mjs';
import { inlineCss } from '../src/inline.mjs';
import { materializeThemeCss } from '../src/theme-package.mjs';
import { materializeEmptyTaskMarkers } from '../src/task-markers.mjs';
import { filterWechatCompatibleHtml } from '../src/wechat-compat.mjs';
import { applyWechatDarkMode } from '../src/dark-mode.mjs';

const probe = (id, text) => `<span data-nested-probe="${id}">${text}</span>`;
export const nestedListSource = [
  '## 无序列表与三级层次',
  `- ${probe('U1', '一级：记录主要判断。')}\n  - ${probe('U2', '二级：补充判断的依据。')}\n    - ${probe('U3', '三级：让例子继续向内展开。')}\n  - ${probe('U2B', '同级：另一个理由，标记与文字都应该对齐。')}\n- ${probe('U1B', '回到一级，继续下一项。')}`,
  '## 有序列表与混合层次',
  `3. ${probe('O1', '从第三项开始。')}\n   1. ${probe('O2', '每个子列表独立编号。')}\n      1. ${probe('O3', '三级顺序仍然清楚。')}\n4. ${probe('O1B', '回到父列表的第四项。')}`,
  `- ${probe('M1', '无序的父项。')}\n  3. ${probe('M2', '有序的子项。')}\n     - ${probe('M3', '再次切回无序列表。')}`,
  '## 待办：首行、换行和续段',
  `- [ ] ${probe('T1', '待办父项：这是一条会在手机宽度下自动换行的长任务，第二行应该与任务正文对齐，不能退到图标的位置。')}\n\n  ${probe('T1C', '父任务续段仍然属于这一条任务。')}\n\n  - [x] ${probe('T2', '已完成的二级任务。')}\n    - [ ] ${probe('T3', '三级任务：继续检查任务图标与正文的可读性。')}\n\n  ${probe('T1A', '经过子任务之后，继续解释父任务。')}\n\n- [x] ${probe('T1B', '另一条已完成任务。')}`,
  '## 多段内容与图片',
  `- ${probe('P1', '第一段保留')} **强调文字** 和 [原链接](https://example.test/nested-list)。\n\n  ${probe('P1C', '第二段与正文图片仍属于父项。')}\n\n  - ${probe('P2', '子项先解释这张本地测试图。')} ![[nested-list-probe.png|嵌套测试图片]]\n\n    ${probe('P2C', '图片后续段仍与子项正文对齐。')}\n\n  ${probe('P1A', '子列表结束后回到父项，不能留在子项的缩进上。')}`,
  '## 长单词与行内代码',
  `- ${probe('L1', '父项保持完整。')}\n  - ${probe('L2', '长标识：VeryLongIdentifierWithoutSpaces0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')}\n    - ${probe('L3', '行内代码：')} \`runtime.trace.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz\`。`,
  '## 同层编号跨位数',
  `<ol start="9"><li>${probe('N9', '九号正文起点。')}<ol><li>用一个子项触发完整列表树适配。</li></ol></li><li>${probe('N10', '十号正文起点应与九号一致。')}</li></ol>`,
  `<ol start="99"><li>${probe('N99', '九十九号正文起点。')}<ol><li>同样保留一个子项。</li></ol></li><li>${probe('N100', '一百号正文起点应与九十九号一致。')}</li></ol>`,
  `<ol><li>字母编号边界<ol start="26" type="a"><li>${probe('A26', '第二十六个子项。')}</li><li>${probe('A27', '第二十七个子项。')}</li></ol></li></ol>`,
].join('\n\n');

const ROW = '[data-wechat-list-row]';
const MARKER = '[data-wechat-list-marker]';
const round = value => Math.round(value * 100) / 100;
const normalize = text => text.replace(/\s+/g, '');
const fragment = html => {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
};
const textWithoutMarkers = root => {
  const copy = root.cloneNode(true);
  for (const node of copy.querySelectorAll(`${MARKER},.wechat-task-marker,span[role="img"][aria-label="未完成"],span[role="img"][aria-label="已完成"]`)) node.remove();
  return normalize(copy.textContent);
};
const imageAlts = root => [...root.querySelectorAll('img')].map(img => img.getAttribute('alt') ?? '');
const stripSelectors = html => {
  const root = fragment(html);
  for (const node of root.querySelectorAll('[class],[id]')) {
    node.removeAttribute('class'); node.removeAttribute('id');
  }
  return [...root.childNodes].map(node => node.outerHTML ?? node.textContent).join('');
};

function syntheticPng() {
  const png = new PNG({ width: 160, height: 80 });
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const offset = (y * png.width + x) * 4;
    const light = x > 14 && x < 145 && y > 14 && y < 65;
    const rgb = light ? [224, 195, 113] : [46, 63, 81];
    for (let c = 0; c < 3; c++) png.data[offset + c] = rgb[c];
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

function lineRects(element) {
  if (!element) return [];
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  const lines = [];
  for (const rect of range.getClientRects()) {
    if (!rect.width || !rect.height) continue;
    if (!lines.some(line => Math.abs(line.y - rect.y) < 1 && Math.abs(line.x - rect.x) < 1)) {
      lines.push({ x: round(rect.x), y: round(rect.y), right: round(rect.right), width: round(rect.width) });
    }
  }
  return lines;
}

function measure(doc, width) {
  const root = doc.getElementById('wechat-long-image-root');
  const article = root.firstElementChild;
  const box = root.getBoundingClientRect();
  const rowElements = [...article.querySelectorAll(ROW)];
  const rows = rowElements.map((element, index) => {
    const rect = element.getBoundingClientRect();
    const style = doc.defaultView.getComputedStyle(element);
    return {
      index, depth: Number(element.dataset.wechatListDepth), kind: element.dataset.wechatListRow,
      x: round(rect.x - box.x), right: round(rect.right - box.x), width: round(rect.width),
      marginLeft: style.marginLeft, paddingLeft: style.paddingLeft,
      fontSize: style.fontSize, color: style.color, lineHeight: style.lineHeight,
      background: style.backgroundImage !== 'none', backgroundPosition: style.backgroundPosition,
      text: element.textContent.trim().slice(0, 110),
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
    };
  });
  const probes = Object.fromEntries([...article.querySelectorAll('[data-nested-probe]')].map(element => {
    const row = element.closest(ROW);
    return [element.dataset.nestedProbe, {
      depth: row ? Number(row.dataset.wechatListDepth) : null,
      rowX: row ? round(row.getBoundingClientRect().x - box.x) : null,
      lines: lineRects(element).map(line => ({ ...line, x: round(line.x - box.x), right: round(line.right - box.x) })),
    }];
  }));
  const elementOverflow = [...article.querySelectorAll(`${ROW},p,code,a,img`)].flatMap(element => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    const owner = element.closest(ROW);
    const edge = owner ? owner.getBoundingClientRect().right : box.right;
    if (rect.right <= edge + 1 && rect.right <= box.right + 1 && rect.left >= box.left - 1
      && (element.clientWidth === 0 || element.scrollWidth <= element.clientWidth + 2)) return [];
    return [{ tag: element.tagName, row: owner?.dataset.wechatListDepth ?? null,
      text: element.textContent.trim().slice(0, 90), x: round(rect.x - box.x), right: round(rect.right - box.x),
      availableRight: round(edge - box.x), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }];
  });
  const textOverflow = [];
  const walker = doc.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim()) continue;
    const parent = node.parentElement, row = parent.closest(ROW);
    if (!row) continue;
    const painted = doc.defaultView.getComputedStyle(parent);
    if (Number.parseFloat(painted.fontSize) === 0 || painted.color === 'rgba(0, 0, 0, 0)' || painted.visibility === 'hidden') continue;
    const range = doc.createRange(); range.selectNodeContents(node);
    const edge = row.getBoundingClientRect().right;
    for (const rect of range.getClientRects()) if (rect.width && (rect.right > edge + 1 || rect.left < box.left - 1)) {
      textOverflow.push({ text: node.textContent.slice(0, 90), depth: Number(row.dataset.wechatListDepth),
        x: round(rect.x - box.x), right: round(rect.right - box.x), availableRight: round(edge - box.x) });
      break;
    }
  }
  const depthChecks = [['U1','U2','U3'],['O1','O2','O3'],['M1','M2','M3'],['T1','T2','T3'],['L1','L2','L3']]
    .map(ids => ({ ids, x: ids.map(id => probes[id]?.rowX),
      pass: ids.every((id, i) => probes[id] && (i === 0 || probes[id].rowX > probes[ids[i - 1]].rowX + 10)) }));
  const sameLevelText = [['N9','N10'],['N99','N100'],['A26','A27']].map(ids => {
    const x = ids.map(id => probes[id]?.lines[0]?.x);
    return { ids, x, delta: round(Math.abs(x[1] - x[0])), pass: x.every(Number.isFinite) && Math.abs(x[1] - x[0]) <= 1 };
  });
  const taskText = ['T1','T1C','T1A'].map(id => ({ id, lines: probes[id]?.lines ?? [] }));
  const brokenImages = [...article.querySelectorAll('img')].filter(img => !img.complete || img.naturalWidth === 0)
    .map(img => ({ alt: img.alt, src: img.src.slice(0, 90) }));
  return { width, height: round(box.height), rows, probes, depthChecks, sameLevelText, taskText,
    pageOverflow: doc.documentElement.scrollWidth > width + 1 || root.scrollWidth > root.clientWidth + 1,
    elementOverflow, textOverflow, brokenImages,
    imageCount: article.querySelectorAll('img').length,
    taskScopes: article.querySelectorAll('[data-wechat-list-task-scope="true"]').length,
    taskScopeProtected: article.querySelectorAll('[data-wechat-list-task-scope="true"][data-no-dark],[data-wechat-list-task-scope="true"] [data-no-dark]').length,
  };
}

async function inFrame(html, width, callback) {
  const frame = document.createElement('iframe');
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:1000px;border:0;`;
  const loaded = new Promise(resolve => { frame.onload = resolve; });
  frame.srcdoc = html; document.body.append(frame);
  try {
    await loaded;
    const doc = frame.contentDocument;
    await doc.fonts.ready;
    await Promise.all([...doc.images].map(img => img.decode().catch(() => {})));
    return await callback(doc);
  } finally { frame.remove(); }
}

export async function verifyNestedLists({ app, directory, widths = [320,390,677] }) {
  const started = Date.now();
  await mkdir(directory, { recursive: true });
  const bytes = syntheticPng(), imagePath = join(directory, 'nested-list-probe.png');
  await writeFile(imagePath, bytes);
  await writeFile(join(directory, 'sample.md'), nestedListSource);
  const resolve = target => target === 'nested-list-probe.png'
    ? { url: 'local://nested-list-probe.png', filePath: imagePath, width:160, height:80 } : null;
  const expected = fragment(sanitizeRenderedHtml(renderMarkdown(convertEmbeds(nestedListSource, resolve).markdown)));
  const expectedText = textWithoutMarkers(expected), expectedImages = imageAlts(expected);
  if (expectedImages.length !== 1 || expectedImages[0] !== '嵌套测试图片') throw new Error('验证样本没有生成所要求的真实嵌套图片');
  const plugin = app.plugins.plugins['changfeng-wechat-mp'];
  const discovered = await discoverVaultThemes({ vault:app.vault, metadataCache:app.metadataCache, themeFolder:plugin.settings.themeFolder });
  const report = { startedAt:new Date(started).toISOString(), scope:'Local source bundle in Obsidian. No installed-plugin change, no real clipboard, no WeChat access.',
    vault:app.vault.getName(), installedVersion:plugin.manifest.version,
    bundleSha256:createHash('sha256').update(await readFile(join(directory,'verify-nested-lists.cjs'))).digest('hex'),
    discoveredProblems:discovered.problems, themeCount:discovered.themes.length, widths, themes:[], failures:[] };
  const resolveFile = (reference, image) => image?.filePath === imagePath || reference === imagePath || reference === 'local://nested-list-probe.png'
    ? { path:imagePath, stat:{ size:bytes.byteLength }, synthetic:true } : app.vault.getAbstractFileByPath(image?.filePath ?? reference);
  const readBinary = file => file.synthetic ? readFile(imagePath) : app.vault.readBinary(file);
  const transformImage = createClipboardImageTransformer({nativeImage});
  const saveReport = async () => {
    report.elapsedMs = Date.now() - started;
    await writeFile(join(directory, 'report.json'), JSON.stringify(report,null,2));
  };
  await saveReport();
  for (const selected of discovered.themes) {
    const themeStarted = Date.now();
    const theme = await loadVaultThemeContent(selected, { vault:app.vault });
    const rendered = renderArticle({ source:nestedListSource, themeCss:theme.css, themeAssets:theme.assets,
      themeDarkMode:theme.wechatDarkMode, resolve });
    const parsed = fragment(rendered.html);
    let clipboardPayload;
    const copied = await copyRenderedArticle({ html:rendered.html, text:expected.textContent, images:rendered.images,
      resolveFile, readBinary, transformImage, embedImages:true, _clipboard:{ write:payload => { clipboardPayload = payload; } } });
    const copiedDom = fragment(copied.html);
    const embedded = await embedImagesForExport({ html:rendered.html, images:rendered.images, resolveFile, readBinary,
      transformImage:async input => ({ bytes:input, mimeType:'image/png' }) });
    // Baseline deliberately omits only materializeNestedLists, to distinguish
    // existing theme alignment choices from regressions introduced by it.
    const themedCss = materializeThemeCss(theme.css,theme.assets);
    const nativeInlined = inlineCss(sanitizeRenderedHtml(renderMarkdown(convertEmbeds(nestedListSource,resolve).markdown)),MARKDOWN_BASE_CSS+'\n'+themedCss.css);
    const nativeCompatible = filterWechatCompatibleHtml(materializeEmptyTaskMarkers(nativeInlined.html),{allowedBackgroundUrls:themedCss.images.map(image=>image.url)});
    const nativeDark = applyWechatDarkMode(nativeCompatible.html,{policy:theme.wechatDarkMode,backgroundImages:themedCss.images});
    const nativeEmbedded = await embedImagesForExport({html:nativeDark.html,images:rendered.images,resolveFile,readBinary,
      transformImage:async input=>({bytes:input,mimeType:'image/png'})});
    const record = { name:selected.name, themeId:selected.themeId, darkMode:Boolean(theme.wechatDarkMode),
      problems:theme.problems, warnings:[...rendered.warnings,...embedded.warnings,...copied.warnings],
      textPreserved:textWithoutMarkers(parsed) === expectedText,
      imageAltsPreserved:JSON.stringify(imageAlts(parsed)) === JSON.stringify(expectedImages),
      copiedTextPreserved:textWithoutMarkers(copiedDom) === expectedText,
      copiedImagesPreserved:JSON.stringify(imageAlts(copiedDom)) === JSON.stringify(expectedImages),
      memoryClipboardOnly:clipboardPayload?.html === copied.html,
      clipboardStats:copied.stats, results:[] };
    await writeFile(join(directory, `${selected.name}-clipboard.html`), copied.html);
    for (const width of widths) {
      const html = buildExportHtml({ articleHtml:embedded.html, showTitle:false, showAuthor:false, layoutWidth:width });
      const correctedHtml = html.replaceAll('677px',`${width}px`);
      const file = join(directory, `${selected.name}-${width}.html`);
      await writeFile(file, correctedHtml);
      const measurement = await inFrame(correctedHtml,width,async doc => {
        const value = measure(doc,width);
        if (width === 390 && ['星尘手记','纪念碑谷','黑夜女神'].includes(selected.name)) {
          const root = doc.getElementById('wechat-long-image-root');
          const canvas = await html2canvas(root,{ scale:1.5,width,height:Math.ceil(root.getBoundingClientRect().height),
            windowWidth:width,logging:false,backgroundColor:'#ffffff',useCORS:false });
          value.screenshot = join(directory, `${selected.name}-${width}.png`);
          await writeFile(value.screenshot,Buffer.from(canvas.toDataURL('image/png').split(',')[1],'base64'));
          const detail = await html2canvas(root,{scale:2,width,height:Math.min(740,Math.ceil(root.getBoundingClientRect().height)),
            windowWidth:width,logging:false,backgroundColor:'#ffffff',useCORS:false});
          value.listDetail = join(directory,`${selected.name}-${width}-list-detail.png`);
          await writeFile(value.listDetail,Buffer.from(detail.toDataURL('image/png').split(',')[1],'base64'));
          const taskHeading = [...root.querySelectorAll('h2')].find(element=>element.textContent.includes('待办：'));
          const followingHeading = [...root.querySelectorAll('h2')].find(element=>element.textContent.includes('多段内容'));
          if (taskHeading && followingHeading) {
            const y=taskHeading.getBoundingClientRect().y-root.getBoundingClientRect().y-12;
            const height=Math.ceil(followingHeading.getBoundingClientRect().y-taskHeading.getBoundingClientRect().y+12);
            const taskCanvas=await html2canvas(root,{scale:2,width,height,y,windowWidth:width,logging:false,backgroundColor:'#ffffff',useCORS:false});
            value.taskDetail=join(directory,`${selected.name}-${width}-task-detail.png`);
            await writeFile(value.taskDetail,Buffer.from(taskCanvas.toDataURL('image/png').split(',')[1],'base64'));
          }
        }
        return value;
      });
      const strippedHtml = buildExportHtml({ articleHtml:stripSelectors(embedded.html), showTitle:false,showAuthor:false,layoutWidth:width }).replaceAll('677px',`${width}px`);
      const stripped = await inFrame(strippedHtml,width,doc => measure(doc,width));
      const nativeHtml = buildExportHtml({articleHtml:nativeEmbedded.html,showTitle:false,showAuthor:false,layoutWidth:width});
      const nativeMeasurement = await inFrame(nativeHtml,width,doc=>measure(doc,width));
      measurement.nativeTaskBaseline = nativeMeasurement.taskText;
      measurement.nativeOrderedBaseline = nativeMeasurement.sameLevelText;
      const relativeTaskOffsets = items => {
        const first=items.find(item=>item.id==='T1')?.lines[0]?.x;
        return items.flatMap(item=>item.lines.map((line,index)=>({id:item.id,line:index,offset:round(line.x-first)})));
      };
      measurement.taskAlignment = {before:relativeTaskOffsets(nativeMeasurement.taskText),after:relativeTaskOffsets(measurement.taskText)};
      measurement.inlineOnly = {
        rowCountPreserved:stripped.rows.length === measurement.rows.length,
        geometryPreserved:JSON.stringify(stripped.rows) === JSON.stringify(measurement.rows),
        textPreserved:textWithoutMarkers(fragment(stripSelectors(embedded.html))) === expectedText,
        pageOverflow:stripped.pageOverflow,
      };
      record.results.push(measurement);
      for (const [name,pass] of Object.entries({ depth:measurement.depthChecks.every(check => check.pass),
        noPageOverflow:!measurement.pageOverflow, noElementOverflow:measurement.elementOverflow.length===0,
        noTextOverflow:measurement.textOverflow.length===0, imagesLoaded:measurement.brokenImages.length===0&&measurement.imageCount===1,
        inlineIndependent:measurement.inlineOnly.geometryPreserved,
        inlineTextPreserved:measurement.inlineOnly.textPreserved,
        orderedTextAligned:measurement.sameLevelText.every(check=>check.pass),
        taskScopeUnchanged:measurement.taskScopeProtected===0 })) {
        if (!pass) report.failures.push({ theme:selected.name,width,check:name });
      }
    }
    for (const key of ['textPreserved','imageAltsPreserved','copiedTextPreserved','copiedImagesPreserved','memoryClipboardOnly']) {
      if (!record[key]) report.failures.push({theme:selected.name,check:key});
    }
    if(record.warnings.length||record.problems.length)report.failures.push({theme:selected.name,check:'themeOrRenderWarnings'});
    const deepSource=Array.from({length:13},(_,index)=>`${'  '.repeat(index)}- 第 ${index+1} 层仍保留真实层级。`).join('\n');
    const deepRendered=renderArticle({source:deepSource,themeCss:theme.css,themeAssets:theme.assets,themeDarkMode:theme.wechatDarkMode,resolve});
    const deepEmbedded=await embedImagesForExport({html:deepRendered.html,images:deepRendered.images,resolveFile,readBinary,
      transformImage:async input=>({bytes:input,mimeType:'image/png'})});
    const deepHtml=buildExportHtml({articleHtml:deepEmbedded.html,showTitle:false,showAuthor:false,layoutWidth:320});
    const deepMeasurement=await inFrame(deepHtml,320,doc=>measure(doc,320));
    const deepest=deepMeasurement.rows.at(-1),first=deepMeasurement.rows[0];
    record.deepProbe={width:320,depth:deepest?.depth,actualIndent:round((deepest?.x??0)-(first?.x??0)),
      rows:deepMeasurement.rows.map(row=>({depth:row.depth,x:row.x,marginLeft:row.marginLeft})),
      pass:deepest?.depth===13&&deepMeasurement.rows.length===13&&(deepest.x-first.x)<=121,
      elementOverflow:deepMeasurement.elementOverflow,textOverflow:deepMeasurement.textOverflow};
    if(!record.deepProbe.pass)report.failures.push({theme:selected.name,width:320,check:'deepActualIndentBudget'});
    record.elapsedMs=Date.now()-themeStarted; report.themes.push(record); await saveReport();
  }
  report.completedAt = new Date().toISOString();
  report.clipboardEncoderStats=transformImage.cacheStats();
  transformImage.clearCache();
  report.frameEvaluations=report.themes.reduce((sum,theme)=>sum+theme.results.length*3+1,0);
  report.pass = report.failures.length === 0 && report.themes.length === 8;
  await saveReport();
  return { report:join(directory,'report.json'), pass:report.pass, themes:report.themes.length,
    renders:report.themes.reduce((sum,theme)=>sum+theme.results.length,0), failures:report.failures, elapsedMs:report.elapsedMs };
}
