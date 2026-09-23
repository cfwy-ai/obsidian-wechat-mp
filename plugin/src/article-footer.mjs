// 文章尾图只开关主题用 after_article 插槽声明的组件。
// 与头图不同，这里不换图也不上传：主题尾图是成套设计的一段，只决定要不要。
const isObject = (value) => Boolean(value && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));

const isFooter = (component) => component?.slot === 'after_article';

/** 主题有没有尾图，决定界面上要不要显示这个开关。 */
export function articleFooterAvailable(components = []) {
  return Array.isArray(components) && components.some(isFooter);
}

/**
 * selection 只认 `{ enabled: boolean }`。
 * 缺省、为空或格式不对时保留主题原有尾图，不因为设置坏了就把版面改掉。
 */
export function resolveArticleFooter({ selection, components = [] } = {}) {
  const list = Array.isArray(components) ? components : [];
  const keep = (warning) => ({ components: [...list], warnings: warning ? [warning] : [] });
  if (selection === undefined || selection === null) return keep();
  if (!isObject(selection)) return keep('文章尾图设置格式不正确，已保留主题尾图');
  if (selection.enabled !== undefined && typeof selection.enabled !== 'boolean') {
    return keep('文章尾图设置格式不正确，已保留主题尾图');
  }
  if (selection.enabled !== false) return keep();
  if (!list.some(isFooter)) return keep();
  return { components: list.filter((component) => !isFooter(component)), warnings: [] };
}
