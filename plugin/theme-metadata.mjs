const cleanMetadataValue = (value) => {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('、');
};

/** 把主题 frontmatter 中用于界面展示的字段归一为稳定字符串。 */
export function themeMetadata(frontmatter = {}) {
  const source = frontmatter && typeof frontmatter === 'object' ? frontmatter : {};
  const palette = cleanMetadataValue(source.theme_palette);
  const style = cleanMetadataValue(source.theme_style);
  const elements = cleanMetadataValue(source.theme_elements);
  const scenes = cleanMetadataValue(source.theme_scenes);
  return {
    palette,
    style,
    elements,
    scenes,
    summary: [palette, style || elements, scenes].filter(Boolean).join('｜'),
  };
}

const searchableText = (value) =>
  cleanMetadataValue(value).normalize('NFKC').toLocaleLowerCase('zh-CN');

/** 按名称、配色、风格、核心元素或适用场景做包含匹配。 */
export function themeMatchesQuery(theme, query) {
  const needle = searchableText(query);
  if (!needle) return true;
  if (!theme || typeof theme !== 'object') return false;

  return [theme.name, theme.palette, theme.style, theme.elements, theme.scenes]
    .map(searchableText)
    .some((value) => value.includes(needle));
}
