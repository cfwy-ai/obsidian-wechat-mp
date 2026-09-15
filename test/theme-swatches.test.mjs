import test from 'node:test';
import assert from 'node:assert/strict';
import { themeSwatches, themeSwatchClass } from '../plugin/theme-swatches.mjs';

test('纪念碑谷菜单色点按用户确认的白、灰、绿顺序提供', () => {
  assert.deepEqual(themeSwatches('monument-valley'), ['#FFFFFF', '#90958D', '#365241']);
  assert.equal(themeSwatchClass(themeSwatches('monument-valley')[0]), 'is-white');
});

test('星尘手记菜单色点按用户确认的黑、白、灰顺序提供', () => {
  assert.deepEqual(themeSwatches('cobalt-orbit'), ['#181818', '#FFFFFF', '#909090']);
});

test('简笔手绘菜单色点按明确的黑、白、黄顺序提供', () => {
  assert.deepEqual(themeSwatches('simple-sketch'), ['#1A1A19', '#FFFFFF', '#FFCE2E']);
});

test('黑夜女神菜单色点按黑、白、金顺序提供，金色与亮黄区分', () => {
  assert.deepEqual(themeSwatches('nyx-night'), ['#07080C', '#FFFFFF', '#C9A45C']);
  assert.equal(themeSwatchClass('#C9A45C'), 'is-gold');
  assert.equal(themeSwatchClass('#FFFFFF'), 'is-white');
  assert.equal(themeSwatchClass('#FFCE2E'), '');
});

test('其他主题与未知身份不从名称或说明猜测配色', () => {
  for (const themeId of ['stardust', '简笔手绘', '', undefined, null, 'toString']) {
    assert.deepEqual(themeSwatches(themeId), []);
  }
});

test('手绘卡通菜单色点按用户确认的白、灰、黄顺序，沿用主题色值', () => {
  assert.deepEqual(themeSwatches('cartoon-doodle'), ['#FFFFFF', '#CECECE', '#F2D16D']);
  assert.equal(themeSwatchClass(themeSwatches('cartoon-doodle')[0]), 'is-white');
  assert.equal(themeSwatchClass(themeSwatches('cartoon-doodle')[2]), '');
});

test('铅笔写意菜单色点按黑、白、灰顺序提供', () => {
  assert.deepEqual(themeSwatches('pencil-impression'), ['#22221F', '#FFFFFF', '#8B8B83']);
  assert.equal(themeSwatchClass(themeSwatches('pencil-impression')[1]), 'is-white');
});

test('调用者修改返回数组不会污染下次菜单渲染', () => {
  const colors = themeSwatches('simple-sketch');
  colors[0] = '#FF0000';
  colors.push('#00FF00');
  assert.deepEqual(themeSwatches('simple-sketch'), ['#1A1A19', '#FFFFFF', '#FFCE2E']);
});
