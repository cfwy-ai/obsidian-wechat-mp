import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFilesystemImageResolver } from '../tools/filesystem-image-resolver.mjs';

const pngHeader = () => {
  const image = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(image);
  image.write('IHDR', 12, 'ascii');
  image.writeUInt32BE(20, 16);
  image.writeUInt32BE(10, 20);
  return image;
};

test('文件系统图片 resolver 阻止越界并正确编码文件 URL', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'wechat-gallery-resolver-'));
  try {
    const root = join(sandbox, 'attachments');
    const image = join(root, 'folder', 'a#b?.png');
    mkdirSync(dirname(image), { recursive: true });
    writeFileSync(image, pngHeader());
    writeFileSync(join(sandbox, 'outside.png'), pngHeader());
    const resolveImage = createFilesystemImageResolver(root);
    const record = resolveImage('folder/a#b?.png');
    assert.deepEqual({ width: record.width, height: record.height }, { width: 20, height: 10 });
    assert.match(record.url, /a%23b%3F\.png$/);
    assert.equal(resolveImage('../outside.png'), null);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
