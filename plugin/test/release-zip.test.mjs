import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { writeZip } from '../scripts/zip.mjs';

test('发布ZIP为中文路径设置UTF-8标志，正文可解压且同输入输出一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-zip-'));
  try {
    const path = join(root, 'source.txt');
    await writeFile(path, '把时间还给创作。');
    const name = 'changfeng-wechat-mp/templates/简笔手绘/主题视觉规范/1. 视觉风格总则.md';
    await writeZip(join(root, 'first.zip'), [{ name, path }]);
    await writeZip(join(root, 'second.zip'), [{ name, path }]);
    const bytes = await readFile(join(root, 'first.zip'));
    assert.deepEqual(bytes, await readFile(join(root, 'second.zip')));
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    assert.equal(bytes.readUInt16LE(6) & 0x0800, 0x0800);
    const nameLength = bytes.readUInt16LE(26);
    assert.equal(bytes.subarray(30, 30 + nameLength).toString('utf8'), name);
    const size = bytes.readUInt32LE(18);
    assert.equal(inflateRawSync(bytes.subarray(30 + nameLength, 30 + nameLength + size)).toString(), '把时间还给创作。');
    const central = 30 + nameLength + size;
    assert.equal(bytes.readUInt32LE(central), 0x02014b50);
    assert.equal(bytes.readUInt16LE(central + 8) & 0x0800, 0x0800);
    assert.equal(bytes.subarray(central + 46, central + 46 + nameLength).toString('utf8'), name);
  } finally { await rm(root, { recursive: true, force: true }); }
});
