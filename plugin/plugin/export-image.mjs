import { Buffer } from 'node:buffer';
import { homedir } from 'node:os';
import { basename as pathBasename, dirname, extname, join } from 'node:path';
import html2canvas from './export-background-renderer.mjs';
import { DEFAULT_MOBILE_PREVIEW_WIDTH } from './constants.mjs';
import { prepareExportInlineBackgrounds } from './export-inline-backgrounds.mjs';
import { PNG } from 'pngjs';
import {
  countRenderedImageReferences,
  estimatedReplacementHtmlBytes,
  replaceRenderedImageSource,
  removeRenderedImageSource,
} from './copy.mjs';

export const EXPORT_WIDTH = 677;
// 手机端长图与本地手机预览共用同一条正文宽度，默认 390px、允许 320–430px。
export const MOBILE_EXPORT_WIDTH = DEFAULT_MOBILE_PREVIEW_WIDTH;
export const MIN_EXPORT_LAYOUT_WIDTH = 320;
export const MAX_EXPORT_LAYOUT_WIDTH = EXPORT_WIDTH;
export const EXPORT_LAYOUT_MODES = Object.freeze(['desktop', 'mobile']);
export const DEFAULT_EXPORT_LAYOUT_MODE = 'desktop';
export const EXPORT_LAYOUT_MODE_LABELS = Object.freeze({
  desktop: '电脑端',
  mobile: '手机端',
});
export const EXPORT_SCALES = Object.freeze([1, 1.5, 2]);
export const DEFAULT_EXPORT_SCALE = 2;
export const EXPORT_TILE_HEIGHT = 8192;
export const MAX_EXPORT_HEIGHT = 28_000;
// 2× 输出的像素数为 1× 的四倍；最大片段仍只分配 8192 个物理像素行。
export const MAX_EXPORT_PIXELS = 76_000_000;
export const DEFAULT_EXPORT_IMAGE_LIMIT = 100;
export const DEFAULT_EXPORT_SOURCE_IMAGE_LIMIT = 64 * 1024 * 1024;
export const DEFAULT_EXPORT_SOURCE_TOTAL_LIMIT = 256 * 1024 * 1024;
export const DEFAULT_EXPORT_SINGLE_IMAGE_LIMIT = 4 * 1024 * 1024;
export const DEFAULT_EXPORT_IMAGE_TOTAL_LIMIT = 32 * 1024 * 1024;
export const DEFAULT_EXPORT_HTML_LIMIT = 48 * 1024 * 1024;

const escapeHtml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 只有文章、风格和渲染结果仍是同一个状态时才允许导出。 */
export function createExportSnapshot({ render, article, themePath }) {
  if (!render || !article || !themePath) return null;
  if (render.articlePath !== article.path || render.themePath !== themePath) return null;
  return { article, render };
}

export function resolveExportAuthor(value) {
  const candidates = Array.isArray(value) ? value : [value];
  const normalized = candidates
    .filter((item) => typeof item === 'string' || typeof item === 'number')
    .map((item) => String(item).trim())
    .filter(Boolean);
  return normalized.join('、');
}

export function normalizeExportScale(value = DEFAULT_EXPORT_SCALE) {
  const scale = Number(value);
  if (!EXPORT_SCALES.includes(scale)) throw new Error('请选择 1×、1.5× 或 2× 导出清晰度');
  return scale;
}

export function normalizeExportLayoutMode(value = DEFAULT_EXPORT_LAYOUT_MODE) {
  if (!EXPORT_LAYOUT_MODES.includes(value)) {
    throw new Error('请选择「电脑端」或「手机端」导出格式');
  }
  return value;
}

export function normalizeExportLayoutWidth(value = EXPORT_WIDTH) {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width)
    || width < MIN_EXPORT_LAYOUT_WIDTH
    || width > MAX_EXPORT_LAYOUT_WIDTH) {
    throw new Error(
      `导出正文宽度需要在 ${MIN_EXPORT_LAYOUT_WIDTH}–${MAX_EXPORT_LAYOUT_WIDTH}px 之间`,
    );
  }
  return width;
}

/**
 * 电脑端固定 677px，手机端跟随「手机预览内容宽度」设置。
 * 该设置来自用户输入，越界时夹回可用区间，不让长图导出因为一个设置项直接失败。
 */
