import assert from 'node:assert/strict';
import test from 'node:test';
import { getHeadingBreakContext, planHeadingBreakEdit } from '../plugin/heading-break-edit.mjs';

const contextAt = (source, line = 0, ch = 3) => getHeadingBreakContext(source, { line, ch });
const editAt = (source, ch, options = {}) => planHeadingBreakEdit({
  source, cursor: { line: 0, ch }, action: 'insert', ...options,
});

test('locates a top-level ATX H1 and plans a single full-line insertion', () => {
  const source = '# 多开对话很爽，难的是它们怎么配合';
  assert.deepEqual(contextAt(source), {
    ok: true, level: 1, line: 0, lineText: source, contentStart: 2,
    contentEnd: source.length, hasBreak: false, breakCount: 0,
  });
  const ch = source.indexOf('难');
  assert.deepEqual(editAt(source, ch, { maxLines: 2 }), {
    ok: true,
    change: {
      from: { line: 0, ch: 0 }, to: { line: 0, ch: source.length },
      text: '# 多开对话很爽，<br>难的是它们怎么配合',
    },
    cursor: { line: 0, ch: ch + 4 },
  });
});

test('all six top-level ATX levels expose level and share insertion and reset', () => {
  for (let level = 1; level <= 6; level += 1) {
    const prefix = `${'#'.repeat(level)} `;
    const source = `${prefix}通用标题文字`;
    const context = contextAt(source, 0, prefix.length + 2);
    assert.equal(context.ok, true, source);
    assert.equal(context.level, level);
    assert.equal(context.contentStart, prefix.length);
    assert.equal(context.contentEnd, source.length);
    const inserted = editAt(source, prefix.length + 2);
    assert.equal(inserted.change.text, `${prefix}通用<br>标题文字`);
    assert.deepEqual(inserted.change.from, { line: 0, ch: 0 });
    assert.deepEqual(inserted.change.to, { line: 0, ch: source.length });
    const reset = editAt(inserted.change.text, inserted.cursor.ch, { action: 'reset' });
    assert.equal(reset.change.text, source);
  }
});

test('each ATX level keeps legal indentation, tab delimiter and closing hashes intact', () => {
  for (let level = 1; level <= 6; level += 1) {
    const prefix = `   ${'#'.repeat(level)}\t`;
    const source = `${prefix}通用标题 ##  `;
    assert.equal(contextAt(source, 0, prefix.length + 2).level, level);
    assert.equal(editAt(source, prefix.length + 2).change.text, `${prefix}通用<br>标题 ##  `);
    assert.equal(editAt(source, source.length - 1).ok, false);
  }
});

test('ignores out-of-range headings, Setext, plain hash text, indented/fenced code and nested headings', () => {
  for (const [source, line, ch] of [
    ['####### 超出六级', 0, 9], ['正文里的 # 假标题', 0, 8], ['#没有空格', 0, 3],
    ['Setext\n======', 0, 3], ['    # 缩进代码', 0, 8], ['\t# 缩进代码', 0, 5],
    ['```markdown\n# 围栏代码\n```', 1, 4], ['~~~\n# 围栏代码\n~~~', 1, 4],
    ['> # 引用标题', 0, 6], ['- 项目\n  # 列表标题', 1, 6], ['1. # 列表标题', 0, 7],
    ['<div>\n# HTML 内标题\n</div>', 1, 5], ['<!--\n# 注释标题\n-->', 1, 4],
    ['<script>\n# 脚本内容\n</script>', 1, 4],
  ]) assert.equal(contextAt(source, line, ch).ok, false, source);
});

test('frontmatter is excluded including BOM, end marker and unfinished properties', () => {
  for (const delimiter of ['---', '...']) {
    const source = `\uFEFF---\ntitle: Test\n# 属性里的标题\n${delimiter}\n# 正文标题`;
    assert.equal(contextAt(source, 2, 4).ok, false);
    assert.equal(contextAt(source, 4, 4).ok, true);
  }
  assert.equal(contextAt('---\ntitle: incomplete\n# 仍在属性区', 2, 4).ok, false);
});

test('all levels remain protected inside YAML, code, quotes, nested lists and HTML', () => {
  for (let level = 1; level <= 6; level += 1) {
    const heading = `${'#'.repeat(level)} 受保护标题`;
    const cases = [
      [`---\ntitle: example\n${heading}\n---`, 2, level + 3],
      [`\uFEFF---\n${heading}\n...`, 1, level + 3],
      [`---\n${heading}`, 1, level + 3],
      [`\`\`\`md\n${heading}\n\`\`\``, 1, level + 3],
      [`~~~\n${heading}\n~~~`, 1, level + 3],
      [`    ${heading}`, 0, level + 7],
      [`> ${heading}`, 0, level + 5],
      [`- 父列表\n  ${heading}`, 1, level + 5],
      [`1. ${heading}`, 0, level + 6],
      [`<div>\n${heading}\n</div>`, 1, level + 3],
    ];
    for (const [source, line, ch] of cases) {
      assert.equal(contextAt(source, line, ch).ok, false, source);
      assert.equal(editAt(source, ch, { cursor: { line, ch } }).ok, false, source);
    }
  }
});

