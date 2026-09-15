import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readImageDimensions } from '../src/image-dimensions.mjs';

test('从 PNG IHDR 读取尺寸', () => {
  const image = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(image);
  image.write('IHDR', 12, 'ascii');
  image.writeUInt32BE(1880, 16);
  image.writeUInt32BE(800, 20);
  assert.deepEqual(readImageDimensions(image), { width: 1880, height: 800 });
});

test('读取 JPEG SOF 中的宽高而不解码像素', () => {
  const image = Buffer.alloc(30);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0]).copy(image);
  image.writeUInt16BE(17, 10);
  image[12] = 8;
  image.writeUInt16BE(800, 13);
  image.writeUInt16BE(1880, 15);
  assert.deepEqual(readImageDimensions(image), { width: 1880, height: 800 });
});

test('读取 GIF、BMP、WebP 与 SVG 尺寸', () => {
  const gif = Buffer.alloc(10);
  gif.write('GIF89a', 0, 'ascii');
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(240, 8);

  const bmp = Buffer.alloc(26);
  bmp.write('BM', 0, 'ascii');
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(640, 18);
  bmp.writeInt32LE(-360, 22);

  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii');
  webp.writeUInt32LE(22, 4);
  webp.write('WEBPVP8X', 8, 'ascii');
  webp.writeUInt32LE(10, 16);
  const width = 999;
  const height = 499;
  webp[24] = width & 0xff;
  webp[25] = (width >>> 8) & 0xff;
  webp[26] = (width >>> 16) & 0xff;
  webp[27] = height & 0xff;
  webp[28] = (height >>> 8) & 0xff;
  webp[29] = (height >>> 16) & 0xff;

  const svg = Buffer.from('<svg viewBox="0 0 1200 675"></svg>');
  assert.deepEqual(readImageDimensions(gif), { width: 320, height: 240 });
  assert.deepEqual(readImageDimensions(bmp), { width: 640, height: 360 });
  assert.deepEqual(readImageDimensions(webp), { width: 1000, height: 500 });
  assert.deepEqual(readImageDimensions(svg), { width: 1200, height: 675 });
});

test('SVG 显式像素尺寸优先于 viewBox，未知单位不伪装成像素', () => {
  assert.deepEqual(
    readImageDimensions(Buffer.from('<svg width="200px" height="100" viewBox="0 0 100 100"></svg>')),
    { width: 200, height: 100 },
  );
  assert.deepEqual(
    readImageDimensions(Buffer.from('<svg width="100%" height="100%" viewBox="0 0 16 9"></svg>')),
    { width: 16, height: 9 },
  );
  assert.equal(
    readImageDimensions(Buffer.from('<svg width="10cm" height="5cm"></svg>')),
    null,
  );
});

test('非图片或坏文件明确返回 null', () => {
  assert.equal(readImageDimensions(Buffer.from('not an image')), null);
  assert.equal(readImageDimensions(null), null);
});
