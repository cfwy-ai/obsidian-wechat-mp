// 微信网页粘贴会丢弃一批 CSS。
//
// 这一层在 juice 内联之后运行：预览与剪贴板共用同一份保守输出，
// 因此 Obsidian 不会再展示一个粘贴后必然消失的效果。

import postcss from 'postcss';
import { transformSanitizedHtmlElements } from './sanitize.mjs';

const SAFE_PROPERTIES = new Set([
  'color',
  'font-size',
  'font-weight',
  'font-style',
  'font-family',
  'text-align',
  'text-decoration',
  'text-indent',
  'text-shadow',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'word-break',
  'word-wrap',
  'overflow-wrap',
  'vertical-align',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'width',
  'max-width',
  'height',
  'min-height',
  'background',
  'background-color',
  'background-image',
  'background-repeat',
  'background-position',
  'background-size',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-width',
  'border-style',
  'border-color',
  'border-top-width',
  'border-top-style',
  'border-top-color',
  'border-right-width',
  'border-right-style',
  'border-right-color',
  'border-bottom-width',
  'border-bottom-style',
  'border-bottom-color',
  'border-left-width',
  'border-left-style',
  'border-left-color',
  // 单元格圆角只在 border-collapse: separate 下生效，微信会强制合并边框；
  // 少了这两项，主题就没有任何办法让表格圆角在公众号里留下来。
  'border-collapse',
  'border-spacing',
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'display',
  'list-style-type',
  'white-space',
]);

const SAFE_DISPLAY_VALUES = new Set(['block', 'inline', 'inline-block', 'none']);
const SAFE_WHITE_SPACE_VALUES = new Set(['normal', 'pre-wrap']);
const UNSAFE_FUNCTION = /(?:var|calc|attr|env|paint|linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient|repeating-radial-gradient|repeating-conic-gradient|url|image-set|cross-fade|filter|color-mix|lab|lch|oklab|oklch|hwb)\s*\(/i;
const VIEWPORT_UNIT = /(?:^|[\s(,])[-+]?(?:\d*\.)?\d+(?:vw|vh|vmin|vmax)\b/i;
const NEGATIVE_MARGIN = /(?:^|\s)-(?:\d*\.)?\d/;
const SAFE_BACKGROUND_SCHEME = /^(?:(?:app|file|local):\/\/|data:image\/(?:png|jpeg);base64,[a-z0-9+/]+=*$)/i;
const BACKGROUND_URL = /^url\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^'"()\s]+))\s*\)$/i;
const SAFE_BACKGROUND_REPEAT = new Set(['no-repeat', 'repeat', 'repeat-x', 'repeat-y']);
const BACKGROUND_POSITION_TOKEN = /^(?:left|center|right|top|bottom|0|(?:\d+(?:\.\d+)?|\.\d+)(?:px|%))$/i;
const BACKGROUND_SIZE_TOKEN = /^(?:auto|0|(?:\d+(?:\.\d+)?|\.\d+)(?:px|%))$/i;
const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));
const toHex = (value) => clampByte(value).toString(16).padStart(2, '0').toUpperCase();

const rgbHex = (red, green, blue) => `#${toHex(red)}${toHex(green)}${toHex(blue)}`;

const hslRgb = (hue, saturation, lightness) => {
  const h = ((Number(hue) % 360) + 360) % 360 / 360;
  const s = Math.max(0, Math.min(1, Number(saturation) / 100));
  const l = Math.max(0, Math.min(1, Number(lightness) / 100));
  if (s === 0) return [l * 255, l * 255, l * 255];

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (offset) => {
    let t = h + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(1 / 3) * 255, channel(0) * 255, channel(-1 / 3) * 255];
};

const alphaValue = (value, percent) => {
  if (value === undefined) return 1;
  const parsed = Number(value);
  return Math.max(0, Math.min(1, percent ? parsed / 100 : parsed));
};

const compositeOnWhite = ([red, green, blue], alpha) => rgbHex(
  red * alpha + 255 * (1 - alpha),
  green * alpha + 255 * (1 - alpha),
  blue * alpha + 255 * (1 - alpha),
);

