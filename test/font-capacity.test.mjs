import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { parseThemeManifest, themeFontByteLimit } from '../src/theme-package.mjs';
import { HeadingImageRuntime } from '../plugin/heading-image.mjs';
import { prepareExportTitleTheme } from '../plugin/export-title-theme.mjs';

const MiB = 1024 * 1024;
const font = { font_id: 'old-print', file: '配套字体资源/original.ttf', family: 'OldPrint', sha256: 'a'.repeat(64) };
const parse = patch => parseThemeManifest(JSON.stringify({ schema_version: 3, theme_id: 'font-capacity', name: '字体容量', assets: [], components: [], fonts: [{ ...font, ...patch }] })).fonts[0];

test('完整大字库容量必须逐字体显式声明，默认结构与8MiB限制保持', () => {
  const defaults = parse({});
  assert.equal(Object.hasOwn(defaults, 'maxBytes'), false);
  assert.equal(themeFontByteLimit(defaults), 8 * MiB);
  assert.equal(parse({ max_file_bytes: 40 * MiB }).maxBytes, 40 * MiB);
  for (const value of [null, 0, 7 * MiB, 40 * MiB + 1, 9 * MiB + .5, 'unlimited']) {
    assert.throws(() => parse({ max_file_bytes: value }), /max_file_bytes/);
  }
});

test('大字库仍校验实际字节和SHA，缓存不能绕过收窄的限制', async () => {
  const bytes = Buffer.alloc(9 * MiB, 7);
  let reads = 0, loads = 0;
  class Face { async load() { loads++; return this; } }
  const runtime = new HeadingImageRuntime({
    vault: { readBinary: async () => { reads++; return bytes; } },
    document: {}, FontFaceClass: Face, fontSet: { add() {}, delete() {} },
  });
  const descriptor = { id: 'old-print', filePath: '主题/配套字体资源/original.ttf', file: { stat: { size: bytes.length, mtime: 1 } }, sha256: createHash('sha256').update(bytes).digest('hex'), style: 'normal', weight: 400 };
  await assert.rejects(runtime.loadFont(descriptor), /8 MiB/);
  assert.equal(reads, 0);
  const allowed = { ...descriptor, maxBytes: 16 * MiB };
  assert.equal(await runtime.loadFont(allowed), await runtime.loadFont(allowed));
  assert.equal(loads, 1);
  await assert.rejects(runtime.loadFont(descriptor), /8 MiB/);
  await assert.rejects(runtime.loadFont({ ...descriptor, file: { stat: { size: 0, mtime: 2 } } }), /8 MiB/);
  await assert.rejects(runtime.loadFont({ ...allowed, sha256: '0'.repeat(64) }), /SHA-256/);
  await assert.rejects(runtime.loadFont({ ...allowed, maxBytes: 41 * MiB }), /8–40/);
  runtime.dispose();
});

test('导出主标题与预览使用同一字体容量契约', async () => {
  const bytes = Buffer.alloc(9 * MiB, 3);
  const descriptor = { id: 'old-print', file: { stat: { size: bytes.length } }, sha256: createHash('sha256').update(bytes).digest('hex'), weight: 400, style: 'normal' };
  const options = { headingImages: [{ fontId: 'old-print', headingLevels: [1] }], readBinary: async () => bytes };
  const blocked = await prepareExportTitleTheme({ ...options, fonts: [descriptor] });
  assert.equal(blocked.family, 'inherit');
  assert.equal(blocked.warnings.length, 1);
  const allowed = await prepareExportTitleTheme({ ...options, fonts: [{ ...descriptor, maxBytes: 16 * MiB }] });
  assert.equal(allowed.warnings.length, 0);
  assert.match(allowed.family, /^cfwx-export-/);
});
