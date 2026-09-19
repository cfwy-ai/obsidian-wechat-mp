import { parseYaml, stringifyYaml, TFile } from 'obsidian';
import { splitFrontmatter } from '../src/markdown.mjs';
import { readImageDimensions } from '../src/image-dimensions.mjs';
import { nativeImage } from 'electron';

const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const UPLOAD_OWNER = Symbol('article-header-upload');
export function readArticleHeaderSelection(source, themeId) {
  const yaml = splitFrontmatter(source).frontmatter;
  if (!yaml) return { selection: undefined, warnings: [] };
  try {
    const data = parseYaml(yaml);
    if (data?.wechat_headers === undefined) return { selection: undefined, warnings: [] };
    if (!object(data.wechat_headers)) throw Error('wechat_headers 必须是对象');
    return { selection: data.wechat_headers[themeId], warnings: [] };
  } catch (error) {
    return { selection: undefined, warnings: ['文章头图设置无法读取，已使用主题默认头图'], error };
  }
}

export function assertHeaderContext(view, context) {
  const file = view.app.vault.getAbstractFileByPath(context.articlePath);
  if (view.closed || !(file instanceof TFile) || file !== context.article
      || view.plugin.getCurrentDocument()?.path !== context.articlePath
      || view.getSelectedThemePath() !== context.themePath
      || view.headerContext?.themeId !== context.themeId) {
    throw Error('文章或主题已切换，请回到目标文章后重新选择头图');
  }
  return file;
}

function applyHeaderSelection(data, selection, themeId) {
  if (!object(data)) throw Error('文章已有的 YAML 属性格式不正确，请先检查属性');
  if (data.wechat_headers !== undefined && !object(data.wechat_headers)) {
    throw Error('文章已有的 wechat_headers 格式不正确，请先检查属性');
  }
  const settings = data.wechat_headers ? { ...data.wechat_headers } : {};
  if (selection === null) delete settings[themeId];
  else {
    const next = { enabled: selection.enabled !== false };
    if (typeof selection.custom_image === 'string' && selection.custom_image) next.custom_image = selection.custom_image;
    else if (typeof selection.preset === 'string' && selection.preset) next.preset = selection.preset;
    settings[themeId] = next;
  }
  if (Object.keys(settings).length) data.wechat_headers = settings;
  else delete data.wechat_headers;
}

function assertSourceEditor(view, context, sourceView, editor) {
  assertHeaderContext(view, context);
  if (view.plugin.getCurrentSourceLeaf()?.view !== sourceView
      || sourceView.file !== context.article || sourceView.editor !== editor
      || sourceView.getMode?.() !== 'source') {
    throw Error('文章编辑器已切换，请回到目标文章后重新选择头图');
  }
}

