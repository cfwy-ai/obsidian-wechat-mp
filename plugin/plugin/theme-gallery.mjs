/** Read gallery artwork without changing the active source or theme selection. */
export async function loadThemeGallery({ resources, settings }) {
  const { themes, problems } = await resources.discover(settings);
  let bundledThemes = [];
  if (settings.themeSource === 'vault' && themes.some(theme => theme.themeId && !theme.showcaseImage)) {
    try {
      const bundled = await resources.discover({ ...settings, themeSource: 'bundled' });
      if (Array.isArray(bundled?.themes)) bundledThemes = bundled.themes;
    } catch {
      // Bundled artwork is optional for a developer's own gallery.
    }
  }
  const bundledShowcases = new Map(bundledThemes
    .filter(theme => theme.themeId && theme.showcaseImage)
    .map(theme => [theme.themeId, theme]));
  return {
    problems,
    items: themes.map(theme => {
      if (theme.showcaseImage) {
        return {
          theme, image: theme.showcaseImage,
          label: theme.showcaseStatus === 'draft' ? '视觉样张（待确认）' : '模板介绍图',
        };
      }
      const bundled = theme.themeId ? bundledShowcases.get(theme.themeId) : null;
      if (bundled) {
        return {
          theme, image: bundled.showcaseImage,
          label: bundled.showcaseStatus === 'draft' ? '发行版视觉样张（待确认）' : '发行版介绍图',
        };
      }
      return {
        theme, image: theme.previewImage ?? null,
        label: theme.previewImage ? '预览图 · 介绍图待补充' : '',
      };
    }),
  };
}
