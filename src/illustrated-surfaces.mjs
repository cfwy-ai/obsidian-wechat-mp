import { load } from 'cheerio/slim';
import postcss from 'postcss';
import { singleBackgroundImageUrl } from './wechat-compat.mjs';

const MARK = 'data-wechat-illustrated';
const background = key => key === 'background' || key.startsWith('background-');
const spacing = key => key === 'padding' || key.startsWith('padding-');
const margin = key => key === 'margin' || key.startsWith('margin-');
const typography = key => /^(color|font(?:-.+)?|line-height|letter-spacing|word-spacing|white-space|word-break|overflow-wrap)$/.test(key);
const name = declaration => declaration.prop.toLowerCase();
const css = rule => rule.nodes.map(node => node.toString()).join(';');
function parse(style = '') {
  const root = postcss.parse(`x{${style}}`, { from: undefined });
  const rule = root.first;
  if (root.nodes.length !== 1 || rule?.type !== 'rule' || rule.selector !== 'x'
    || rule.nodes.some(node => !['decl','comment'].includes(node.type))) throw Error('样式无法解析');
  return rule;
}
function remove(rule, predicate) {
  for (const node of [...rule.nodes]) if (node.type === 'decl' && predicate(name(node))) node.remove();
}
function set(rule, prop, value) {
  remove(rule, key => key === prop);
  rule.append({ prop, value });
}
const value = (rule, key) => rule.nodes.filter(node => node.type === 'decl' && name(node) === key).at(-1)?.value;
function subset(rule, predicate) {
  const result = parse('');
  for (const node of rule.nodes) if (node.type === 'decl' && predicate(name(node))) result.append(node.clone());
  return result;
}
function imageUrl(rule) {
  const v = value(rule, 'background-image');
  if (!v || v === 'none') return null;
  const url = singleBackgroundImageUrl(v);
  if (!url) throw Error('背景地址无效');
  return url;
}
function transparent(rule) {
  return !value(rule, 'background-color') || value(rule, 'background-color') === 'transparent';
}
function paddingValues(rule) {
  const raw = (value(rule, 'padding') ?? '0').split(/\s+/);
  const v = raw.map(part => /^\d+(?:\.\d+)?(?:px)?$/.test(part) ? parseFloat(part) : null);
  if (!v.length || v.length > 4 || v.includes(null)) return null;
  const sides = [v[0],v[1] ?? v[0],v[2] ?? v[0],v[3] ?? v[1] ?? v[0]];
  for (const [i, side] of ['top','right','bottom','left'].entries()) {
    const override = value(rule, `padding-${side}`);
    if (override !== undefined) {
      if (!/^\d+(?:\.\d+)?(?:px)?$/.test(override)) return null;
      sides[i] = parseFloat(override);
    }
  }
  return sides;
}

/** Move illustrated decoration off native pre/table paint layers. Opt-in only.
 * Empty decorative spans become actual images; code text remains pre > code and
 * native cells retain column/row spans. No whole-component rasterization.
 */
