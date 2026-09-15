import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'htmlparser2';
import { renderArticle, unwrapGalleryCallouts } from '../src/pipeline.mjs';
import { copyRenderedArticle } from '../plugin/copy.mjs';

test('共用管线连起 frontmatter、wikilink、Markdown 和 CSS 内联', () => {
  const source = '---\ntype: 文章\n---\n\n## 小标题\n\n![[a.png]]';
  const result = renderArticle({
    source,
    themeCss: '#nice h2 { color: red; }',
    resolve: (target) => `app://local/${target}`,
  });

  assert.equal(result.frontmatter, 'type: 文章');
  assert.match(result.html, /<h2 style="color:\s*red;?"><span class="content">小标题<\/span><\/h2>/);
  assert.match(result.html, /<img src="app:\/\/local\/a\.png"\s*\/?>/);
  assert.deepEqual(result.images.map((image) => image.target), ['a.png']);
  assert.equal(result.inlineLevel, 'full');
  assert.equal(result.stage, 'wechat-compatible');
});

test('共用管线保留图片解析警告', () => {
  const result = renderArticle({
    source: '![[缺失.png]]',
    themeCss: '#nice { color: black; }',
    resolve: () => null,
  });

  assert.equal(result.images.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /缺失\.png/);
});

test('共用管线对非字符串输入明确报错', () => {
  assert.throws(
    () => renderArticle({ source: null, themeCss: '', resolve: () => null }),
    /文章原文/,
  );
});

