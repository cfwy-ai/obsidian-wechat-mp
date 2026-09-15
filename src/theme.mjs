// 主题正本在 Obsidian 配置的「图文主题仓库」目录里，本模块只负责读出来。
// 不缓存、不改写、不在别处留副本 —— 单一真相源见 3. 架构.md。

import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import {
  themeFontByteLimit,
  parseThemeManifest,
  THEME_PACKAGE_DIRECTORIES,
  THEME_PACKAGE_FILES,
  THEME_VISUAL_SPEC_FILES,
  themePackageFilePath,
} from './theme-package.mjs';

// 主题身份由「是否位于配置目录」决定，文件名不再承担语义。
const MARKDOWN_SUFFIX = /\.md$/i;
const NUMBER_PREFIX = /^(\d+)\.\s*/;
const CSS_FENCE = /^[ \t]*```[ \t]*css[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/im;

export const isThemeFile = (filename) => MARKDOWN_SUFFIX.test(filename);

export const themeName = (filename) =>
  filename.replace(NUMBER_PREFIX, '').replace(/\.md$/i, '');

const orderOf = (filename) => {
  const m = NUMBER_PREFIX.exec(filename);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

const assertFilesystemPathInside = (root, filePath, label) => {
  if (!existsSync(filePath)) throw new Error(`缺少${label}`);
  const rootReal = realpathSync(root);
  const fileReal = realpathSync(filePath);
  const offset = relative(rootReal, fileReal);
  if (!offset || offset.startsWith('..') || isAbsolute(offset)) {
    if (fileReal === rootReal) throw new Error(`${label}不能指向主题包根目录`);
    throw new Error(`${label}不能越出主题包`);
  }
  if (!statSync(fileReal).isFile()) throw new Error(`${label}不是文件`);
  return fileReal;
};

const assertFilesystemDirectoryInside = (root, directoryPath, label) => {
  if (!existsSync(directoryPath)) throw new Error(`缺少${label}`);
  const rootReal = realpathSync(root);
  const directoryReal = realpathSync(directoryPath);
  const offset = relative(rootReal, directoryReal);
  if (!offset || offset.startsWith('..') || isAbsolute(offset)) {
    if (directoryReal === rootReal) throw new Error(`${label}不能指向主题包根目录`);
    throw new Error(`${label}不能越出主题包`);
  }
  if (!statSync(directoryReal).isDirectory()) throw new Error(`${label}不是目录`);
  return directoryReal;
};

const loadPackageTheme = (dir, directoryName) => {
  const packageDir = join(dir, directoryName);
  const manifestPath = join(packageDir, THEME_PACKAGE_FILES.manifest);
  const cssPath = join(packageDir, THEME_PACKAGE_FILES.css);
  const manifest = parseThemeManifest(
    readFileSync(assertFilesystemPathInside(packageDir, manifestPath, ' manifest.json'), 'utf8'),
    { directoryName },
  );
  const css = readFileSync(
    assertFilesystemPathInside(packageDir, cssPath, ' theme.css'),
    'utf8',
  );
  for (const dirname of Object.values(THEME_PACKAGE_DIRECTORIES)) {
    assertFilesystemDirectoryInside(packageDir, join(packageDir, dirname), ` ${dirname}`);
  }
  for (const filename of THEME_VISUAL_SPEC_FILES) {
    assertFilesystemPathInside(
      packageDir,
      join(packageDir, THEME_PACKAGE_DIRECTORIES.visualSpecs, filename),
      ` ${THEME_PACKAGE_DIRECTORIES.visualSpecs}/${filename}`,
    );
  }

  const problems = [];
  let previewImage = null;
  if (manifest.previewImage) {
    try {
      const logicalPath = themePackageFilePath(directoryName, manifest.previewImage, 'preview_image');
      const filePath = assertFilesystemPathInside(
        packageDir,
        join(dir, logicalPath),
        ' preview_image',
      );
      readFileSync(filePath);
      previewImage = {
        file: manifest.previewImage,
        filePath,
        url: `file://${encodeURI(filePath)}`,
      };
    } catch (error) {
      if (/不能越出主题包|不能指向主题包根目录/.test(
        error instanceof Error ? error.message : String(error),
      )) {
        throw error;
      }
      problems.push(
        `preview_image 不可用，已忽略：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const assets = [];
  for (const asset of manifest.assets) {
    try {
      const logicalPath = themePackageFilePath(directoryName, asset.file, `素材 ${asset.id}`);
      const filePath = assertFilesystemPathInside(
        packageDir,
        join(dir, logicalPath),
        `素材 ${asset.id}`,
      );
      readFileSync(filePath);
      assets.push({
        ...asset,
        filePath,
        url: `file://${encodeURI(filePath)}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/不能越出主题包|不能指向主题包根目录/.test(message)) throw error;
      problems.push(`素材 ${asset.id} 不可用，已忽略：${message}`);
    }
  }
  const fonts = [];
  for (const font of manifest.fonts) {
    try {
      const logicalPath = themePackageFilePath(directoryName, font.file, `字体 ${font.id}`);
      const filePath = assertFilesystemPathInside(
        packageDir,
        join(dir, logicalPath),
        `字体 ${font.id}`,
      );
      const bytes = readFileSync(filePath);
      const maxBytes = themeFontByteLimit(font);
      if (bytes.byteLength > maxBytes) {
        throw new Error(`超过 ${maxBytes} 字节上限`);
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== font.sha256) throw new Error('SHA-256 与 manifest 不一致');
      fonts.push({ ...font, filePath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/不能越出主题包|不能指向主题包根目录/.test(message)) throw error;
      problems.push(`字体 ${font.id} 不可用，已忽略：${message}`);
    }
  }
  const components = manifest.components.map((component) => {
    const logicalPath = themePackageFilePath(directoryName, component.file, `组件 ${component.id}`);
    const filePath = assertFilesystemPathInside(
      packageDir,
      join(dir, logicalPath),
      `组件 ${component.id}`,
    );
    return {
      ...component,
      filePath,
      html: readFileSync(filePath, 'utf8'),
    };
  });

  return {
    theme: {
      kind: 'v3',
      themeId: manifest.themeId,
      name: manifest.name,
      file: `${directoryName}/${THEME_PACKAGE_FILES.manifest}`,
      packageDir: directoryName,
      css,
      palette: manifest.palette,
      style: manifest.style,
      elements: manifest.elements,
      scenes: manifest.scenes,
      previewImage,
      assets,
      components,
      fonts,
      headingImages: manifest.headingImages,
      ...(manifest.orderedListImages ? { orderedListImages: manifest.orderedListImages } : {}),
      ...(manifest.quoteImages ? { quoteImages: manifest.quoteImages } : {}),
      ...(manifest.referenceComposition ? { referenceComposition: manifest.referenceComposition } : {}),
      articleHeader: manifest.articleHeader,
      wechatDarkMode: manifest.wechatDarkMode,
    },
    problems,
  };
};

