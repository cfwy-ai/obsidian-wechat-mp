import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanVaultFolder,
  compareNumberedNames,
  isPathInFolder,
} from '../src/vault-path.mjs';

test('目录设置去掉首尾斜杠并统一分隔符', () => {
  assert.equal(cleanVaultFolder(' /06｜个人账号运营\\3. 原创文章/ '), '06｜个人账号运营/3. 原创文章');
});

test('文件只匹配完整目录边界', () => {
  assert.equal(isPathInFolder('A/B/文章.md', 'A/B'), true);
  assert.equal(isPathInFolder('A/B2/文章.md', 'A/B'), false);
  assert.equal(isPathInFolder('A/B', 'A/B'), true);
});

test('主题文件按数字前缀排序，无序号的放最后', () => {
  const names = ['10. 丙风格.md', '无序号风格.md', '2. 乙风格.md', '1. 甲风格.md'];
  assert.deepEqual(names.sort(compareNumberedNames), [
    '1. 甲风格.md',
    '2. 乙风格.md',
    '10. 丙风格.md',
    '无序号风格.md',
  ]);
});
