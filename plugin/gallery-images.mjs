import { collectGalleryImageTargets } from '../src/gallery.mjs';
import { readImageDimensions } from '../src/image-dimensions.mjs';

const validDimensions = (value) =>
  value && Number.isFinite(value.width) && Number.isFinite(value.height) &&
  value.width > 0 && value.height > 0
    ? { width: value.width, height: value.height }
    : null;

/** 让 Chromium 读取真实显示方向下的固有尺寸。 */
export function loadImageElementDimensions(
  url,
  { ImageClass = globalThis.Image, timeoutMs = 8000 } = {},
) {
  if (typeof ImageClass !== 'function' || typeof url !== 'string' || !url) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const image = new ImageClass();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(validDimensions(value));
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    image.onload = () => finish({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => finish(null);
    image.src = url;
    if (image.complete) {
      queueMicrotask(() => finish({ width: image.naturalWidth, height: image.naturalHeight }));
    }
  });
}

const fileStamp = (file) => `${file?.stat?.mtime ?? 0}:${file?.stat?.size ?? 0}`;

/**
 * 预先解析 gallery 图片；renderArticle 仍保持同步，resolver 只多返回 width/height。
 *
 * @param {{
 *   source: string,
 *   resolveFile: (target: string) => object|null,
 *   getResourcePath: (file: object) => string,
 *   readBinary?: (file: object) => Promise<ArrayBuffer|ArrayBufferView>,
 *   cache?: Map<string, {stamp: string, dimensions?: {width:number,height:number}, promise?: Promise<{width:number,height:number}|null>}>,
 *   loadDimensions?: (url: string) => Promise<{width:number,height:number}|null>
 * }} input
 * @returns {Promise<Map<string, {url:string, filePath:string, width?:number, height?:number}>>}
 */
export async function resolveGalleryImageRecords({
  source,
  resolveFile,
  getResourcePath,
  readBinary,
  cache = new Map(),
  loadDimensions = loadImageElementDimensions,
}) {
  const records = new Map();
  await Promise.all(collectGalleryImageTargets(source).map(async (target) => {
    let file;
    let url;
    try {
      file = resolveFile(target);
      if (!file?.path) return;
      url = getResourcePath(file);
    } catch {
      return;
    }
    const stamp = fileStamp(file);
    const cached = cache.get(file.path);
    let imageDimensions = cached?.stamp === stamp ? cached.dimensions : undefined;

    if (imageDimensions === undefined) {
      let pending = cached?.stamp === stamp ? cached.promise : null;
      if (!pending) {
        pending = (async () => {
          let value = null;
          try {
            value = validDimensions(await loadDimensions(url));
          } catch {
            value = null;
          }
          if (!value && typeof readBinary === 'function') {
            try {
              value = readImageDimensions(await readBinary(file));
            } catch {
              value = null;
            }
          }
          return value;
        })();
        cache.set(file.path, { stamp, promise: pending });
      }
      imageDimensions = await pending;
      if (cache.get(file.path)?.promise === pending) {
        if (imageDimensions) cache.set(file.path, { stamp, dimensions: imageDimensions });
        else cache.delete(file.path);
      }
    }

    records.set(target, {
      url,
      filePath: file.path,
      ...(imageDimensions ?? {}),
    });
  }));
  return records;
}
