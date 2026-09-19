import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectGalleryImageTargets,
  materializeGalleryCallouts,
} from '../src/gallery.mjs';
import { renderArticle } from '../src/pipeline.mjs';

const source = [
  '> [!blank|gallery]',
  '> ![[wide.png]]',
  '> ![[square.png]]',
  '',
  '正文',
].join('\n');

const records = {
  'wide.png': { url: 'app://local/wide.png', filePath: 'wide.png', width: 1880, height: 800 },
  'square.png': { url: 'app://local/square.png', filePath: 'square.png', width: 800, height: 800 },
};

const styleValue = (style, property) =>
  new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`, 'i').exec(style)?.[1]?.replace(/\s*!important\s*$/i, '').trim();

test('按源图比例生成有明确分组的 gallery 行', () => {
  const result = materializeGalleryCallouts(source, (target) => records[target]);
  assert.match(result.markdown, /<section data-wechat-gallery-row="gallery-1" data-wechat-gallery-layout="justified">/);
  assert.match(result.markdown, /!\[\[wide\.png\]\]\!\[\[square\.png\]\]<\/section>/);
  assert.match(result.css, /nth-child\(1\).*width:69\.097015%/s);
  assert.match(result.css, /nth-child\(2\).*width:29\.402985%/s);
  assert.equal(result.warnings.length, 0);
});

test('最终 HTML 只用微信白名单属性，并覆盖主题的 48% 等宽规则', () => {
  const result = renderArticle({
    source,
    themeCss: [
      '#nice img { display:block; width:100%; max-width:100%; height:auto; margin:24px auto 26px; border:2px solid #ddd; }',
      '#nice img:has(+ img), #nice img + img { display:inline-block; width:48%; max-width:48%; vertical-align:middle; }',
    ].join('\n'),
    resolve: (target) => records[target],
  });
  const styles = [...result.html.matchAll(/<img\b[^>]*style="([^"]*)"/g)].map((match) => match[1]);
  assert.equal(styles.length, 2);
  const widths = styles.map((style) => Number.parseFloat(styleValue(style, 'width')));
  assert.ok(Math.abs(widths[0] / 2.35 - widths[1]) < 0.00001);
  assert.ok(Math.abs(widths[0] + widths[1] + 1.5 - 100) < 0.00001);
  assert.deepEqual(styles.map((style) => styleValue(style, 'vertical-align')), ['top', 'top']);
  assert.deepEqual(styles.map((style) => styleValue(style, 'border-width')), ['0', '0']);
  assert.match(result.html, /data-wechat-gallery-layout="justified"/);
  assert.doesNotMatch(result.html, /(?:display:\s*(?:flex|grid)|calc\(|aspect-ratio|object-fit)/i);
  assert.equal(result.compatibility.removedStyleCount, 0);
  assert.deepEqual(result.warnings, []);
});

test('空引用行严格保留作者指定的 gallery 换行', () => {
  const input = [
    '> [!blank|gallery]',
    '> ![[a.png]]',
    '> ![[b.png]]',
    '>',
    '> ![[c.png]]',
  ].join('\n');
  const resolver = (target) => ({ url: `app://local/${target}`, width: 100, height: 100 });
  const result = materializeGalleryCallouts(input, resolver);
  assert.equal((result.markdown.match(/data-wechat-gallery-row=/g) ?? []).length, 2);
  assert.match(result.markdown, /gallery-1[^>]*>!\[\[a\.png\]\]\!\[\[b\.png\]\]<\/section>/);
  assert.match(result.markdown, /gallery-2[^>]*>!\[\[c\.png\]\]<\/section>/);
});