/**
 * 公众号粘贴路径中纯 hex 比 hsl()/rgba() 更稳定。
 * 带 alpha 的 HSLA/RGBA 按白底合成，不依赖粘贴端保留透明色。
 */
export function normalizeWechatColors(value) {
  let changed = false;
  let output = value.replace(
    /hsla?\(\s*([-+\d.]+)\s*,\s*([-+\d.]+)%\s*,\s*([-+\d.]+)%(?:\s*(?:,|\/)\s*([-+\d.]+)(%)?)?\s*\)/gi,
    (_whole, h, s, l, alphaText, alphaPercent) => {
      changed = true;
      return compositeOnWhite(hslRgb(h, s, l), alphaValue(alphaText, alphaPercent));
    },
  );
  output = output.replace(
    /rgba?\(\s*([-+\d.]+)\s*,\s*([-+\d.]+)\s*,\s*([-+\d.]+)(?:\s*,\s*([-+\d.]+)(%)?)?\s*\)/gi,
    (_whole, r, g, b, alphaText, alphaPercent) => {
      const a = alphaValue(alphaText, alphaPercent);
      changed = true;
      return compositeOnWhite([Number(r), Number(g), Number(b)], a);
    },
  );
  return { value: output, changed };
}

const simpleBackground = (value) =>
  /^(?:#[0-9a-f]{3,8}|[a-z]+)$/i.test(value.trim());

/** 严格读取一个 CSS url()，拒绝多背景和其他函数。 */
export function singleBackgroundImageUrl(value) {
  const match = BACKGROUND_URL.exec(String(value ?? '').trim());
  if (!match) return null;
  const url = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  return url && SAFE_BACKGROUND_SCHEME.test(url) ? url : null;
}

const splitBackgroundTokens = (value) => value.trim().split(/\s+/).filter(Boolean);

const safeBackgroundPosition = (value) => {
  const tokens = splitBackgroundTokens(value);
  return tokens.length >= 1 && tokens.length <= 2 && tokens.every((token) =>
    BACKGROUND_POSITION_TOKEN.test(token));
};

const safeBackgroundSize = (value) => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'cover' || normalized === 'contain') return true;
  const tokens = splitBackgroundTokens(normalized);
  return tokens.length >= 1 && tokens.length <= 2 && tokens.every((token) =>
    BACKGROUND_SIZE_TOKEN.test(token));
};

const compatibilityReason = (property, value, context = {}) => {
  if (!SAFE_PROPERTIES.has(property)) return '非白名单属性';
  if (property === 'background-image') {
    if (value.trim().toLowerCase() === 'none') return null;
    const url = singleBackgroundImageUrl(value);
    if (!url) return '非安全单背景图片';
    if (!context.allowedBackgroundUrls?.has(url)) return '未登记背景素材';
    return null;
  }
  if (property === 'background-repeat') {
    if (!context.hasSafeBackgroundImage && !context.hasExplicitNoBackground) return '缺少受管背景图片';
    return SAFE_BACKGROUND_REPEAT.has(value.trim().toLowerCase()) ? null : '不稳定背景平铺';
  }
  if (property === 'background-position') {
    if (!context.hasSafeBackgroundImage && !context.hasExplicitNoBackground) return '缺少受管背景图片';
    return safeBackgroundPosition(value) ? null : '不稳定背景位置';
  }
  if (property === 'background-size') {
    if (!context.hasSafeBackgroundImage && !context.hasExplicitNoBackground) return '缺少受管背景图片';
    return safeBackgroundSize(value) ? null : '不稳定背景尺寸';
  }
  if (UNSAFE_FUNCTION.test(value)) return '不稳定函数值';
  if (VIEWPORT_UNIT.test(value)) return '视口单位';
  if (property.startsWith('margin') && NEGATIVE_MARGIN.test(value)) {
    const amount = property === 'margin-top' && /^-\d+(?:\.\d+)?px$/.test(value) ? -Number.parseFloat(value) : NaN;
    if (context.referenceOverlap?.mode === 'allow' && Number.isFinite(amount)
      && amount > 0 && amount <= context.referenceOverlap.limit) return null;
    return '负外边距';
  }
  if (property === 'display' && !SAFE_DISPLAY_VALUES.has(value.trim().toLowerCase())) {
    return '不稳定布局模式';
  }
  if (property === 'white-space' && !SAFE_WHITE_SPACE_VALUES.has(value.trim().toLowerCase())) {
    return '不稳定空白规则';
  }
  if (property === 'background' && !simpleBackground(value)) return '非纯色背景';
  return null;
};

