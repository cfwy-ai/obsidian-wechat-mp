// 用 live Vault 的全部文章与已登记主题做真实组合回归。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderArticle } from '../src/pipeline.mjs';
import { listThemes } from '../src/theme.mjs';
import { extractWechatStyleAttributes } from '../src/wechat-compat.mjs';
import { createFilesystemImageResolver } from './filesystem-image-resolver.mjs';

const VAULT = process.env.WECHAT_MP_VAULT;
if (!VAULT) throw new Error('请通过 WECHAT_MP_VAULT 指定开发者测试库');
const firstExisting = (paths) => paths.find(existsSync) ?? paths[0];
const ARTICLE_DIR = firstExisting([
  join(VAULT, '06｜个人账号运营/3. 原创文章'),
  join(VAULT, '06｜个人账号运营/4. 原创文章'),
]);
const ATTACHMENT_DIR = join(VAULT, '00｜本库附件');
const THEME_DIR = firstExisting([
  join(VAULT, '06｜个人账号运营/2. 排版配图/5. 图文主题仓库'),
  join(VAULT, '06｜个人账号运营/3. 正文排版/模板仓库'),
  join(VAULT, '06｜个人账号运营/3. 正文排版'),
]);
const resolveImage = createFilesystemImageResolver(ATTACHMENT_DIR);
const UNSTABLE_OUTPUT = /box-shadow|linear-gradient|radial-gradient|(?:^|;)\s*position\s*:|(?:^|;)\s*transform\s*:|display\s*:\s*(?:flex|grid)|var\(|calc\(/gi;

const articles = readdirSync(ARTICLE_DIR)
  .filter((name) => name.endsWith('.md'))
  .sort();
const { themes, problems: themeProblems } = listThemes(THEME_DIR);
const failures = [];

for (const article of articles) {
  const source = readFileSync(join(ARTICLE_DIR, article), 'utf8');
  for (const theme of themes) {
    const result = renderArticle({
      source,
      themeCss: theme.css,
      themeComponents: theme.components,
      themeAssets: theme.assets,
      themeDarkMode: theme.wechatDarkMode,
      resolve: resolveImage,
    });
    const reasons = [];
    if (result.inlineLevel !== 'full') reasons.push(`内联档位=${result.inlineLevel}`);
    if (!/^<section id="nice"/.test(result.html)) reasons.push('根容器不是 section#nice');
    if (result.compatibility.removedStyleCount !== 0) {
      reasons.push(`兼容层移除 ${result.compatibility.removedStyleCount} 处样式`);
    }
    const inlineStyles = extractWechatStyleAttributes(result.html).join(';');
    const unstableCount = (inlineStyles.match(UNSTABLE_OUTPUT) ?? []).length;
    if (unstableCount > 0) reasons.push(`仍有 ${unstableCount} 处不稳定样式`);
    const managedThemeAssetUrls = new Set(theme.assets.map((asset) => asset.url));
    const unmanagedBackgrounds = result.compatibility.backgroundImageUrls.filter((url) =>
      !managedThemeAssetUrls.has(url));
    if (unmanagedBackgrounds.length > 0) {
      reasons.push(`仍有 ${unmanagedBackgrounds.length} 处未受管背景图片`);
    }
    const renderedImageKeys = result.images.map((image) => image.filePath || image.url);
    if (new Set(renderedImageKeys).size !== renderedImageKeys.length) {
      reasons.push('渲染图片清单存在重复资源');
    }
    if (result.warnings.length > 0) reasons.push(result.warnings.join('；'));
    if (reasons.length > 0) failures.push({ article, theme: theme.name, reasons });
  }
}

const summary = {
  articles: articles.length,
  themes: themes.length,
  renders: articles.length * themes.length,
  themeProblems,
  failures,
};

console.log(JSON.stringify(summary, null, 2));
if (themeProblems.length > 0 || failures.length > 0) process.exitCode = 1;