test('三张以上仍按比例排满，超多图片不会算出负宽度', () => {
  const four = '> [!blank|gallery]\n> ![[a.png]]\n> ![[b.png]]\n> ![[c.png]]\n> ![[d.png]]';
  const result = materializeGalleryCallouts(
    four,
    (target) => ({ url: `app://local/${target}`, width: 100, height: 100 }),
  );
  const widths = [...result.css.matchAll(/nth-child\(\d+\)\{width:([\d.]+)%/g)]
    .map((match) => Number(match[1]));
  assert.equal(widths.length, 4);
  assert.ok(Math.abs(widths.reduce((sum, width) => sum + width, 0) + 4.5 - 100) < 0.00001);

  const many = [
    '> [!blank|gallery]',
    ...Array.from({ length: 80 }, (_value, index) => `> ![[${index}.png]]`),
  ].join('\n');
  const crowded = materializeGalleryCallouts(
    many,
    (target) => ({ url: `app://local/${target}`, width: 1, height: 1 }),
  );
  const crowdedWidths = [...crowded.css.matchAll(/nth-child\(\d+\)\{width:([\d.]+)%/g)]
    .map((match) => Number(match[1]));
  assert.equal(crowdedWidths.length, 80);
  assert.ok(crowdedWidths.every((width) => width > 0));
});

test('尺寸不可用时整行纵向回退并给出可见警告', () => {
  const result = renderArticle({
    source,
    themeCss: '#nice img { width:48%; }',
    resolve: (target) => `app://local/${target}`,
  });
  assert.match(result.html, /data-wechat-gallery-layout="stacked"/);
  const styles = [...result.html.matchAll(/<img\b[^>]*style="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(styles.map((style) => styleValue(style, 'display')), ['block', 'block']);
  assert.deepEqual(styles.map((style) => styleValue(style, 'width')), ['100%', '100%']);
  assert.match(result.warnings[0], /尺寸不可用.*wide\.png.*square\.png/);
});

test('主题 CSS 语法损坏时仍保住核心 gallery 布局并报告主题失败', () => {
  const result = renderArticle({
    source,
    themeCss: '#nice { color: red;',
    resolve: (target) => records[target],
  });
  assert.equal(result.inlineLevel, 'none');
  assert.match(result.warnings.join('\n'), /主题 CSS 语法错误/);
  assert.match(result.html, /data-wechat-gallery-layout="justified"/);
  assert.match(result.html, /width:\s*69\.097015%/);
  assert.equal(result.compatibility.removedStyleCount, 0);
});

test('只收集真实 gallery callout 的图片并去重', () => {
  const input = [
    '![[outside.png]]',
    '> [!blank|gallery]',
    '> ![[a.png|300]] ![[b.jpg|说明]]',
    '> ![[a.png]]',
    '',
    '> [!note]',
    '> ![[note.png]]',
  ].join('\n');
  assert.deepEqual(collectGalleryImageTargets(input), ['a.png', 'b.jpg']);
});

test('gallery 中的非图片正文按旧行为展开，不伪装成图片行', () => {
  const input = '> [!blank|gallery]\n> 一句说明\n> ![[a.png]]';
  const result = materializeGalleryCallouts(input, () => ({ url: 'app://local/a.png', width: 1, height: 1 }));
  assert.equal(result.markdown, '一句说明\n![[a.png]]');
  assert.equal(result.css, '');
});

test('代码围栏里的 gallery 示例保持原样且不预取图片', () => {
  for (const input of [
    ['```markdown', '> [!blank|gallery]', '> ![[example.png]]', '```'].join('\n'),
    ['> ```markdown', '> [!blank|gallery]', '> ![[example.png]]', '> ```'].join('\n'),
    ['- ```markdown', '  > [!blank|gallery]', '  > ![[example.png]]', '  ```'].join('\n'),
  ]) {
    const result = materializeGalleryCallouts(input, () => {
      throw new Error('不应解析代码示例');
    });
    assert.equal(result.markdown, input);
    assert.deepEqual(collectGalleryImageTargets(input), []);
  }
});

test('不支持的嵌入不会参与 gallery 几何或打乱受支持图片序号', () => {
  const input = '> [!blank|gallery]\n> ![[first.avif]]\n> ![[a.png]]\n> ![[last.pdf]]\n> ![[b.png]]';
  const resolver = (target) => ({ url: `app://local/${target}`, width: 100, height: 100 });
  const prepared = materializeGalleryCallouts(input, resolver);
  assert.deepEqual(collectGalleryImageTargets(input), ['a.png', 'b.png']);
  assert.equal((prepared.css.match(/nth-child\(/g) ?? []).length, 2);
  const result = renderArticle({ source: input, themeCss: '', resolve: resolver });
  assert.equal((result.html.match(/<img\b/g) ?? []).length, 2);
  assert.match(result.html, /width:\s*49\.25%/);
});

test('CommonMark 允许的三格缩进 gallery 仍能识别', () => {
  const input = '   > [!blank|gallery]\n   > ![[a.png]]\n   > ![[b.png]]';
  const resolver = (target) => ({ url: `app://local/${target}`, width: 1, height: 1 });
  const result = materializeGalleryCallouts(input, resolver);
  assert.match(result.markdown, /data-wechat-gallery-layout="justified"/);
  assert.deepEqual(collectGalleryImageTargets(input), ['a.png', 'b.png']);
});

test('gallery 后即使没有手写空行，后续正文仍按 Markdown 段落渲染', () => {
  const input = '> [!blank|gallery]\n> ![[a.png]]\n> ![[b.png]]\n紧随正文';
  const resolver = (target) => ({ url: `app://local/${target}`, width: 1, height: 1 });
  const result = renderArticle({ source: input, themeCss: '#nice p{color:red}', resolve: resolver });
  assert.match(result.html, /<\/section>\s*<p style="color:\s*red;?">紧随正文<\/p>/);
});

test('同一 gallery 内图片行与说明文字无论先后都保持独立段落', () => {
  const resolver = (target) => ({ url: `app://local/${target}`, width: 1, height: 1 });
  for (const input of [
    '> [!blank|gallery]\n> ![[a.png]]\n>\n> 图片说明',
    '> [!blank|gallery]\n> 图片说明\n>\n> ![[a.png]]',
  ]) {
    const result = renderArticle({ source: input, themeCss: '#nice p{color:red}', resolve: resolver });
    assert.match(result.html, /<p style="color:\s*red;?">图片说明<\/p>/);
    assert.equal((result.html.match(/data-wechat-gallery-row=/g) ?? []).length, 1);
  }
});
