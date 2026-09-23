import { load } from 'cheerio/slim';
import postcss from 'postcss';
import { singleBackgroundImageUrl } from './wechat-compat.mjs';

const SURFACE = 'data-wechat-table-surface';
const CONTENT = 'data-wechat-table-content';
const FRAME = 'data-wechat-table-frame';
const BACKGROUND = /^(?:background(?:-|$)|border-(?:radius|(?:top|bottom)-(?:left|right)-radius)$)/;
const TYPOGRAPHY = /^(?:color|font(?:-[a-z-]+)?|line-height|letter-spacing|word-spacing|text-align|text-indent|white-space|word-break|word-wrap|overflow-wrap)$/;
const padding = key => key === 'padding' || key.startsWith('padding-');
const noOp = (html, warnings = []) => ({ html, warnings });
const css = rule => rule.nodes.map(node => node.toString()).join(';');
const remove = (rule, predicate) => rule.nodes.slice().forEach(node => {
  if (node.type === 'decl' && predicate(node.prop.toLowerCase())) node.remove();
});
function set(rule, prop, value) {
  remove(rule, key => key === prop);
  rule.append({ prop, value });
}
function parse(style = '') {
  const root = postcss.parse(`x{${style}}`, { from: undefined });
  const rule = root.first;
  if (root.nodes.length !== 1 || rule.type !== 'rule' || rule.selector !== 'x'
    || rule.nodes.some(node => !['decl','comment'].includes(node.type)
      || (node.type === 'decl' && (!node.prop.trim() || !node.value.trim())))) throw Error('无效行内样式');
  return rule;
}
function backgroundSafe(rule, managed) {
  for (const node of rule.nodes) {
    if (node.type !== 'decl') continue;
    const key = node.prop.toLowerCase();
    if (key === 'background-image' && node.value.trim().toLowerCase() !== 'none') {
      const url = singleBackgroundImageUrl(node.value);
      if (!url || !managed.has(url)) return false;
    } else if (key === 'background' && /url\s*\(/i.test(node.value)) return false;
  }
  return true;
}

function frameProperty(key) {
  return key === 'margin' || key.startsWith('margin-') || key.startsWith('background')
    || ((key === 'border' || key.startsWith('border-')) && !['border-collapse', 'border-spacing'].includes(key));
}

/** The reader's collapsed table borders ignore border-radius. Let a regular
 * protected section own the frame and clip; keep the table for column layout.
 * Only opted-in themes take this path. No global CSS whitelist is expanded.
 */
function wrapRoundedFrame($, table, nativeStyle) {
  const frameStyle = parse('display:block;overflow:hidden');
  for (const declaration of nativeStyle.nodes) {
    if (declaration.type === 'decl' && frameProperty(declaration.prop.toLowerCase())) {
      frameStyle.append(declaration.clone());
    }
  }
  remove(nativeStyle, frameProperty);
  for (const [key, value] of Object.entries({
    margin:'0', border:'0', 'border-radius':'0', 'background-color':'transparent',
    'border-collapse':'separate', 'border-spacing':'0',
  })) set(nativeStyle, key, value);
  table.attr('style', css(nativeStyle)).removeAttr('data-no-dark');
  const frame = $('<section></section>').attr({ [FRAME]:'rounded', 'data-no-dark':'', style:css(frameStyle) });
  frame.append(table);
  return frame;
}

/** Opt-in after CSS inlining and compatibility filtering, before copy/export.
 * Keep native cells for shared column sizing and full-height internal rules.
 * Their only height is a minimal 1px anchor: the unpadded 100% surface stretches
 * to the row's content-driven height. Padding belongs to a second section, so
 * it cannot make the surface taller than the cell (no box-sizing dependency).
 */
export function materializeTableSurfaces(html, { policy = null, backgroundImages = [] } = {}) {
  if (policy?.strategy !== 'preserve-table-surfaces' || typeof html !== 'string') return noOp(html);
  try {
    const $ = load(html, { withStartIndices:true, withEndIndices:true }, false);
    const scope = $('[id="nice"]');
    if (scope.length !== 1) return noOp(html, ['表格颜色保护已跳过：需要唯一的 #nice 容器。']);
    const managed = new Set(backgroundImages.filter(image => image?.origin === 'theme'
      && typeof image.filePath === 'string' && image.filePath && typeof image.url === 'string')
      .map(image => image.url));
    const excluded = node => $(node).closest('pre,code,[data-wechat-list-task-scope="true"],li.wechat-task-item,li.task-list-item').length > 0;
    const tables = scope.find('table').toArray().filter(node => !excluded(node) && !$(node).parents('table').length);
    const warnings = [];
    const replacements = [];
    for (const table of tables) {
      if (policy.roundedFrame === true && $(table).parent(`[${FRAME}="rounded"]`).length) continue;
      const clone = $(table).clone();
      const cells = clone.find('th,td').toArray().filter(node => !excluded(node));
      // A bad cell must not yield a half-upgraded table. Leave the whole table
      // intact if any background is unregistered or its style is malformed.
      let safe = true;
      let nativeStyle;
      if (policy.roundedFrame === true) {
        try {
          nativeStyle = parse(clone.attr('style'));
          if (!backgroundSafe(nativeStyle, managed)) safe = false;
        } catch { safe = false; }
      }
      for (const node of cells) {
        if ($(node).children(`[${SURFACE}]`).length) continue;
        try { if (!backgroundSafe(parse($(node).attr('style')),managed)) safe = false; }
        catch { safe = false; }
      }
      if (!safe) {
        warnings.push('表格颜色保护已跳过：表格或单元格样式无效或含未登记背景，原表格已完整保留。');
        continue;
      }
      let changed = false;
      for (const node of cells.slice().reverse()) {
        const cell = $(node);
        if (cell.children(`[${SURFACE}]`).length) continue;
        const original = parse(cell.attr('style'));
        // WeChat adds its own 1px cell grid when an edge is unspecified.
        // Reset that grid, then retain every explicitly themed edge unchanged.
        if (policy.roundedFrame === true) original.prepend({ prop:'border', value:'0' });
        const surfaceStyle = parse('display:block;height:100%;margin:0;padding:0;border:none;background-color:transparent');
        const contentStyle = parse('display:block;margin:0');
        for (const declaration of original.nodes) {
          if (declaration.type !== 'decl') continue;
          const key = declaration.prop.toLowerCase();
          if (BACKGROUND.test(key) || TYPOGRAPHY.test(key)) {
            remove(surfaceStyle,name => name === key);
            surfaceStyle.append(declaration.clone());
          }
          if (padding(key)) contentStyle.append(declaration.clone());
          // 微信会给最内层文字容器补自己的 color，继承来的颜色会被盖掉，
          // 深底表头于是变成深字。颜色显式写到文字容器上，不依赖继承。
          if (key === 'color') contentStyle.append(declaration.clone());
        }
        const surface = $('<section></section>').attr({[SURFACE]:'cell','data-no-dark':'',style:css(surfaceStyle)});
        const content = $('<section></section>').attr({[CONTENT]:'','data-no-dark':'',style:css(contentStyle)});
        content.append(cell.contents());
        // Code/pre has its own handling; do not rewrite or recolor its subtree.
        content.find('[style]').each((_,child) => {
          if (!excluded(child) && !['table','thead','tbody','tfoot','tr','th','td'].includes(child.tagName)) {
            $(child).attr('data-no-dark','');
          }
        });
        surface.append(content);
        remove(original,key => BACKGROUND.test(key) || padding(key) || TYPOGRAPHY.test(key));
        set(original,'padding','0');
        set(original,'height','1px');
        set(original,'background-color','transparent');
        set(original,'vertical-align','top');
        cell.empty().append(surface).attr('style',css(original)).removeAttr('data-no-dark');
        changed = true;
      }
      if (!changed && policy.roundedFrame !== true) continue;
      clone.add(clone.find('table')).filter((_,node)=>!excluded(node)).attr({cellspacing:'0',cellpadding:'0'});
      const output = policy.roundedFrame === true ? wrapRoundedFrame($, clone, nativeStyle) : clone;
      replacements.push({start:table.startIndex,end:table.endIndex+1,html:$.html(output)});
    }
    let result = html;
    for (const replacement of replacements.sort((a,b)=>b.start-a.start)) {
      result = result.slice(0,replacement.start)+replacement.html+result.slice(replacement.end);
    }
    return { html:result,warnings };
  } catch (error) {
    return noOp(html,[`表格颜色保护已跳过，原文保留：${error.message}`]);
  }
}