/**
 * @param {{ allowedBackgroundUrls?: Iterable<string> }} options
 * @returns {{ style: string, removed: Array<{property: string, reason: string}>, normalizedColors: number, backgroundImageUrls: string[] }}
 */
export function filterWechatStyle(style, { allowedBackgroundUrls = [], _referenceOverlap = null } = {}) {
  const root = postcss.parse(`a{${style}}`, { from: undefined });
  const rule = root.first;
  const removed = [];
  let normalizedColors = 0;
  const allowed = new Set(allowedBackgroundUrls);
  const backgroundDeclarations = rule.nodes.filter((node) =>
    node.type === 'decl' && node.prop.trim().toLowerCase() === 'background-image');
  const candidateBackgroundUrl = backgroundDeclarations.length === 1
    ? singleBackgroundImageUrl(backgroundDeclarations[0].value)
    : null;
  const hasExplicitNoBackground = backgroundDeclarations.length === 1
    && backgroundDeclarations[0].value.trim().toLowerCase() === 'none';
  const hasSafeBackgroundImage = Boolean(
    candidateBackgroundUrl && allowed.has(candidateBackgroundUrl),
  );
  const backgroundImageUrls = [];

  rule.walkDecls((declaration) => {
    const property = declaration.prop.trim().toLowerCase();
    if (property === 'margin-top' && _referenceOverlap?.mode === 'zero'
      && /^-\d+(?:\.\d+)?px$/.test(declaration.value)
      && -Number.parseFloat(declaration.value) <= _referenceOverlap.limit) declaration.value = '0px';
    const normalized = normalizeWechatColors(declaration.value);
    const reason = property === 'background-image' && backgroundDeclarations.length !== 1
      ? '多重背景图片'
      : compatibilityReason(property, normalized.value, {
          allowedBackgroundUrls: allowed,
          hasSafeBackgroundImage,
          hasExplicitNoBackground,
          referenceOverlap: _referenceOverlap,
        });
    if (reason) {
      removed.push({ property, reason });
      declaration.remove();
      return;
    }
    if (normalized.changed) {
      declaration.value = normalized.value;
      normalizedColors += 1;
    }
    if (property === 'background-image' && candidateBackgroundUrl) {
      backgroundImageUrls.push(candidateBackgroundUrl);
    }
  });

  return {
    style: rule.nodes.length > 0
      ? `${rule.nodes.map((node) => node.toString()).join('; ')};`
      : '',
    removed,
    normalizedColors,
    backgroundImageUrls,
  };
}

/**
 * 只改 juice 生成的行内 style，不改文章结构与图片地址。
 *
 * @returns {{ html: string, warnings: string[], removedCount: number, normalizedColorCount: number }}
 */
export function filterWechatCompatibleHtml(html, { allowedBackgroundUrls = [], referenceSceneOverlaps = null } = {}) {
  const removedByProperty = new Map();
  let removedCount = 0;
  let normalizedColorCount = 0;
  let parseFailures = 0;
  const backgroundImageUrls = new Set();
  let sectionIndex = -1;

  const output = transformSanitizedHtmlElements(html, (tagName, attribs) => {
    if (tagName === 'section') sectionIndex += 1;
    if (!Object.hasOwn(attribs, 'style')) return { tagName, attribs };
    const next = { ...attribs };
    try {
      const filtered = filterWechatStyle(attribs.style, { allowedBackgroundUrls,
        _referenceOverlap: tagName === 'section' && attribs['data-wechat-scene'] === 'feature'
          ? referenceSceneOverlaps?.get(sectionIndex) : null,
      });
      removedCount += filtered.removed.length;
      normalizedColorCount += filtered.normalizedColors;
      for (const item of filtered.removed) {
        removedByProperty.set(item.property, (removedByProperty.get(item.property) ?? 0) + 1);
      }
      for (const url of filtered.backgroundImageUrls) backgroundImageUrls.add(url);
      if (filtered.style) next.style = filtered.style;
      else delete next.style;
    } catch {
      parseFailures += 1;
      delete next.style;
    }
    return { tagName, attribs: next };
  });

  const warnings = [];
  if (removedCount > 0) {
    const summary = [...removedByProperty.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([property, count]) => `${property}×${count}`)
      .join('、');
    warnings.push(`为贴近微信粘贴结果，已移除 ${removedCount} 处不稳定样式：${summary}`);
  }
  if (normalizedColorCount > 0) {
    warnings.push(`已将 ${normalizedColorCount} 处 HSL/RGBA 色值转为稳定的 HEX 色值`);
  }
  if (parseFailures > 0) {
    warnings.push(`${parseFailures} 个行内样式语法无法解析，已保守移除`);
  }

  return {
    html: output,
    warnings,
    removedCount,
    normalizedColorCount,
    backgroundImageUrls: [...backgroundImageUrls],
  };
}

