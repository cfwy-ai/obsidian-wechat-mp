import { extractCss, isThemeFile, themeName } from '../src/theme.mjs';
import {
  parseThemeManifest,
  isThemeFontPath,
  THEME_FONT_DIRECTORY,
  THEME_PACKAGE_DIRECTORIES,
  THEME_PACKAGE_FILES,
  THEME_VISUAL_SPEC_FILES,
  themePackageFilePath,
} from '../src/theme-package.mjs';
import { compareNumberedNames, cleanVaultFolder } from '../src/vault-path.mjs';
import { themeMetadata } from './theme-metadata.mjs';

const isFolder = (entry) => Boolean(entry && Array.isArray(entry.children));
const isFile = (entry) => Boolean(entry && !isFolder(entry) && typeof entry.path === 'string');

const getFile = (vault, path) => {
  const entry = vault.getAbstractFileByPath(path);
  return isFile(entry) ? entry : null;
};

const requiredPackageFile = (vault, packagePath, filename) => {
  const path = themePackageFilePath(packagePath, filename, filename);
  const file = getFile(vault, path);
  if (!file) throw new Error(`缺少 ${filename}`);
  return file;
};

const requiredPackageFolder = (vault, packagePath, dirname) => {
  const path = themePackageFilePath(packagePath, dirname, dirname);
  const folder = vault.getAbstractFileByPath(path);
  if (!isFolder(folder)) throw new Error(`缺少 ${dirname}`);
  return folder;
};

const v1Descriptor = (file, metadataCache) => {
  const cache = metadataCache.getFileCache(file);
  const metadata = themeMetadata(cache?.frontmatter ?? {});
  return {
    kind: 'v1',
    themeId: '',
    path: file.path,
    file,
    sortName: file.name,
    name: themeName(file.name),
    ...metadata,
    cssFile: file,
    visualSpecFiles: [],
    previewImage: null,
    assets: [],
    components: [],
    fonts: [],
    headingImages: [],
  };
};

/**
 * 四个固定目录与三份视觉规范是「主题制作」的契约：它们保证作者有确定的位置放东西。
 * 渲染并不依赖目录本身 —— manifest 里每个素材、组件、字体都带显式路径并逐项校验，
 * 缺件会精确报出「缺少素材 X」。所以发布形态（主题包随插件分发、作者资料已剥离）
 * 不再要求目录存在，只靠 manifest 的逐项校验，既不误拒也不放过真正的缺件。
 */
