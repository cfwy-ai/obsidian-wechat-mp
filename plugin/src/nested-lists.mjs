// Convert nested native lists only after theme selectors have been inlined.
// Each visible row carries its own depth offset; native ul/li boxes are no
// longer responsible for the indent that a rich-text paste handler can erase.
import { load } from 'cheerio/slim';
import postcss from 'postcss';

export const LIST_TASK_SCOPE_ATTRIBUTE = 'data-wechat-list-task-scope';
export const ORDERED_LIST_IMAGE_MARKER_ATTRIBUTE = 'data-wechat-ordered-list-label';
const REVERSED_ATTRIBUTE = 'data-wechat-ordered-list-reversed';
const LIST = new Set(['ul', 'ol']);
export function orderedListEmblemForDepth(rule, depth) {
  return (rule?.depthEmblems ?? []).reduce((chosen, item) =>
    item.depth <= depth && (!chosen || item.depth > chosen.depth) ? item : chosen, null);
}
const INHERITED = new Set([
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'word-spacing', 'text-align', 'white-space', 'word-break',
  'word-wrap', 'overflow-wrap',
]);
const BLOCK = new Set([
  'p', 'div', 'section', 'blockquote', 'pre', 'table', 'figure', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'hr', 'details', 'dl',
]);
const STRUCTURAL = new Set(['table','thead','tbody','tfoot','tr','colgroup','dl']);
const noOp = html => ({ html, warnings: [], listCount: 0, itemCount: 0, maxDepth: 0 });
const number = value => /^[-+]?\d+$/.test(String(value ?? ''))
  && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const round = value => Math.round(value * 1000) / 1000;
const px = value => `${round(value)}px`;
const clean = value => String(value ?? '').replace(/\s*!important\s*$/i,'').trim();
const hidden = style => clean(style.get('display')) === 'none';