const escapeCssString = (value) =>
  String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '');

/**
 * 只重写已通过兼容层的行内 background-image。
 * replacement 为 null 时只删图片声明，其他样式（尤其 background-color）保留。
 */
export function rewriteWechatBackgroundImage(html, source, replacement) {
  let rewrittenCount = 0;
  const output = transformSanitizedHtmlElements(html, (tagName, attribs) => {
    if (!Object.hasOwn(attribs, 'style')) return { tagName, attribs };
    const next = { ...attribs };
    try {
      const root = postcss.parse(`a{${attribs.style}}`, { from: undefined });
      const rule = root.first;
      let elementRewrittenCount = 0;
      rule.walkDecls('background-image', (declaration) => {
        if (singleBackgroundImageUrl(declaration.value) !== source) return;
        rewrittenCount += 1;
        elementRewrittenCount += 1;
        if (replacement === null) declaration.remove();
        else declaration.value = `url("${escapeCssString(replacement)}")`;
      });
      if (elementRewrittenCount === 0) return { tagName, attribs };
      if (rule.nodes.length === 0) delete next.style;
      else next.style = `${rule.nodes.map((node) => node.toString()).join('; ')};`;
      return { tagName, attribs: next };
    } catch {
      return { tagName, attribs };
    }
  }, { allowDataImages: true });
  return { html: output, rewrittenCount };
}

const LOCAL_IMAGE_URL = /^(?:app|file|local):\/\//i;

/**
 * 一次遍历最终 HTML，为已登记图片和遗留的本地图片引用建立稳定令牌。
 *
 * 复制层之后只处理这些小令牌，不再为每张图反复扫描整篇 HTML。
 * 返回的 occurrences 按文档可见顺序排列。
 */
export function indexWechatImageReferences(
  html,
  {
    sources = [],
    tokenPrefix = 'app://changfeng-clipboard-token-v098',
  } = {},
) {
  const registered = new Set([...sources].map((source) => String(source ?? '')));
  const occurrences = [];
  let sequence = 0;
  const shouldIndex = (source) => Boolean(
    source && (registered.has(source) || LOCAL_IMAGE_URL.test(source)),
  );
  const nextToken = (kind) => {
    const token = `${tokenPrefix}/${kind}/${String(sequence).padStart(6, '0')}`;
    sequence += 1;
    return token;
  };

  const output = transformSanitizedHtmlElements(html, (tagName, attribs) => {
    let changed = false;
    const next = { ...attribs };

    if (tagName === 'img' && shouldIndex(attribs.src)) {
      const source = attribs.src;
      const token = nextToken('img');
      next.src = token;
      occurrences.push({ kind: 'img', source, token, order: occurrences.length });
      changed = true;
    }

    if (Object.hasOwn(attribs, 'style')) {
      try {
        const root = postcss.parse(`a{${attribs.style}}`, { from: undefined });
        const rule = root.first;
        let styleChanged = false;
        rule.walkDecls('background-image', (declaration) => {
          const source = singleBackgroundImageUrl(declaration.value);
          if (!shouldIndex(source)) return;
          const token = nextToken('background');
          declaration.value = `url("${escapeCssString(token)}")`;
          occurrences.push({
            kind: 'background',
            source,
            token,
            order: occurrences.length,
          });
          styleChanged = true;
        });
        if (styleChanged) {
          next.style = `${rule.nodes.map((node) => node.toString()).join('; ')};`;
          changed = true;
        }
      } catch {
        // 兼容层理论上已清理 style；异常样式留给终检拦截。
      }
    }

    return changed ? { tagName, attribs: next } : { tagName, attribs };
  }, { allowDataImages: true });

  return { html: output, occurrences };
}