export function exportLayoutWidthForMode(
  mode = DEFAULT_EXPORT_LAYOUT_MODE,
  mobileWidth = MOBILE_EXPORT_WIDTH,
) {
  if (normalizeExportLayoutMode(mode) !== 'mobile') return EXPORT_WIDTH;
  const requested = Math.round(Number(mobileWidth));
  if (!Number.isFinite(requested)) return MOBILE_EXPORT_WIDTH;
  return Math.min(MAX_EXPORT_LAYOUT_WIDTH, Math.max(MIN_EXPORT_LAYOUT_WIDTH, requested));
}

export function exportWidthForScale(scale = DEFAULT_EXPORT_SCALE, layoutWidth = EXPORT_WIDTH) {
  return Math.round(normalizeExportLayoutWidth(layoutWidth) * normalizeExportScale(scale));
}

/** 弹窗提交前的唯一参数入口，不读 frontmatter，也不猜作者姓名。 */
export function normalizeExportOptions(options = {}) {
  const showTitle = options.showTitle !== false;
  const showAuthor = options.showAuthor !== false;
  const author = resolveExportAuthor(options.author);
  if (showAuthor && !author) {
    throw new Error('请输入作者姓名，或关闭「显示作者姓名」');
  }
  const layoutMode = normalizeExportLayoutMode(options.layoutMode);
  return {
    showTitle,
    showAuthor,
    author,
    layoutMode,
    layoutWidth: exportLayoutWidthForMode(layoutMode, options.mobileWidth),
    scale: DEFAULT_EXPORT_SCALE,
    destinationPath:
      typeof options.destinationPath === 'string' && options.destinationPath.trim()
        ? options.destinationPath.trim()
        : null,
  };
}

