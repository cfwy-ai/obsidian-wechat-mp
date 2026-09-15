import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { themeFontByteLimit } from '../src/theme-package.mjs';

/** 只借用主题字体与基本色彩，不借用章节编号、行数限制或左右配饰。 */
export async function prepareExportTitleTheme({ fonts = [], headingImages = [], readBinary, includeFont = true } = {}) {
  const rule = headingImages.find(rule => rule.headingLevels?.includes(1));
  const font = fonts.find(font => font.id === rule?.fontId);
  const result = { family: 'inherit', color: rule?.color ?? 'inherit',
    align: rule?.align ?? 'left', weight: font?.weight ?? 700, fontCss: '', warnings: [] };
  if (!font || !includeFont) return result;
  try {
    const maxBytes = themeFontByteLimit(font);
    if (font.file?.stat?.size > maxBytes) throw new Error('字体文件过大');
    const bytes = Buffer.from(await readBinary(font.file));
    if (bytes.byteLength > maxBytes) throw new Error('字体文件过大');
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== font.sha256) throw new Error('字体文件校验不一致');
    result.family = `cfwx-export-${hash.slice(0, 16)}`;
    result.fontCss = `@font-face{font-family:${result.family};src:url(data:font/ttf;base64,${bytes.toString('base64')});font-weight:${font.weight};font-style:${font.style};}`;
  } catch (error) {
    result.family = 'inherit';
    result.warnings.push(`主标题字体改用系统字体：${error.message || error}`);
  }
  return result;
}