/**
 * 一次改写所有背景令牌。
 * replacement 为 null 时删除 background-image，但保留背景色和其他样式。
 */
export function rewriteWechatBackgroundImageTokens(html, replacements) {
  const replacementMap = replacements instanceof Map
    ? replacements
    : new Map(Object.entries(replacements ?? {}));
  let rewrittenCount = 0;
  let removedCount = 0;

  const output = transformSanitizedHtmlElements(html, (tagName, attribs) => {
    if (!Object.hasOwn(attribs, 'style')) return { tagName, attribs };
    const next = { ...attribs };
    try {
      const root = postcss.parse(`a{${attribs.style}}`, { from: undefined });
      const rule = root.first;
      let elementChanged = false;
      rule.walkDecls('background-image', (declaration) => {
        const source = singleBackgroundImageUrl(declaration.value);
        if (!source || !replacementMap.has(source)) return;
        const replacement = replacementMap.get(source);
        rewrittenCount += 1;
        elementChanged = true;
        if (replacement === null) {
          removedCount += 1;
          declaration.remove();
        } else {
          declaration.value = `url("${escapeCssString(replacement)}")`;
        }
      });
      if (!elementChanged) return { tagName, attribs };
      if (rule.nodes.length === 0) delete next.style;
      else next.style = `${rule.nodes.map((node) => node.toString()).join('; ')};`;
      return { tagName, attribs: next };
    } catch {
      return { tagName, attribs };
    }
  }, { allowDataImages: true });

  return { html: output, rewrittenCount, removedCount };
}

/** 终检图片属性中是否还有本地地址或复制令牌。 */
export function auditWechatImageReferences(
  html,
  { tokenPrefix = 'app://changfeng-clipboard-token-v098' } = {},
) {
  let localCount = 0;
  let tokenCount = 0;
  transformSanitizedHtmlElements(html, (tagName, attribs) => {
    const inspect = (source) => {
      if (!source) return;
      if (source.startsWith(tokenPrefix)) tokenCount += 1;
      else if (LOCAL_IMAGE_URL.test(source)) localCount += 1;
    };
    if (tagName === 'img') inspect(attribs.src);
    if (Object.hasOwn(attribs, 'style')) {
      try {
        const root = postcss.parse(`a{${attribs.style}}`, { from: undefined });
        root.first.walkDecls('background-image', (declaration) => {
          inspect(singleBackgroundImageUrl(declaration.value));
        });
      } catch {
        // 异常 style 不误判为可安全复制的图片引用。
      }
    }
    return { tagName, attribs };
  }, { allowDataImages: true });
  return { localCount, tokenCount };
}

/** 复制/导出前预估 data URL 重复展开量，避免先构建超大字符串再回退。 */
export function countWechatBackgroundImageReferences(html, source) {
  let count = 0;
  transformSanitizedHtmlElements(html, (tagName, attribs) => {
    if (!Object.hasOwn(attribs, 'style')) return { tagName, attribs };
    try {
      const root = postcss.parse(`a{${attribs.style}}`, { from: undefined });
      root.first.walkDecls('background-image', (declaration) => {
        if (singleBackgroundImageUrl(declaration.value) === source) count += 1;
      });
    } catch {
      // 最终 HTML 理论上已经通过兼容层；异常 style 不纳入可替换计数。
    }
    return { tagName, attribs };
  });
  return count;
}

/** 只收集元素的真实 style 属性，供回归工具检查最终输出。 */
export function extractWechatStyleAttributes(html) {
  const styles = [];
  transformSanitizedHtmlElements(html, (tagName, attribs) => {
    if (Object.hasOwn(attribs, 'style')) styles.push(attribs.style);
    return { tagName, attribs };
  });
  return styles;
}
