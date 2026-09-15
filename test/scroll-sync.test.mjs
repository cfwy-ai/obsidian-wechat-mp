import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getScrollRatio, setScrollRatio, syncScrollPosition } from '../plugin/scroll-sync.mjs';

test('按可滚动范围计算进度，不用绝对像素', () => {
  const element = { scrollTop: 300, scrollHeight: 1000, clientHeight: 400 };
  assert.equal(getScrollRatio(element), 0.5);
});

test('写入滚动进度时会限制在 0 到 1', () => {
  const element = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
  setScrollRatio(element, 2);
  assert.equal(element.scrollTop, 600);
  setScrollRatio(element, -1);
  assert.equal(element.scrollTop, 0);
});

test('两边高度不同时同步相对位置', () => {
  const source = { scrollTop: 250, scrollHeight: 750, clientHeight: 250 };
  const target = { scrollTop: 0, scrollHeight: 2200, clientHeight: 200 };
  syncScrollPosition(source, target);
  assert.equal(target.scrollTop, 1000);
});
