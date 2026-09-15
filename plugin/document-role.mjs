import { isThemeFile as isMarkdownFileName } from '../src/theme.mjs';
import { cleanVaultFolder, isPathInFolder } from '../src/vault-path.mjs';

const trimSlashes = (value) => cleanVaultFolder(value);

const pathParts = (path) => {
  const normalized = trimSlashes(path);
  const slash = normalized.lastIndexOf('/');
  return {
    name: slash >= 0 ? normalized.slice(slash + 1) : normalized,
    parentPath: slash >= 0 ? normalized.slice(0, slash) : '',
  };
};

/** 只有配置的主题目录直属 Markdown 才是主题。 */
export function isConfiguredThemePath(path, themeFolder) {
  const { name, parentPath } = pathParts(path);
  return parentPath === trimSlashes(themeFolder) && isMarkdownFileName(name);
}

/**
 * 主题仓库直属 v1 Markdown 与目录式 v3 包内的任意文件/目录都是主题资源。
 * 供 Vault 监听使用，确保修改、改名或删除素材后会刷新预览。
 */
export function isConfiguredThemeResourcePath(path, themeFolder) {
  const normalizedPath = trimSlashes(path);
  const folder = trimSlashes(themeFolder);
  return normalizedPath !== folder && isPathInFolder(normalizedPath, folder);
}

export function isThemeDocument(file, themeFolder) {
  if (!file || file.extension !== 'md') return false;
  if (isConfiguredThemePath(file.path, themeFolder)) return true;
  if (!isConfiguredThemeResourcePath(file.path, themeFolder)) return false;
  const relative = trimSlashes(file.path).slice(`${trimSlashes(themeFolder)}/`.length);
  return relative.split('/').length >= 2;
}

export function isPreviewableMarkdownDocument(file, themeFolder) {
  return Boolean(file && file.extension === 'md' && !isThemeDocument(file, themeFolder));
}
