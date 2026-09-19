import { load } from 'cheerio/slim';
import postcss from 'postcss';
import { filterWechatStyle, singleBackgroundImageUrl } from './wechat-compat.mjs';

const BACKGROUND_PARTS = new Set([
  'background', 'background-image', 'background-size', 'background-position',
  'background-repeat', 'background-origin', 'background-clip', 'background-attachment',
]);
const UNRELIABLE_MARKER_TAGS = new Set(['blockquote', 'li', 'th', 'td', 'hr']);
const SURFACE_ATTRIBUTE = 'data-wechat-darkmode-surface';
const DEFAULT_BORDER_COLOR = '#C9A45C';
const ASSET_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function parseStyle(style = '') {
  try {
    const root = postcss.parse(`x{${style}}`, { from: undefined });
    const rule = root.first;
    if (root.nodes.length !== 1 || rule?.type !== 'rule' || rule.selector !== 'x'
      || rule.nodes.some(node => !['decl', 'comment'].includes(node.type)
        || (node.type === 'decl' && (!node.prop.trim() || !node.value.trim())))) return null;
    return rule;
  } catch {
    return null;
  }
}

const propertyName = node => node.prop.trim().toLowerCase();
const serializeStyle = rule => rule.nodes.map(node => node.toString()).join(';');

function removeProperties(rule, predicate) {
  for (const node of [...rule.nodes]) {
    if (node.type === 'decl' && predicate(propertyName(node))) node.remove();
  }
}

function setProperty(rule, prop, value) {
  removeProperties(rule, name => name === prop);
  rule.append({ prop, value });
}

function propertyValue(rule, property) {
  return rule?.nodes.filter(node => node.type === 'decl' && propertyName(node) === property).at(-1)?.value;
}

function backgroundUrl(rule) {
  if (!rule) return null;
  const declarations = rule.nodes.filter(node =>
    node.type === 'decl' && propertyName(node) === 'background-image');
  return declarations.length === 1 ? singleBackgroundImageUrl(declarations[0].value) : null;
}

function hasBackgroundImage(rule) {
  return rule?.nodes.some(node => node.type === 'decl'
    && propertyName(node) === 'background-image' && node.value.trim().toLowerCase() !== 'none');
}

function removeImageBackground(rule) {
  removeProperties(rule, name => BACKGROUND_PARTS.has(name));
  setProperty(rule, 'background-color', 'transparent');
}

function collectBackgroundUrls($) {
  const urls = new Set();
  $('[style]').each((_, node) => {
    const url = backgroundUrl(parseStyle($(node).attr('style')));
    if (url) urls.add(url);
  });
  return [...urls];
}

function noOp(html, warnings = []) {
  // Omit this field so the caller keeps the existing compatibility-stage list.
  return { html, images: [], warnings };
}

function managedAssets(backgroundImages) {
  const byUrl = new Map();
  const byId = new Map();
  if (Array.isArray(backgroundImages)) for (const image of backgroundImages) {
    if (!image || image.origin !== 'theme' || typeof image.target !== 'string'
      || !image.target || typeof image.url !== 'string'
      || typeof image.filePath !== 'string' || !image.filePath
      || singleBackgroundImageUrl(`url("${image.url}")`) !== image.url) continue;
    if (!byUrl.has(image.url)) byUrl.set(image.url, image);
    if (!byId.has(image.target)) byId.set(image.target, image);
  }
  return { byUrl, byId };
}

function tableFrameDefinition(input, assets, warnings) {
  if (input === undefined || input === null) return null;
  const borderWidth = input?.borderWidth ?? 2;
  const borderRadius = input?.borderRadius ?? 10;
  const surfacePadding = input?.surfacePadding ?? [6, 8, 8];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.borderAssetId !== 'string' || !ASSET_ID.test(input.borderAssetId)
    || typeof input.surfaceAssetId !== 'string' || !ASSET_ID.test(input.surfaceAssetId)
    || !Number.isInteger(borderWidth) || borderWidth < 1 || borderWidth > 4
    || !Number.isInteger(borderRadius) || borderRadius < 4 || borderRadius > 20 || borderRadius <= borderWidth
    || !Array.isArray(surfacePadding) || surfacePadding.length < 1 || surfacePadding.length > 4
    || surfacePadding.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 24)) {
    warnings.add('表格外框已跳过：参数格式或数值不合法。');
    return null;
  }
  const border = assets.get(input.borderAssetId);
  const surface = assets.get(input.surfaceAssetId);
  if (!border || !surface) {
    warnings.add('表格外框已跳过：边框或内层底纹未登记、文件不可用或地址不安全。');
    return null;
  }
  return { border, surface, borderWidth, borderRadius, surfacePadding };
}

