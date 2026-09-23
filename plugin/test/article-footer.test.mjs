import test from 'node:test';
import assert from 'node:assert/strict';
import { articleFooterAvailable, resolveArticleFooter } from '../src/article-footer.mjs';

const opening = { component_id: 'x-opening', slot: 'before_article', html: '<p>开</p>' };
const footer = { component_id: 'x-ending', slot: 'after_article', html: '<p>尾</p>' };
const heading = { component_id: 'x-h1', slot: 'before_heading', heading_levels: [1], html: '<p>题</p>' };
const all = [opening, heading, footer];

test('主题声明了 after_article 才算有尾图', () => {
  assert.equal(articleFooterAvailable(all), true);
  assert.equal(articleFooterAvailable([opening, heading]), false);
  assert.equal(articleFooterAvailable([]), false);
  assert.equal(articleFooterAvailable(undefined), false);
});

test('没有设置时保留主题原有尾图', () => {
  for (const selection of [undefined, null, {}, { enabled: true }]) {
    const result = resolveArticleFooter({ selection, components: all });
    assert.deepEqual(result.components, all);
    assert.deepEqual(result.warnings, []);
  }
});

test('关闭后只摘掉尾图，其余组件原样保留', () => {
  const result = resolveArticleFooter({ selection: { enabled: false }, components: all });
  assert.deepEqual(result.components, [opening, heading]);
  assert.deepEqual(result.warnings, []);
  // 不改动传入的数组本身。
  assert.deepEqual(all, [opening, heading, footer]);
});

test('主题本来就没有尾图时，关闭不报警告也不改版面', () => {
  const result = resolveArticleFooter({ selection: { enabled: false }, components: [opening] });
  assert.deepEqual(result.components, [opening]);
  assert.deepEqual(result.warnings, []);
});

test('设置格式不对时保留尾图并给出提示，不静默改版面', () => {
  for (const selection of ['false', 0, [], { enabled: 'no' }]) {
    const result = resolveArticleFooter({ selection, components: all });
    assert.deepEqual(result.components, all, `${JSON.stringify(selection)} 不应改动组件`);
    assert.deepEqual(result.warnings, ['文章尾图设置格式不正确，已保留主题尾图']);
  }
});

test('多个 after_article 组件会一起摘掉', () => {
  const second = { component_id: 'x-ending-2', slot: 'after_article', html: '<p>尾二</p>' };
  const result = resolveArticleFooter({ selection: { enabled: false }, components: [...all, second] });
  assert.deepEqual(result.components, [opening, heading]);
});
