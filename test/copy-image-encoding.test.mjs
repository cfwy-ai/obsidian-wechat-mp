import test from 'node:test';
import assert from 'node:assert/strict';
import { createClipboardImageTransformer } from '../plugin/copy-image-encoding.mjs';

const png = (length) => Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(length - 8, 3),
]);
const jpeg = (length) => Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(length - 3, 7)]);
const file = (overrides = {}) => ({ path: 'images/picture.png', stat: { size: 1000, mtime: 1 }, ...overrides });
const fixture = ({ transparent = false, width = 500, height = 400, pngBytes = 400, jpegBytes = 100, ...options } = {}) => {
  const calls = { decode: 0, png: 0, jpeg: [], resize: [], yields: 0 };
  let shouldFail = false;
  const image = {
    isEmpty: () => shouldFail,
    getSize: () => ({ width, height }),
    resize: (value) => { calls.resize.push(value); return image; },
    toBitmap: () => Buffer.from([0, 0, 0, 255, 0, 0, 0, transparent ? 254 : 255]),
    toPNG: () => { calls.png += 1; return png(pngBytes); },
    toJPEG: (quality) => { calls.jpeg.push(quality); return jpeg(jpegBytes); },
  };
  const transform = createClipboardImageTransformer({
    nativeImage: { createFromBuffer: () => { calls.decode += 1; return image; } },
    yieldControl: async () => { calls.yields += 1; },
    ...options,
  });
  return { transform, calls, fail: (value) => { shouldFail = value; } };
};

test('合规正文 JPEG 沿用原字节，不重新编码成 PNG 或 JPEG', async () => {
  const { transform, calls } = fixture();
  const original = jpeg(150);
  const result = await transform(original, file(), 'image/jpeg', { origin: 'article' });
  assert.equal(result.mimeType, 'image/jpeg');
  assert.deepEqual(result.bytes, original);
  assert.equal(calls.png, 0);
  assert.equal(calls.jpeg.length, 0);
});

test('默认逐图调度不调用 Chromium 全局 setTimeout', async () => {
  const previous = globalThis.setTimeout;
  let rendererTimerCalled = false;
  globalThis.setTimeout = () => { rendererTimerCalled = true; throw new Error('后台计时器不可用'); };
  try {
    const { transform } = fixture({ yieldControl: undefined });
    const result = await transform(jpeg(150), file(), 'image/jpeg');
    assert.equal(result.mimeType, 'image/jpeg');
    assert.equal(rendererTimerCalled, false);
  } finally {
    globalThis.setTimeout = previous;
  }
});

test('不透明正文图用 JPEG 92 与无损 PNG 择小，纯色小 PNG 保持无损', async () => {
  const photo = fixture();
  const result = await photo.transform(png(1000), file(), 'image/png', { origin: 'article' });
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.bytes.length, 100);
  assert.deepEqual(photo.calls.jpeg, [92]);

  const small = fixture({ pngBytes: 100, jpegBytes: 200 });
  const original = png(50);
  const lossless = await small.transform(original, file(), 'image/png', { origin: 'article' });
  assert.equal(lossless.mimeType, 'image/png');
  assert.deepEqual(lossless.bytes, original);
});

test('透明正文与主题素材保留 PNG，不以 JPEG 损失透明度或细线', async () => {
  for (const [transparent, origin] of [[true, 'article'], [false, 'theme'], [true, 'theme']]) {
    const { transform, calls } = fixture({ transparent });
    const result = await transform(png(1000), file(), 'image/png', { origin });
    assert.equal(result.mimeType, 'image/png');
    assert.equal(calls.jpeg.length, 0);
  }
});

test('大图保持原比例与最长边 1080，不因容量压力继续缩小', async () => {
  const { transform, calls } = fixture({ width: 2400, height: 1600 });
  await transform(jpeg(1000), file(), 'image/jpeg', { origin: 'article' });
  assert.deepEqual(calls.resize, [{ width: 1080, height: 720, quality: 'best' }]);
  assert.deepEqual(calls.jpeg, [92]);
});

test('已生成 H1 字节直接沿用，不经过解码或缓存', async () => {
  const { transform, calls } = fixture();
  const original = png(30);
  const result = await transform(original, null, 'image/png', { origin: 'generated' });
  assert.deepEqual(result.bytes, original);
  assert.equal(calls.decode, 0);
  assert.equal(transform.cacheStats().entries, 0);
});

test('精确文件路径、修改时间、大小与角色控制缓存；命中时跳过解码与调度', async () => {
  const { transform, calls } = fixture();
  const input = png(1000);
  const initial = file();
  await transform(input, initial, 'image/png', { origin: 'article' });
  await transform(input, file(), 'image/png', { origin: 'article' });
  assert.equal(calls.decode, 1);
  assert.equal(transform.cacheStats().hits, 1);
  assert.equal(calls.yields, 1);
  await transform(input, file({ stat: { size: 1000, mtime: 2 } }), 'image/png', { origin: 'article' });
  await transform(input, file({ stat: { size: 1001, mtime: 2 } }), 'image/png', { origin: 'article' });
  await transform(input, file({ path: 'other/picture.png' }), 'image/png', { origin: 'article' });
  await transform(input, initial, 'image/png', { origin: 'theme' });
  assert.equal(calls.decode, 5);
  transform.clearCache();
  assert.equal(transform.cacheStats().entries, 0);
  assert.equal(transform.cacheStats().bytes, 0);
});

test('无修改时间不缓存，Node stat Date 修改时间可命中缓存', async () => {
  const { transform, calls } = fixture();
  const noMtime = file({ stat: { size: 1000 } });
  await transform(png(1000), noMtime, 'image/png');
  await transform(png(1000), noMtime, 'image/png');
  assert.equal(calls.decode, 2);
  const dated = file({ stat: { size: 1000, mtime: new Date(100) } });
  await transform(png(1000), dated, 'image/png');
  await transform(png(1000), dated, 'image/png');
  assert.equal(calls.decode, 3);
});

test('LRU 同时约束条目数和字节数，并淘汰最久未使用结果', async () => {
  const { transform, calls } = fixture({ maxCacheEntries: 2, maxCacheBytes: 200 });
  for (const path of ['one', 'two', 'one', 'three', 'two']) {
    await transform(png(1000), file({ path }), 'image/png');
  }
  assert.equal(calls.decode, 4);
  assert.equal(transform.cacheStats().entries, 2);
  assert.equal(transform.cacheStats().bytes, 200);
});

test('解码错误和超过单图门槛的结果不进入缓存', async () => {
  const bad = fixture();
  bad.fail(true);
  await assert.rejects(bad.transform(png(1000), file(), 'image/png'), /无法解码/);
  bad.fail(false);
  await bad.transform(png(1000), file(), 'image/png');
  assert.equal(bad.calls.decode, 2);
  assert.equal(bad.transform.cacheStats().hits, 0);

  const oversized = fixture({ maxSingleImageBytes: 90 });
  await oversized.transform(png(1000), file(), 'image/png');
  await oversized.transform(png(1000), file(), 'image/png');
  assert.equal(oversized.calls.decode, 2);
  assert.equal(oversized.transform.cacheStats().entries, 0);
});