function isTask($, node) {
  const element = $(node);
  return element.hasClass('wechat-task-item') || element.hasClass('task-list-item')
    || element.attr('data-task') !== undefined
    || element.children('input[type="checkbox"],.wechat-task-marker').length > 0;
}

/**
 * Preserve transparent themed decorations using the structure verified in WeChat.
 * Run after sanitization, CSS inlining, and filterWechatCompatibleHtml; URLs are
 * still the exact managed local URLs used by the preview at this stage.
 *
 * The policy is opt-in. Only #nice is changed; other themes and outer HTML remain
 * untouched. Code/pre subtrees retain their current appearance and attributes
 * unless transparentCodeBlocks is explicitly enabled for transparent blocks.
 * Removed cell/divider background URLs are not retained as background metadata.
 */
export function applyWechatDarkMode(html, options = {}) {
  if (typeof html !== 'string') {
    return { html: '', images: [], warnings: ['深色模式处理已跳过：HTML 必须是字符串。'], backgroundImageUrls: [] };
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return noOp(html, ['深色模式处理已跳过：选项格式不正确。']);
  }
  const { policy = null, backgroundImages = [] } = options;
  if (policy === null) return noOp(html);
  // This narrowly scoped strategy is handled by table-surfaces.mjs; do not
  // additionally transform quotes, lists, dividers or remove cell watermarks.
  if (['preserve-table-surfaces', 'preserve-illustrated-surfaces'].includes(policy?.strategy)) return noOp(html);
  const borderColor = policy?.tableBorderColor ?? DEFAULT_BORDER_COLOR;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || policy.strategy !== 'preserve-backgrounds'
    || ['transparentCodeBlocks', 'nativeTableBorders'].some(key => policy[key] !== undefined && typeof policy[key] !== 'boolean')
    || (policy.nativeTableBorders && policy.tableFrame)
    || typeof borderColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(borderColor)) {
    return noOp(html, ['深色模式处理已跳过：策略或表格线颜色不合法。']);
  }

  let $;
  try {
    $ = load(html, { withStartIndices: true, withEndIndices: true }, false);
  } catch {
    return noOp(html, ['深色模式处理已跳过：正文无法解析。']);
  }
  const roots = $('[id="nice"]');
  if (roots.length !== 1) return noOp(html, ['深色模式处理已跳过：需要唯一的 #nice 正文容器。']);
  const root = roots[0];
  const { startIndex, endIndex } = root;
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)
    || endIndex < startIndex || endIndex >= html.length
    || !new RegExp(`</${root.tagName}\\s*>$`, 'i').test(html.slice(startIndex, endIndex + 1))) {
    return noOp(html, ['深色模式处理已跳过：正文容器不完整。']);
  }

  const { byUrl: assets, byId: assetsById } = managedAssets(backgroundImages);
  const warnings = new Set();
  const tableFrame = tableFrameDefinition(policy.tableFrame, assetsById, warnings);
  const scope = $(root);
  const inside = selector => scope.find(selector).add(scope.filter(selector));
  const excluded = node => $(node).closest('pre,code').length > 0
    || $(node).closest('[data-wechat-list-task-scope="true"]').length > 0
    || $(node).parents('li').toArray().some(parent => isTask($, parent))
    || (node.tagName === 'li' && isTask($, node));
  const assetFor = (node, rule) => {
    const url = backgroundUrl(rule);
    if (url && assets.has(url)) return assets.get(url);
    if (hasBackgroundImage(rule)) warnings.add(`深色模式处理跳过 ${node.tagName} 的未登记或不安全背景素材。`);
    return null;
  };

  // WeChat preserves this marker on section/span/headings, but not on several
  // native tags. Never put it on those failed carriers as a purported fix.
  inside('[style]').each((_, node) => {
    if (excluded(node)) return;
    const element = $(node);
    const rule = parseStyle(element.attr('style'));
    if (!rule) {
      warnings.add(`深色模式处理跳过 ${node.tagName} 的无效样式。`);
      return;
    }
    if (UNRELIABLE_MARKER_TAGS.has(node.tagName)) element.removeAttr('data-no-dark');
    else if (!hasBackgroundImage(rule) || assetFor(node, rule)) element.attr('data-no-dark', '');
  });

  // Keep task text/state and layout untouched. Only the registered image marker
  // needs its own dark-mode protection; the surrounding task stays excluded.
  inside('span.wechat-task-marker[style]').each((_, node) => {
    const element = $(node);
    if (element.closest('pre,code').length > 0) return;
    const inTask = element.closest('[data-wechat-list-task-scope="true"]').length > 0
      || element.parents('li').toArray().some(parent => isTask($, parent));
    if (!inTask) return;
    const url = backgroundUrl(parseStyle(element.attr('style')));
    if (url && assets.has(url)) element.attr('data-no-dark', '');
  });

  for (const node of inside('blockquote').toArray().reverse()) {
    if (excluded(node)) continue;
    const element = $(node);
    const original = parseStyle(element.attr('style'));
    if (!original || !assetFor(node, original)) continue;
    const innerStyle = original.clone();
    const outerStyle = parseStyle('');
    for (const declaration of original.nodes) {
      if (declaration.type === 'decl'
        && (propertyName(declaration) === 'margin' || propertyName(declaration).startsWith('margin-'))) {
        outerStyle.append(declaration.clone());
      }
    }
    removeProperties(innerStyle, name => name === 'margin' || name.startsWith('margin-'));
    setProperty(innerStyle, 'margin', '0');
    for (const [property, value] of Object.entries({ padding: '0', border: 'none', 'background-color': 'transparent' })) {
      setProperty(outerStyle, property, value);
    }
    const surface = $('<section></section>').attr({
      'data-no-dark': '', [SURFACE_ATTRIBUTE]: 'quote', style: serializeStyle(innerStyle),
    });
    surface.append(element.contents());
    element.empty().append(surface).attr('style', serializeStyle(outerStyle)).removeAttr('data-no-dark');
  }

  for (const node of inside('li').toArray().reverse()) {
    if (excluded(node)) continue;
    const element = $(node);
    const outerStyle = parseStyle(element.attr('style'));
    if (!outerStyle || !assetFor(node, outerStyle)) continue;
    const innerStyle = parseStyle('margin:0');
    for (const declaration of outerStyle.nodes) {
      if (declaration.type !== 'decl') continue;
      const name = propertyName(declaration);
      if (BACKGROUND_PARTS.has(name) || name === 'background-color'
        || name === 'padding' || name.startsWith('padding-')) innerStyle.append(declaration.clone());
    }
    removeImageBackground(outerStyle);
    removeProperties(outerStyle, name => name === 'padding' || name.startsWith('padding-'));
    setProperty(outerStyle, 'padding', '0');
    const surface = $('<section></section>').attr({
      'data-no-dark': '', [SURFACE_ATTRIBUTE]: 'list', style: serializeStyle(innerStyle),
    });
    surface.append(element.contents());
    element.empty().append(surface).attr('style', serializeStyle(outerStyle)).removeAttr('data-no-dark');
  }

  if (policy.transparentCodeBlocks) {
    const transparent = rule => {
      const color = propertyValue(rule, 'background-color') ?? propertyValue(rule, 'background');
      return !color || color.trim().toLowerCase() === 'transparent';
    };
    for (const node of inside('pre').toArray()) {
      const pre = $(node);
      if (pre.parent(`[${SURFACE_ATTRIBUTE}="code-content"], [${SURFACE_ATTRIBUTE}="code"]`).length
        || pre.closest('[data-wechat-list-task-scope="true"]').length
        || pre.parents('li').toArray().some(parent => isTask($, parent))) continue;
      const preStyle = parseStyle(pre.attr('style'));
      const codes = pre.children('code');
      const code = codes.length === 1 ? codes.first() : null;
      const codeStyle = code ? parseStyle(code.attr('style')) : null;
      if (!preStyle || !transparent(preStyle) || (code && (!codeStyle || !transparent(codeStyle)))) continue;
      if (!hasBackgroundImage(preStyle) && !hasBackgroundImage(codeStyle)) continue;
      if ((hasBackgroundImage(preStyle) && !assetFor(node, preStyle))
        || (hasBackgroundImage(codeStyle) && !assetFor(code[0], codeStyle))) continue;

      // Decorations live outside pre/code; the original pre > code and its
      // whitespace remain intact. One section per image avoids multiple layers.
      const outer = $('<section></section>').attr({
        'data-no-dark': '', [SURFACE_ATTRIBUTE]: 'code', style: serializeStyle(preStyle.clone()),
      });
      const contentStyle = parseStyle('display:block;margin:0');
      if (codeStyle) {
        for (const declaration of codeStyle.nodes) {
          if (declaration.type !== 'decl') continue;
          const name = propertyName(declaration);
          if (BACKGROUND_PARTS.has(name) || name === 'background-color'
            || name === 'padding' || name.startsWith('padding-')) contentStyle.append(declaration.clone());
        }
        removeImageBackground(codeStyle);
        removeProperties(codeStyle, name => name === 'padding' || name.startsWith('padding-'));
        setProperty(codeStyle, 'padding', '0');
        code.attr('style', serializeStyle(codeStyle));
      }
      const content = $('<section></section>').attr({
        'data-no-dark': '', [SURFACE_ATTRIBUTE]: 'code-content', style: serializeStyle(contentStyle),
      });
      removeImageBackground(preStyle);
      removeProperties(preStyle, name => name === 'margin' || name.startsWith('margin-')
        || name === 'padding' || name.startsWith('padding-') || name === 'border' || name.startsWith('border-'));
      for (const [name, value] of Object.entries({ margin: '0', padding: '0', border: 'none' })) setProperty(preStyle, name, value);
      pre.attr('style', serializeStyle(preStyle)).removeAttr('data-no-dark').replaceWith(outer);
      pre.find('span[style]').attr('data-no-dark', '');
      content.append(pre);
      outer.append(content);
    }
  }

  if (policy.nativeTableBorders) {
    for (const node of inside('table,thead,tbody,tfoot,tr').toArray()) {
      if (excluded(node)) continue;
      const element = $(node);
      const rule = parseStyle(element.attr('style'));
      if (rule && hasBackgroundImage(rule) && assetFor(node, rule)) {
        removeImageBackground(rule);
        element.attr('style', serializeStyle(rule));
      }
      element.removeAttr('data-no-dark');
      // Native zero spacing prevents gaps between the adjoining header borders.
      if (node.tagName === 'table') element.attr({ cellspacing: '0', cellpadding: '0' });
    }
  }

  for (const node of inside('th,td').toArray()) {
    if (excluded(node)) continue;
    const element = $(node);
    const rule = parseStyle(element.attr('style'));
    if (!rule || !assetFor(node, rule)) continue;
    removeImageBackground(rule);
    setProperty(rule, 'border-bottom', `${node.tagName === 'th' ? '2px' : '1px'} solid ${borderColor}`);
    element.attr('style', serializeStyle(rule)).removeAttr('data-no-dark');
  }

  if (tableFrame) {
    const rootStyle = parseStyle(scope.attr('style'));
    for (const node of inside('table').toArray().reverse()) {
      if (excluded(node)) continue;
      const table = $(node);
      const alreadyFramed = table.parent(`[${SURFACE_ATTRIBUTE}="table-surface"]`)
        .parent(`[${SURFACE_ATTRIBUTE}="table-frame"]`).length > 0;
      if (alreadyFramed) {
        table.removeAttr('data-no-dark');
        continue;
      }
      const nativeStyle = parseStyle(table.attr('style'));
      if (!nativeStyle) {
        warnings.add('表格外框已跳过：表格样式无法解析。');
        continue;
      }
      const cellsWithUnknownBackground = table.find('th,td').toArray().some(cell => {
        const rule = parseStyle($(cell).attr('style'));
        return !rule || hasBackgroundImage(rule);
      });
      if (cellsWithUnknownBackground || (hasBackgroundImage(nativeStyle) && !assetFor(node, nativeStyle))) {
        warnings.add('表格外框已跳过：原生表格仍含未处理的背景图片。');
        continue;
      }
      const outerStyle = parseStyle('display:block');
      for (const declaration of nativeStyle.nodes) {
        if (declaration.type === 'decl'
          && (propertyName(declaration) === 'margin' || propertyName(declaration).startsWith('margin-'))) {
          outerStyle.append(declaration.clone());
        }
      }
      removeProperties(nativeStyle, name => name === 'margin' || name.startsWith('margin-'));
      setProperty(nativeStyle, 'margin', '0');
      removeImageBackground(nativeStyle);
      const frameValues = {
        padding: `${tableFrame.borderWidth}px`, border: 'none', 'border-radius': `${tableFrame.borderRadius}px`,
        'background-color': borderColor, 'background-image': `url("${tableFrame.border.url}")`,
        'background-repeat': 'no-repeat', 'background-position': 'center center', 'background-size': '100% 100%',
      };
      for (const [property, value] of Object.entries(frameValues)) setProperty(outerStyle, property, value);
      const innerStyle = parseStyle('display:block;margin:0;border:none');
      const surfaceValues = {
        padding: tableFrame.surfacePadding.map(value => `${value}px`).join(' '),
        'border-radius': `${tableFrame.borderRadius - tableFrame.borderWidth}px`,
        'background-color': propertyValue(rootStyle, 'background-color') ?? propertyValue(rootStyle, 'background') ?? '#07080C',
        'background-image': `url("${tableFrame.surface.url}")`,
        'background-repeat': propertyValue(rootStyle, 'background-repeat') ?? 'repeat',
        'background-position': propertyValue(rootStyle, 'background-position') ?? 'left top',
        'background-size': propertyValue(rootStyle, 'background-size') ?? '627px 627px',
      };
      for (const [property, value] of Object.entries(surfaceValues)) setProperty(innerStyle, property, value);
      // Only copy compatible root background parameters. This uses one image per
      // section; the inset texture starts at the panel, not the page origin.
      const safeInner = filterWechatStyle(serializeStyle(innerStyle), { allowedBackgroundUrls: [tableFrame.surface.url] });
      if (safeInner.removed.length) warnings.add('表格内层已忽略不兼容的正文背景参数。');
      const outer = $('<section></section>').attr({
        'data-no-dark': '', [SURFACE_ATTRIBUTE]: 'table-frame', style: serializeStyle(outerStyle),
      });
      const inner = $('<section></section>').attr({
        'data-no-dark': '', [SURFACE_ATTRIBUTE]: 'table-surface', style: safeInner.style,
      });
      table.attr('style', serializeStyle(nativeStyle)).removeAttr('data-no-dark').replaceWith(outer);
      inner.append(table);
      outer.append(inner);
    }
  }

  for (const node of inside('hr').toArray()) {
    if (excluded(node)) continue;
    const element = $(node);
    const rule = parseStyle(element.attr('style'));
    const image = rule && assetFor(node, rule);
    if (!image) continue;
    removeImageBackground(rule);
    removeProperties(rule, name => ['height', 'min-height', 'max-height', 'overflow', 'overflow-x', 'overflow-y'].includes(name));
    for (const [property, value] of Object.entries({ padding: '0', border: 'none', display: 'block', 'font-size': '0', 'line-height': '0' })) {
      setProperty(rule, property, value);
    }
    const surface = $('<section></section>').attr({
      ...element.attr(), role: 'separator', 'aria-orientation': 'horizontal',
      'data-no-dark': '', [SURFACE_ATTRIBUTE]: 'separator', style: serializeStyle(rule),
    });
    surface.append($('<img>').attr({
      src: image.url, alt: '', 'aria-hidden': 'true', 'data-no-dark': '',
      style: 'display:block;width:100%;max-width:100%;height:auto;margin:0;padding:0;border:none;background-color:transparent',
    }));
    element.replaceWith(surface);
  }

  // Also recover these records when called again on already-upgraded HTML.
  const images = new Map();
  inside(`[${SURFACE_ATTRIBUTE}="separator"] > img`).each((_, node) => {
    const asset = assets.get($(node).attr('src'));
    if (asset) images.set(asset.url, { ...asset, preferWechatUrl: true });
  });
  const updated = html.slice(0, startIndex) + $.html(root) + html.slice(endIndex + 1);
  return {
    html: updated,
    images: [...images.values()],
    warnings: [...warnings],
    backgroundImageUrls: collectBackgroundUrls($),
  };
}