const v3Descriptor = async (folder, { vault, requireAuthoringDocs = true }) => {
  const manifestFile = requiredPackageFile(vault, folder.path, THEME_PACKAGE_FILES.manifest);
  const cssFile = requiredPackageFile(vault, folder.path, THEME_PACKAGE_FILES.css);
  if (requireAuthoringDocs) {
    for (const dirname of Object.values(THEME_PACKAGE_DIRECTORIES)) {
      requiredPackageFolder(vault, folder.path, dirname);
    }
  }
  const visualSpecFiles = requireAuthoringDocs
    ? THEME_VISUAL_SPEC_FILES.map((filename) =>
      requiredPackageFile(
        vault,
        folder.path,
        `${THEME_PACKAGE_DIRECTORIES.visualSpecs}/${filename}`,
      ))
    : [];
  const manifest = parseThemeManifest(await vault.cachedRead(manifestFile), {
    directoryName: folder.name,
    requireAuthoringDocs,
  });
  const metadata = themeMetadata({
    theme_palette: manifest.palette,
    theme_style: manifest.style,
    theme_elements: manifest.elements,
    theme_scenes: manifest.scenes,
  });
  const problems = [];
  let previewImage = null;
  if (manifest.previewImage) {
    const filePath = themePackageFilePath(folder.path, manifest.previewImage, 'preview_image');
    const file = getFile(vault, filePath);
    if (!file) {
      problems.push(`${folder.name}：preview_image 文件不存在：${manifest.previewImage}`);
    } else {
      try {
        if (typeof vault.readBinary === 'function') await vault.readBinary(file);
        previewImage = {
          file,
          filePath,
          url: vault.getResourcePath(file),
        };
      } catch (error) {
        problems.push(
          `${folder.name}：preview_image 读取失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  const assets = [];
  for (const asset of manifest.assets) {
    const filePath = themePackageFilePath(folder.path, asset.file, `素材 ${asset.id}`);
    const file = getFile(vault, filePath);
    if (!file) {
      problems.push(`${folder.name}：缺少素材 ${asset.file}`);
      continue;
    }
    assets.push({ ...asset, file, filePath });
  }
  const fonts = [];
  for (const font of manifest.fonts) {
    const filePath = themePackageFilePath(folder.path, font.file, `字体 ${font.id}`);
    const file = getFile(vault, filePath);
    if (!file) {
      problems.push(`${folder.name}：缺少字体 ${font.file}`);
      continue;
    }
    if (!isThemeFontPath(font.file)) {
      problems.push(`${folder.name}：字体路径不在 ${THEME_FONT_DIRECTORY}：${font.file}`);
      continue;
    }
    fonts.push({ ...font, file, filePath });
  }
  const components = [];
  for (const component of manifest.components) {
    const filePath = themePackageFilePath(folder.path, component.file, `组件 ${component.id}`);
    const file = getFile(vault, filePath);
    if (!file) {
      problems.push(`${folder.name}：缺少组件 ${component.file}`);
      continue;
    }
    components.push({ ...component, file, filePath });
  }
  return {
    theme: {
      kind: 'v3',
      themeId: manifest.themeId,
      path: manifestFile.path,
      packagePath: folder.path,
      file: manifestFile,
      sortName: folder.name,
      name: manifest.name,
      order: manifest.order,
      ...metadata,
      manifestFile,
      cssFile,
      visualSpecFiles,
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

const compareThemes = (a, b) => {
  const byName = compareNumberedNames(a.sortName, b.sortName);
  if (byName !== 0) return byName;
  const aOrder = a.order ?? Number.MAX_SAFE_INTEGER;
  const bOrder = b.order ?? Number.MAX_SAFE_INTEGER;
  return aOrder - bOrder || a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
};

/**
 * 发现主题目录直属的 v1 Markdown 与目录式 v3 主题包。
 * 任一 v3 核心文件缺失会进入 problems；组件、素材或预览图缺失只停用对应条目，不留裂图。
 */
export async function discoverVaultThemes({
  vault,
  metadataCache,
  themeFolder,
  requireAuthoringDocs = true,
}) {
  const folderPath = cleanVaultFolder(themeFolder);
  const folder = vault.getAbstractFileByPath(folderPath);
  if (!isFolder(folder)) {
    return { themes: [], problems: [`主题仓库不存在：${folderPath}`] };
  }

  const themes = [];
  const problems = [];
  const ids = new Map();
  const entries = [...folder.children].sort((a, b) => compareNumberedNames(a.name, b.name));

  for (const entry of entries) {
    if (isFile(entry) && isThemeFile(entry.name) && entry.parent?.path === folderPath) {
      themes.push(v1Descriptor(entry, metadataCache));
      continue;
    }
    if (!isFolder(entry) || entry.parent?.path !== folderPath) continue;
    try {
      const loaded = await v3Descriptor(entry, { vault, requireAuthoringDocs });
      const first = ids.get(loaded.theme.themeId);
      if (first) {
        problems.push(`${entry.name}：theme_id 与「${first}」重复：${loaded.theme.themeId}`);
        continue;
      }
      ids.set(loaded.theme.themeId, entry.name);
      themes.push(loaded.theme);
      problems.push(...loaded.problems);
    } catch (error) {
      problems.push(`${entry.name}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  themes.sort(compareThemes);
  return { themes, problems };
}

/** 稳定 theme_id 优先，旧版 selectedThemeFile 仅作兼容回退。 */
export function selectThemeDescriptor(themes, settings = {}) {
  const selectedId = typeof settings.selectedThemeId === 'string'
    ? settings.selectedThemeId.trim().toLowerCase()
    : '';
  if (selectedId) {
    const byId = themes.find((theme) => theme.themeId === selectedId);
    if (byId) return byId;
  }
  const selectedPath = String(settings.selectedThemeFile ?? '');
  const byPath = themes.find((theme) => theme.path === selectedPath);
  if (byPath) return byPath;

  // v0.6 以前只保存平铺 Markdown 路径。目录式迁移后文件不存在时，
  // 仍按旧文件名恢复同名 v3 主题，避免升级后静默跳到第一套主题。
  const legacyFilename = selectedPath.split('/').at(-1) ?? '';
  const legacyName = /\.md$/i.test(legacyFilename)
    ? themeName(legacyFilename).replace(/风格$/u, '')
    : '';
  if (legacyName) {
    const byLegacyName = themes.find((theme) => theme.kind === 'v3' && theme.name === legacyName);
    if (byLegacyName) return byLegacyName;
  }

  return themes[0] ?? null;
}

/** 只读取当前选中主题的 CSS、组件 HTML 和实际可用素材。 */
export async function loadVaultThemeContent(theme, { vault, context = {} } = {}) {
  if (!theme) {
    return {
      css: '',
      components: [],
      assets: [],
      fonts: [],
      headingImages: [],
      problems: [],
    };
  }
  if (theme.kind === 'v1') {
    try {
      const source =
        context.themePath === theme.path && typeof context.themeSource === 'string'
          ? context.themeSource
          : await vault.cachedRead(theme.cssFile);
      return {
        css: extractCss(source),
        components: [],
        assets: [],
        fonts: [],
        headingImages: [],
        problems: [],
      };
    } catch (error) {
      return {
        css: '',
        components: [],
        assets: [],
        fonts: [],
        headingImages: [],
        problems: [`${theme.file.name}：${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }

  const problems = [];
  let css = '';
  try {
    css = await vault.cachedRead(theme.cssFile);
  } catch (error) {
    problems.push(`${theme.name}：theme.css 读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const components = [];
  for (const component of theme.components) {
    try {
      components.push({ ...component, html: await vault.cachedRead(component.file) });
    } catch (error) {
      problems.push(`${theme.name}：组件 ${component.id} 读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const assets = theme.assets.map((asset) => ({
    ...asset,
    url: vault.getResourcePath(asset.file),
  }));
  return {
    css,
    components,
    assets,
    fonts: theme.fonts ?? [],
    headingImages: theme.headingImages ?? [],
    ...(theme.orderedListImages ? { orderedListImages: theme.orderedListImages } : {}),
    ...(theme.quoteImages ? { quoteImages: theme.quoteImages } : {}),
    ...(theme.referenceComposition ? { referenceComposition: theme.referenceComposition } : {}),
    articleHeader: theme.articleHeader ?? null,
    wechatDarkMode: theme.wechatDarkMode ?? null,
    problems,
  };
}
