/** 文件名是标题文字的唯一来源，frontmatter 只记录换行位置。 */
export function parseEditedDocumentTitle(input) {
  const value = String(input ?? '').replace(/\r\n?/g, '\n').trim();
  const name = value.replace(/\n/g, '');
  if (!name.trim()) throw new Error('文档标题不能为空');
  if (/[/\\:*?"<>|\u0000-\u001f]/.test(name) || name === '.' || name === '..') {
    throw new Error('标题含文件名不支持的字符，请使用全角标点');
  }
  if (new TextEncoder().encode(`${name}.md`).length > 255) throw new Error('标题太长，无法用作文件名');
  const breaks = [];
  let offset = 0;
  for (const line of value.split('\n').slice(0, -1)) {
    offset += Array.from(line).length;
    if (offset > 0 && offset < Array.from(name).length && !breaks.includes(offset)) breaks.push(offset);
  }
  return { name, breaks };
}

export function documentTitleForDisplay(basename, frontmatter = {}) {
  const name = String(basename ?? '');
  const chars = Array.from(name);
  let breaks = frontmatter.title_breaks;
  // 旧值只在文字与文件名严格一致时保留换行，不能再次形成另一套标题。
  if (!Array.isArray(breaks) && typeof frontmatter.display_title === 'string') {
    const legacy = frontmatter.display_title.replace(/\r\n?/g, '\n').trim();
    if (legacy.replace(/\n/g, '') === name) {
      try { breaks = parseEditedDocumentTitle(legacy).breaks; } catch { breaks = []; }
    }
  }
  const positions = new Set((Array.isArray(breaks) ? breaks : [])
    .filter(value => Number.isSafeInteger(value) && value > 0 && value < chars.length));
  return chars.map((char, i) => `${positions.has(i) ? '\n' : ''}${char}`).join('');
}

/** 通过 Obsidian 的文件管理器改名，以便它同步链接与目录树。 */
export async function saveDocumentTitle(app, file, value) {
  const parsed = parseEditedDocumentTitle(value);
  const directory = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
  const nextPath = `${directory}${parsed.name}.${file.extension || 'md'}`;
  const conflict = app.vault.getAbstractFileByPath(nextPath);
  if (conflict && conflict !== file) throw new Error('同目录已有同名文档，未覆盖任何文件');
  if (nextPath !== file.path) await app.fileManager.renameFile(file, nextPath);
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    delete frontmatter.display_title;
    if (parsed.breaks.length) frontmatter.title_breaks = parsed.breaks;
    else delete frontmatter.title_breaks;
  });
  return parsed;
}