test('locates duplicate H1s precisely after other block tokens and CRLF', () => {
  const lines = ['[ref]: https://example.com', '', '```', '# 重复标题', '```', '', '# 重复标题', '', '# 重复标题'];
  for (const newline of ['\n', '\r\n', '\r']) {
    const source = lines.join(newline);
    assert.equal(contextAt(source, 3, 4).ok, false);
    assert.equal(contextAt(source, 6, 4).line, 6);
    const edit = editAt(source, 4, { cursor: { line: 8, ch: 4 } });
    assert.equal(edit.change.from.line, 8);
    assert.equal(edit.change.text, '# 重复<br>标题');
  }
});

test('mixed-level duplicate headings are targeted by source position, not text or first match', () => {
  const lines = ['# 重复标题', '', '## 重复标题', '', '### 重复标题', '', '## 重复标题', '', '###### 重复标题'];
  const source = lines.join('\r\n');
  for (const [line, level] of [[0, 1], [2, 2], [4, 3], [6, 2], [8, 6]]) {
    const cursor = { line, ch: level + 3 };
    const context = getHeadingBreakContext(source, cursor);
    assert.equal(context.level, level);
    const edit = planHeadingBreakEdit({ source, cursor, action: 'insert' });
    assert.deepEqual(edit.change.from, { line, ch: 0 });
    assert.equal(edit.change.text, `${'#'.repeat(level)} 重复<br>标题`);
  }
});

test('preserves permitted indentation, tabs and closing hashes outside title content', () => {
  const source = '   #\tTitle words ###  ';
  const context = contextAt(source, 0, 10);
  assert.equal(context.contentStart, 5);
  assert.equal(context.contentEnd, 16);
  assert.equal(editAt(source, 11).change.text, '   #\tTitle <br>words ###  ');
  assert.equal(editAt(source, 18).ok, false);
  assert.equal(contextAt('# ###').ok, false);
  assert.equal(contextAt('#   ').ok, false);
  assert.equal(contextAt('# abc###').contentEnd, 8);
});

test('rejects title edges, whitespace-only segments and adjacent manual breaks', () => {
  for (const [source, ch] of [
    ['# 标题文字', 0], ['# 标题文字', 2], ['# 标题文字', 6],
    ['# 前半 <br> 后半', 5], ['# 前半 <br> 后半', 9],
    ['# &nbsp;标题', 8], ['# 标题&#32;', 4], ['# \u200b标题', 3],
  ]) assert.equal(editAt(source, ch).ok, false, `${source} at ${ch}`);
});

test('recognizes uppercase/self-closing br and protects the interior of their tags', () => {
  const source = '# 前半<BR />中间<br/>后半';
  assert.equal(contextAt(source).breakCount, 2);
  assert.equal(editAt(source, 7).ok, false);
  const reset = editAt(source, 12, { action: 'reset' });
  assert.equal(reset.change.text, '# 前半中间后半');
});

test('does not split entities or UTF-16 surrogate pairs', () => {
  for (const source of ['# A &amp; B', '# A &#x1F680; B', '# A &copy; B']) {
    assert.equal(editAt(source, source.indexOf('&') + 2).ok, false);
    assert.equal(editAt(source, source.indexOf('&')).ok, true);
  }
  const source = '# AI 🚀 写作';
  assert.equal(editAt(source, source.indexOf('🚀') + 1).ok, false);
  assert.equal(editAt(source, source.indexOf('🚀')).ok, true);
});

test('rejects complex inline formats for insertion', () => {
  for (const source of [
    '# **加粗**标题', '# 标题 *强调*', '# [链接](https://example.com) 标题',
    '# 标题 `code` 内容', '# 标题 ~~删除~~ 内容', '# 标题 <em>强调</em>',
    '# 标题 ![图片](x.png)', '# 标题\\*星号',
  ]) assert.equal(editAt(source, 3).ok, false, source);
});

test('plain punctuation is supported and literal br in code/escaped text does not count', () => {
  assert.equal(editAt('# 标题（说明）：后半', 9).ok, true);
  for (const source of ['# 标题 `<br>` 内容', '# 标题 \\<br> 内容', '# 标题 <!-- <br> --> 内容']) {
    assert.equal(contextAt(source).hasBreak, false, source);
    assert.equal(editAt(source, 3, { action: 'reset' }).ok, false, source);
  }
});