test('高亮与静态待办经过净化、内联、兼容及复制后仍保留', async () => {
  const result = renderArticle({
    source: '==高亮== 和 <mark>标签高亮</mark>\n\n- 普通\n- [ ] 未完成\n- [x] 已完成',
    themeCss: '#nice mark { background-color:#FFCE2E; color:#1A1A19; }',
    resolve: () => null,
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.compatibility.removedStyleCount, 0);
  assert.equal((result.html.match(/<mark\b[^>]*style=/g) || []).length, 2);
  assert.doesNotMatch(result.html, /<input|==高亮==/);
  assert.match(result.html, /is-unchecked" style="list-style-type:none"/);
  assert.match(result.html, /is-checked" style="list-style-type:none"/);
  let payload;
  const copy = await copyRenderedArticle({
    html: result.html, text: '高亮和待办', images: result.images,
    _clipboard: { write: value => { payload = value; } },
  });
  assert.deepEqual(copy.warnings, []);
  assert.match(payload.html, /background-color:#FFCE2E/);
  assert.ok(payload.html.includes('☐') && payload.html.includes('✓'));
  assert.doesNotMatch(payload.html, /<input/);
});

test('展开 Obsidian 图库布局指令，不把指令或引用块样式带进正文', () => {
  const source = [
    '> [!blank|gallery]',
    '> ![[a.png]]',
    '> ![[b.png]]',
    '',
    '正文',
  ].join('\n');
  const result = renderArticle({
    source,
    themeCss: '#nice blockquote { color: red; }',
    resolve: (target) => `app://local/${target}`,
  });

  assert.doesNotMatch(result.html, /blank\|gallery/);
  assert.doesNotMatch(result.html, /<blockquote/);
  assert.equal((result.html.match(/<img\b/g) ?? []).length, 2);
});

test('普通引用与其他 callout 不被图库预处理误改', () => {
  const source = '> 普通引用\n\n> [!note]\n> 备注';
  assert.equal(unwrapGalleryCallouts(source), source);
});

test('共用管线在预览和复制前移除微信粘贴不稳定样式', () => {
  const result = renderArticle({
    source: '> 引用',
    themeCss: [
      '#nice { background-color:#F8F4EA; padding:16px; }',
      '#nice blockquote { color:#333; position:relative; box-shadow:0 8px 16px #999; background:linear-gradient(#fff,#eee); }',
    ].join('\n'),
    resolve: () => null,
  });

  assert.match(result.html, /^<section id="nice"/);
  assert.match(result.html, /background-color:\s*#F8F4EA/);
  assert.doesNotMatch(result.html, /position|box-shadow|gradient/);
  assert.equal(result.compatibility.removedStyleCount, 3);
  assert.match(result.warnings.at(-1), /不稳定样式/);
});

test('块前组件经过净化、内联及复制，代码三头像仍同排且正文结构一致', async () => {
  const themeAssets = ['peek', 'happy', 'angry', 'sweet'].map((id) => ({
    id,
    url: `app://theme/${id}.png`,
    filePath: `主题/透明装饰素材/${id}.png`,
  }));
  const result = renderArticle({
    source: [
      '> 第一段引用。', '>', '> 第二段引用。', '',
      '| 项目 | 预期 |', '| --- | --- |', '| 文字 | 保持活内容 |', '',
      '```html', '<table>代码内伪表格</table>', '```',
    ].join('\n'),
    themeAssets,
    themeComponents: [
      {
        id: 'quote-peek', slot: 'before_blockquote', assetIds: ['peek'],
        html: '<p class="quote-peek"><img src="theme-asset://peek" onerror="bad()"></p>',
      },
      {
        id: 'table-peek', slot: 'before_table', assetIds: ['peek'],
        html: '<p class="table-peek"><img src="theme-asset://peek"></p>',
      },
      {
        id: 'code-cats', slot: 'before_codeblock', assetIds: ['happy', 'angry', 'sweet'],
        html: '<p class="code-cats">' + ['happy', 'angry', 'sweet']
          .map((id) => `<img src="theme-asset://${id}" alt="${id}">`).join('') + '</p>',
      },
    ],
    themeCss: [
      '#nice p.quote-peek, #nice p.table-peek {margin:24px 0 0; line-height:0;}',
      '#nice p.table-peek {text-align:right;}',
      '#nice .quote-peek img, #nice .table-peek img {display:inline-block; width:80px; height:auto;}',
      '#nice blockquote {border:2px solid #999999; border-radius:12px; padding:16px 16px 16px 56px; font-size:18px;}',
      '#nice p.code-cats {margin:24px 0 0; padding:10px 14px; background-color:#EEEEEE; border-radius:8px 8px 0 0;}',
      '#nice p.code-cats img {display:inline-block; width:28px; height:28px; margin-right:8px; vertical-align:middle;}',
      '#nice pre {margin:0; padding:0 14px 14px; background-color:#EEEEEE; border-radius:0 0 8px 8px;}',
    ].join('\n'),
    resolve: () => null,
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.compatibility.removedStyleCount, 0);
  assert.doesNotMatch(result.html, /onerror|theme-asset|position:|display:flex/);
  assert.equal(result.images.length, 4);
  let payload;
  const copied = await copyRenderedArticle({
    html: result.html,
    text: '第一段引用。第二段引用。文字保持活内容。',
    images: result.images,
    resolveFile: (target) => ({ path: target, stat: { size: 3 } }),
    readBinary: async () => Uint8Array.from([1, 2, 3]).buffer,
    embedImages: true,
    _clipboard: { write: (value) => { payload = value; } },
  });
  assert.deepEqual(copied.warnings, []);
  const normalizeImageSources = (html) => html.replace(/(<img\b[^>]*\bsrc=")[^"]*(")/g, '$1IMAGE$2');
  assert.equal(normalizeImageSources(payload.html), normalizeImageSources(result.html));
  for (const html of [result.html, payload.html]) {
    const root = parseDocument(html).children.find((node) => node.name === 'section');
    const headerIndex = root.children.findIndex((node) => node.attribs?.class === 'code-cats');
    const header = root.children[headerIndex];
    const avatars = header.children.filter((node) => node.name === 'img');
    assert.equal(header.name, 'p');
    assert.equal(avatars.length, 3);
    assert.ok(avatars.every((node) => /display:inline-block/.test(node.attribs.style)
      && /width:28px/.test(node.attribs.style)
      && /vertical-align:middle/.test(node.attribs.style)));
    assert.equal(root.children.slice(headerIndex + 1).find((node) => node.type === 'tag').name, 'pre');
    assert.match(html, /第一段引用。/);
    assert.match(html, /第二段引用。/);
    assert.match(html, /保持活内容/);
  }
  assert.doesNotMatch(payload.html, /app:\/\//);
});