export function buildExportHtml({
  articleHtml,
  title,
  author,
  showTitle = true,
  showAuthor = true,
  titleTheme = {},
  layoutWidth = EXPORT_WIDTH,
}) {
  const layout = normalizeExportLayoutWidth(layoutWidth);
  const normalizedAuthor = resolveExportAuthor(author);
  if (showAuthor && !normalizedAuthor) {
    throw new Error('请输入作者姓名，或关闭「显示作者姓名」');
  }
  const titleHtml = showTitle
    ? `<div class="wechat-long-image-title" role="heading" aria-level="1">${escapeHtml(title).replace(/\n/g, '<br>')}</div>`
    : '';
  const authorHtml = showAuthor
    ? `<p class="wechat-long-image-author">${escapeHtml(normalizedAuthor)}</p>`
    : '';
  const header = titleHtml || authorHtml
    ? `<header class="wechat-long-image-header">${titleHtml}${authorHtml}</header>`
    : '';
  // 将文首插入同一主题背景，已有 before_article banner 自然跟在标题和作者后面。
  const rootOpening = /^(\s*<section\b(?=[^>]*\bid=["']nice["'])[^>]*>)/i;
  const content = !header ? articleHtml : rootOpening.test(articleHtml)
    ? articleHtml.replace(rootOpening, (root) => `${root}${header}`)
    : `<section id="nice">${header}${articleHtml}</section>`;
  const titleColor = /^#[a-f\d]{6}$/i.test(titleTheme.color ?? '') ? titleTheme.color : 'inherit';
  const titleFamily = /^cfwx-export-[a-f\d]{16}$/.test(titleTheme.family ?? '') ? titleTheme.family : 'inherit';
  const titleWeight = [100,200,300,400,500,600,700,800,900].includes(titleTheme.weight) ? titleTheme.weight : 700;
  const titleAlign = titleTheme.align === 'center' ? 'center' : 'left';
  // 34px 是 677px 正文下的标题字号；窄幅按同一比例收，并保留 24px 下限避免手机端标题过小。
  const titleFontSize = Math.max(24, Math.round(34 * layout / EXPORT_WIDTH));

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${layout}, initial-scale=1">
<style>
${titleTheme.fontCss ?? ''}
html,body{margin:0;padding:0;width:${layout}px;background:#fff;}
body{overflow:hidden;color:#222;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}
#wechat-long-image-root{width:${layout}px;min-height:1px;overflow:hidden;background:#fff;}
.wechat-long-image-header{box-sizing:border-box;width:100%;padding:14px 0 32px;background:transparent;text-align:${titleAlign};}
.wechat-long-image-title{margin:0;color:${titleColor};font-family:${titleFamily};font-size:${titleFontSize}px;font-weight:${titleWeight};letter-spacing:.01em;line-height:1.4;text-align:${titleAlign};text-wrap:balance;overflow-wrap:anywhere;}
.wechat-long-image-author{margin:14px 0 0;color:inherit;opacity:.7;font-size:14px;font-weight:400;line-height:1.6;text-align:${titleAlign};}
</style>
</head>
<body><main id="wechat-long-image-root">${content}</main></body>
</html>`;
}

export function buildExportFilename(basename, sequence = 1) {
  const suffix = sequence > 1 ? `-${sequence}` : '';
  return `${basename}-公众号长图${suffix}.png`;
}

export function buildExportPath(folder, basename, sequence = 1) {
  const filename = buildExportFilename(basename, sequence);
  return folder ? join(folder, filename) : filename;
}

export async function findAvailableExportPath({ folder, basename, exists, maxAttempts = 999 }) {
  for (let sequence = 1; sequence <= maxAttempts; sequence += 1) {
    const path = buildExportPath(folder, basename, sequence);
    if (!(await exists(path))) return path;
  }
  throw new Error('同名长图过多，请先整理后重试');
}

export function ensurePngExtension(filePath) {
  const normalized = String(filePath ?? '').trim();
  if (!normalized) return '';
  return /\.png$/i.test(normalized) ? normalized : `${normalized}.png`;
}

/** 自选文件名冲突时保留原名，只在扩展名前追加序号。 */
export function buildSequencedTargetPath(targetPath, sequence = 1) {
  const normalized = ensurePngExtension(targetPath);
  if (sequence <= 1) return normalized;
  const extension = extname(normalized) || '.png';
  const stem = pathBasename(normalized, extension);
  return join(dirname(normalized), `${stem}-${sequence}${extension}`);
}

export async function findAvailableTargetPath({ targetPath, exists, maxAttempts = 999 }) {
  for (let sequence = 1; sequence <= maxAttempts; sequence += 1) {
    const candidate = buildSequencedTargetPath(targetPath, sequence);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('同名长图过多，请先整理后重试');
}

/** 优先使用 Electron 返回的系统下载目录，不可用时才回退 ~/Downloads。 */
export function resolveDownloadsDirectory(getSystemPath, fallbackHome = homedir()) {
  try {
    const value = getSystemPath?.('downloads');
    if (typeof value === 'string' && value.trim()) return value;
  } catch {
    // Electron remote 在部分 Obsidian 版本不可用，下方是可预期的降级路径。
  }
  return join(fallbackHome, 'Downloads');
}

async function cleanupFailedExport(path, remove, primaryError) {
  try {
    await remove(path);
  } catch (cleanupError) {
    const primary = primaryError instanceof Error ? primaryError.message : String(primaryError);
    const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new Error(`${primary}；同时未能清理失败文件：${cleanup}`);
  }
  throw primaryError;
}

/**
 * 把 PNG 写到非 vault 路径：先避让同名，再独占创建，回读校验后才报成功。
 * write 必须使用类似 fs.writeFile(path, bytes, { flag: 'wx' }) 的独占写入。
 */
export async function saveVerifiedExportPng({
  targetPath,
  bytes,
  expectedWidth = EXPORT_WIDTH,
  expectedHeight,
  exists,
  write,
  read,
  remove,
  maxAttempts = 999,
}) {
  const source = Buffer.from(bytes);
  if (!ensurePngExtension(targetPath)) throw new Error('长图保存路径为空');
  verifyPng(source, { expectedWidth, expectedHeight });

  for (let sequence = 1; sequence <= maxAttempts; sequence += 1) {
    const path = buildSequencedTargetPath(targetPath, sequence);
    if (await exists(path)) continue;

    try {
      await write(path, source);
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      await cleanupFailedExport(path, remove, error);
    }

    try {
      const saved = Buffer.from(await read(path));
      verifyPng(saved, { expectedWidth, expectedHeight });
      if (!saved.equals(source)) throw new Error('PNG 保存后的内容与生成结果不一致');
      return path;
    } catch (error) {
      await cleanupFailedExport(path, remove, error);
    }
  }
  throw new Error('同名长图过多，请先整理后重试');
}

/**
 * 导出不受剪贴板 4 MiB 限制，但仍保留原图读取上限，避免单次导出占满内存。
 * 图片失败时使用明确图位，不让一张图阻断整篇文章。
 */
export async function embedImagesForExport({
  html,
  images,
  resolveFile,
  readBinary,
  transformImage,
  maxImageCount = DEFAULT_EXPORT_IMAGE_LIMIT,
  maxSourceImageBytes = DEFAULT_EXPORT_SOURCE_IMAGE_LIMIT,
  maxSourceTotalBytes = DEFAULT_EXPORT_SOURCE_TOTAL_LIMIT,
  maxSingleImageBytes = DEFAULT_EXPORT_SINGLE_IMAGE_LIMIT,
  maxImageBytes = DEFAULT_EXPORT_IMAGE_TOTAL_LIMIT,
  maxHtmlBytes = DEFAULT_EXPORT_HTML_LIMIT,
}) {
  if (Buffer.byteLength(html, 'utf8') > maxHtmlBytes) {
    throw new Error('文章 HTML 本身已超过长图导出上限');
  }
  let output = html;
  let embeddedCount = 0;
  let embeddedBytes = 0;
  let sourceBytesRead = 0;
  const warnings = [];

  for (const [index, image] of images.entries()) {
    const label = `【图片 ${index + 1} 加载失败】`;
    if (countRenderedImageReferences(output, image.url).total === 0) {
      warnings.push(`${image.target}：未找到可替换的图片位置`);
      continue;
    }
    const generatedBytes = image.bytes ? Buffer.from(image.bytes) : null;
    const file = generatedBytes ? null : resolveFile(image.filePath ?? image.target, image);
    if (index >= maxImageCount) {
      output = removeRenderedImageSource(output, image.url, label, image.fallbackHtml);
      warnings.push(`${image.target}：超过前 ${maxImageCount} 张导出上限`);
      continue;
    }
    if (!file && !generatedBytes) {
      output = removeRenderedImageSource(output, image.url, label, image.fallbackHtml);
      warnings.push(`找不到图片：${image.target}`);
      continue;
    }

    const sourceSize = generatedBytes?.byteLength ?? file.stat?.size ?? 0;
    if (sourceSize > maxSourceImageBytes) {
      output = removeRenderedImageSource(output, image.url, label, image.fallbackHtml);
      warnings.push(`${image.target}：原图超过单图读取上限`);
      continue;
    }
    if (sourceBytesRead + sourceSize > maxSourceTotalBytes) {
      output = removeRenderedImageSource(output, image.url, label, image.fallbackHtml);
      warnings.push(`${image.target}：原图累计超过本次读取上限`);
      continue;
    }
    sourceBytesRead += sourceSize;

    try {
      const sourceBytes = generatedBytes ?? await readBinary(file);
      const transformed = await transformImage(sourceBytes, file);
      const bytes = Buffer.from(transformed.bytes);
      if (bytes.byteLength > maxSingleImageBytes) {
        output = removeRenderedImageSource(output, image.url, label, image.fallbackHtml);
        warnings.push(`${image.target}：处理后仍超过单图导出上限`);
        continue;
      }
      if (embeddedBytes + bytes.byteLength > maxImageBytes) {
        output = removeRenderedImageSource(output, image.url, label, image.fallbackHtml);
        warnings.push(`${image.target}：超过本次长图图片总量上限`);
        continue;
      }
      const dataUrl = `data:${transformed.mimeType};base64,${bytes.toString('base64')}`;
      if (estimatedReplacementHtmlBytes(output, image.url, dataUrl) > maxHtmlBytes) {
        output = removeRenderedImageSource(output, image.url, label, image.fallbackHtml);
        warnings.push(`${image.target}：内嵌后会超过长图 HTML 上限`);
        continue;
      }
      const candidate = replaceRenderedImageSource(output, image.url, dataUrl);
      if (Buffer.byteLength(candidate, 'utf8') > maxHtmlBytes) {
        output = removeRenderedImageSource(output, image.url, label, image.fallbackHtml);
        warnings.push(`${image.target}：内嵌后会超过长图 HTML 上限`);
        continue;
      }
      output = candidate;
      embeddedCount += 1;
      embeddedBytes += bytes.byteLength;
    } catch (error) {
      output = removeRenderedImageSource(output, image.url, label, image.fallbackHtml);
      warnings.push(`${image.target}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { html: output, embeddedCount, embeddedBytes, sourceBytesRead, warnings };
}

function waitForFrameLoad(frame, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('导出页面加载超时'));
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timeout);
      frame.removeEventListener('load', onLoad);
      frame.removeEventListener('error', onError);
    };
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('导出页面无法加载'));
    };
    frame.addEventListener('load', onLoad, { once: true });
    frame.addEventListener('error', onError, { once: true });
  });
}

