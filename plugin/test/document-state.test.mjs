import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activateMarkdownDocument,
  focusMarkdownDocument,
  handleCurrentDocumentDeletion,
  refreshThemeDocument,
  rememberMarkdownDocument,
  renderedArticleUsesFile,
} from '../plugin/document-state.mjs';

test('删除当前文档时清掉滚动源并立即刷新', () => {
  const current = { path: 'A.md' };
  const calls = [];
  const owner = {
    currentDocument: current,
    currentSourceLeaf: { id: 'source' },
    updatePreviewSources: () => calls.push('sources'),
    scheduleRefresh: () => calls.push('refresh'),
  };

  assert.equal(handleCurrentDocumentDeletion(owner, current), true);
  assert.equal(owner.currentDocument, null);
  assert.equal(owner.currentSourceLeaf, null);
  assert.deepEqual(calls, ['sources', 'refresh']);
});

test('删除其他文件不改当前文档状态', () => {
  const current = { path: 'A.md' };
  const owner = {
    currentDocument: current,
    currentSourceLeaf: { id: 'source' },
    updatePreviewSources: () => assert.fail('不应更新源'),
    scheduleRefresh: () => assert.fail('不应刷新'),
  };

  assert.equal(handleCurrentDocumentDeletion(owner, { path: 'B.md' }), false);
  assert.equal(owner.currentDocument, current);
});

test('只把当前渲染实际使用的精确图片路径视为刷新依赖', () => {
  const render = {
    images: [
      { target: 'same.png', filePath: '附件/一/same.png' },
      { target: 'same.png', filePath: '附件/二/same.png' },
    ],
  };
  assert.equal(renderedArticleUsesFile(render, '附件/一/same.png'), true);
  assert.equal(renderedArticleUsesFile(render, '附件/same.png'), false);
  assert.equal(renderedArticleUsesFile(null, '附件/一/same.png'), false);
});

test('预览开启时从 A 切换到 B 会立即更换文档、滚动源与刷新内容', () => {
  const calls = [];
  const owner = {
    currentDocument: null,
    currentSourceLeaf: null,
    updatePreviewSources: () => calls.push({ type: 'sources' }),
    scheduleRefresh: (context) => calls.push({ type: 'refresh', context }),
  };

  activateMarkdownDocument(owner, {
    file: { path: 'A.md' },
    sourceLeaf: { id: 'leaf-a' },
    articleSource: '# A',
  });
  activateMarkdownDocument(owner, {
    file: { path: 'B.md' },
    sourceLeaf: { id: 'leaf-b' },
    articleSource: '# B',
  });

  assert.equal(owner.currentDocument.path, 'B.md');
  assert.equal(owner.currentSourceLeaf.id, 'leaf-b');
  assert.deepEqual(calls, [
    { type: 'sources' },
    { type: 'refresh', context: { articlePath: 'A.md', articleSource: '# A' } },
    { type: 'sources' },
    { type: 'refresh', context: { articlePath: 'B.md', articleSource: '# B' } },
  ]);
});

test('预览关闭时切换文档只记录状态，不读正文也不更新预览', () => {
  const owner = {
    currentDocument: null,
    currentSourceLeaf: null,
    hasPreviewView: () => false,
    updatePreviewSources: () => assert.fail('不应更新预览源'),
    scheduleRefresh: () => assert.fail('不应请求渲染'),
  };

  const refreshed = focusMarkdownDocument(owner, {
    file: { path: 'B.md' },
    sourceLeaf: { id: 'leaf-b' },
    readArticleSource: () => assert.fail('不应读取编辑器正文'),
  });

  assert.equal(refreshed, false);
  assert.equal(owner.currentDocument.path, 'B.md');
  assert.equal(owner.currentSourceLeaf.id, 'leaf-b');
});

test('预览开启时才读取正文并刷新', () => {
  const calls = [];
  const owner = {
    currentDocument: null,
    currentSourceLeaf: null,
    hasPreviewView: () => true,
    updatePreviewSources: () => calls.push('sources'),
    scheduleRefresh: (context) => calls.push(context),
  };

  const refreshed = focusMarkdownDocument(owner, {
    file: { path: 'B.md' },
    sourceLeaf: { id: 'leaf-b' },
    readArticleSource: () => {
      calls.push('read');
      return '# B';
    },
  });

  assert.equal(refreshed, true);
  assert.deepEqual(calls, [
    'read',
    'sources',
    { articlePath: 'B.md', articleSource: '# B' },
  ]);
});

test('预览关闭时编辑主题不读取主题源文本', () => {
  const owner = {
    hasPreviewView: () => false,
    scheduleRefresh: () => assert.fail('不应请求渲染'),
  };

  const refreshed = refreshThemeDocument(owner, {
    file: { path: '3. 经典蓝调风格.md' },
    readThemeSource: () => assert.fail('不应读取主题源文本'),
  });

  assert.equal(refreshed, false);
});

test('只记录 Markdown 时不会触发任何预览副作用', () => {
  const owner = {
    currentDocument: null,
    currentSourceLeaf: null,
    updatePreviewSources: () => assert.fail('不应更新预览源'),
    scheduleRefresh: () => assert.fail('不应请求渲染'),
  };

  rememberMarkdownDocument(owner, {
    file: { path: 'A.md' },
    sourceLeaf: { id: 'leaf-a' },
  });

  assert.equal(owner.currentDocument.path, 'A.md');
  assert.equal(owner.currentSourceLeaf.id, 'leaf-a');
});

test('预览关闭时删除当前文档也只清理状态', () => {
  const current = { path: 'A.md' };
  const owner = {
    currentDocument: current,
    currentSourceLeaf: { id: 'source' },
    hasPreviewView: () => false,
    updatePreviewSources: () => assert.fail('不应更新预览源'),
    scheduleRefresh: () => assert.fail('不应请求渲染'),
  };

  assert.equal(handleCurrentDocumentDeletion(owner, current), true);
  assert.equal(owner.currentDocument, null);
  assert.equal(owner.currentSourceLeaf, null);
});
