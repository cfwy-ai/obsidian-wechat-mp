// 预览与推送共用的文章管线入口。
//
// 当前管线：frontmatter → wikilink → Markdown → HTML 净化
// → CSS 内联 → 微信粘贴兼容过滤 → 嵌套列表适配 → 可选深色保护。
// 预览与剪贴板必须消费同一份最终 HTML，不能在界面层另做美化。

import { inlineCss } from './inline.mjs';
import { materializeGalleryCallouts } from './gallery.mjs';
import { MARKDOWN_BASE_CSS, renderMarkdown, splitFrontmatter } from './markdown.mjs';
import { sanitizeRenderedHtml } from './sanitize.mjs';
import { applyThemeComponents, materializeThemeCss } from './theme-package.mjs';
import { convertEmbeds } from './wikilink.mjs';
import { filterWechatCompatibleHtml } from './wechat-compat.mjs';
import { resolveArticleHeader } from './article-header.mjs';
import { resolveArticleFooter } from './article-footer.mjs';
import { materializeEmptyTaskMarkers } from './task-markers.mjs';
import { applyWechatDarkMode } from './dark-mode.mjs';
import { materializeNestedLists, preserveOrderedListImageSemantics } from './nested-lists.mjs';
import { materializeTableSurfaces } from './table-surfaces.mjs';
import { materializeIllustratedSurfaces } from './illustrated-surfaces.mjs';
import { planReferenceComposition, applyReferenceComposition, scaleReferenceCss, referenceSceneOverlapPolicy, scaleReferenceOrderedListRule } from './reference-composition.mjs';

/**
 * 展开 Obsidian 中只用于布局的 blank|gallery callout。
 *
 * 这个标记不是文章内容；直接交给 marked 会把 `[!blank|gallery]`
 * 当正文打出来，还会让封图误套用引用块样式。
 * 只处理这一种已知布局指令，普通 blockquote 与其他 callout 不改。
 */
export function unwrapGalleryCallouts(markdown) {
  return materializeGalleryCallouts(markdown, () => null).markdown;
}

/**
 * 把一篇 Obsidian 文章渲染为已内联样式的 HTML。
 *
 * 这是预览面板和之后推送草稿的共用入口。
 * 微信兼容层和 lint 完成后也应接在本函数内，不在插件外壳里另写一份。
 *
 * @param {{
 *   source: string,
 *   themeCss: string,
 *   resolve: (target: string) => string | {url: string, filePath?: string, width?: number, height?: number} | null,
 *   themeComponents?: Array<object>,
 *   themeAssets?: Array<object>,
 *   themeHeader?: object|null,
 *   themeDarkMode?: object|null,
 *   headerSelection?: {enabled?: boolean, preset?: string, custom_image?: string}|null
 * }} input
 * @returns {{
 *   html: string,
 *   frontmatter: string,
 *   images: Array<{target: string, url: string, origin: 'article'|'theme', filePath: string | null}>,
 *   inlineLevel: 'full'|'no-pseudo'|'no-font'|'none',
 *   warnings: string[],
 *   stage: 'wechat-compatible'
 * }}
 */