function styleMap(style = '') {
  const map = new Map();
  const priority = new Map();
  const rule = postcss.parse(`x{${style}}`).first;
  const put = (key,value,important) => {
    if (priority.get(key) && !important) return;
    map.delete(key);
    map.set(key,value + (important ? ' !important' : ''));
    priority.set(key,important);
  };
  rule.walkDecls(decl => {
    const key = decl.prop.trim().toLowerCase(), value = decl.value.trim();
    if (key === 'padding' || key === 'margin') {
      const p = value.split(/\s+/);
      if (p.length >= 1 && p.length <= 4) {
        const values = [p[0],p[1]??p[0],p[2]??p[0],p[3]??p[1]??p[0]];
        ['top','right','bottom','left'].forEach((side,i)=>put(`${key}-${side}`,values[i],Boolean(decl.important)));
        return;
      }
    }
    put(key,value,Boolean(decl.important));
  });
  return map;
}
const serialize = map => [...map].map(([k, v]) => `${k}: ${v};`).join(' ');
function length(value, fontSize = 16, fallback = 0) {
  if (value === undefined) return fallback;
  const m = /^(-?(?:\d*\.)?\d+)(px|em|rem|%)?$/.exec(clean(value));
  if (!m) return fallback;
  const n = Number(m[1]);
  return n * (m[2] === 'em' ? fontSize : m[2] === 'rem' ? 16 : m[2] === '%' ? fontSize / 100 : 1);
}
function side(style, property, direction, fontSize) {
  const parts = (style.get(property) ?? '0').split(/\s+/);
  const positions = { top: 0, right: parts.length > 1 ? 1 : 0,
    bottom: parts.length > 2 ? 2 : 0, left: parts.length > 3 ? 3 : parts.length > 1 ? 1 : 0 };
  return length(style.get(`${property}-${direction}`) ?? parts[positions[direction]], fontSize);
}
function contextFor(style, parent) {
  const inherited = new Map(parent);
  const fontSize = length(style.get('font-size'),length(parent.get('font-size'),16,16),
    length(parent.get('font-size'),16,16));
  for (const key of INHERITED) {
    if (!style.has(key) || /^(inherit|unset)$/i.test(clean(style.get(key)))) continue;
    const value = style.get(key);
    // Dimensioned line height/spacing inherits its computed length, unlike a
    // unitless line-height ratio, which intentionally scales with child text.
    if (['line-height','letter-spacing','word-spacing'].includes(key)
      && /^[-\d.]+(?:em|rem|px|%)$/.test(clean(value))) {
      inherited.set(key,px(length(value,fontSize)) + (/!important/i.test(value) ? ' !important' : ''));
    } else inherited.set(key,value);
  }
  inherited.set('font-size',px(fontSize) + (/!important/i.test(style.get('font-size')??'') ? ' !important' : ''));
  return inherited;
}
function borderLeftWidth(style, fontSize) {
  let width = 0, visible = true;
  for (const [property,raw] of style) {
    const value = clean(raw);
    if (property === 'border' || property === 'border-left') {
      visible = !/\b(?:none|hidden)\b/.test(value);
      width = length(value.split(/\s+/).find(v=>/^[\d.]+(?:px|em|rem)?$/.test(v)),fontSize);
    } else if (property === 'border-left-width') width = length(value,fontSize);
    else if (property === 'border-left-style') visible = !/^(none|hidden)$/.test(value);
  }
  return visible ? Math.max(0,width) : 0;
}
function alpha(n) {
  if (n < 1) return String(n);
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(97 + n % 26) + s; n = Math.floor(n / 26); }
  return s;
}
function roman(n) {
  if (n < 1 || n > 3999) return String(n);
  let s = '';
  for (const [v, mark] of [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],
    [50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']]) {
    while (n >= v) { s += mark; n -= v; }
  }
  return s;
}
function markerFor(kind, type, index, warnings) {
  if (type === 'none') return '';
  if (kind === 'ul') {
    const glyph = { disc: '•', circle: '◦', square: '▪' }[type || 'disc'];
    if (glyph) return glyph;
    warnings.add(`无序列表标记 ${type} 暂不支持，已用圆点保留条目。`);
    return '•';
  }
  let text;
  switch (type) {
    case 'lower-alpha': case 'lower-latin': text = alpha(index); break;
    case 'upper-alpha': case 'upper-latin': text = alpha(index).toUpperCase(); break;
    case 'lower-roman': text = roman(index).toLowerCase(); break;
    case 'upper-roman': text = roman(index); break;
    case 'decimal-leading-zero': text = index >= 0 && index < 10 ? `0${index}` : String(index); break;
    default:
      if (type && type !== 'decimal') warnings.add(`有序列表标记 ${type} 暂不支持，已用数字保留序号。`);
      text = String(index);
  }
  return `${text}.`;
}

/**
 * Preserve flat native lists byte-for-byte. Nested trees become editable rich
 * text, not WeChat's native automatically-numbered list widget.
 */
export function preserveOrderedListImageSemantics(html, rule) {
  if (!rule || !/<ol\b/i.test(html)) return html;
  // The generic sanitizer deliberately omits reversed. Preserve this semantic
  // only for opted-in lists, before its native list becomes explicit rows.
  const $ = load(html, { withStartIndices: true }, false);
  const positions = $('#nice ol[reversed]').toArray().filter(node => !$(node).closest('pre,code').length)
    .map(node => node.startIndex).sort((a, b) => b - a);
  let output = html;
  for (const at of positions) output = output.slice(0, at + 3) + ` ${REVERSED_ATTRIBUTE}="true"` + output.slice(at + 3);
  return output;
}

function convertNestedLists(html, { orderedListImages = null } = {}) {
  if (typeof html !== 'string' || !/<(?:ul|ol)\b/i.test(html)) return noOp(html);
  const $ = load(html, { withStartIndices: true, withEndIndices: true }, false);
  const scopes = $('[id="nice"]');
  if (scopes.length !== 1) return noOp(html);
  const scope = scopes[0];
  const inCode = node => $(node).closest('pre,code').length > 0;
  const containsList = node => $(node).find('ul,ol').toArray().some(n => !inCode(n));
  const roots = $(scope).find('ul,ol').toArray().filter(node =>
    !inCode(node) && !$(node).parents('ul,ol').length
      && (containsList(node) || (orderedListImages && node.tagName === 'ol')));
  if (!roots.length) return noOp(html);
  const warnings = new Set();
  let listCount = 0, itemCount = 0, maxDepth = 0;
  const originalStyles = new WeakMap();
  const getStyle = node => {
    if (!originalStyles.has(node)) originalStyles.set(node, styleMap($(node).attr('style') ?? ''));
    return originalStyles.get(node);
  };
  const isTask = node => $(node).hasClass('wechat-task-item') || $(node).hasClass('task-list-item')
    || $(node).children('p').first().find('.wechat-task-marker').length > 0;
  const cleanAttrs = node => {
    const attrs = { ...node.attribs };
    for (const key of ['style','start','type','value','reversed']) delete attrs[key];
    return attrs;
  };
  const initialContext = node => {
    let context = new Map([['font-size','16px']]);
    for (const ancestor of $(node).parents().toArray().reverse()) context = contextFor(getStyle(ancestor), context);
    return context;
  };

  const replacements = [];
  for (const root of roots) {
    const lists = [root, ...$(root).find('ul,ol').toArray().filter(n => !inCode(n))];
    const depthOf = node => 1 + $(node).parents('ul,ol').length;
    const treeDepth = Math.max(...lists.map(depthOf));
    const step = Math.min(24, 120 / Math.max(1, treeDepth - 1)) * (orderedListImages?.layoutScale ?? 1);
    if (treeDepth > 16) warnings.add('列表层级超过 16 层，已缩小每级间距保留层次；建议拆分以便手机阅读。');

    const renderList = (node, depth, parentContext, inheritedOffset, taskScope) => {
      listCount++; maxDepth = Math.max(maxDepth, depth);
      const kind = node.tagName;
      const numberedImages = Boolean(orderedListImages && kind === 'ol');
      const emblem = numberedImages ? orderedListEmblemForDepth(orderedListImages, depth) : null;
      const style = getStyle(node);
      const context = contextFor(style, parentContext);
      const fontSize = length(context.get('font-size'),16,16);
      const listPadding = side(style,'padding','left',fontSize);
      const groupStyle = new Map(style);
      // Horizontal placement is explicit below; never inherit ul's UA padding.
      groupStyle.set('display',hidden(style)?'none':'block');
      groupStyle.set('padding-left','0');
      // The outer margin is the theme's page/column placement, not list depth.
      // Keep its authored px/% value; only descendant groups reset indentation.
      if (depth > 1 || !style.has('margin-left')) groupStyle.set('margin-left','0');
      groupStyle.delete('list-style-type');
      const borderWidth = borderLeftWidth(style,fontSize);
      const hasBorder = borderWidth > 0;
      const groupShift = hasBorder && depth > 1 ? Math.max(0, (depth - 1) * step - inheritedOffset - 8) : 0;
      if (groupShift) groupStyle.set('margin-left',px(groupShift));
      const offset = inheritedOffset + groupShift + borderWidth;
      const group = $('<section></section>').attr({
        ...cleanAttrs(node), role:'list', 'data-wechat-list-group':kind,
        'data-wechat-list-depth':String(depth), style:serialize(groupStyle),
      });
      if (depth === 1) group.attr('data-wechat-list-root',kind);
      if (node.attribs.start !== undefined) group.attr('data-wechat-list-start',node.attribs.start);
      const listType = clean(style.get('list-style-type')) || (kind === 'ol'
        ? ({ a:'lower-alpha', A:'upper-alpha', i:'lower-roman', I:'upper-roman' }[node.attribs.type] ?? 'decimal')
        : ['disc','circle','square'][Math.min(depth - 1, 2)]);
      const reversed = numberedImages && (node.attribs.reversed !== undefined || node.attribs[REVERSED_ATTRIBUTE] === 'true');
      const stepIndex = reversed ? -1 : 1;
      let index = number(node.attribs.start) ?? (reversed ? $(node).children('li').length : 1);
      if (reversed) group.attr(REVERSED_ATTRIBUTE, 'true');
      const labels = new WeakMap();
      let markerGutter = listPadding;
      for (const child of node.children ?? []) {
        if (child.tagName !== 'li') continue;
        if (kind === 'ol' && number(child.attribs.value) !== null) index = number(child.attribs.value);
        const itemStyle = getStyle(child);
        const itemContext = contextFor(itemStyle,context);
        const font = length(itemContext.get('font-size'),16,16);
        const bg = clean(itemStyle.get('background-image'));
        let markerType = clean(itemStyle.get('list-style-type')) || listType;
        if (numberedImages && markerType === 'none') markerType = 'decimal';
        const marker = isTask(child) || (!numberedImages && bg && bg !== 'none') ? ''
          : markerFor(kind,markerType,index,warnings);
        labels.set(child,marker);
        if (marker) markerGutter = Math.max(markerGutter,font*1.4,marker.length*font*.65+6,
          side(itemStyle,'padding','left',font));
        if (marker && numberedImages) markerGutter = Math.max(markerGutter,
          marker.length * orderedListImages.fontSize * .75 + orderedListImages.gap + 4 * (orderedListImages.layoutScale ?? 1) + (emblem ? emblem.width + emblem.gap : 0));
        index += stepIndex;
      }

      for (const child of node.children ?? []) {
        if (child.tagName !== 'li') { group.append($(child).clone()); continue; }
        itemCount++;
        const itemStyle = getStyle(child);
        const itemContext = contextFor(itemStyle, context);
        const task = isTask(child);
        const withinTask = taskScope || task;
        const marker = labels.get(child);
        const shellStyle = new Map([...itemContext,['display',hidden(itemStyle)?'none':'block'],['padding','0']]);
        for (const [key,value] of itemStyle) if (key === 'margin' || key.startsWith('margin-')) shellStyle.set(key,value);
        shellStyle.set('margin-left','0');
        const shell = $('<section></section>').attr({
          ...cleanAttrs(child), role:'listitem', 'data-wechat-list-item':kind,
          'data-wechat-list-depth':String(depth), style:serialize(shellStyle),
        });
        if (withinTask) shell.attr(LIST_TASK_SCOPE_ATTRIBUTE,'true');
        if (child.attribs.value !== undefined) shell.attr('data-wechat-list-value',child.attribs.value);
        const state = { head:true };

        const makeRow = (nodes, rowContext) => {
          const head = state.head;
          state.head = false;
          const rowStyle = new Map(itemStyle);
          for (const key of [...rowStyle.keys()]) if (key === 'margin' || key.startsWith('margin-')) rowStyle.delete(key);
          for (const [key,value] of rowContext) rowStyle.set(key,value);
          rowStyle.set('display',hidden(itemStyle)?'none':'block');
          rowStyle.set('margin','0');
          rowStyle.set('margin-left',px(Math.max(0,(depth-1)*step-offset)));
          rowStyle.delete('list-style-type');
          if (!head) {
            for (const key of ['background-image','background-position','background-size','background-repeat']) rowStyle.delete(key);
            rowStyle.set('text-indent','0');
          }
          const row = $('<section></section>').attr({
            'data-wechat-list-row':head?'head':'continuation',
            'data-wechat-list-depth':String(depth), style:serialize(rowStyle),
          });
          for (const original of nodes) row.append($(original).clone());
          if (marker) {
            const font = length(itemContext.get('font-size'),16,16);
            const gutter = markerGutter;
            rowStyle.set('padding-left',px(gutter));
            rowStyle.set('text-indent','0');
            if (head) {
              const label = $('<span></span>').attr({
                'data-wechat-list-marker':kind,
                style:`display: inline-block; width: ${px(gutter)}; font-size: ${px(font)}; text-indent: 0; text-align: left;`,
              }).text(marker + '\u00a0');
              if (numberedImages) label.attr(ORDERED_LIST_IMAGE_MARKER_ATTRIBUTE, marker);
              const first = row.contents().toArray().find(n => n.type !== 'text' || n.data.trim());
              if (first?.tagName === 'p') {
                const p = $(first);
                const pStyle = styleMap(p.attr('style') ?? '');
                pStyle.set('text-indent',px(-gutter));
                p.attr('style',serialize(pStyle)).prepend(label);
              } else {
                // Keep block children as blocks. Only the leading inline run
                // becomes the first line that owns the visible marker.
                const line = $('<p></p>').attr({
                  'data-wechat-list-line':'',
                  style:`margin: 0; padding: 0; text-indent: ${px(-gutter)};`,
                }).append(label);
                const leading = [];
                for (const n of row.contents().toArray()) {
                  if (BLOCK.has(n.tagName)) break;
                  leading.push(n);
                }
                for (const n of leading) { $(n).remove(); line.append(n); }
                row.prepend(line);
              }
            }
          }
          if (!nodes.length) rowStyle.set('min-height',px(length(rowContext.get('font-size'),16,16)));
          row.attr('style',serialize(rowStyle));
          return row;
        };

        const renderWrapper = (node,rowContext) => {
          const wrapper = $(node).clone().empty();
          const nextContext = contextFor(getStyle(node),rowContext);
          if (STRUCTURAL.has(node.tagName)) {
            // table/tr and dl cannot directly contain generated flow rows.
            for (const child of node.children ?? []) {
              wrapper.append(child.type === 'tag' && !inCode(child) && containsList(child)
                ? renderWrapper(child,nextContext) : $(child).clone());
            }
          } else if (node.tagName === 'details') {
            for (const child of node.children ?? []) {
              if (child.tagName === 'summary') wrapper.append($(child).clone());
              else renderContents(wrapper,[child],nextContext);
            }
          } else renderContents(wrapper,node.children ?? [],nextContext);
          return wrapper;
        };
        const renderContents = (container, nodes, rowContext) => {
          let pending = [];
          const flush = force => {
            const meaningful = pending.some(n => n.type !== 'text' || n.data.trim());
            if (meaningful || force) container.append(makeRow(pending,rowContext));
            else for (const n of pending) container.append($(n).clone());
            pending = [];
          };
          for (const n of nodes) {
            if (LIST.has(n.tagName) && !inCode(n)) {
              flush(state.head && pending.every(x => x.type === 'text' && !x.data.trim()));
              container.append(renderList(n,depth+1,rowContext,offset,withinTask));
            } else if (n.type === 'tag' && !inCode(n) && containsList(n)) {
              flush(false);
              container.append(renderWrapper(n,rowContext));
            } else if (BLOCK.has(n.tagName)) {
              flush(false); pending.push(n); flush(false);
            } else pending.push(n);
          }
          flush(false);
        };
        renderContents(shell,child.children ?? [],itemContext);
        if (state.head) shell.prepend(makeRow([],itemContext));
        group.append(shell);
      }
      return group;
    };

    const output = renderList(root,1,initialContext(root),0,false);
    replacements.push({start:root.startIndex,end:root.endIndex+1,html:$.html(output)});
  }
  // Replace only original list substrings, leaving unrelated HTML byte-stable.
  let output = html;
  for (const replacement of replacements.sort((a,b)=>b.start-a.start)) {
    output = output.slice(0,replacement.start)+replacement.html+output.slice(replacement.end);
  }
  return { html:output, warnings:[...warnings], listCount,itemCount,maxDepth };
}

export function materializeNestedLists(html, options) {
  try {
    return convertNestedLists(html, options);
  } catch (error) {
    return { ...noOp(html), warnings:[`嵌套列表适配失败，已保留原始列表：${error instanceof Error ? error.message : String(error)}`] };
  }
}
