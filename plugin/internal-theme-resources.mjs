import { cleanVaultFolder } from '../src/vault-path.mjs';

export const INTERNAL_THEME_RESOURCE_DIRECTORIES = Object.freeze([
  '配套字体资源',
  '字体资源',
  '正文组件结构',
]);

export const INTERNAL_THEME_RESOURCE_STYLE_ID =
  'changfeng-wechat-mp-internal-theme-resources';

const isFolder = (entry) => Boolean(entry && Array.isArray(entry.children));

export function isConfiguredThemeRepositoryChange(path, themeFolder) {
  const normalizedPath = cleanVaultFolder(path);
  const rootPath = cleanVaultFolder(themeFolder);
  return Boolean(
    rootPath &&
    (normalizedPath === rootPath || normalizedPath.startsWith(`${rootPath}/`)),
  );
}

/**
 * 把 Vault 路径安全写进 CSS 双引号字符串。
 * 控制字符、引号和反斜杠统一使用 CSS 十六进制转义，避免路径截断选择器。
 */
export function escapeCssString(value) {
  return [...String(value ?? '')].map((character) => {
    const codePoint = character.codePointAt(0);
    if (
      character === '"' ||
      character === '\\' ||
      codePoint === 0 ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    ) {
      return `\\${codePoint.toString(16)} `;
    }
    return character;
  }).join('');
}

/**
 * 只枚举配置主题仓库的直属主题目录，不用前后缀选择器猜路径。
 * 因此 Vault 其他位置、主题包更深层级的同名目录都不会被隐藏。
 */
export function internalThemeResourcePaths({ vault, themeFolder }) {
  const rootPath = cleanVaultFolder(themeFolder);
  const root = vault?.getAbstractFileByPath?.(rootPath);
  if (!rootPath || !isFolder(root)) return [];

  return [...root.children]
    .filter((entry) => isFolder(entry) && entry.parent?.path === rootPath)
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }))
    .flatMap((theme) => INTERNAL_THEME_RESOURCE_DIRECTORIES.map(
      (directory) => `${theme.path}/${directory}`,
    ));
}

export function internalThemeResourcesCss(paths) {
  const selectors = [...new Set(paths)]
    .filter(Boolean)
    .map((path) => [
      '.workspace-leaf-content[data-type="file-explorer"]',
      `.nav-folder:has(> .nav-folder-title[data-path="${escapeCssString(path)}"])`,
    ].join(' '));
  if (selectors.length === 0) return '';
  return `${selectors.join(',\n')} {\n  display: none !important;\n}`;
}

export class InternalThemeResourcesVisibility {
  constructor({ vault, document }) {
    this.vault = vault;
    this.document = document;
    this.styleEl = null;
  }

  refresh({ themeFolder, showInternalThemeResources }) {
    if (showInternalThemeResources) {
      this.removeStyle();
      return;
    }

    const css = internalThemeResourcesCss(internalThemeResourcePaths({
      vault: this.vault,
      themeFolder,
    }));
    if (!css) {
      this.removeStyle();
      return;
    }

    if (!this.styleEl) {
      const orphan = this.document?.getElementById?.(INTERNAL_THEME_RESOURCE_STYLE_ID);
      orphan?.remove?.();
      this.styleEl = this.document?.createElement?.('style') ?? null;
      if (!this.styleEl) return;
      this.styleEl.id = INTERNAL_THEME_RESOURCE_STYLE_ID;
      this.styleEl.setAttribute?.('data-owner', 'changfeng-wechat-mp');
      this.document?.head?.appendChild?.(this.styleEl);
    }
    this.styleEl.textContent = css;
  }

  removeStyle() {
    this.styleEl?.remove?.();
    this.styleEl = null;
    this.document?.getElementById?.(INTERNAL_THEME_RESOURCE_STYLE_ID)?.remove?.();
  }

  dispose() {
    this.removeStyle();
  }
}