async function waitForDocumentAssets(doc, timeoutMs = 20_000) {
  const imagePromises = [...doc.images].map(async (image) => {
    if (image.complete && image.naturalWidth > 0) return;
    if (typeof image.decode === 'function') await image.decode();
    if (!image.complete || image.naturalWidth < 1) throw new Error('图片无法解码');
  });
  const fontPromise = doc.fonts?.ready ?? Promise.resolve();
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error('图片或字体加载超时')), timeoutMs);
  });
  try {
    await Promise.race([Promise.all([...imagePromises, fontPromise]), timeout]);
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }
  // 离屏 iframe 的 requestAnimationFrame 可能被 Chromium 永久暂停。
  // 用顶层窗口等待两帧，并用短定时器兜底，避免导出一直卡在「正在分片生成 PNG」。
  await Promise.race([
    new Promise((resolve) => window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolve);
    })),
    new Promise((resolve) => window.setTimeout(resolve, 250)),
  ]);
}

export function assertExportDimensions(width, height, layoutWidth = EXPORT_WIDTH) {
  const layout = normalizeExportLayoutWidth(layoutWidth);
  if (!EXPORT_SCALES.some((scale) => exportWidthForScale(scale, layout) === width)) {
    throw new Error(`导出宽度异常：${width}px`);
  }
  if (!Number.isSafeInteger(height) || height < 1) throw new Error('导出高度异常');
  if (height > Math.round(MAX_EXPORT_HEIGHT * width / layout)
    || width * height > MAX_EXPORT_PIXELS) {
    throw new Error(`文章过长（${height}px），已超过单张长图的内存保护范围，请分段导出`);
  }
}