/**
 * 取出文件里第一个 css 代码块。
 * 找不到就抛错 —— 静默返回空样式会让人以为是自己 CSS 写错了。
 */
export function extractCss(content) {
  const m = CSS_FENCE.exec(content);
  if (!m) throw new Error('没有找到 css 代码块');
  return m[1];
}

/**
 * 同时兼容直属 Markdown v1 与目录式 v3 主题包。
 * @returns {{ themes: Array<object>, problems: string[] }}
 */
export function listThemes(dir) {
  const themes = [];
  const problems = [];

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => (entry.isFile() && isThemeFile(entry.name)) || entry.isDirectory())
    .sort((a, b) => orderOf(a.name) - orderOf(b.name) || a.name.localeCompare(b.name, 'zh-CN'));
  const themeIds = new Map();

  for (const entry of entries) {
    try {
      const loaded = entry.isDirectory() ? loadPackageTheme(dir, entry.name) : {
        theme: {
          kind: 'v1',
          themeId: '',
          name: themeName(entry.name),
          file: entry.name,
          css: extractCss(readFileSync(join(dir, entry.name), 'utf8')),
          palette: [],
          style: [],
          elements: [],
          scenes: [],
          previewImage: null,
          assets: [],
          components: [],
          fonts: [],
          headingImages: [],
        },
        problems: [],
      };
      const { theme } = loaded;
      if (theme.themeId) {
        const first = themeIds.get(theme.themeId);
        if (first) throw new Error(`theme_id 与「${first}」重复：${theme.themeId}`);
        themeIds.set(theme.themeId, entry.name);
      }
      themes.push(theme);
      problems.push(...loaded.problems.map((problem) => `${entry.name}：${problem}`));
    } catch (e) {
      problems.push(`${entry.name}：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { themes, problems };
}