test('respects optional image maxLines and maxBreaks without imposing a default cap', () => {
  assert.equal(editAt('# 前后', 3, { maxLines: 1 }).ok, false);
  assert.equal(editAt('# 前<br>中后', 8, { maxLines: 2 }).ok, false);
  assert.equal(editAt('# 前<br>中后', 8, { maxLines: 3 }).ok, true);
  assert.equal(editAt('# 前<br>中<br>后尾', 13, { maxLines: 8, maxBreaks: 2 }).ok, false);
  assert.equal(editAt('# 前<br>中<br>后尾', 13, { maxLines: 8 }).ok, true);
  assert.equal(editAt('# 前<br>中<br>后尾', 13, { maxBreaks: 2 }).ok, false);
  assert.equal(editAt('# 前<br>中后', 8, { maxLines: 2.9 }).ok, false);
});

test('ordinary live-text headings accept more than four manual breaks at every level', () => {
  for (let level = 1; level <= 6; level += 1) {
    const original = `${'#'.repeat(level)} 甲乙丙丁戊己庚`;
    let source = original;
    for (const word of ['乙', '丙', '丁', '戊', '己']) {
      const edit = editAt(source, source.indexOf(word));
      assert.equal(edit.ok, true, source);
      source = edit.change.text;
    }
    assert.equal(contextAt(source, 0, level + 2).breakCount, 5);
    assert.equal(editAt(source, source.length, { action: 'reset' }).change.text, original);
  }
});

test('reset joins Chinese without added spaces and retains English word boundaries', () => {
  for (const [source, expected] of [
    ['# 前半，<br>后半', '# 前半，后半'],
    ['# Hello<br>world', '# Hello world'],
    ['# Hello <br> world', '# Hello world'],
    ['# Hello<br>, world', '# Hello, world'],
    ['# AI<br>写作', '# AI写作'],
    ['# 前半 <br> 后半', '# 前半 后半'],
    ['# <br>前半<br>', '# 前半'],
    ['# Hello<br><BR />world ###', '# Hello world ###'],
  ]) {
    const edit = editAt(source, source.length, { action: 'reset' });
    assert.equal(edit.change.text, expected, source);
    assert.equal(edit.cursor.ch, expected.length, source);
  }
});

test('reset only actual breaks and keeps complex inline content unchanged', () => {
  const source = '# **前<br>后** 与 `<br>` 以及 [a<br>b](https://example.com)';
  const context = contextAt(source);
  assert.equal(context.breakCount, 2);
  const edit = editAt(source, 8, { action: 'reset' });
  assert.equal(edit.change.text, '# **前后** 与 `<br>` 以及 [a b](https://example.com)');
});

test('H2–H6 keep complex-insertion restrictions while reset ignores code and escaped br', () => {
  for (let level = 2; level <= 6; level += 1) {
    const prefix = `${'#'.repeat(level)} `;
    const source = `${prefix}**前<br>后** 与 \`<br>\` 以及 \\<br> 和 [a<br>b](https://example.com)`;
    const context = contextAt(source, 0, prefix.length + 3);
    assert.equal(context.level, level);
    assert.equal(context.breakCount, 2);
    assert.equal(editAt(source, prefix.length + 3).ok, false);
    const reset = editAt(source, source.length, { action: 'reset' });
    assert.equal(reset.change.text, `${prefix}**前后** 与 \`<br>\` 以及 \\<br> 和 [a b](https://example.com)`);
  }
});

test('reset maps cursor positions and never touches neighboring paragraphs', () => {
  const source = '开头\n# A<br>B<br>C\n正文<br>保留';
  for (const [ch, expectedCh] of [[2, 2], [4, 4], [8, 5], [12, 6], [13, 7]]) {
    const edit = editAt(source, ch, { action: 'reset', cursor: { line: 1, ch } });
    assert.equal(edit.change.text, '# A B C');
    assert.deepEqual(edit.change.from, { line: 1, ch: 0 });
    assert.deepEqual(edit.change.to, { line: 1, ch: 13 });
    assert.deepEqual(edit.cursor, { line: 1, ch: expectedCh }, `cursor ${ch}`);
  }
});

test('a changed source invalidates cached heading positions and inline breaks', () => {
  const plain = '# 缓存标题\n\n正文';
  assert.equal(contextAt(plain).breakCount, 0);
  assert.equal(contextAt(plain, 0, 4).breakCount, 0);
  const updated = '# 缓存<br>标题\n\n正文';
  assert.equal(contextAt(updated).breakCount, 1);
  assert.equal(contextAt('```\n' + updated + '\n```', 1, 4).ok, false);
  assert.equal(contextAt(plain).breakCount, 0);
});

test('fails safely for stale, invalid or absent cursor and unsupported actions', () => {
  for (const cursor of [undefined, { line: -1, ch: 0 }, { line: 1, ch: 0 },
    { line: 0, ch: 200 }, { line: 0, ch: 2.5 }, { line: 0, ch: -1 }]) {
    assert.equal(getHeadingBreakContext('# 标题', cursor).ok, false);
  }
  assert.equal(getHeadingBreakContext(null, { line: 0, ch: 0 }).ok, false);
  assert.equal(planHeadingBreakEdit().ok, false);
  assert.equal(editAt('# 标题', 3, { action: 'delete' }).ok, false);
});
