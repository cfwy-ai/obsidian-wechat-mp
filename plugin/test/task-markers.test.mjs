import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materializeEmptyTaskMarkers } from '../src/task-markers.mjs';
import { renderArticle } from '../src/pipeline.mjs';

test('主题自行画框且隐藏原字形时，输出不再携带内层方框字符', () => {
  const before='<p><span class="wechat-task-marker is-unchecked" role="img" aria-label="未完成" style="border:1px solid #111;color:transparent;display:inline">☐</span>待办未完成</p>';
  const html=materializeEmptyTaskMarkers(before);
  assert.doesNotMatch(html,/☐/);
  assert.match(html,/aria-label="未完成"/);
  assert.match(html,/border:1px solid #111/);
  assert.match(html,/\u00a0\u00a0\u00a0<\/span>待办未完成/);
  // Restoring foreground color can no longer reveal a hidden checkbox glyph.
  assert.doesNotMatch(html.replace('color:transparent','color:#111'),/☐/);
});

test('已完成符号、未画框的默认主题与其他透明文字不被改变', () => {
  const html='<span class="wechat-task-marker is-checked" style="color:transparent">✓</span><span class="wechat-task-marker is-unchecked" style="color:#111">☐</span><span style="color:transparent">其他文字</span>';
  assert.equal(materializeEmptyTaskMarkers(html),html);
});

test('遵循最终色值，不把已恢复可见颜色的标记清空', () => {
  const html='<span class="wechat-task-marker is-unchecked" style="color:transparent;color:#111">☐</span>';
  assert.equal(materializeEmptyTaskMarkers(html),html);
});

test('生产渲染管线将空框占位物化，同时保留同段结构和已完成勾', () => {
  const result=renderArticle({source:'- [ ] 未完成\n- [x] 已完成',themeCss:'#nice .wechat-task-marker {display:inline;border:1px solid #111;} #nice .wechat-task-marker.is-unchecked {color:transparent}',resolve:()=>null});
  assert.doesNotMatch(result.html,/☐/);
  assert.match(result.html,/✓<\/span>已完成/);
  assert.equal((result.html.match(/class="wechat-task-line"/g)??[]).length,2);
  assert.deepEqual(result.warnings,[]);
});
