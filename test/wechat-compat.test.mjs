import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterWechatCompatibleHtml,
  filterWechatStyle,
  extractWechatStyleAttributes,
  normalizeWechatColors,
  rewriteWechatBackgroundImage,
  singleBackgroundImageUrl,
} from '../src/wechat-compat.mjs';

test('literal none is safe without image registration, including harmless retained background geometry', () => {
  for (const value of ['none', 'NONE', ' nOnE ']) {
    const result = filterWechatStyle(`background-image:${value};background-repeat:no-repeat;background-size:100% auto;background-position:left top`);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.backgroundImageUrls, []);
    assert.match(result.style, /background-image:\s*none/i);
  }
  for (const value of ['url("app://unregistered.png")', 'none,url("app://unregistered.png")', 'none url("app://unregistered.png")']) {
    const result = filterWechatStyle(`background-image:${value}`);
    assert.ok(result.removed.length > 0);
    assert.deepEqual(result.backgroundImageUrls, []);
    assert.doesNotMatch(result.style, /background-image/);
  }
});

test('保留微信粘贴白名单内的文字、间距、纯色背景与边框', () => {
  const result = filterWechatStyle([
    'color:#223344',
    'font-size:16px',
    'line-height:1.8',
    'padding:12px 16px',
    'background-color:#F7F3EA',
    'border-left:4px solid #557799',
    'border-radius:8px',
    'display:block',
    'white-space:pre-wrap',
  ].join(';'));

  assert.equal(result.removed.length, 0);
  assert.match(result.style, /background-color:#F7F3EA/);
  assert.match(result.style, /border-left:4px solid #557799/);
  assert.match(result.style, /white-space:pre-wrap/);
});

test('移除预览能显示但微信粘贴不稳定的布局与装饰', () => {
  const result = filterWechatStyle([
    'position:relative',
    'transform:translateY(-2px)',
    'box-shadow:0 8px 16px rgba(0,0,0,.1)',
    'background-image:linear-gradient(#fff,#eee)',
    'display:flex',
    'overflow:hidden',
    'margin-top:-4px',
    'color:#333333',
  ].join(';'));

  assert.match(result.style, /color:#333333/);
  assert.doesNotMatch(result.style, /position|transform|box-shadow|gradient|flex|overflow|-4px/);
  assert.deepEqual(
    new Set(result.removed.map((item) => item.property)),
    new Set(['position', 'transform', 'box-shadow', 'background-image', 'display', 'overflow', 'margin-top']),
  );
});

test('只保留 allowlist 内的单个受管背景图与保守平铺参数', () => {
  const url = 'app://vault/paper-grain.png';
  const result = filterWechatStyle([
    'background-color:#F7F8FA',
    `background-image:url("${url}")`,
    'background-repeat:repeat',
    'background-position:center top',
    'background-size:320px 40%',
  ].join(';'), { allowedBackgroundUrls: [url] });

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.backgroundImageUrls, [url]);
  assert.match(result.style, /background-image:url\(["']app:\/\/vault\/paper-grain\.png["']\)/);
  assert.match(result.style, /background-repeat:repeat/);
  assert.match(result.style, /background-position:center top/);
  assert.match(result.style, /background-size:320px 40%/);
});

test('外链、未登记、多背景、渐变和危险背景参数仍被拒绝', () => {
  const managed = 'file:///tmp/grain.png';
  const cases = [
    { value: 'background-image:url("https://example.com/a.png")', allowed: [] },
    { value: `background-image:url("${managed}")`, allowed: [] },
    {
      value: `background-image:url("${managed}"),url("${managed}")`,
      allowed: [managed],
    },
    { value: 'background-image:linear-gradient(#fff,#eee)', allowed: [] },
  ];
  for (const item of cases) {
    const result = filterWechatStyle(item.value, { allowedBackgroundUrls: item.allowed });
    assert.equal(result.style, '');
    assert.equal(result.removed.length, 1);
  }

  const unsafeParameters = filterWechatStyle([
    `background-image:url("${managed}")`,
    'background-repeat:round',
    'background-position:calc(50% - 2px)',
    'background-size:100vw auto',
  ].join(';'), { allowedBackgroundUrls: [managed] });
  assert.match(unsafeParameters.style, /background-image/);
  assert.doesNotMatch(unsafeParameters.style, /background-repeat|background-position|background-size/);
  assert.equal(unsafeParameters.removed.length, 3);
});

test('安全背景 URL 解析仅接受本地协议与 PNG\/JPEG data URL', () => {
  assert.equal(singleBackgroundImageUrl('url("local://asset/a.png")'), 'local://asset/a.png');
  assert.equal(singleBackgroundImageUrl('url(data:image/png;base64,AQID)'), 'data:image/png;base64,AQID');
  assert.equal(singleBackgroundImageUrl('url(data:image/svg+xml;base64,PHN2Zz4=)'), null);
  assert.equal(singleBackgroundImageUrl('url("https://example.com/a.png")'), null);
  assert.equal(singleBackgroundImageUrl('url("file:///a.png"), url("file:///b.png")'), null);
});

test('背景 allowlist 必须精确匹配，辅助属性不能脱离受管图片独立存活', () => {
  const allowed = 'app://vault/grain.png?revision=1#paper';
  const nearMatches = [
    'app://vault/grain.png',
    'app://vault/grain.png?revision=1',
    'app://vault/grain.png?revision=2#paper',
  ];
  for (const url of nearMatches) {
    const result = filterWechatStyle(`background-image:url("${url}")`, {
      allowedBackgroundUrls: [allowed],
    });
    assert.equal(result.style, '');
  }
  const helpersOnly = filterWechatStyle(
    'background-repeat:repeat;background-position:center top;background-size:320px auto',
  );
  assert.equal(helpersOnly.style, '');
  assert.equal(helpersOnly.removed.length, 3);
});

test('即使伪造 allowlist，危险协议和非位图 data URL 仍不能通过', () => {
  const urls = [
    '//example.com/a.png',
    'https://example.com/a.png',
    'javascript:alert(1)',
    'blob:https://example.com/id',
    'data:image/svg+xml;base64,PHN2Zz4=',
  ];
  for (const url of urls) {
    const result = filterWechatStyle(`background-image:url("${url}")`, {
      allowedBackgroundUrls: [url],
    });
    assert.equal(result.style, '');
  }
});

test('复制阶段能改写或单独删除背景图，且保留背景色', () => {
  const source = 'app://vault/grain.png';
  const html = `<section style="background-color:#F7F8FA;background-image:url('${source}');background-repeat:repeat"><p>正文</p></section>`;
  const replaced = rewriteWechatBackgroundImage(
    html,
    source,
    'data:image/png;base64,AQID',
  );
  assert.equal(replaced.rewrittenCount, 1);
  assert.match(replaced.html, /background-color:#F7F8FA/);
  assert.match(replaced.html, /data:image\/png;base64,AQID/);

  const removed = rewriteWechatBackgroundImage(html, source, null);
  assert.equal(removed.rewrittenCount, 1);
  assert.match(removed.html, /background-color:#F7F8FA/);
  assert.match(removed.html, /background-repeat:repeat/);
  assert.doesNotMatch(removed.html, /background-image|app:\/\//);
  assert.doesNotMatch(removed.html, /图片\s*1/);
});

test('HSL 和 RGBA 转成稳定 HEX，透明色按白底合成', () => {
  assert.deepEqual(normalizeWechatColors('1px solid hsl(216, 100%, 68%)'), {
    value: '1px solid #5C9DFF',
    changed: true,
  });
  assert.deepEqual(normalizeWechatColors('rgba(0, 0, 0, 0.1)'), {
    value: '#E6E6E6',
    changed: true,
  });
  assert.deepEqual(normalizeWechatColors('hsla(0, 100%, 50%, 0.5)'), {
    value: '#FF8080',
    changed: true,
  });
});

test('纯色关键字 background 不会被误删', () => {
  const result = filterWechatStyle('background:white;color:black');
  assert.equal(result.removed.length, 0);
  assert.match(result.style, /background:white/);
});

test('整篇 HTML 过滤后保留 section#nice 与纯色根背景', () => {
  const result = filterWechatCompatibleHtml([
    '<section id="nice" style="background-color:#FBF6EC;padding:20px;box-shadow:0 2px 8px #999">',
    '<p style="color:hsl(216, 100%, 68%);position:relative">\u6b63\u6587</p>',
    '</section>',
  ].join(''));

  assert.match(result.html, /^<section id="nice"/);
  assert.match(result.html, /background-color:#FBF6EC/);
  assert.match(result.html, /color:#5C9DFF/);
  assert.doesNotMatch(result.html, /box-shadow|position/);
  assert.equal(result.removedCount, 2);
  assert.equal(result.normalizedColorCount, 1);
  assert.match(result.warnings[0], /已移除 2 处/);
});

test('不依赖 class 和 id 的选择器样式，过滤后仍全是行内 style', () => {
  const result = filterWechatCompatibleHtml(
    '<section id="nice"><h2 class="title" style="color:#334455;padding:8px">\u6807\u9898</h2></section>',
  );
  assert.match(result.html, /class="title" style="color:#334455;\s*padding:8px;?"/);
  assert.doesNotMatch(result.html, /<style|#nice\s/);
});

test('只处理元素的真实 style 属性，不改正文和代码字面量', () => {
  const html = [
    '<section id="nice" style="color:red;position:relative">',
    '<p>正文 style="position:relative" 保留</p>',
    '<pre><code>&lt;p style="position:relative"&gt;</code></pre>',
    '</section>',
  ].join('');
  const result = filterWechatCompatibleHtml(html);

  assert.match(result.html, /<section id="nice" style="color:red;?"/);
  assert.match(result.html, /正文 style="position:relative" 保留/);
  assert.match(result.html, /&lt;p style="position:relative"&gt;/);
  assert.equal(result.removedCount, 1);
});

test('审计只提取真实 style 属性，不把正文 CSS 词当样式', () => {
  const styles = extractWechatStyleAttributes(
    '<p style="color:red">正文 box-shadow 与 position:relative</p>',
  );
  assert.deepEqual(styles, ['color:red']);
});
