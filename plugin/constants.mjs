export const VIEW_TYPE = 'changfeng-wechat-mp-preview';

export const LEGACY_DEFAULT_THEME_FOLDER = '06｜个人账号运营/3. 正文排版';
export const PREVIOUS_DEFAULT_THEME_FOLDER = `${LEGACY_DEFAULT_THEME_FOLDER}/模板仓库`;
export const DEFAULT_THEME_FOLDER = '06｜个人账号运营/2. 排版配图/5. 图文主题仓库';
export const DEFAULT_PREVIEW_WIDTH = 677;
export const DEFAULT_MOBILE_PREVIEW_WIDTH = 390;

export const DEFAULT_SETTINGS = Object.freeze({
  themeFolder: DEFAULT_THEME_FOLDER,
  selectedThemeFile: '',
  selectedThemeId: '',
  showInternalThemeResources: false,
  headingBreakToolsEnabled: true,
  syncScroll: true,
  previewWidth: DEFAULT_PREVIEW_WIDTH,
  mobilePreview: false,
  mobilePreviewWidth: DEFAULT_MOBILE_PREVIEW_WIDTH,
});
