import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  DEFAULT_THEME_FOLDER,
  LEGACY_DEFAULT_THEME_FOLDER,
  PREVIOUS_DEFAULT_THEME_FOLDER,
} from '../plugin/constants.mjs';
import { migrateLegacyThemeSettings } from '../plugin/settings-migration.mjs';

test('第一代默认根目录直达新的图文主题仓库', () => {
  const original = {
    themeFolder: LEGACY_DEFAULT_THEME_FOLDER,
    selectedThemeFile: '',
    syncScroll: true,
  };

  const result = migrateLegacyThemeSettings(original);

  assert.equal(result.migrated, true);
  assert.equal(result.settings.themeFolder, DEFAULT_THEME_FOLDER);
  assert.notEqual(result.settings, original);

  const secondPass = migrateLegacyThemeSettings(result.settings);
  assert.equal(secondPass.migrated, false);
  assert.equal(secondPass.settings, result.settings);
});

test('旧设置补入默认关闭的主题内部资源开关，并保持幂等', () => {
  assert.equal(DEFAULT_SETTINGS.showInternalThemeResources, false);
  const first = migrateLegacyThemeSettings({
    themeFolder: DEFAULT_THEME_FOLDER,
    selectedThemeFile: '',
  });
  assert.equal(first.migrated, true);
  assert.equal(first.settings.showInternalThemeResources, false);
  const second = migrateLegacyThemeSettings(first.settings);
  assert.equal(second.migrated, false);
  assert.equal(second.settings, first.settings);
});

test('第二代模板仓库也直达新的图文主题仓库', () => {
  const result = migrateLegacyThemeSettings({
    themeFolder: PREVIOUS_DEFAULT_THEME_FOLDER,
    selectedThemeFile: '',
  });
  assert.equal(result.migrated, true);
  assert.equal(result.settings.themeFolder, DEFAULT_THEME_FOLDER);
  assert.equal(migrateLegacyThemeSettings(result.settings).migrated, false);
});

test('旧根目录直属的已选主题一起迁移', () => {
  const filename = '5. 莫兰迪晨风格.md';
  const result = migrateLegacyThemeSettings({
    themeFolder: LEGACY_DEFAULT_THEME_FOLDER,
    selectedThemeFile: `${LEGACY_DEFAULT_THEME_FOLDER}/${filename}`,
  });

  assert.equal(result.migrated, true);
  assert.equal(result.settings.selectedThemeFile, `${DEFAULT_THEME_FOLDER}/${filename}`);
});

test('目录已更新但已选主题仍指向旧根目录时补做迁移', () => {
  const filename = '2. 微信读书风格.md';
  const result = migrateLegacyThemeSettings({
    themeFolder: DEFAULT_THEME_FOLDER,
    selectedThemeFile: `${LEGACY_DEFAULT_THEME_FOLDER}/${filename}`,
  });

  assert.equal(result.migrated, true);
  assert.equal(result.settings.themeFolder, DEFAULT_THEME_FOLDER);
  assert.equal(result.settings.selectedThemeFile, `${DEFAULT_THEME_FOLDER}/${filename}`);
});

test('第二代目录直属的已选主题一起迁移', () => {
  const filename = '4. 粘土卡通风格.md';
  const result = migrateLegacyThemeSettings({
    themeFolder: PREVIOUS_DEFAULT_THEME_FOLDER,
    selectedThemeFile: `${PREVIOUS_DEFAULT_THEME_FOLDER}/${filename}`,
    selectedThemeId: '',
  });
  assert.equal(result.settings.themeFolder, DEFAULT_THEME_FOLDER);
  assert.equal(result.settings.selectedThemeFile, `${DEFAULT_THEME_FOLDER}/${filename}`);
  assert.equal(result.settings.selectedThemeId, '');
});

test('目录已更新但已选主题仍指向第二代路径时补做迁移', () => {
  const filename = '2. 微信读书风格.md';
  const result = migrateLegacyThemeSettings({
    themeFolder: DEFAULT_THEME_FOLDER,
    selectedThemeFile: `${PREVIOUS_DEFAULT_THEME_FOLDER}/${filename}`,
  });
  assert.equal(result.migrated, true);
  assert.equal(result.settings.selectedThemeFile, `${DEFAULT_THEME_FOLDER}/${filename}`);
});

test('自定义主题目录与外部已选路径不做猜测迁移', () => {
  const custom = {
    themeFolder: 'My Themes',
    selectedThemeFile: 'My Themes/theme.md',
  };
  const customResult = migrateLegacyThemeSettings(custom);
  assert.equal(customResult.migrated, true);
  assert.equal(customResult.settings.themeFolder, custom.themeFolder);
  assert.equal(customResult.settings.selectedThemeFile, custom.selectedThemeFile);
  assert.equal(customResult.settings.showInternalThemeResources, false);
  assert.equal(migrateLegacyThemeSettings(customResult.settings).migrated, false);

  const legacyWithSlash = {
    themeFolder: `${LEGACY_DEFAULT_THEME_FOLDER}/`,
    selectedThemeFile: '',
  };
  const slashResult = migrateLegacyThemeSettings(legacyWithSlash);
  assert.equal(slashResult.migrated, true);
  assert.equal(slashResult.settings.themeFolder, DEFAULT_THEME_FOLDER);

  const currentWithSlash = {
    themeFolder: `${DEFAULT_THEME_FOLDER}/`,
    selectedThemeFile: '',
  };
  const currentSlashResult = migrateLegacyThemeSettings(currentWithSlash);
  assert.equal(currentSlashResult.migrated, true);
  assert.equal(currentSlashResult.settings.themeFolder, DEFAULT_THEME_FOLDER);

  const outsideSelection = 'Other Themes/theme.md';
  const legacyResult = migrateLegacyThemeSettings({
    themeFolder: LEGACY_DEFAULT_THEME_FOLDER,
    selectedThemeFile: outsideSelection,
  });
  assert.equal(legacyResult.migrated, true);
  assert.equal(legacyResult.settings.selectedThemeFile, outsideSelection);
});

test('旧根目录下的深层路径不被误拆成文件名', () => {
  const nestedSelection = `${LEGACY_DEFAULT_THEME_FOLDER}/子目录/theme.md`;
  const result = migrateLegacyThemeSettings({
    themeFolder: LEGACY_DEFAULT_THEME_FOLDER,
    selectedThemeFile: nestedSelection,
  });

  assert.equal(result.migrated, true);
  assert.equal(result.settings.selectedThemeFile, nestedSelection);

  const previousNested = `${PREVIOUS_DEFAULT_THEME_FOLDER}/子目录/manifest.json`;
  const previousResult = migrateLegacyThemeSettings({
    themeFolder: PREVIOUS_DEFAULT_THEME_FOLDER,
    selectedThemeFile: previousNested,
  });
  assert.equal(previousResult.settings.themeFolder, DEFAULT_THEME_FOLDER);
  assert.equal(previousResult.settings.selectedThemeFile, previousNested);
});
