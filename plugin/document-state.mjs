/**
 * 删除的是当前文档时，立刻清掉文档与滚动源，并刷新预览。
 * 返回 true 表示已处理，调用方不必再走普通 vault 变化分支。
 */
export function handleCurrentDocumentDeletion(owner, file) {
  const current = owner.currentDocument;
  const wasCurrent = Boolean(
    current && (file === current || (file?.path && file.path === current.path)),
  );
  if (!wasCurrent) return false;

  owner.currentDocument = null;
  owner.currentSourceLeaf = null;
  // 关闭排版模式时只维护文档状态，不做无意义的预览工作。
  if (typeof owner.hasPreviewView !== 'function' || owner.hasPreviewView()) {
    owner.updatePreviewSources();
    owner.scheduleRefresh();
  }
  return true;
}

/** 当前渲染是否实际引用了这个 Vault 文件。 */
export function renderedArticleUsesFile(render, filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  return Boolean(render?.images?.some((image) => image?.filePath === filePath));
}

/** 只记住当前 Markdown，不读取正文、不更新预览。 */
export function rememberMarkdownDocument(owner, { file, sourceLeaf }) {
  const sameDocument = owner.currentDocument?.path === file.path;
  owner.currentDocument = file;
  if (sourceLeaf) owner.currentSourceLeaf = sourceLeaf;
  else if (!sameDocument) owner.currentSourceLeaf = null;
}

/**
 * 把用户刚切换到的 Markdown 视图立即设为当前文章，并请求预览刷新。
 * scheduleRefresh 会在预览未开启时直接返回，因此关闭模式不会运行渲染。
 */
export function activateMarkdownDocument(owner, { file, sourceLeaf, articleSource }) {
  rememberMarkdownDocument(owner, { file, sourceLeaf });
  owner.updatePreviewSources();
  owner.scheduleRefresh({ articlePath: file.path, articleSource });
}

/**
 * Markdown 被打开或成为活动视图时的统一入口。
 * readArticleSource 延迟到预览已开启后才执行，避免关闭模式仍读取整篇正文。
 */
export function focusMarkdownDocument(
  owner,
  { file, sourceLeaf, readArticleSource },
) {
  rememberMarkdownDocument(owner, { file, sourceLeaf });
  if (!owner.hasPreviewView()) return false;

  activateMarkdownDocument(owner, {
    file,
    sourceLeaf,
    articleSource: readArticleSource(),
  });
  return true;
}

/** 主题编辑同样只在预览开启时读取源文本。 */
export function refreshThemeDocument(owner, { file, readThemeSource }) {
  if (!owner.hasPreviewView()) return false;
  owner.scheduleRefresh({ themePath: file.path, themeSource: readThemeSource() });
  return true;
}