export function materializeIllustratedSurfaces(html, { policy = null, backgroundImages = [] } = {}) {
  const noOp = warnings => ({ html, images: [], warnings: warnings ?? [] });
  if (policy?.strategy !== 'preserve-illustrated-surfaces' || typeof html !== 'string') return noOp();
  try {
    const $ = load(html, { withStartIndices:true, withEndIndices:true }, false);
    const roots = $('[id="nice"]');
    if (roots.length !== 1) return noOp(['插画装饰保护已跳过：需要唯一正文容器。']);
    const root = roots[0], start = root.startIndex, end = root.endIndex;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return noOp(['插画装饰保护已跳过：正文容器不完整。']);
    const scope = $(root), warnings = [];
    const assets = new Map(backgroundImages.filter(i => i?.origin === 'theme' && i.url && i.filePath).map(i => [i.url,i]));
    const images = new Map();
    const decorationRecord = url => ({ ...assets.get(url), preferWechatUrl: Boolean(assets.get(url)?.wechatUrl) });
    const assertManaged = rule => {
      const url = imageUrl(rule);
      if (url && !assets.has(url)) throw Error('背景素材未登记');
      return url;
    };
    const section = (kind, rule) => $('<section></section>').attr({ [MARK]:kind, 'data-no-dark':'', style:css(rule) });
    const excluded = node => $(node).closest('[data-wechat-list-task-scope],li.wechat-task-item,li.task-list-item').length > 0;
    // Preserve the existing painted underline/highlight. Native mark/u and an
    // unprotected CSS-image carrier can be recolored independently by WeChat.
    if (policy.protectInlinePaint) for (const node of scope.find('mark[style],u[style]').toArray()) {
      if (excluded(node) || $(node).closest('pre,code').length) continue;
      const original=$(node);
      try {
        const rule=parse(original.attr('style'));
        if (!assertManaged(rule)) continue;
        set(rule,'background-color','transparent');
        const replacement=$('<span></span>').attr({...original.attr(),[MARK]:'inline-paint','data-no-dark':'',style:css(rule)});
        replacement.append(original.contents());original.replaceWith(replacement);
      } catch(error) { warnings.push(`行内笔触保留原结构：${error.message}。`); }
    }
    const decorate = element => {
      const rule = parse(element.attr('style'));
      const url = assertManaged(rule);
      if (!url || element.children().length || element.text().trim()) return false;
      const width = value(rule,'width') ?? '100%';
      const height = value(rule,'height');
      if (!height || !/^\d+(?:\.\d+)?px$/.test(height)) return false;
      const display = value(rule,'display') === 'inline-block' ? 'inline-block' : 'block';
      remove(rule, key => background(key) || key === 'line-height');
      set(rule,'display',display);set(rule,'font-size','0');set(rule,'line-height','0');
      // Keep a span carrier so the quotation parser still sees decoration,
      // rather than an unsupported nested block next to its paragraphs.
      const carrier = $('<span></span>').attr({ [MARK]:'decoration', 'data-no-dark':'', style:css(rule) });
      const picture = $('<img>').attr({ src:url, alt:'', 'aria-hidden':'true', 'data-no-dark':'',
        style:`display:block;width:${width === '100%' ? '100%' : width};max-width:100%;height:${height};margin:0;padding:0;border:none;border-radius:0;background-color:transparent` });
      if (/^\d+(?:\.\d+)?px$/.test(width)) picture.attr('width',String(parseFloat(width)));
      picture.attr('height',String(parseFloat(height)));
      carrier.append(picture);element.replaceWith(carrier);
      images.set(url,decorationRecord(url));
      return true;
    };

    // Native list items with a background image are saved by WeChat as opaque
    // white strips. Move the registered marker into a real transparent image
    // and leave the li itself unpainted.
    if (policy.materializeDecorations) for (const node of scope.find('li[style],section[data-wechat-list-row="head"][style]').toArray()) {
      if (excluded(node)) continue;
      const item = $(node);
      try {
        const rule = parse(item.attr('style'));
        const url = assertManaged(rule);
        if (!url) continue;
        const size = (value(rule, 'background-size') ?? '').trim().split(/\s+/);
        if (!/^\d+(?:\.\d+)?px$/.test(size[0] ?? '')) continue;
        const width = parseFloat(size[0]);
        const height = /^\d+(?:\.\d+)?px$/.test(size[1] ?? '') ? parseFloat(size[1]) : width;
        if (!(width > 0 && height > 0 && width <= 64 && height <= 64)) continue;
        const paddingLeft = /^\d+(?:\.\d+)?px$/.test(value(rule, 'padding-left') ?? '')
          ? parseFloat(value(rule, 'padding-left'))
          : width + 6;
        const gap = Math.max(3, Math.min(16, paddingLeft - width));
        remove(rule, key => background(key) || key === 'padding-left');
        set(rule, 'padding-left', '0');
        set(rule, 'background-color', 'transparent');
        const picture = $('<img>').attr({
          src: url,
          alt: '',
          'aria-hidden': 'true',
          'data-no-dark': '',
          [MARK]: 'list-marker',
          style: `display:inline-block;width:${width}px;max-width:none;height:${height}px;margin:0 ${gap}px 0 0;padding:0;border:none;border-radius:0;background-color:transparent;vertical-align:-0.22em`,
        });
        if(item.is('[data-wechat-list-row]')){
          set(rule,'padding-left',`${paddingLeft}px`);
          const first=item.children().first();
          let line;
          if(first.is('p'))line=first;
          else {
            line=$('<p></p>').attr({'data-wechat-list-line':''});
            const leading=[];
            for(const child of item.contents().toArray()){
              if(['section','p','table','pre','ul','ol','blockquote'].includes(child.tagName))break;
              leading.push(child);
            }
            for(const child of leading)line.append(child);
            item.prepend(line);
          }
          const lineStyle=parse(line.attr('style'));
          set(lineStyle,'margin','0');set(lineStyle,'padding','0');
          set(lineStyle,'text-indent',`-${paddingLeft}px`);
          line.attr('style',css(lineStyle)).prepend(picture);
          item.attr('style',css(rule));
        }else item.attr('style', css(rule)).prepend(picture);
        images.set(url, decorationRecord(url));
      } catch (error) { warnings.push(`列表装饰保留原结构：${error.message}。`); }
    }

    // This marker survives until the DOM runtime renders the original paint and
    // text together. No white backdrop and no replacement with a CSS solid line.
    if (policy.rasterizeInlinePaint) scope.find('mark[style],u[style],del[style],s[style]').each((_,node) => {
      if ($(node).closest('pre,code').length) return;
      const rule=parse($(node).attr('style'));
      if (assertManaged(rule)) $(node).attr('data-wechat-raster-inline','true');
    });

    // A saved WeChat draft may reinstate the platform's native blockquote bar
    // and fill even when the original inline style says border/background none.
    // Only an explicit theme opt-in replaces a simple illustrated quote with a
    // neutral section. Existing quote-image themes retain the native tag and
    // their current generation path unless they request this behavior.
    if (policy.replaceNativeQuotes) for (const node of scope.find('blockquote').toArray().reverse()) {
      if (excluded(node) || $(node).parents('blockquote').length || $(node).find('blockquote').length) continue;
      const original = $(node);
      original.children('span').filter((_,child)=>!$(child).children().length&&!$(child).text().trim()).remove();
      const children = original.children();
      if (!children.length || children.toArray().some(child => child.tagName !== 'p')) continue;
      try {
        const quoteStyle = parse(original.attr('style'));
        assertManaged(quoteStyle);
        set(quoteStyle,'display','block');set(quoteStyle,'border','none');set(quoteStyle,'background-color','transparent');
        const surface = section('quote',quoteStyle);
        surface.append(original.contents());
        original.replaceWith(surface);
      } catch(error) { warnings.push(`引用装饰保留原结构：${error.message}。`); }
    }

    if (policy.materializeDecorations) for (const node of scope.find('span.wechat-task-marker[style]').toArray()) {
      const marker=$(node);
      try {
        const rule=parse(marker.attr('style')), url=assertManaged(rule);
        if (!url) continue;
        const size=(value(rule,'background-size')??'').trim().split(/\s+/);
        const width=/^\d+(?:\.\d+)?px$/.test(value(rule,'width')??'') ? value(rule,'width')
          : (/^\d+(?:\.\d+)?px$/.test(size[0]??'') ? size[0] : '24px');
        const height=/^\d+(?:\.\d+)?px$/.test(value(rule,'height')??'') ? value(rule,'height')
          : (/^\d+(?:\.\d+)?px$/.test(size[1]??'') ? size[1] : width);
        const pictureStyle=subset(rule,key=>margin(key)||key==='vertical-align');
        for(const [key,val] of Object.entries({display:'inline-block',width,'max-width':width,height,margin:value(rule,'margin')??'0 7px 0 0',padding:'0',border:'none','border-radius':'0','background-color':'transparent','font-size':'0','line-height':'0'}))set(pictureStyle,key,val);
        const picture=$('<img>').attr({...marker.attr(),src:url,alt:marker.attr('aria-label')??'', [MARK]:'task-marker','data-no-dark':'',style:css(pictureStyle)});
        marker.replaceWith(picture);images.set(url,decorationRecord(url));
      } catch(error) { warnings.push(`待办装饰保留原结构：${error.message}。`); }
    }

    for (const node of scope.find('pre').toArray()) {
      if (excluded(node) || $(node).closest(`[${MARK}="code"]`).length) continue;
      const original = $(node), clone = original.clone();
      try {
        const preStyle = parse(clone.attr('style')), codes = clone.children('code');
        if (codes.length !== 1 || !transparent(preStyle)) continue;
        const code = codes.first(), codeStyle = parse(code.attr('style'));
        if (!transparent(codeStyle) || !(assertManaged(preStyle) || assertManaged(codeStyle))) continue;
        clone.find('[style]').add(clone).each((_,child)=>assertManaged(parse($(child).attr('style'))));
        const ornaments = clone.children().not('code');
        if (ornaments.toArray().some(child => $(child).text().trim() || $(child).children().length || !imageUrl(parse($(child).attr('style'))))) continue;
        const before = [], after = [];
        let seenCode = false;
        for (const child of clone.contents().toArray()) {
          if (child === code[0]) { seenCode = true; continue; }
          if (child.type === 'text' && !child.data.trim()) continue;
          (seenCode ? after : before).push(child);
        }
        const contentStyle = subset(codeStyle,key=>background(key)||spacing(key)||typography(key));
        set(contentStyle,'display','block');set(contentStyle,'margin','0');
        const codeTail = code.children('span[style]').filter((_,child)=>{
          const e=$(child);return !e.children().length && !e.text().trim() && !!imageUrl(parse(e.attr('style')));
        }).remove();
        remove(preStyle,key=>background(key)||margin(key)||spacing(key)||key==='border'||key.startsWith('border-'));
        for (const [k,v] of Object.entries({margin:'0',padding:'0',border:'none','background-color':'transparent'})) set(preStyle,k,v);
        remove(codeStyle,key=>background(key)||spacing(key));set(codeStyle,'padding','0');set(codeStyle,'background-color','transparent');
        code.attr('style',css(codeStyle));clone.empty().append(code).attr('style',css(preStyle));
        const frameStyle=parse(original.attr('style'));set(frameStyle,'display','block');
        const outer=section('code',frameStyle), body=section('code-content',contentStyle);
        body.append(clone).append(codeTail);outer.append(before).append(body).append(after);
        original.replaceWith(outer);
      } catch(error) { warnings.push(`代码装饰保留原结构：${error.message}。`); }
    }

    for (const node of scope.find('table').toArray()) {
      if (excluded(node) || $(node).parents('table').length || $(node).parent(`[${MARK}="table-frame"]`).length) continue;
      const original=$(node), table=original.clone();
      try {
        if (table.find('table').length) continue;
        const style=parse(table.attr('style'));
        if (!assertManaged(style)) continue;
        table.find('thead,tbody,tfoot,tr,th,td').each((_,child)=>assertManaged(parse($(child).attr('style'))));
        const frameStyle=subset(style,key=>background(key)||margin(key)||key==='border'||key.startsWith('border-'));
        set(frameStyle,'display','block');set(frameStyle,'padding','8px');
        // A percentage width belongs to the article, not to the new frame.
        // Otherwise a narrower table gets that percentage applied twice.
        const tableWidth=value(style,'width');
        if (tableWidth) {
          set(frameStyle,'width',tableWidth);
          set(frameStyle,'box-sizing','border-box');
          set(style,'width','100%');
        }
        remove(style,key=>background(key)||margin(key));set(style,'margin','0');set(style,'background-color','transparent');
        set(style,'border-spacing','0');set(style,'border-collapse','separate');
        table.attr({style:css(style),cellspacing:'0',cellpadding:'0'});
        for (const row of table.find('tr').toArray()) {
          const r=$(row), rowStyle=parse(r.attr('style')), lineStyle=subset(rowStyle,background);
          const cells=r.children('th,td');
          for (const [index,cellNode] of cells.toArray().entries()) {
            const cell=$(cellNode), cellStyle=parse(cell.attr('style'));
            const contentStyle=subset(cellStyle,key=>spacing(key)||background(key));
            const pads=paddingValues(cellStyle);
            if (pads && index===0) {pads[3]=Math.max(0,pads[3]-8);remove(contentStyle,spacing);set(contentStyle,'padding',pads.map(v=>`${v}px`).join(' '));}
            set(contentStyle,'display','block');set(contentStyle,'margin','0');
            const body=section('table-cell-content',contentStyle);body.append(cell.contents());
            const surfaceStyle=parse('display:block;height:100%;margin:0;padding:0;border:none;background-color:transparent');
            for (const decl of lineStyle.nodes) surfaceStyle.append(decl.clone());
            const surface=section('table-cell',surfaceStyle);surface.append(body);
            remove(cellStyle,key=>spacing(key)||background(key));set(cellStyle,'padding','0');set(cellStyle,'height','1px');set(cellStyle,'background-color','transparent');
            cell.empty().append(surface).attr('style',css(cellStyle));
          }
          remove(rowStyle,background);set(rowStyle,'background-color','transparent');r.attr('style',css(rowStyle));
        }
        for (const groupNode of table.children('thead,tbody,tfoot').toArray()) {
          const group=$(groupNode), groupStyle=parse(group.attr('style'));
          if (imageUrl(groupStyle)) {
            const body=group.find(`[${MARK}="table-cell-content"]`).last();
            if (body.length) {
              const bodyStyle=parse(body.attr('style'));
              for(const decl of subset(groupStyle,background).nodes) bodyStyle.append(decl.clone());
              set(bodyStyle,'background-size','contain');set(bodyStyle,'background-position','right bottom');body.attr('style',css(bodyStyle));
            }
          }
          remove(groupStyle,background);set(groupStyle,'background-color','transparent');group.attr('style',css(groupStyle));
        }
        const frame=section('table-frame',frameStyle);frame.append(table);original.replaceWith(frame);
      } catch(error) { warnings.push(`表格装饰保留原结构：${error.message}。`); }
    }

    if (policy.tableRuleImages) for (const node of scope.find('table').toArray()) {
      if ($(node).parents('table').length || $(node).find('table').length) continue;
      const table=$(node), rows=table.find('tr').toArray();
      const rules=rows.map(row=>{
        const rule=parse($(row).attr('style'));
        return assertManaged(rule);
      });
      if(!rules.some(Boolean))continue;
      // Account for column and row spans without changing cell contents.
      const occupied=[], columnCounts=[], continuingSpans=[];
      for(const row of rows){
        let col=0;
        for(const cell of $(row).children('th,td').toArray()){
          while(occupied[col]>0) col++;
          const span=Math.max(1,Number($(cell).attr('colspan'))||1);
          const rowspan=Math.max(1,Number($(cell).attr('rowspan'))||1);
          for(let c=col;c<col+span;c++) occupied[c]=rowspan;
          col+=span;
        }
        columnCounts.push(Math.max(col,occupied.length));
        for(let c=0;c<occupied.length;c++) occupied[c]=Math.max(0,occupied[c]-1);
        continuingSpans.push([...occupied]);
      }
      const columns=Math.max(1,...columnCounts);
      rules.forEach((url,index)=>{
        if(url && continuingSpans[index].filter(n=>n>0).length===columns)rules[index]=null;
      });
      rows.forEach((row,index)=>{
        for(const cell of $(row).children('th,td').toArray()){
          const rowspan=Number($(cell).attr('rowspan'))||1;
          if(rowspan>1) $(cell).attr('rowspan',String(rowspan+rules.slice(index,index+rowspan-1).filter(Boolean).length));
        }
        const url=rules[index];
        const rowStyle=parse($(row).attr('style'));remove(rowStyle,background);
        set(rowStyle,'background-color','transparent');$(row).attr('style',css(rowStyle));
        if(!url)return;
        const thickness=$(row).parent().is('thead')?3:1;
        const line=$('<tr></tr>').attr({'aria-hidden':'true','data-wechat-table-rule':'true',style:'padding:0;margin:0;border:0;background:transparent;'});
        let col=0;
        while(col<columns){
          if(continuingSpans[index][col]>0){col++;continue;}
          const start=col;
          while(col<columns && !(continuingSpans[index][col]>0))col++;
          const image=$('<img>').attr({src:url,alt:'','aria-hidden':'true','data-no-dark':'',
            [MARK]:'table-rule',style:`display:block;width:100%;max-width:100%;height:${thickness}px;margin:0;padding:0;border:0;background:transparent;`});
          line.append($('<td></td>').attr({colspan:String(col-start),style:'padding:0;margin:0;border:0;background:transparent;font-size:0;line-height:0;'}).append(image));
        }
        $(row).after(line);images.set(url,decorationRecord(url));
      });
      table.attr({cellpadding:'0',cellspacing:'0'});
      const tableStyle=parse(table.attr('style'));set(tableStyle,'border-spacing','0');set(tableStyle,'border-collapse','collapse');
      table.attr('style',css(tableStyle));
    }

    if (policy.materializeDecorations) for (const node of scope.find('hr[style]').toArray()) {
      const original=$(node);
      try {
        const rule=parse(original.attr('style')), url=assertManaged(rule);
        if (!url) continue;
        remove(rule,key=>background(key)||['height','min-height','max-height','overflow','overflow-x','overflow-y'].includes(key));
        for(const [key,val] of Object.entries({padding:'0',border:'none',display:'block','font-size':'0','line-height':'0'}))set(rule,key,val);
        const carrier=section('separator',rule).attr({role:'separator','aria-orientation':'horizontal'});
        const picture=$('<img>').attr({src:url,alt:'','aria-hidden':'true','data-no-dark':'',style:'display:block;width:100%;max-width:100%;height:auto;margin:0;padding:0;border:none;border-radius:0;background-color:transparent'});
        carrier.append(picture);original.replaceWith(carrier);images.set(url,decorationRecord(url));
      } catch(error) { warnings.push(`分割线装饰保留原结构：${error.message}。`); }
    }

    for (const node of scope.find('span[style]').toArray()) {
      if (excluded(node) || $(node).closest('pre,code').length) continue;
      try { decorate($(node)); } catch(error) { warnings.push(`小装饰保留原结构：${error.message}。`); }
    }
    // Recover asset records if an already-materialized fragment is processed again.
    scope.find(`[${MARK}="decoration"] > img,[${MARK}="separator"] > img,img[${MARK}="task-marker"],img[${MARK}="list-marker"],img[${MARK}="table-rule"]`).each((_,node)=>{
      const url=$(node).attr('src');if(assets.has(url))images.set(url,decorationRecord(url));
    });
    const urls=new Set();
    scope.find('[style]').add(scope).each((_,node)=>{const url=imageUrl(parse($(node).attr('style')));if(url)urls.add(url);});
    return { html:html.slice(0,start)+$.html(root)+html.slice(end+1), images:[...images.values()], warnings, backgroundImageUrls:[...urls] };
  } catch(error) { return noOp([`插画装饰保护已跳过：${error.message}。`]); }
}
