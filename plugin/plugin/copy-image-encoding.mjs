import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';

const ENCODER_VERSION = 'copy-encoding-v1';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const isPng = (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
const isJpeg = (bytes) => bytes.length >= 3
  && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const roleOf = (record) => record?.origin === 'theme' ? 'theme'
  : record?.origin === 'generated' ? 'generated' : 'article';
// Node 调度器不会受 Chromium 后台标签页的计时器节流影响。
const defaultYield = () => new Promise((resolve) => setImmediate(resolve));

/** NativeImage 的位图在每个四字节像素的末尾保存 alpha。 */
const hasTransparency = (image) => {
  const bitmap = image.toBitmap();
  for (let index = 3; index < bitmap.length; index += 4) {
    if (bitmap[index] !== 255) return true;
  }
  return false;
};

const cacheKeyFor = (file, role, policy) => {
  if (typeof file?.path !== 'string' || !file.path || file?.stat?.mtime == null) return null;
  const mtime = file.stat.mtime instanceof Date
    ? file.stat.mtime.getTime() : Number(file.stat.mtime);
  const size = Number(file.stat.size);
  if (!Number.isFinite(mtime) || !Number.isFinite(size) || size < 0) return null;
  return JSON.stringify([file.path, mtime, size, role, ...policy]);
};

/**
 * 复制专用编码器；导出长图仍使用原有无损转换流程。
 * 正文照片选择较小的 PNG/JPEG；透明图与主题素材保持 PNG。
 * 缓存只保留已成功且不超过单图门槛的结果，不缓存错误或 NativeImage 对象。
 */
export function createClipboardImageTransformer({
  nativeImage,
  maxDimension = 1080,
  jpegQuality = 92,
  maxSingleImageBytes = 1024 * 1024,
  maxCacheBytes = 32 * 1024 * 1024,
  maxCacheEntries = 64,
  yieldControl = defaultYield,
} = {}) {
  if (typeof nativeImage?.createFromBuffer !== 'function') {
    throw new Error('图片编码器不可用');
  }
  const cache = new Map();
  const policy = [ENCODER_VERSION, maxDimension, jpegQuality, maxSingleImageBytes];
  const stats = { hits: 0, misses: 0, decodes: 0, pngEncodes: 0, jpegEncodes: 0 };
  let cacheBytes = 0;

  const remember = (key, result) => {
    const size = result.bytes.byteLength;
    if (!key || maxCacheEntries <= 0 || size > maxCacheBytes || size > maxSingleImageBytes) return;
    while (cache.size >= maxCacheEntries || cacheBytes + size > maxCacheBytes) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cacheBytes -= cache.get(oldestKey).bytes.byteLength;
      cache.delete(oldestKey);
    }
    cache.set(key, result);
    cacheBytes += size;
  };

  const transform = async (input, file, mimeType, record = {}) => {
    const role = roleOf(record);
    if (role === 'generated') return { bytes: Buffer.from(input), mimeType: record.mimeType || mimeType };
    const key = cacheKeyFor(file, role, policy);
    const cached = key && cache.get(key);
    if (cached) {
      stats.hits += 1;
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    // 仅真正解码前让出事件循环；缓存命中没有重编码工作，也不累加后台调度延迟。
    // 复制锁覆盖整个异步过程。
    await yieldControl();
    stats.misses += 1;
    stats.decodes += 1;
    const bytes = Buffer.from(input);
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('图片无法解码');
    const size = image.getSize();
    if (!(size.width > 0 && size.height > 0)) throw new Error('图片尺寸无效');
    const largest = Math.max(size.width, size.height);
    const needsResize = largest > maxDimension;
    const resized = needsResize ? image.resize({
      width: Math.max(1, Math.round(size.width * maxDimension / largest)),
      height: Math.max(1, Math.round(size.height * maxDimension / largest)),
      quality: 'best',
    }) : image;

    // 已合规的 JPEG 不再次有损压缩，也不因统一转 PNG 而膨胀。
    if (role === 'article' && !needsResize && isJpeg(bytes)
      && bytes.byteLength <= maxSingleImageBytes) {
      const result = { bytes, mimeType: 'image/jpeg' };
      remember(key, result);
      return result;
    }

    stats.pngEncodes += 1;
    const encodedPng = Buffer.from(resized.toPNG());
    // 原 PNG 更小时直接保留；toPNG 同样无损，可在保持尺寸时去掉冗余数据。
    const png = !needsResize && isPng(bytes) && bytes.byteLength < encodedPng.byteLength
      ? bytes : encodedPng;
    let result = { bytes: png, mimeType: 'image/png' };
    if (role === 'article' && !hasTransparency(resized)) {
      stats.jpegEncodes += 1;
      const jpeg = Buffer.from(resized.toJPEG(jpegQuality));
      if (jpeg.byteLength < png.byteLength) result = { bytes: jpeg, mimeType: 'image/jpeg' };
    }
    if (result.bytes.byteLength === 0) throw new Error('图片编码结果为空');
    remember(key, result);
    return result;
  };

  transform.cacheStats = () => ({ ...stats, entries: cache.size, bytes: cacheBytes });
  transform.clearCache = () => { cache.clear(); cacheBytes = 0; };
  return transform;
}
