import { Buffer } from 'node:buffer';
import {
  auditWechatImageReferences,
  countWechatBackgroundImageReferences,
  indexWechatImageReferences,
  rewriteWechatBackgroundImage,
  rewriteWechatBackgroundImageTokens,
} from '../src/wechat-compat.mjs';
import { transformSanitizedHtmlElements } from '../src/sanitize.mjs';
import { normalizeWechatAssetUrl } from '../src/theme-package.mjs';

export const DEFAULT_IMAGE_EMBED_LIMIT = 12 * 1024 * 1024;
export const DEFAULT_CLIPBOARD_HTML_LIMIT = 4 * 1024 * 1024;
export const DEFAULT_SINGLE_IMAGE_LIMIT = 1024 * 1024;
export const DEFAULT_SOURCE_IMAGE_LIMIT = 24 * 1024 * 1024;
export const DEFAULT_SOURCE_TOTAL_LIMIT = 64 * 1024 * 1024;
export const DEFAULT_MAX_PROCESSED_RESOURCES = 128;

const COPY_TOKEN_PREFIX = 'app://changfeng-clipboard-token-v098';

const MIME_BY_EXTENSION = {
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

const escapeHtml = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escapeAttr = (value) =>
  escapeHtml(value).replace(/"/g, '&quot;');

const IMAGE_TAG = /<img\b[^>]*>/gi;
const QUOTED_SRC_ATTRIBUTE = /(^|\s)(src\s*=\s*)(["'])([\s\S]*?)\3/i;

const imageTagSource = (tag) => QUOTED_SRC_ATTRIBUTE.exec(tag)?.[4] ?? null;

/**
 * 只扫描 img 标签并对 src 做字面比较。
 * source 可能是数万字符的 Data URL，绝不能插入动态 RegExp。
 */
const transformImageTags = (html, transform) => String(html ?? '').replace(
  IMAGE_TAG,
  (tag) => transform(tag, imageTagSource(tag)),
);

export function imageMimeType(filename) {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

export function replaceImageSource(html, source, replacement) {
  const escapedSource = escapeAttr(source);
  return transformImageTags(
    html,
    (tag, value) => value === escapedSource
      ? tag.replace(
          QUOTED_SRC_ATTRIBUTE,
          (_whole, leading, attribute, quote) =>
            `${leading}${attribute}${quote}${replacement}${quote}`,
        )
      : tag,
  );
}

export function countRenderedImageReferences(html, source) {
  const escapedSource = escapeAttr(source);
  let imageCount = 0;
  transformImageTags(html, (tag, value) => {
    if (value === escapedSource) imageCount += 1;
    return tag;
  });
  const backgroundCount = countWechatBackgroundImageReferences(html, source);
  return { imageCount, backgroundCount, total: imageCount + backgroundCount };
}

/** 在 data URL 展开前保守估算结果体积，实际串构建后仍会二次校验。 */
export function estimatedReplacementHtmlBytes(html, source, replacement) {
  const references = countRenderedImageReferences(html, source);
  const sourceBytes = Buffer.byteLength(source, 'utf8');
  const replacementBytes = Buffer.byteLength(replacement, 'utf8');
  const imageGrowth = Math.max(
    0,
    replacementBytes - sourceBytes,
  );
  // sanitize-html 重建 style 属性时会把 CSS 引号写成 &quot;，每处预留 16 字节。
  const backgroundGrowth = Math.max(0, replacementBytes - sourceBytes + 16);
  return Buffer.byteLength(html, 'utf8')
    + references.imageCount * imageGrowth
    + references.backgroundCount * backgroundGrowth;
}

/** 同时替换 img src 与受管 CSS 背景引用。 */
export function replaceRenderedImageSource(html, source, replacement) {
  const withBackgrounds = rewriteWechatBackgroundImage(html, source, replacement).html;
  return replaceImageSource(withBackgrounds, source, replacement);
}

export function replaceImageWithPlaceholder(html, source, label) {
  const escapedSource = escapeAttr(source);
  return transformImageTags(
    html,
    (tag, value) => value === escapedSource
      ? `<span data-wechat-image-placeholder="true" style="display:block;color:#888;font-size:13px;text-align:center;">${escapeHtml(label)}</span>`
      : tag,
  );
}

export function replaceImageWithFallback(html, source, fallbackHtml, label) {
  if (!fallbackHtml) return replaceImageWithPlaceholder(html, source, label);
  const escapedSource = escapeAttr(source);
  return transformImageTags(
    html,
    (tag, value) => value === escapedSource ? fallbackHtml : tag,
  );
}

/**
 * img 失败时保留编号图位；背景失败时只删 background-image，
 * 不向正文插入图位，也不删 background-color。
 */
export function removeRenderedImageSource(html, source, label, fallbackHtml = '') {
  const withPlaceholders = replaceImageWithFallback(html, source, fallbackHtml, label);
  return rewriteWechatBackgroundImage(withPlaceholders, source, null).html;
}

/**
 * 只有文章、风格和渲染结果仍指向同一个状态时才允许复制。
 * 返回的快照使后续异步读图不再依赖可能变化的 view.lastRender。
 */
export function createCopySnapshot({ render, article, themePath }) {
  if (!render || !article || !themePath) return null;
  if (render.articlePath !== article.path || render.themePath !== themePath) return null;
  return { article, render };
}

/** 复制全流程互斥，避免并发读图和剪贴板末写覆盖。 */
export function createCopyLock() {
  let locked = false;
  return {
    get locked() {
      return locked;
    },
    acquire() {
      if (locked) return false;
      locked = true;
      return true;
    },
    release() {
      locked = false;
    },
  };
}

const byteLength = (value) => Buffer.byteLength(String(value ?? ''), 'utf8');

const ORIGIN_PRIORITY = Object.freeze({ article: 0, generated: 1, theme: 2 });

const DEGRADATION_REASON_LABELS = Object.freeze({
  missingImage: '找不到图片',
  singleImageLimit: '单图上限',
  totalImageLimit: '总量上限',
  htmlLimit: 'HTML 上限',
  sourceImageLimit: '单张源图读取上限',
  sourceTotalLimit: '源图读取总量上限',
  resolveError: '图片解析失败',
  processingError: '图片处理失败',
});

const createDegradationReasons = () => Object.fromEntries(
  Object.keys(DEGRADATION_REASON_LABELS).map((code) => [code, 0]),
);

const normalizedOrigin = (image) => (
  image?.origin === 'generated' || image?.origin === 'theme'
    ? image.origin
    : 'article'
);

const stableMetadataKey = (image) => [
  ORIGIN_PRIORITY[normalizedOrigin(image)],
  normalizedOrigin(image) === 'theme' && image?.preferWechatUrl === true ? '0' : '1',
  image?.filePath ?? '',
  image?.target ?? '',
  image?.wechatUrl ?? '',
  image?.fallbackHtml ?? '',
].join('\u0000');

const normalizedImageRecords = (images) => {
  const grouped = new Map();
  for (const image of Array.isArray(images) ? images : []) {
    const source = String(image?.url ?? '');
    if (!source) continue;
    const group = grouped.get(source) ?? [];
    group.push(image);
    grouped.set(source, group);
  }
  return new Map([...grouped.entries()].map(([source, group]) => {
    const chosen = [...group].sort((a, b) =>
      stableMetadataKey(a).localeCompare(stableMetadataKey(b)))[0];
    return [source, { ...chosen, url: source, origin: normalizedOrigin(chosen) }];
  }));
};

const escapedCssUrlBytes = (url) => byteLength(escapeAttr(String(url)
  .replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '')));

const imageTagMetadata = (html, occurrenceByToken) => {
  const expression = /<([a-z][a-z0-9-]*)\b[^>]*>/gi;
  const backgroundToken = /app:\/\/changfeng-clipboard-token-v098\/background\/\d+/g;
  const probeUrl = 'data:image/png;base64,AA==';
  let match;
  while ((match = expression.exec(html)) !== null) {
    const tag = match[0];
    const occurrence = match[1].toLowerCase() === 'img'
      ? occurrenceByToken.get(imageTagSource(tag)) : null;
    if (occurrence) occurrence.serializedTag = tag;

    // 只测量短令牌标签，不展开真实图片。背景的样式属性、CSS 引号和 HTML
    // 实体开销由同一序列化器计算，后续按 URL 字节数即可预算每个唯一资源。
    const tokens = [...tag.matchAll(backgroundToken)].map((item) => item[0]);
    if (tokens.length === 0) continue;
    const fragment = `${tag}</${match[1]}>`;
    const replacements = new Map(tokens.map((token) => [token, null]));
    const removedBytes = byteLength(rewriteWechatBackgroundImageTokens(
      fragment, replacements,
    ).html);
    for (const token of tokens) {
      const background = occurrenceByToken.get(token);
      if (!background || background.kind !== 'background') continue;
      replacements.set(token, probeUrl);
      const kept = rewriteWechatBackgroundImageTokens(fragment, replacements);
      background.backgroundFixedGrowth = byteLength(kept.html)
        - removedBytes - escapedCssUrlBytes(probeUrl);
      replacements.set(token, null);
    }
  }
};

const sanitizedFragment = (html) => transformSanitizedHtmlElements(
  String(html ?? ''),
  (tagName, attribs) => ({ tagName, attribs }),
  { allowDataImages: false },
);

const articlePlaceholderHtml = (number) => (
  '<span data-wechat-image-placeholder="true" '
  + 'style="display:block;color:#888;font-size:13px;text-align:center;">'
  + `【正文图片 ${number}】</span>`
);

const fallbackForOccurrence = (resource, occurrence) => {
  if (occurrence.kind === 'background') return null;
  if (resource.origin === 'generated') {
    const fallback = resource.image.fallbackHtml
      || (resource.image.alt ? `<span>${escapeHtml(String(resource.image.alt))}</span>` : '');
    return sanitizedFragment(fallback);
  }
  if (resource.origin === 'theme') return '';
  return sanitizedFragment(articlePlaceholderHtml(occurrence.articleNumber));
};

const createCopyStats = (maxHtmlBytes) => ({
  articleImages: { total: 0, embedded: 0, placeholders: 0 },
  headingImages: { total: 0, embedded: 0, textFallbacks: 0 },
  themeImages: { total: 0, embedded: 0, remote: 0, omitted: 0 },
  themeBackgrounds: { total: 0, delivered: 0, remote: 0, embedded: 0, removed: 0 },
  remoteBackgrounds: { total: 0, delivered: 0, removed: 0 },
  degradationReasons: createDegradationReasons(),
  resources: {
    uniqueSeen: 0,
    localProcessed: 0,
    stale: 0,
    safetySkipped: 0,
  },
  limits: { htmlBytes: 0, maxHtmlBytes, embeddedBytes: 0 },
});

const updateImageStats = (stats, resource, outcome) => {
  if (resource.origin === 'generated') {
    const group = resource.image.generatedKind === 'inline-paint' ? stats.inlinePaintImages
      : resource.image.generatedKind === 'quote' ? stats.quoteImages
      : resource.image.generatedKind === 'ordered-list' ? stats.orderedListImages : stats.headingImages;
    if (outcome === 'embedded') group.embedded += 1;
    else group.textFallbacks += 1;
    return;
  }
  if (resource.origin === 'theme') {
    if (outcome === 'embedded') stats.themeImages.embedded += 1;
    else if (outcome === 'remote') stats.themeImages.remote += 1;
    else stats.themeImages.omitted += 1;
    return;
  }
  if (outcome === 'embedded') stats.articleImages.embedded += 1;
  else stats.articleImages.placeholders += 1;
};

/** 把分项统计组装成界面提示，避免 view 再猜测各类图片的降级方式。 */
export function formatCopyResultNotice(result) {
  const stats = result?.stats;
  if (!stats) return '已复制排版';
  const parts = [];
  if (stats.articleImages.total > 0) {
    parts.push(`正文图片 ${stats.articleImages.embedded}/${stats.articleImages.total}`);
  }
  if (stats.headingImages.total > 0) {
    parts.push(`标题图片 ${stats.headingImages.embedded}/${stats.headingImages.total}`);
  }
  if (stats.quoteImages?.total > 0) parts.push(`金句图片 ${stats.quoteImages.embedded}/${stats.quoteImages.total}`);
  if (stats.inlinePaintImages?.total > 0) parts.push(`行内批注 ${stats.inlinePaintImages.embedded}/${stats.inlinePaintImages.total}`);
  if (stats.orderedListImages?.total > 0) parts.push(`列表编号 ${stats.orderedListImages.embedded}/${stats.orderedListImages.total}`);
  if (stats.themeImages.total > 0) {
    parts.push(`主题装饰 ${stats.themeImages.embedded + (stats.themeImages.remote ?? 0)}/${stats.themeImages.total}`);
  }
  const backgrounds = stats.themeBackgrounds ?? stats.remoteBackgrounds;
  if (backgrounds?.total > 0) {
    parts.push(`主题背景 ${backgrounds.delivered}/${backgrounds.total}`);
  }
  if (parts.length === 0) return '已复制排版';

  const fallbacks = [];
  if (stats.articleImages.placeholders > 0) {
    fallbacks.push(`正文 ${stats.articleImages.placeholders} 张保留图位`);
  }
  if (stats.headingImages.textFallbacks > 0) {
    fallbacks.push(`标题 ${stats.headingImages.textFallbacks} 处恢复活文字`);
  }
  if (stats.quoteImages?.textFallbacks > 0) fallbacks.push(`金句 ${stats.quoteImages.textFallbacks} 处恢复活文字`);
  if (stats.inlinePaintImages?.textFallbacks > 0) fallbacks.push(`行内批注 ${stats.inlinePaintImages.textFallbacks} 处恢复文字`);
  if (stats.orderedListImages?.textFallbacks > 0) fallbacks.push(`列表编号 ${stats.orderedListImages.textFallbacks} 处恢复文字`);
  if (stats.themeImages.omitted > 0) {
    fallbacks.push(`主题装饰 ${stats.themeImages.omitted} 处省略`);
  }
  if (backgrounds?.removed > 0) {
    fallbacks.push(`背景 ${backgrounds.removed} 处移除`);
  }
  const reasons = Object.entries(stats.degradationReasons ?? {})
    .filter(([, count]) => count > 0)
    .map(([code, count]) => `${DEGRADATION_REASON_LABELS[code] ?? code} ${count} 处`);
  return `已复制：${parts.join('，')}。${
    fallbacks.length > 0 ? `降级：${fallbacks.join('，')}。` : ''
  }${reasons.length > 0 ? `原因：${reasons.join('、')}。` : ''}`;
}

/**
 * 写入同时带 text/html 与纯文本的富文本剪贴板。
 * 本地图片默认转成 data URL；容量越界或读取失败时按语义降级。
 * 整篇 HTML 的遍历次数为常数，不随资源数增长。
 */
export async function copyRenderedArticle({
  html,
  text,
  images,
  resolveFile,
  readBinary,
  transformImage,
  embedImages = false,
  maxImageBytes = DEFAULT_IMAGE_EMBED_LIMIT,
  maxSingleImageBytes = DEFAULT_SINGLE_IMAGE_LIMIT,
  maxSourceImageBytes = DEFAULT_SOURCE_IMAGE_LIMIT,
  maxSourceTotalBytes = DEFAULT_SOURCE_TOTAL_LIMIT,
  maxHtmlBytes = DEFAULT_CLIPBOARD_HTML_LIMIT,
  maxProcessedResources = DEFAULT_MAX_PROCESSED_RESOURCES,
  _clipboard,
}) {
  if (!_clipboard?.write) throw new Error('剪贴板适配器不可用');
  const inputHtml = String(html ?? '');
  const imageList = Array.isArray(images) ? images : [];
  const metadata = normalizedImageRecords(imageList);
  let fullHtmlScanCount = 0;
  const indexed = indexWechatImageReferences(inputHtml, {
    sources: metadata.keys(),
    tokenPrefix: COPY_TOKEN_PREFIX,
  });
  fullHtmlScanCount += 1;
  const resources = new Map([...metadata.entries()].map(([source, image]) => [source, {
    source,
    image,
    origin: normalizedOrigin(image),
    occurrences: [],
  }]));
  for (const occurrence of indexed.occurrences) {
    let resource = resources.get(occurrence.source);
    if (!resource) {
      const origin = occurrence.kind === 'img' ? 'article' : 'theme';
      const image = {
        target: occurrence.source,
        url: occurrence.source,
        origin,
      };
      resource = { source: occurrence.source, image, origin, occurrences: [] };
      resources.set(occurrence.source, resource);
    }
    resource.occurrences.push(occurrence);
    occurrence.resource = resource;
  }

  const stats = createCopyStats(maxHtmlBytes);
  stats.resources.uniqueSeen = resources.size;
  const warnings = [];
  const staleResources = [...resources.values()]
    .filter((resource) => resource.occurrences.length === 0)
    .sort((a, b) => a.source.localeCompare(b.source));
  stats.resources.stale = staleResources.length;
  for (const resource of staleResources) {
    warnings.push(`${resource.image.target}：未找到可替换的图片位置`);
  }

  const occurrenceByToken = new Map(indexed.occurrences.map((occurrence) => [
    occurrence.token,
    occurrence,
  ]));
  imageTagMetadata(indexed.html, occurrenceByToken);
  fullHtmlScanCount += 1;

  let articleNumber = 0;
  for (const occurrence of indexed.occurrences) {
    if (occurrence.kind === 'background') {
      stats.themeBackgrounds.total += 1;
      if (occurrence.resource.image.wechatUrl) stats.remoteBackgrounds.total += 1;
      continue;
    }
    if (!occurrence.serializedTag) {
      throw new Error('图片索引校验失败，未写入剪贴板');
    }
    if (occurrence.resource.origin === 'generated') {
      if (occurrence.resource.image.generatedKind === 'inline-paint') {
        stats.inlinePaintImages ??= {total:0,embedded:0,textFallbacks:0};
        stats.inlinePaintImages.total+=1;
      } else if (occurrence.resource.image.generatedKind === 'quote') {
        stats.quoteImages ??= { total: 0, embedded: 0, textFallbacks: 0 };
        stats.quoteImages.total += 1;
      } else if (occurrence.resource.image.generatedKind === 'ordered-list') {
        stats.orderedListImages ??= { total: 0, embedded: 0, textFallbacks: 0 };
        stats.orderedListImages.total += 1;
      } else stats.headingImages.total += 1;
    } else if (occurrence.resource.origin === 'theme') {
      stats.themeImages.total += 1;
    } else {
      articleNumber += 1;
      occurrence.articleNumber = articleNumber;
      stats.articleImages.total += 1;
    }
    occurrence.fallbackReplacement = fallbackForOccurrence(
      occurrence.resource,
      occurrence,
    );
    occurrence.decision = {
      kind: 'fallback',
      replacement: occurrence.fallbackReplacement,
    };
  }
  for (const occurrence of indexed.occurrences) {
    if (occurrence.kind !== 'background') continue;
    occurrence.fallbackReplacement = null;
    occurrence.decision = { kind: 'fallback', replacement: null };
  }

  const serializeDecisions = () => {
    const withImages = transformImageTags(indexed.html, (tag, source) => {
      const occurrence = occurrenceByToken.get(source);
      if (!occurrence || occurrence.kind !== 'img') return tag;
      if (occurrence.decision?.kind === 'embedded' || occurrence.decision?.kind === 'remote') {
        return tag.replace(
          QUOTED_SRC_ATTRIBUTE,
          (_whole, leading, attribute, quote) =>
            `${leading}${attribute}${quote}${escapeAttr(occurrence.decision.replacement)}${quote}`,
        );
      }
      return occurrence.decision?.replacement ?? '';
    });
    fullHtmlScanCount += 1;
    const backgroundReplacements = new Map(indexed.occurrences
      .filter((occurrence) => occurrence.kind === 'background')
      .map((occurrence) => [
        occurrence.token,
        occurrence.decision?.replacement ?? null,
      ]));
    const backgroundResult = rewriteWechatBackgroundImageTokens(
      withImages,
      backgroundReplacements,
    );
    fullHtmlScanCount += 1;
    const tokenAudit = auditWechatImageReferences(backgroundResult.html, {
      tokenPrefix: COPY_TOKEN_PREFIX,
    });
    if (tokenAudit.tokenCount > 0) {
      throw new Error(`背景图令牌校验失败：剩余 ${tokenAudit.tokenCount} 处；未写入剪贴板`);
    }
    return backgroundResult.html;
  };

  // 先把所有资源降级到安全形态，这才是不可再缩减的初始 HTML 基线。
  // 原始 render.html 可能含多张 H1 Data URL，不能在令牌化前误判为整篇越界。
  const baselineHtml = serializeDecisions();
  let projectedHtmlBytes = byteLength(baselineHtml);
  if (projectedHtmlBytes > maxHtmlBytes) {
    throw new Error('文章基础 HTML 已超过剪贴板安全上限，未写入剪贴板');
  }

  let committedImageBytes = 0;
  let sourceBytesRead = 0;
  let totalBytes = 0;
  const committedLocalSources = new Set();

  const describeFallback = (resource, occurrences) => {
    let articleFallbacks = 0;
    let headingFallbacks = 0;
    let quoteFallbacks = 0;
    let orderedListFallbacks = 0;
    let themeFallbacks = 0;
    let backgroundFallbacks = 0;
    for (const occurrence of occurrences) {
      if (occurrence.kind === 'background') backgroundFallbacks += 1;
      else if (resource.origin === 'generated') {
        if (resource.image.generatedKind === 'quote') quoteFallbacks += 1;
        else if (resource.image.generatedKind === 'ordered-list') orderedListFallbacks += 1;
        else headingFallbacks += 1;
      }
      else if (resource.origin === 'theme') themeFallbacks += 1;
      else articleFallbacks += 1;
    }
    const outcomes = [];
    if (articleFallbacks > 0) outcomes.push(`${articleFallbacks} 处正文图位已保留`);
    if (headingFallbacks > 0) outcomes.push(`${headingFallbacks} 处标题已恢复活文字`);
    if (quoteFallbacks > 0) outcomes.push(`${quoteFallbacks} 处金句已恢复活文字`);
    if (orderedListFallbacks > 0) outcomes.push(`${orderedListFallbacks} 处列表编号已恢复文字`);
    if (themeFallbacks > 0) outcomes.push(`${themeFallbacks} 处主题装饰已省略`);
    if (backgroundFallbacks > 0) outcomes.push(`${backgroundFallbacks} 处背景图已移除`);
    return outcomes.join('；');
  };

  const recordDegradation = (reasonCode, occurrences) => {
    const code = Object.hasOwn(stats.degradationReasons, reasonCode)
      ? reasonCode
      : 'processingError';
    for (const occurrence of occurrences) {
      occurrence.degradationReasonCodes ??= new Set();
      if (occurrence.degradationReasonCodes.has(code)) continue;
      occurrence.degradationReasonCodes.add(code);
      stats.degradationReasons[code] += 1;
    }
  };

  const warnFallback = (resource, reasonCode, reason, occurrences) => {
    recordDegradation(reasonCode, occurrences);
    const outcome = describeFallback(resource, occurrences);
    if (outcome) warnings.push(`${resource.image.target}：${reason}；${outcome}`);
  };

  const activeResources = [...resources.values()]
    .filter((resource) => resource.occurrences.length > 0)
    .sort((a, b) => {
      const byPriority = ORIGIN_PRIORITY[a.origin] - ORIGIN_PRIORITY[b.origin];
      if (byPriority !== 0) return byPriority;
      const byOccurrence = Math.min(...a.occurrences.map((item) => item.order))
        - Math.min(...b.occurrences.map((item) => item.order));
      return byOccurrence || a.source.localeCompare(b.source);
    });

  // 远程背景只先校验地址，最后才在正文、标题和主题 img 之后尝试交付。
  for (const resource of activeResources) {
    const backgroundOccurrences = resource.occurrences.filter((occurrence) =>
      occurrence.kind === 'background');
    if (backgroundOccurrences.length === 0 || !resource.image.wechatUrl) continue;
    if (!embedImages) continue;

    let deliveryUrl = '';
    try {
      deliveryUrl = normalizeWechatAssetUrl(
        resource.image.wechatUrl,
        `${resource.image.target}.wechat_url`,
      );
    } catch (error) {
      warnings.push(
        `${resource.image.target}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!deliveryUrl) continue;
    for (const occurrence of backgroundOccurrences) {
      occurrence.backgroundCandidate = { kind: 'remote', replacement: deliveryUrl };
    }
  }

  const localResources = activeResources.filter((resource) => {
    // 仅显式选择微信地址的主题 img 才跳过本地读取；正文和动态标题不受影响。
    if (embedImages && resource.origin === 'theme' && resource.image.preferWechatUrl === true
      && resource.occurrences.some((occurrence) => occurrence.kind === 'img')) {
      try {
        resource.remoteImageUrl = normalizeWechatAssetUrl(
          resource.image.wechatUrl,
          `${resource.image.target}.wechat_url`,
        );
      } catch (error) {
        warnings.push(`${resource.image.target}：${error instanceof Error ? error.message : String(error)}；已改用本地图片内嵌`);
      }
    }
    if (!resource.remoteImageUrl
      && resource.occurrences.some((occurrence) => occurrence.kind === 'img')) return true;
    return resource.occurrences.some((occurrence) =>
      occurrence.kind === 'background' && !occurrence.backgroundCandidate);
  });
  if (embedImages && localResources.length > maxProcessedResources) {
    const error = new Error(
      `异常资源过多（${localResources.length} 项），请检查文章，未写入剪贴板`,
    );
    error.code = 'COPY_RESOURCE_SAFETY_LIMIT';
    throw error;
  }

  const localResourceSet = new Set(localResources);
  for (const resource of activeResources) {
    if (!embedImages) continue;
    if (resource.remoteImageUrl) {
      const imageOccurrences = resource.occurrences.filter((occurrence) => occurrence.kind === 'img');
      const escapedUrl = escapeAttr(resource.remoteImageUrl);
      const growth = imageOccurrences.reduce((sum, occurrence) => {
        const remoteTag = occurrence.serializedTag.replace(
          QUOTED_SRC_ATTRIBUTE,
          (_whole, leading, attribute, quote) => `${leading}${attribute}${quote}${escapedUrl}${quote}`,
        );
        return sum + byteLength(remoteTag) - byteLength(occurrence.fallbackReplacement);
      }, 0);
      if (projectedHtmlBytes + growth > maxHtmlBytes) {
        warnFallback(resource, 'htmlLimit', '微信图片地址交付后会超过 HTML 上限', imageOccurrences);
      } else {
        for (const occurrence of imageOccurrences) {
          occurrence.decision = { kind: 'remote', replacement: resource.remoteImageUrl };
        }
        projectedHtmlBytes += growth;
      }
    }
    if (!localResourceSet.has(resource)) continue;
    stats.resources.localProcessed += 1;
    const localOccurrences = resource.occurrences.filter((occurrence) =>
      (occurrence.kind === 'img' && !resource.remoteImageUrl)
      || (occurrence.kind === 'background' && !occurrence.backgroundCandidate));
    const generatedBytes = resource.image.bytes ? Buffer.from(resource.image.bytes) : null;
    let file = null;
    if (!generatedBytes) {
      try {
        file = resolveFile(resource.image.filePath ?? resource.image.target, resource.image);
      } catch (error) {
        warnFallback(
          resource,
          'resolveError',
          `解析图片失败：${error instanceof Error ? error.message : String(error)}`,
          localOccurrences,
        );
        continue;
      }
      if (!file) {
        warnFallback(resource, 'missingImage', '找不到图片', localOccurrences);
        continue;
      }
    }

    const declaredSize = generatedBytes?.byteLength ?? Number(file?.stat?.size ?? 0);
    totalBytes += Number.isFinite(declaredSize) ? Math.max(0, declaredSize) : 0;
    if (declaredSize > maxSourceImageBytes) {
      warnFallback(
        resource,
        'sourceImageLimit',
        '原图超过单图读取上限',
        localOccurrences,
      );
      continue;
    }
    if (sourceBytesRead + declaredSize > maxSourceTotalBytes) {
      warnFallback(
        resource,
        'sourceTotalLimit',
        '原图累计超过本次读取上限',
        localOccurrences,
      );
      continue;
    }
    if (!generatedBytes && !transformImage
      && committedImageBytes + declaredSize > maxImageBytes) {
      warnFallback(
        resource,
        'totalImageLimit',
        '超过本次剪贴板图片总量上限',
        localOccurrences,
      );
      continue;
    }

    try {
      const sourceBytes = generatedBytes ?? Buffer.from(await readBinary(file));
      const actualSourceSize = sourceBytes.byteLength;
      if (actualSourceSize > maxSourceImageBytes) {
        warnFallback(
          resource,
          'sourceImageLimit',
          '原图超过单图读取上限',
          localOccurrences,
        );
        continue;
      }
      if (sourceBytesRead + actualSourceSize > maxSourceTotalBytes) {
        warnFallback(
          resource,
          'sourceTotalLimit',
          '原图累计超过本次读取上限',
          localOccurrences,
        );
        continue;
      }
      sourceBytesRead += actualSourceSize;

      // H1 字节已由标题渲染运行时验证，直接复用，避免 Electron 重复解码再编码。
      const filename = resource.image.filePath ?? resource.image.target;
      const transformed = generatedBytes
        ? {
            bytes: sourceBytes,
            mimeType: resource.image.mimeType || imageMimeType(filename),
          }
        : transformImage
          ? await transformImage(sourceBytes, file, imageMimeType(filename), resource.image)
          : {
              bytes: sourceBytes,
              mimeType: resource.image.mimeType || imageMimeType(filename),
            };
      const imageBytes = Buffer.from(transformed.bytes);
      if (imageBytes.byteLength > maxSingleImageBytes) {
        warnFallback(
          resource,
          'singleImageLimit',
          '处理后仍超过单图上限',
          localOccurrences,
        );
        continue;
      }
      const dataUrl = `data:${transformed.mimeType};base64,${imageBytes.toString('base64')}`;
      resource.processedImageBytes = imageBytes.byteLength;
      resource.dataUrl = dataUrl;

      const imageOccurrences = resource.occurrences.filter((occurrence) =>
        occurrence.kind === 'img' && !resource.remoteImageUrl);
      if (imageOccurrences.length > 0) {
        if (committedImageBytes + imageBytes.byteLength > maxImageBytes) {
          warnFallback(
            resource,
            'totalImageLimit',
            '超过本次剪贴板图片总量上限',
            imageOccurrences,
          );
        } else {
          const growth = imageOccurrences.reduce((sum, occurrence) => {
            const embeddedTag = occurrence.serializedTag.replace(
              QUOTED_SRC_ATTRIBUTE,
              (_whole, leading, attribute, quote) =>
                `${leading}${attribute}${quote}${dataUrl}${quote}`,
            );
            return sum + byteLength(embeddedTag) - byteLength(occurrence.fallbackReplacement);
          }, 0);
          if (projectedHtmlBytes + growth > maxHtmlBytes) {
            warnFallback(
              resource,
              'htmlLimit',
              '内嵌后会超过 HTML 上限',
              imageOccurrences,
            );
          } else {
            for (const occurrence of imageOccurrences) {
              occurrence.decision = { kind: 'embedded', replacement: dataUrl };
            }
            projectedHtmlBytes += growth;
            committedImageBytes += imageBytes.byteLength;
            committedLocalSources.add(resource.source);
          }
        }
      }

      for (const occurrence of resource.occurrences) {
        if (occurrence.kind === 'background' && !occurrence.backgroundCandidate) {
          occurrence.backgroundCandidate = { kind: 'embedded', replacement: dataUrl };
        }
      }
    } catch (error) {
      warnFallback(
        resource,
        'processingError',
        error instanceof Error ? error.message : String(error),
        localOccurrences,
      );
    }
  }

  // 正文、标题、装饰之后先交付合法远程背景，再按唯一资源尝试本地背景。
  // 使用短令牌阶段的精确样式开销预算，超出资源单独回退，不先拼出巨型 HTML。
  let reservedBackgroundBytes = committedImageBytes;
  for (const kind of ['remote', 'embedded']) {
    for (const resource of activeResources) {
      const candidates = resource.occurrences.filter((occurrence) =>
        occurrence.kind === 'background' && occurrence.backgroundCandidate?.kind === kind);
      if (candidates.length === 0) continue;
      const binaryGrowth = kind === 'embedded' && !committedLocalSources.has(resource.source)
        ? resource.processedImageBytes ?? 0 : 0;
      if (reservedBackgroundBytes + binaryGrowth > maxImageBytes) {
        warnFallback(resource, 'totalImageLimit', '超过本次剪贴板图片总量上限', candidates);
        continue;
      }
      const growth = candidates.reduce((sum, occurrence) => {
        if (!Number.isFinite(occurrence.backgroundFixedGrowth)) {
          throw new Error('背景图体积索引缺失，未写入剪贴板');
        }
        return sum + occurrence.backgroundFixedGrowth
          + escapedCssUrlBytes(occurrence.backgroundCandidate.replacement);
      }, 0);
      if (projectedHtmlBytes + growth > maxHtmlBytes) {
        warnFallback(resource, 'htmlLimit', '背景图交付后会超过 HTML 上限', candidates);
        continue;
      }
      for (const occurrence of candidates) occurrence.decision = occurrence.backgroundCandidate;
      projectedHtmlBytes += growth;
      reservedBackgroundBytes += binaryGrowth;
      if (kind === 'embedded') committedLocalSources.add(resource.source);
    }
  }
  const output = serializeDecisions();

  const audit = auditWechatImageReferences(output, { tokenPrefix: COPY_TOKEN_PREFIX });
  fullHtmlScanCount += 1;
  if (audit.localCount > 0 || audit.tokenCount > 0) {
    throw new Error('复制结果仍含本地图片地址，未写入剪贴板');
  }
  const finalHtmlBytes = byteLength(output);
  if (finalHtmlBytes > maxHtmlBytes) {
    throw new Error('复制结果超过剪贴板 HTML 安全上限，未写入剪贴板');
  }

  const deliveredResources = new Set();
  const locallyDeliveredResources = new Set();
  for (const occurrence of indexed.occurrences) {
    if (occurrence.kind === 'img') {
      updateImageStats(
        stats,
        occurrence.resource,
        occurrence.decision.kind,
      );
    } else {
      if (occurrence.decision.kind === 'remote') {
        stats.themeBackgrounds.delivered += 1;
        stats.themeBackgrounds.remote += 1;
      } else if (occurrence.decision.kind === 'embedded') {
        stats.themeBackgrounds.delivered += 1;
        stats.themeBackgrounds.embedded += 1;
      } else {
        stats.themeBackgrounds.removed += 1;
      }
      if (occurrence.resource.image.wechatUrl) {
        if (occurrence.decision.kind === 'remote') {
          stats.remoteBackgrounds.delivered += 1;
        } else if (occurrence.decision.kind === 'fallback') {
          stats.remoteBackgrounds.removed += 1;
        }
      }
    }
    if (occurrence.decision.kind === 'embedded' || occurrence.decision.kind === 'remote') {
      deliveredResources.add(occurrence.source);
    }
    if (occurrence.decision.kind === 'embedded') {
      locallyDeliveredResources.add(occurrence.source);
    }
  }
  const embeddedBytes = [...locallyDeliveredResources].reduce(
    (sum, source) => sum + (resources.get(source)?.processedImageBytes ?? 0),
    0,
  );
  stats.limits.htmlBytes = finalHtmlBytes;
  stats.limits.embeddedBytes = embeddedBytes;
  _clipboard.write({ html: output, text });
  const embeddedCount = deliveredResources.size;
  const remoteBackgroundCount = new Set(indexed.occurrences
    .filter((occurrence) => occurrence.kind === 'background'
      && occurrence.decision?.kind === 'remote')
    .map((occurrence) => occurrence.source)).size;
  return {
    html: output,
    imageCount: imageList.length,
    embeddedCount,
    embeddedBytes,
    sourceBytesRead,
    totalBytes,
    remoteBackgroundCount,
    warnings,
    stats,
    _metrics: {
      fullHtmlScanCount,
      finalSerializationPasses: fullHtmlScanCount - 3,
      referenceIndexPasses: 1,
    },
    mode:
      embeddedCount === imageList.length && imageList.length > 0
        ? 'embedded'
        : embeddedCount > 0
          ? 'mixed'
          : 'placeholders',
  };
}
