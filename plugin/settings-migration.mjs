import {
  DEFAULT_THEME_FOLDER,
  LEGACY_DEFAULT_THEME_FOLDER,
  PREVIOUS_DEFAULT_THEME_FOLDER,
} from './constants.mjs';
import { cleanVaultFolder } from '../src/vault-path.mjs';

/**
 * v0.4 以前使用「3. 正文排版」根目录，v0.4–0.6 使用其「模板仓库」。
 * 两代旧受管路径直达 v0.7 的「5. 图文主题仓库」；自定义目录不猜测。
 */
export function migrateLegacyThemeSettings(settings) {
  const migratedSettings = { ...settings };
  let migrated = false;

  if (typeof settings?.showInternalThemeResources !== 'boolean') {
    migratedSettings.showInternalThemeResources = false;
    migrated = true;
  }
  const normalizedThemeFolder = cleanVaultFolder(settings?.themeFolder ?? '');
  const managedFolders = new Set([
    LEGACY_DEFAULT_THEME_FOLDER,
    PREVIOUS_DEFAULT_THEME_FOLDER,
    DEFAULT_THEME_FOLDER,
  ]);
  if (
    normalizedThemeFolder === LEGACY_DEFAULT_THEME_FOLDER ||
    normalizedThemeFolder === PREVIOUS_DEFAULT_THEME_FOLDER
  ) {
    migratedSettings.themeFolder = DEFAULT_THEME_FOLDER;
    migrated = true;
  } else if (
    normalizedThemeFolder === DEFAULT_THEME_FOLDER &&
    settings?.themeFolder !== DEFAULT_THEME_FOLDER
  ) {
    // 只持久化本插件管理的默认路径；不擅自改写自定义目录。
    migratedSettings.themeFolder = DEFAULT_THEME_FOLDER;
    migrated = true;
  }

  const selected = cleanVaultFolder(settings?.selectedThemeFile ?? '');

  // 两代旧目录下只有直属 Markdown 是 v1 主题；深层路径与外部路径保持原样。
  // 目录已经迁完但 selectedThemeFile 仍是旧值时，也补做一次迁移。
  if (managedFolders.has(normalizedThemeFolder)) {
    for (const oldFolder of [LEGACY_DEFAULT_THEME_FOLDER, PREVIOUS_DEFAULT_THEME_FOLDER]) {
      const prefix = `${oldFolder}/`;
      const filename = selected.startsWith(prefix) ? selected.slice(prefix.length) : '';
      if (filename && !filename.includes('/')) {
        migratedSettings.selectedThemeFile = `${DEFAULT_THEME_FOLDER}/${filename}`;
        migrated = true;
        break;
      }
    }
  }

  return migrated
    ? { settings: migratedSettings, migrated: true }
    : { settings, migrated: false };
}
