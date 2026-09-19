import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadImageElementDimensions,
  resolveGalleryImageRecords,
} from '../plugin/gallery-images.mjs';

const source = '> [!blank|gallery]\n> ![[a.png]]\n> ![[b.png]]';

test('运行时预取 gallery 图片尺寸并按文件版本缓存', async () => {
  const files = new Map([
    ['a.png', { path: '附件/a.png', stat: { mtime: 1, size: 10 } }],
    ['b.png', { path: '附件/b.png', stat: { mtime: 1, size: 20 } }],
  ]);
  const cache = new Map();
  let loads = 0;
  const options = {
    source,
    resolveFile: (target) => files.get(target) ?? null,
    getResourcePath: (file) => `app://local/${file.path}`,
    cache,
    loadDimensions: async () => {
      loads += 1;
      return { width: 1880, height: 800 };
    },
  };
  const first = await resolveGalleryImageRecords(options);
  const second = await resolveGalleryImageRecords(options);
  assert.equal(loads, 2);
  assert.deepEqual(first.get('a.png'), {
    url: 'app://local/附件/a.png',
    filePath: '附件/a.png',
    width: 1880,
    height: 800,
  });
  assert.deepEqual(second, first);

  files.get('a.png').stat.mtime = 2;
  await resolveGalleryImageRecords(options);
  assert.equal(loads, 3);
});

test('Chromium 解码失败时从文件头兜底', async () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(800, 16);
  png.writeUInt32BE(800, 20);
  const records = await resolveGalleryImageRecords({
    source: '> [!blank|gallery]\n> ![[a.png]]',
    resolveFile: () => ({ path: 'a.png', stat: { mtime: 1, size: png.length } }),
    getResourcePath: () => 'app://local/a.png',
    readBinary: async () => png,
    loadDimensions: async () => null,
  });
  assert.deepEqual(records.get('a.png'), {
    url: 'app://local/a.png',
    filePath: 'a.png',
    width: 800,
    height: 800,
  });
});

test('Image 元素返回用户实际看到的 naturalWidth/naturalHeight', async () => {
  class FakeImage {
    set src(_value) {
      this.complete = true;
      this.naturalWidth = 1880;
      this.naturalHeight = 800;
    }
  }
  assert.deepEqual(
    await loadImageElementDimensions('app://local/a.png', { ImageClass: FakeImage }),
    { width: 1880, height: 800 },
  );
});

test('瞬时解码失败不缓存 null，下次刷新会重试', async () => {
  let attempts = 0;
  const options = {
    source: '> [!blank|gallery]\n> ![[a.png]]',
    resolveFile: () => ({ path: 'a.png', stat: { mtime: 1, size: 10 } }),
    getResourcePath: () => 'app://local/a.png',
    cache: new Map(),
    loadDimensions: async () => {
      attempts += 1;
      return attempts === 1 ? null : { width: 2, height: 1 };
    },
  };
  const first = await resolveGalleryImageRecords(options);
  const second = await resolveGalleryImageRecords(options);
  assert.equal(first.get('a.png').width, undefined);
  assert.equal(second.get('a.png').width, 2);
  assert.equal(attempts, 2);
});

test('并发 refresh 与同文件别名共用一份进行中的尺寸解码', async () => {
  let release;
  let starts = 0;
  const deferred = new Promise((resolve) => { release = resolve; });
  const options = {
    source: '> [!blank|gallery]\n> ![[a.png]]\n> ![[folder/a.png]]',
    resolveFile: () => ({ path: 'folder/a.png', stat: { mtime: 1, size: 10 } }),
    getResourcePath: () => 'app://local/folder/a.png',
    cache: new Map(),
    loadDimensions: async () => {
      starts += 1;
      return deferred;
    },
  };
  const first = resolveGalleryImageRecords(options);
  const second = resolveGalleryImageRecords(options);
  await Promise.resolve();
  assert.equal(starts, 1);
  release({ width: 2, height: 1 });
  const [firstRecords, secondRecords] = await Promise.all([first, second]);
  assert.equal(firstRecords.get('a.png').width, 2);
  assert.equal(secondRecords.get('folder/a.png').width, 2);
});