export function renderArticle({
  source,
  themeCss,
  resolve,
  themeComponents = [],
  themeAssets = [],
  themeHeader = null,
  themeDarkMode = null,
  orderedListImages = null,
  referenceComposition = null,
  layoutWidth,
  headerSelection,
  footerSelection,
}) {
  if (typeof source !== 'string') throw new TypeError('文章原文必须是字符串');
  if (typeof themeCss !== 'string') throw new TypeError('主题 CSS 必须是字符串');
  if (typeof resolve !== 'function') throw new TypeError('图片解析器必须是函数');

  const { frontmatter, body } = splitFrontmatter(source);
  const resolved = new Map();
  const resolveOnce = (target) => {
    if (!resolved.has(target)) resolved.set(target, resolve(target));
    return resolved.get(target);
  };
  const galleries = materializeGalleryCallouts(body, resolveOnce);
  const converted = convertEmbeds(galleries.markdown, resolveOnce);
  const rendered = renderMarkdown(converted.markdown);
  const header = resolveArticleHeader({
    definition: themeHeader, selection: headerSelection, components: themeComponents,
    assets: themeAssets, resolveCustom: resolveOnce,
  });
  // 尾图在头图之后处理：头图可能改写组件，这里只按插槽决定留不留。
  const footer = resolveArticleFooter({ selection: footerSelection, components: header.components });
  const compositionPlan = planReferenceComposition(rendered, referenceComposition);
  const themed = applyThemeComponents(compositionPlan.html, footer.components, header.assets);
  const safe = sanitizeRenderedHtml(preserveOrderedListImageSemantics(
    applyReferenceComposition(themed.html, compositionPlan), orderedListImages,
  ));
  const themeStyles = materializeThemeCss(themeCss, header.assets);
  const stylesheet = [MARKDOWN_BASE_CSS, themeStyles.css, galleries.css].filter(Boolean).join('\n');
  const inlined = inlineCss(safe, scaleReferenceCss(stylesheet, referenceComposition, layoutWidth));
  const galleryFallback = inlined.level === 'none' && galleries.css
    ? inlineCss(safe, galleries.css)
    : { html: inlined.html, warnings: [] };
  const compatible = filterWechatCompatibleHtml(materializeEmptyTaskMarkers(galleryFallback.html), {
    allowedBackgroundUrls: themeStyles.images.map((image) => image.url),
    referenceSceneOverlaps: referenceSceneOverlapPolicy(galleryFallback.html, compositionPlan, referenceComposition, layoutWidth),
  });
  const nestedLists = materializeNestedLists(compatible.html, { orderedListImages: scaleReferenceOrderedListRule(orderedListImages, referenceComposition, layoutWidth) });
  // 配置专用的表格框素材不必在 theme.css 里制造一个假的背景引用。
  // 它们先进入受管候选池，实际未被输出结构使用的素材不会进入图片清单。
  const frameAssetIds = new Set([
    themeDarkMode?.tableFrame?.borderAssetId,
    themeDarkMode?.tableFrame?.surfaceAssetId,
  ].filter(id => typeof id === 'string'));
  const policyAssets = header.assets
    .filter(asset => frameAssetIds.has(asset.id) && asset.origin !== 'article')
    .map(asset => ({
      target: asset.id,
      url: asset.url,
      origin: 'theme',
      filePath: asset.filePath,
      ...(asset.wechatUrl ? { wechatUrl: asset.wechatUrl } : {}),
    }));
  const managedBackgroundImages = [...themeStyles.images, ...policyAssets];
  const tableSurfaces = materializeTableSurfaces(nestedLists.html, {
    policy: themeDarkMode,
    backgroundImages: managedBackgroundImages,
  });
  const illustrated = materializeIllustratedSurfaces(tableSurfaces.html, {
    policy: themeDarkMode,
    backgroundImages: managedBackgroundImages,
  });
  const darkMode = applyWechatDarkMode(illustrated.html, {
    policy: themeDarkMode,
    backgroundImages: managedBackgroundImages,
  });
  const backgroundImageUrls = darkMode.backgroundImageUrls ?? illustrated.backgroundImageUrls ?? compatible.backgroundImageUrls;
  const usedBackgroundUrls = new Set(backgroundImageUrls);
  const backgroundImages = managedBackgroundImages.filter((image) =>
    usedBackgroundUrls.has(image.url));
  const images = [];
  const seenImages = new Map();
  for (const image of [...converted.images, ...themed.images, ...illustrated.images, ...darkMode.images, ...backgroundImages]) {
    const key = image.filePath || image.url;
    if (!key) continue;
    if (seenImages.has(key)) {
      const existing = seenImages.get(key);
      if (existing.origin === 'theme' && image.preferWechatUrl) existing.preferWechatUrl = true;
      continue;
    }
    const record = { ...image };
    seenImages.set(key, record);
    images.push(record);
  }

  return {
    html: darkMode.html,
    frontmatter,
    images,
    inlineLevel: inlined.level,
    warnings: [
      ...galleries.warnings,
      ...converted.warnings,
      ...header.warnings,
      ...footer.warnings,
      ...themed.warnings,
      ...themeStyles.warnings,
      ...inlined.warnings,
      ...galleryFallback.warnings,
      ...compatible.warnings,
      ...nestedLists.warnings,
      ...tableSurfaces.warnings,
      ...illustrated.warnings,
      ...darkMode.warnings,
    ],
    compatibility: {
      removedStyleCount: compatible.removedCount,
      normalizedColorCount: compatible.normalizedColorCount,
      backgroundImageUrls,
      ...(nestedLists.listCount ? {
        nestedLists: { listCount:nestedLists.listCount, itemCount:nestedLists.itemCount, maxDepth:nestedLists.maxDepth },
      } : {}),
    },
    stage: 'wechat-compatible',
    ...(referenceComposition ? { referenceResolvedImages: [...resolved].map(([target, result]) => [target, result && typeof result === 'object' ? { ...result } : result]) } : {}),
  };
}