function headerFrontmatterChange(source, selection, themeId) {
  // Keep the entire body suffix byte-for-byte; splitFrontmatter intentionally
  // normalizes leading blank lines and therefore cannot be used for this edit.
  const match = /^---[ \t]*(\r?\n)([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(source);
  const frontmatter = match?.index === 0 ? match : null;
  if (!frontmatter && /^---[ \t]*(?:\r?\n|$)/.test(source)) {
    throw Error('文章 YAML 属性缺少结束分隔线，请先检查属性');
  }
  let data;
  try {
    data = frontmatter ? parseYaml(frontmatter[2]) ?? {} : {};
  } catch {
    throw Error('文章 YAML 属性无法解析，请先检查属性');
  }
  applyHeaderSelection(data, selection, themeId);
  const newline = frontmatter?.[1] ?? (source.includes('\r\n') ? '\r\n' : '\n');
  const yaml = stringifyYaml(data).replace(/\r?\n/g, newline);
  return {
    endOffset: frontmatter?.[0].length ?? 0,
    text: `---${newline}${yaml}${yaml.endsWith(newline) ? '' : newline}---${newline}`,
  };
}

export async function saveArticleHeaderSelection(view, selection, context, owner) {
  const article = assertHeaderContext(view, context);
  if (view.headerSaving || (view.headerUploading && owner !== UPLOAD_OWNER)) throw Error('头图正在保存，请稍后再试');
  view.headerSaving = true;
  view.updateActionButtons();
  try {
    const sourceView = view.plugin.getCurrentSourceLeaf()?.view;
    if (sourceView?.getMode?.() === 'source') {
      const editor = sourceView.editor;
      assertSourceEditor(view, context, sourceView, editor);
      if (typeof editor?.getValue !== 'function' || typeof editor.transaction !== 'function'
          || typeof editor.offsetToPos !== 'function' || typeof sourceView.save !== 'function') {
        throw Error('当前编辑器无法保存头图设置，请重新打开文章后再试');
      }
      const source = editor.getValue();
      const change = headerFrontmatterChange(source, selection, context.themeId);
      const to = editor.offsetToPos(change.endOffset);
      assertSourceEditor(view, context, sourceView, editor);
      if (editor.getValue() !== source) throw Error('文章内容已变化，请重新选择头图');
      editor.transaction({ changes: [{ from: { line: 0, ch: 0 }, to, text: change.text }] }, 'wechat-article-header');
      await sourceView.save();
    } else {
      await view.app.fileManager.processFrontMatter(article, data => {
        assertHeaderContext(view, context);
        if (view.plugin.getCurrentSourceLeaf()?.view?.getMode?.() === 'source') {
          throw Error('文章编辑模式已切换，请重新选择头图');
        }
        applyHeaderSelection(data, selection, context.themeId);
      });
    }
    assertHeaderContext(view, context);
    // Do not wait for metadataCache to catch up with the frontmatter write.
    const source = await view.app.vault.cachedRead(article);
    if (view.plugin.getCurrentDocument()?.path === article.path) {
      await view.refresh({ articlePath: article.path, articleSource: source });
    }
  } finally {
    view.headerSaving = false;
    view.updateActionButtons();
    view.headerControls?.update();
  }
}

export function validateHeaderUpload(bytes, filename) {
  if (!/\.(?:png|jpe?g)$/i.test(filename)) throw Error('请选择 PNG 或 JPG 图片');
  if (bytes.byteLength > 24 * 1024 * 1024) throw Error('图片超过 24 MiB，请先缩小图片文件');
  const isPng = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const isJpeg = bytes[0] === 255 && bytes[1] === 216;
  if (!isPng && !isJpeg) throw Error('文件内容不是 PNG 或 JPG 图片');
  const size = readImageDimensions(bytes);
  if (!size || size.width * size.height > 40_000_000) throw Error('图片尺寸无法读取或超过 4000 万像素');
  return { ...size, extension: isPng ? 'png' : 'jpg' };
}

export async function uploadArticleHeader(view, input, context) {
  if (view.headerUploading || view.headerSaving) throw Error('头图正在保存，请稍后再试');
  const article = assertHeaderContext(view, context);
  view.headerUploading = true;
  view.updateActionButtons();
  try {
  const bytes = new Uint8Array(await input.arrayBuffer());
  const image = validateHeaderUpload(bytes, input.name);
  if (nativeImage.createFromBuffer(Buffer.from(bytes)).isEmpty()) throw Error('图片无法解码，请重新导出为 PNG 或 JPG');
  assertHeaderContext(view, context);
  const base = input.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|#\[\]^]/g, '-').slice(0, 70) || '自定义';
  const filename = `头图-${base}.${image.extension}`;
  const target = await view.app.fileManager.getAvailablePathForAttachment(filename, article.path);
  assertHeaderContext(view, context);
  const created = await view.app.vault.createBinary(target, bytes.buffer);
  try {
    assertHeaderContext(view, context);
    await saveArticleHeaderSelection(view, { enabled: true, custom_image: `[[${created.path}]]` }, context, UPLOAD_OWNER);
  } catch (error) {
    // Keep a successfully imported user image recoverable even if selection failed.
    throw Error(`${error.message}；图片已保存在 ${created.path}`);
  }
  return created;
  } finally {
    view.headerUploading = false;
    view.updateActionButtons();
  }
}