/** 同一模式内排版宽度固定，只增加绘制像素；使用物理像素边界，避免 1.5× 拼接缺行。 */
export function planExportRaster(layoutHeight, {
  scale = DEFAULT_EXPORT_SCALE,
  tileHeight = EXPORT_TILE_HEIGHT,
  layoutWidth = EXPORT_WIDTH,
} = {}) {
  const normalizedScale = normalizeExportScale(scale);
  const layout = normalizeExportLayoutWidth(layoutWidth);
  if (!Number.isFinite(layoutHeight) || layoutHeight < 1) throw new Error('导出高度异常');
  if (!Number.isSafeInteger(tileHeight) || tileHeight < 1 || tileHeight > EXPORT_TILE_HEIGHT) {
    throw new Error('导出分片高度异常');
  }
  const width = exportWidthForScale(normalizedScale, layout);
  const rasterScale = width / layout;
  const height = Math.round(Math.ceil(layoutHeight) * rasterScale);
  assertExportDimensions(width, height, layout);
  const tiles = [];
  for (let outputY = 0; outputY < height; outputY += tileHeight) {
    const outputHeight = Math.min(tileHeight, height - outputY);
    tiles.push({ outputY, outputHeight, y: outputY / rasterScale, height: outputHeight / rasterScale });
  }
  return {
    width,
    height,
    scale: normalizedScale,
    rasterScale,
    layoutWidth: layout,
    layoutHeight: Math.ceil(layoutHeight),
    tiles,
  };
}

export function stitchCanvasTiles(tiles, width, height, { _PNG = PNG } = {}) {
  assertExportDimensions(width, height);
  const pixels = Buffer.alloc(width * height * 4, 255);
  let targetY = 0;

  for (const canvas of tiles) {
    const tileHeight = copyCanvasTileToPixels(canvas, pixels, width, height, targetY);
    targetY += tileHeight;
  }

  if (targetY !== height) throw new Error('长图分片不完整');
  return _PNG.sync.write({ width, height, data: pixels }, {
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true,
  });
}

