/** 把设置中的 Vault 相对目录整理为不带首尾斜杠的形式。 */
export function cleanVaultFolder(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/** 判断一个 Vault 相对路径是否位于指定目录中。 */
export function isPathInFolder(path, folder) {
  const clean = cleanVaultFolder(folder);
  return Boolean(clean) && (path === clean || path.startsWith(`${clean}/`));
}

const numberPrefix = (name) => {
  const match = /^(\d+)\.\s*/.exec(name);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

/** 按文件名前的数字排序，无序号文件放最后。 */
export function compareNumberedNames(a, b) {
  const byNumber = numberPrefix(a) - numberPrefix(b);
  return byNumber || a.localeCompare(b, 'zh-CN', { numeric: true });
}
