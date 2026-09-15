import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isConfiguredThemePath,
  isConfiguredThemeResourcePath,
  isPreviewableMarkdownDocument,
  isThemeDocument,
} from '../plugin/document-role.mjs';

const layoutFolder = '06｜个人账号运营/2. 排版配图';
const themeFolder = `${layoutFolder}/5. 图文主题仓库`;
const file = (path, extension = 'md') => ({ path, extension });

test('正文排版原则目录里的 Markdown 可以预览', () => {
  const guide = file(`${layoutFolder}/1. 正文排版原则/1. 文章排版技巧.md`);

  assert.equal(isThemeDocument(guide, themeFolder), false);
  assert.equal(isPreviewableMarkdownDocument(guide, themeFolder), true);
});

test('主题目录直属的任意 Markdown 都被识别为主题', () => {
  const withoutStyleSuffix = file(`${themeFolder}/3. 经典蓝调.md`);
  const withStyleSuffix = file(`${themeFolder}/4. 粘土卡通风格.md`);

  assert.equal(isThemeDocument(withoutStyleSuffix, themeFolder), true);
  assert.equal(isPreviewableMarkdownDocument(withoutStyleSuffix, themeFolder), false);
  assert.equal(isThemeDocument(withStyleSuffix, themeFolder), true);
  assert.equal(isPreviewableMarkdownDocument(withStyleSuffix, themeFolder), false);
});

test('主题目录外即使同名或以风格结尾也仍可预览', () => {
  const sameNameOutsideFolder = file(`其他目录/3. 经典蓝调风格.md`);

  assert.equal(isThemeDocument(sameNameOutsideFolder, themeFolder), false);
  assert.equal(isPreviewableMarkdownDocument(sameNameOutsideFolder, themeFolder), true);
});

test('v3 主题包里的 Markdown 属于主题资料，不会误当文章预览', () => {
  const nested = file(`${themeFolder}/1. 纪念碑谷/主题视觉规范/1. 视觉风格总则.md`);

  assert.equal(isThemeDocument(nested, themeFolder), true);
  assert.equal(isPreviewableMarkdownDocument(nested, themeFolder), false);
});

test('非 Markdown 文件不可预览', () => {
  assert.equal(
    isPreviewableMarkdownDocument(file(`${themeFolder}/图片.png`, 'png'), themeFolder),
    false,
  );
});

test('旧路径判断将主题目录直属 Markdown 视为主题变更', () => {
  assert.equal(isConfiguredThemePath(`${themeFolder}/2. 微信读书风格.md`, themeFolder), true);
  assert.equal(isConfiguredThemePath(`${themeFolder}/自定义模板.md`, themeFolder), true);
  assert.equal(isConfiguredThemePath(`${layoutFolder}/1. 正文排版原则/1. 文章排版技巧.md`, themeFolder), false);
});

test('主题资源监听覆盖 v3 CSS、组件、素材和目录本身，并守住目录边界', () => {
  assert.equal(
    isConfiguredThemeResourcePath(`${themeFolder}/1. 纪念碑谷/theme.css`, themeFolder),
    true,
  );
  assert.equal(
    isConfiguredThemeResourcePath(`${themeFolder}/1. 纪念碑谷/透明装饰素材/角花.png`, themeFolder),
    true,
  );
  assert.equal(
    isConfiguredThemeResourcePath(`${themeFolder}/1. 纪念碑谷`, themeFolder),
    true,
  );
  assert.equal(
    isConfiguredThemeResourcePath(`${themeFolder}-备份/1. 纪念碑谷/theme.css`, themeFolder),
    false,
  );
});