/** 把一片 canvas 写入最终 RGBA Buffer，生产路径用它做逐片释放。 */
export function copyCanvasTileToPixels(canvas, pixels, width, height, targetY) {
  if (canvas.width !== width) throw new Error(`长图分片宽度异常：${canvas.width}px`);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法读取长图分片');
  const tileHeight = Math.min(canvas.height, height - targetY);
  if (tileHeight < 1) throw new Error('长图分片高度异常');
  const imageData = context.getImageData(0, 0, width, tileHeight);
  const source = Buffer.from(
    imageData.data.buffer,
    imageData.data.byteOffset,
    imageData.data.byteLength,
  );
  source.copy(pixels, targetY * width * 4);
  return tileHeight;
}

/** 在隔离 iframe 中按 8192px 分片截图，再在内存中编码为一张 PNG。 */
export async function renderLongImagePng(html, {
  scale = DEFAULT_EXPORT_SCALE,
  tileHeight = EXPORT_TILE_HEIGHT,
  layoutWidth = EXPORT_WIDTH,
  _html2canvas = html2canvas,
} = {}) {
  normalizeExportScale(scale);
  const layout = normalizeExportLayoutWidth(layoutWidth);
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = [
    'position:fixed',
    'left:-100000px',
    'top:0',
    `width:${layout}px`,
    'height:1024px',
    'border:0',
    'pointer-events:none',
    'z-index:-2147483648',
  ].join(';');

  const loaded = waitForFrameLoad(frame);
  frame.srcdoc = html;
  document.body.append(frame);

  try {
    await loaded;
    const doc = frame.contentDocument;
    const root = doc?.getElementById('wechat-long-image-root');
    if (!doc || !root) throw new Error('导出页面结构不完整');
    await waitForDocumentAssets(doc);
    prepareExportInlineBackgrounds(root);

    const layoutHeight = Math.ceil(Math.max(root.scrollHeight, root.getBoundingClientRect().height));
    const plan = planExportRaster(layoutHeight, { scale, tileHeight, layoutWidth: layout });
    const { width, height } = plan;
    const pixels = Buffer.alloc(width * height * 4, 255);
    let tileCount = 0;
    let targetY = 0;
    for (const tile of plan.tiles) {
      // html2canvas 会向传入的原生高分辨率画布绘制文字；不放大旧截图。
      // 画布与文章共用文档的 FontFaceSet，才能绘制主题内嵌字体。
      const targetCanvas = doc.createElement('canvas');
      targetCanvas.width = width;
      targetCanvas.height = tile.outputHeight;
      let canvas = targetCanvas;
      try {
        canvas = await _html2canvas(root, {
          canvas: targetCanvas,
          backgroundColor: '#ffffff',
          scale: plan.rasterScale,
          useCORS: true,
          allowTaint: false,
          logging: false,
          imageTimeout: 20_000,
          removeContainer: true,
          width: layout,
          height: tile.height,
          x: 0,
          y: tile.y,
          scrollX: 0,
          scrollY: 0,
          windowWidth: layout,
          windowHeight: Math.min(layoutHeight, EXPORT_TILE_HEIGHT),
        });
        if (canvas.width !== width || canvas.height !== tile.outputHeight) {
          throw new Error(`长图分片尺寸异常：${canvas.width}×${canvas.height}`);
        }
        targetY += copyCanvasTileToPixels(
          canvas,
          pixels,
          width,
          height,
          targetY,
        );
        tileCount += 1;
      } finally {
        // 缩小底层 backing store，避免长文同时保留所有分片画布。
        canvas.width = 1;
        canvas.height = 1;
        if (canvas !== targetCanvas) { targetCanvas.width = 1; targetCanvas.height = 1; }
      }
    }
    if (targetY !== height) throw new Error('长图分片不完整');

    return {
      bytes: PNG.sync.write({ width, height, data: pixels }, {
        colorType: 6,
        inputColorType: 6,
        inputHasAlpha: true,
      }),
      width,
      height,
      tileCount,
      scale: plan.scale,
      layoutWidth: layout,
      layoutHeight,
    };
  } finally {
    frame.remove();
  }
}

export function verifyPng(bytes, { expectedWidth = EXPORT_WIDTH, expectedHeight } = {}) {
  const buffer = Buffer.from(bytes);
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') throw new Error('导出文件不是有效 PNG');
  if (buffer.length < 24 || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('PNG 缺少 IHDR 尺寸信息');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== expectedWidth) {
    throw new Error(`PNG 回读宽度异常：${width}px`);
  }
  if (expectedHeight !== undefined && height !== expectedHeight) {
    throw new Error(`PNG 回读高度异常：${height}px`);
  }
  return { width, height };
}
