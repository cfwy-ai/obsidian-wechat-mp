import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  countRenderedImageReferences,
  copyRenderedArticle,
  createCopyLock,
  createCopySnapshot,
  DEFAULT_MAX_PROCESSED_RESOURCES,
  formatCopyResultNotice,
  imageMimeType,
  replaceImageSource,
  replaceImageWithPlaceholder,
  replaceRenderedImageSource,
  removeRenderedImageSource,
} from '../plugin/copy.mjs';

test('按扩展名产出图片 MIME', () => {
  assert.equal(imageMimeType('a.PNG'), 'image/png');
  assert.equal(imageMimeType('a.jpeg'), 'image/jpeg');
  assert.equal(imageMimeType('a.unknown'), 'application/octet-stream');
});

test('只替换指定图片的 src', () => {
  const html = '<p><img src="app://a.png"><img src="app://b.png"></p>';
  assert.equal(
    replaceImageSource(html, 'app://a.png', 'data:image/png;base64,AA=='),
    '<p><img src="data:image/png;base64,AA=="><img src="app://b.png"></p>',
  );
});

test('图片引用计数保留普通 URL、重复引用与零命中的既有语义', () => {
  const source = 'app://theme/title.png';
  const html = [
    `<img src="${source}">`,
    `<p><img src='${source}'></p>`,
    '<img src="app://theme/other.png">',
  ].join('');
  assert.deepEqual(countRenderedImageReferences(html, source), {
    imageCount: 2,
    backgroundCount: 0,
    total: 2,
  });
  assert.deepEqual(countRenderedImageReferences(html, 'app://theme/missing.png'), {
    imageCount: 0,
    backgroundCount: 0,
    total: 0,
  });
});

test('图片无法内嵌时留可见占位，不留本地裂图', () => {
  const html = replaceImageWithPlaceholder('<p><img src="app://a.png"></p>', 'app://a.png', '【图片 1】');
  assert.doesNotMatch(html, /app:\/\//);
  assert.match(html, /【图片 1】/);
});

test('行内图片的占位不会产生嵌套段落', () => {
  const html = replaceImageWithPlaceholder(
    '<p>正文 <img src="app://a.png"> 继续</p>',
    'app://a.png',
    '【图片 1】',
  );
  assert.doesNotMatch(html, /<p[^>]*>\s*<p/i);
  assert.match(html, /<p>正文 <span[^>]*display:block[^>]*>【图片 1】<\/span> 继续<\/p>/);
});

test('受管背景和 img 共用同一资源时可一次替换，失败则按用途分别降级', () => {
  const source = 'app://theme/shared.png';
  const html = [
    `<section style="background-color:#F7F8FA;background-image:url('${source}')">`,
    `<img src="${source}"><p>正文</p></section>`,
  ].join('');
  const replaced = replaceRenderedImageSource(html, source, 'data:image/png;base64,AQID');
  assert.equal((replaced.match(/data:image\/png;base64,AQID/g) ?? []).length, 2);

  const removed = removeRenderedImageSource(html, source, '【图片 1】');
  assert.match(removed, /background-color:#F7F8FA/);
  assert.doesNotMatch(removed, /background-image|app:\/\//);
  assert.equal((removed.match(/【图片 1】/g) ?? []).length, 1);
});

test('复制快照要求文章与风格同时匹配', () => {
  const article = { path: 'A.md' };
  const render = { articlePath: 'A.md', themePath: 'theme.md', html: '<p>A</p>', images: [] };
  assert.deepEqual(
    createCopySnapshot({ render, article, themePath: 'theme.md' }),
    { article, render },
  );
  assert.equal(createCopySnapshot({ render, article: { path: 'B.md' }, themePath: 'theme.md' }), null);
  assert.equal(createCopySnapshot({ render, article, themePath: 'other.md' }), null);
});

test('复制锁在释放前拒绝第二个并发任务', () => {
  const lock = createCopyLock();
  assert.equal(lock.acquire(), true);
  assert.equal(lock.locked, true);
  assert.equal(lock.acquire(), false);
  lock.release();
  assert.equal(lock.locked, false);
  assert.equal(lock.acquire(), true);
});

test('剪贴板同时写入富文本与纯文本，并将本地图转为 data URL', async () => {
  let payload;
  const result = await copyRenderedArticle({
    html: '<div id="nice"><img src="app://a.png"><p>正文</p></div>',
    text: '正文',
    images: [{ target: 'a.png', url: 'app://a.png' }],
    resolveFile: () => ({ stat: { size: 3 } }),
    readBinary: async () => Uint8Array.from([1, 2, 3]).buffer,
    embedImages: true,
    _clipboard: { write: (value) => { payload = value; } },
  });

  assert.equal(result.embeddedCount, 1);
  assert.equal(payload.text, '正文');
  assert.match(payload.html, /data:image\/png;base64,AQID/);
});

test('内存标题 PNG 进入既有复制门禁，不读取本地文件或泄露字体路径', async () => {
  const source = 'data:image/png;base64,AA==';
  let payload;
  let resolves = 0;
  let reads = 0;
  const result = await copyRenderedArticle({
    html: `<h1><img src="${source}" alt="核心参数"></h1>`,
    text: '核心参数',
    images: [{
      target: 'generated-heading.png',
      url: source,
      origin: 'generated',
      bytes: Uint8Array.from([1, 2, 3]),
      mimeType: 'image/png',
      fallbackHtml: '<span style="font-size:28px">核心参数</span>',
    }],
    resolveFile: () => { resolves += 1; return null; },
    readBinary: async () => { reads += 1; return new Uint8Array(); },
    transformImage: async (bytes) => ({ bytes, mimeType: 'image/png' }),
    embedImages: true,
    _clipboard: { write: (value) => { payload = value; } },
  });

  assert.equal(resolves, 0);
  assert.equal(reads, 0);
  assert.equal(result.embeddedCount, 1);
  assert.equal(payload.text, '核心参数');
  assert.match(payload.html, /data:image\/png;base64,AQID/);
  assert.doesNotMatch(payload.html, /file:\/\/|app:\/\/|\.ttf/);
});

for (const byteLength of [26_976, 50_995]) {
  test(`${byteLength} 字节量级的标题 Data URL 可重复计数并真正写入两种剪贴板格式`, async () => {
    const bytes = Buffer.alloc(byteLength, byteLength % 251);
    const source = `data:image/png;base64,${bytes.toString('base64')}`;
    const text = `标题 PNG ${byteLength}`;
    const html = `<h1><img src="${source}" alt="${text}"></h1><p><img src='${source}'></p>`;
    let payload = null;
    let writes = 0;
    const references = countRenderedImageReferences(html, source);
    assert.equal(references.imageCount, 2);

    const result = await copyRenderedArticle({
      html,
      text,
      images: [{
        target: `generated-heading-${byteLength}.png`,
        url: source,
        origin: 'generated',
        bytes,
        mimeType: 'image/png',
        fallbackHtml: `<span>${text}</span>`,
      }],
      resolveFile: () => null,
      readBinary: async () => { throw new Error('不应读取本地文件'); },
      transformImage: async (value) => ({ bytes: value, mimeType: 'image/png' }),
      embedImages: true,
      _clipboard: {
        write: (value) => {
          writes += 1;
          payload = value;
        },
      },
    });

    assert.equal(writes, 1);
    assert.equal(payload.text, text);
    assert.equal((payload.html.match(/data:image\/png;base64,/g) ?? []).length, 2);
    assert.match(payload.html, new RegExp(`alt="${text}"`));
    assert.equal(result.embeddedCount, 1);
    assert.equal(result.embeddedBytes, byteLength);
    assert.equal(result.warnings.length, 0);
  });
}

test('长 Data URL 图片触发门禁时仍能恢复 H1 活文字', async () => {
  const bytes = Buffer.alloc(26_976, 7);
  const source = `data:image/png;base64,${bytes.toString('base64')}`;
  let payload;
  const result = await copyRenderedArticle({
    html: `<h1><img src="${source}" alt="很长的标题"></h1>`,
    text: '很长的标题',
    images: [{
      target: 'generated-heading-long.png',
      url: source,
      origin: 'generated',
      bytes,
      mimeType: 'image/png',
      fallbackHtml: '<span class="content">很长的标题</span>',
    }],
    resolveFile: () => null,
    readBinary: async () => new Uint8Array(),
    transformImage: async (value) => ({ bytes: value, mimeType: 'image/png' }),
    embedImages: true,
    maxSingleImageBytes: 10,
    _clipboard: { write: (value) => { payload = value; } },
  });

  assert.equal(result.embeddedCount, 0);
  assert.equal(result.stats.degradationReasons.singleImageLimit, 1);
  assert.match(payload.html, /class="content">很长的标题<\/span>/);
  assert.doesNotMatch(payload.html, /data:image|【图片/);
});

test('内存标题 PNG 超限时恢复原活文字，不显示普通图片占位', async () => {
  const source = 'data:image/png;base64,AA==';
  let payload;
  const result = await copyRenderedArticle({
    html: `<h1><img src="${source}" alt="核心参数"></h1>`,
    text: '核心参数',
    images: [{
      target: 'generated-heading.png',
      url: source,
      origin: 'generated',
      bytes: Uint8Array.from([1, 2, 3]),
      mimeType: 'image/png',
      fallbackHtml: '<span style="font-size:28px">核心参数</span>',
    }],
    resolveFile: () => null,
    readBinary: async () => new Uint8Array(),
    transformImage: async () => ({ bytes: Uint8Array.from([1, 2, 3]), mimeType: 'image/png' }),
    embedImages: true,
    maxSingleImageBytes: 2,
    _clipboard: { write: (value) => { payload = value; } },
  });

  assert.equal(result.embeddedCount, 0);
  assert.match(payload.html, />核心参数<\/span>/);
  assert.doesNotMatch(payload.html, /【图片|data:image/);
});

for (const count of [20, 30, 50]) {
  test(`${count} 张小图在 HTML 容量内可全部复制，不存在固定 12 张配额`, async () => {
    assert.equal(DEFAULT_MAX_PROCESSED_RESOURCES, 128);
    const images = Array.from({ length: count }, (_, index) => ({
      target: `image-${index + 1}.png`,
      url: `app://image-${index + 1}.png`,
      origin: 'article',
    }));
    const html = images.map((image) => `<img src="${image.url}">`).join('');
    let payload;
    let reads = 0;
    const result = await copyRenderedArticle({
      html,
      text: '',
      images,
      resolveFile: (reference) => ({ path: reference, stat: { size: 3 } }),
      readBinary: async () => {
        reads += 1;
        return Uint8Array.from([1, 2, 3]);
      },
      embedImages: true,
      _clipboard: { write: (value) => { payload = value; } },
    });

    assert.equal(reads, count);
    assert.equal(result.imageCount, count);
    assert.equal(result.embeddedCount, count);
    assert.equal(result.stats.articleImages.embedded, count);
    assert.equal(result.stats.articleImages.placeholders, 0);
    assert.equal(result.warnings.length, 0);
    assert.equal((payload.html.match(/data:image\/png;base64,AQID/g) ?? []).length, count);
    assert.doesNotMatch(payload.html, /app:\/\/|【正文图片/);
  });
}

test('剪贴板会内嵌 CSS 背景图，读取失败时只删背景图并保留底色', async () => {
  const source = 'app://theme/grain.png';
  const html = `<section style="background-color:#F7F8FA;background-image:url('${source}');background-repeat:repeat"><p>正文</p></section>`;
  let payload;
  const embedded = await copyRenderedArticle({
    html,
    text: '正文',
    images: [{
      target: 'paper-grain',
      url: source,
      origin: 'theme',
      filePath: '主题/透明装饰素材/grain.png',
    }],
    resolveFile: () => ({ stat: { size: 3 } }),
    readBinary: async () => Uint8Array.from([1, 2, 3]),
    transformImage: async (bytes) => ({ bytes, mimeType: 'image/png' }),
    embedImages: true,
    _clipboard: { write: (value) => { payload = value; } },
  });
  assert.equal(embedded.embeddedCount, 1);
  assert.match(payload.html, /background-image:url\([^)]*data:image\/png;base64,AQID[^)]*\)/);

  const failed = await copyRenderedArticle({
    html,
    text: '正文',
    images: [{ target: 'paper-grain', url: source, origin: 'theme' }],
    resolveFile: () => null,
    readBinary: async () => new Uint8Array(),
    embedImages: true,
    _clipboard: { write: (value) => { payload = value; } },
  });
  assert.equal(failed.embeddedCount, 0);
  assert.match(payload.html, /background-color:#F7F8FA/);
  assert.doesNotMatch(payload.html, /background-image|app:\/\/|【图片 1】/);
});

test('仅用作背景的主题素材优先改写为 wechat_url，不读取本地二进制', async () => {
  const source = 'app://theme/grain.png';
  const wechatUrl = 'https://res.wx.qq.com/example/grain.png';
  const html = `<section style="background-color:#F7F8FA;background-image:url('${source}');background-repeat:repeat"><p>正文</p></section>`;
  let payload;
  let reads = 0;
  const result = await copyRenderedArticle({
    html,
    text: '正文',
    images: [{
      target: 'paper-grain',
      url: source,
      origin: 'theme',
      filePath: '主题/透明装饰素材/grain.png',
      wechatUrl,
    }],
    resolveFile: () => ({ stat: { size: 999 } }),
    readBinary: async () => {
      reads += 1;
      throw new Error('不应读取本地背景');
    },
    embedImages: true,
    _clipboard: { write: (value) => { payload = value; } },
  });

  assert.equal(reads, 0);
  assert.equal(result.embeddedCount, 1);
  assert.equal(result.remoteBackgroundCount, 1);
  assert.equal(result.embeddedBytes, 0);
  assert.equal(result.sourceBytesRead, 0);
  assert.equal(result.warnings.length, 0);
  assert.match(payload.html, /background-image:url\([^)]*https:\/\/res\.wx\.qq\.com\/example\/grain\.png[^)]*\)/);
  assert.doesNotMatch(payload.html, /app:\/\/|data:image/);
});

test('同一素材共用于 img 与背景时，背景走 wechat_url 而 img 仍走本地 data URL', async () => {
  const source = 'app://theme/shared.png';
  const wechatUrl = 'https://res.wx.qq.com/example/shared.png';
  const html = [
    `<section style="background-image:url('${source}');background-repeat:repeat">`,
    `<img src="${source}"><p>正文</p></section>`,
  ].join('');
  let payload;
  let reads = 0;
  const result = await copyRenderedArticle({
    html,
    text: '正文',
    images: [{
      target: 'shared',
      url: source,
      origin: 'theme',
      filePath: '主题/透明装饰素材/shared.png',
      wechatUrl,
    }],
    resolveFile: () => ({ stat: { size: 3 } }),
    readBinary: async () => {
      reads += 1;
      return Uint8Array.from([1, 2, 3]);
    },
    embedImages: true,
    _clipboard: { write: (value) => { payload = value; } },
  });

  assert.equal(reads, 1);
  assert.equal(result.embeddedCount, 1);
  assert.equal(result.remoteBackgroundCount, 1);
  assert.equal(result.embeddedBytes, 3);
  assert.match(payload.html, /background-image:url\([^)]*https:\/\/res\.wx\.qq\.com\/example\/shared\.png[^)]*\)/);
  assert.match(payload.html, /<img src="data:image\/png;base64,AQID"/);
  assert.doesNotMatch(payload.html, /app:\/\//);
});

test('图片标签自身带独立主题边框背景时，基线降级不误报丢失的背景令牌', async () => {
  const article = 'app://article/photo.png';
  const frame = 'app://theme/frame.png';
  const frameUrl = 'https://res.wx.qq.com/example/frame.png';
  let payload;
  const result = await copyRenderedArticle({
    html:`<img src="${article}" style="display:block;background-color:transparent;background-image:url('${frame}');background-size:100% 100%">`,
    text:'图片',
    images:[
      {target:'photo.png',url:article,origin:'article',filePath:'文章/photo.png'},
      {target:'frame',url:frame,origin:'theme',filePath:'主题/透明装饰素材/frame.png',wechatUrl:frameUrl},
    ],
    resolveFile:()=>({stat:{size:3}}),
    readBinary:async()=>Uint8Array.from([1,2,3]),
    embedImages:true,
    _clipboard:{write:value=>{payload=value}},
  });
  assert.equal(result.warnings.length,0);
  assert.match(payload.html,/src="data:image\/png;base64,AQID"/);
  assert.match(payload.html,/background-image:url\([^)]*https:\/\/res\.wx\.qq\.com\/example\/frame\.png/);
  assert.doesNotMatch(payload.html,/changfeng-clipboard-token|app:\/\//);
});

test('embedImages 关闭时不启用远程背景交付', async () => {
  const source = 'app://theme/grain.png';
  let payload;
  const result = await copyRenderedArticle({
    html: `<section style="background-color:#fff;background-image:url('${source}')">正文</section>`,
    text: '正文',
    images: [{
      target: 'paper-grain',
      url: source,
      wechatUrl: 'https://res.wx.qq.com/example/grain.png',
    }],
    resolveFile: () => ({ stat: { size: 3 } }),
    readBinary: async () => { throw new Error('不应读取'); },
    embedImages: false,
    _clipboard: { write: (value) => { payload = value; } },
  });

  assert.equal(result.embeddedCount, 0);
  assert.equal(result.remoteBackgroundCount, 0);
  assert.match(payload.html, /background-color:#fff/);
  assert.doesNotMatch(payload.html, /background-image|res\.wx\.qq\.com|app:\/\//);
});

test('复制阶段再次校验 wechat_url，被篡改的外部地址不会进入剪贴板', async () => {
  const source = 'app://theme/grain.png';
  let payload;
  const result = await copyRenderedArticle({
    html: `<section style="background-image:url('${source}')">正文</section>`,
    text: '正文',
    images: [{
      target: 'paper-grain',
      url: source,
      filePath: '主题/透明装饰素材/grain.png',
      wechatUrl: 'https://tracker.example.com/grain.png',
    }],
    resolveFile: () => ({ stat: { size: 3 } }),
    readBinary: async () => Uint8Array.from([1, 2, 3]),
    embedImages: true,
    _clipboard: { write: (value) => { payload = value; } },
  });

  assert.equal(result.embeddedCount, 1);
  assert.equal(result.remoteBackgroundCount, 0);
  assert.match(result.warnings[0], /微信官方/);
  assert.match(payload.html, /data:image\/png;base64,AQID/);
  assert.doesNotMatch(payload.html, /tracker\.example\.com/);
});

test('同一背景命中过多元素时先按 HTML 上限回退，不构建巨大结果', async () => {
  const source = 'app://theme/grain.png';
  const html = Array.from({ length: 20 }, () =>
    `<p style="background-color:#fff;background-image:url('${source}')">正文</p>`).join('');
  let payload;
  const result = await copyRenderedArticle({
    html,
    text: '正文',
    images: [{ target: 'grain', url: source, origin: 'theme' }],
    resolveFile: () => ({ stat: { size: 60 } }),
    readBinary: async () => Uint8Array.from({ length: 60 }, () => 1),
    transformImage: async (bytes) => ({ bytes, mimeType: 'image/png' }),
    embedImages: true,
    maxHtmlBytes: Buffer.byteLength(html, 'utf8') + 100,
    _clipboard: { write: (value) => { payload = value; } },
  });

  assert.equal(result.embeddedCount, 0);
  assert.match(result.warnings[0], /HTML 上限/);
  assert.doesNotMatch(payload.html, /background-image|app:\/\/|data:image/);
  assert.equal((payload.html.match(/background-color:#fff/g) ?? []).length, 20);
});

test('图片记录未在 HTML 中命中时不读图也不增加内嵌计数', async () => {
  let reads = 0;
  const result = await copyRenderedArticle({
    html: '<p>正文</p>',
    text: '正文',
    images: [{ target: 'stale.png', url: 'app://stale.png' }],
    resolveFile: () => ({ stat: { size: 3 } }),
    readBinary: async () => {
      reads += 1;
      return Uint8Array.from([1, 2, 3]);
    },
    embedImages: true,
    _clipboard: { write: () => {} },
  });
  assert.equal(reads, 0);
  assert.equal(result.embeddedCount, 0);
  assert.equal(result.embeddedBytes, 0);
  assert.match(result.warnings[0], /未找到可替换/);
});

test('超过上限时不构建超大剪贴板，改用占位', async () => {
  let payload;
  const result = await copyRenderedArticle({
    html: '<img src="app://a.png">',
    text: '',
    images: [{ target: 'a.png', url: 'app://a.png' }],
    resolveFile: () => ({ stat: { size: 20 } }),
    readBinary: async () => { throw new Error('不应读取'); },
    embedImages: true,
    maxImageBytes: 10,
    _clipboard: { write: (value) => { payload = value; } },
  });

  assert.equal(result.embeddedCount, 0);
  assert.equal(result.stats.degradationReasons.totalImageLimit, 1);
  assert.match(payload.html, /【正文图片 1】/);
  assert.match(result.warnings[0], /超过/);
  assert.match(formatCopyResultNotice(result), /总量上限 1 处/);
});

test('一张图超限不会让其他图整篇回退', async () => {
  let payload;
  const result = await copyRenderedArticle({
    html: '<img src="app://a.png"><img src="app://b.png">',
    text: '',
    images: [
      { target: 'a.png', url: 'app://a.png' },
      { target: 'b.png', url: 'app://b.png' },
    ],
    resolveFile: (target) => ({ path: target, stat: { size: target === 'a.png' ? 20 : 3 } }),
    readBinary: async (file) => file.path === 'a.png'
      ? Uint8Array.from({ length: 20 }, () => 1).buffer
      : Uint8Array.from([1, 2, 3]).buffer,
    embedImages: true,
    maxSingleImageBytes: 10,
    _clipboard: { write: (value) => { payload = value; } },
  });

  assert.equal(result.mode, 'mixed');
  assert.equal(result.embeddedCount, 1);
  assert.match(payload.html, /【正文图片 1】/);
  assert.match(payload.html, /data:image\/png;base64,AQID/);
});

test('HTML 体积额度按图判断，保留已经成功的前图', async () => {
  let payload;
  const result = await copyRenderedArticle({
    html: '<img src="app://a.png"><img src="app://b.png">',
    text: '',
    images: [
      { target: 'a.png', url: 'app://a.png' },
      { target: 'b.png', url: 'app://b.png' },
    ],
    resolveFile: (target) => ({ path: target, stat: { size: 300 } }),
    readBinary: async () => Buffer.alloc(300, 1),
    embedImages: true,
    maxHtmlBytes: 700,
    _clipboard: { write: (value) => { payload = value; } },
  });

  assert.equal(result.embeddedCount, 1);
  assert.equal(result.stats.degradationReasons.htmlLimit, 1);
  assert.equal((payload.html.match(/data:image\/png/g) ?? []).length, 1);
  assert.match(payload.html, /【正文图片 2】/);
  assert.match(formatCopyResultNotice(result), /HTML 上限 1 处/);
});

test('异常资源熔断会取消整次复制，不会静默缺图', async () => {
  let writes = 0;
  await assert.rejects(() => copyRenderedArticle({
    html: '<img src="app://a.png"><img src="app://b.png">',
    text: '',
    images: [
      { target: 'a.png', url: 'app://a.png' },
      { target: 'b.png', url: 'app://b.png' },
    ],
    resolveFile: (target) => ({ path: target, stat: { size: 3 } }),
    readBinary: async () => Uint8Array.from([1, 2, 3]).buffer,
    embedImages: true,
    maxProcessedResources: 1,
    _clipboard: { write: () => { writes += 1; } },
  }), /异常资源过多.*请检查文章/);
  assert.equal(writes, 0);
});

test('有转换器时仍在读图前拦截超大原图', async () => {
  let readCount = 0;
  let payload;
  const result = await copyRenderedArticle({
    html: '<img src="app://huge.png"><img src="app://small.png">',
    text: '',
    images: [
      { target: 'huge.png', url: 'app://huge.png' },
      { target: 'small.png', url: 'app://small.png' },
    ],
    resolveFile: (target) => ({
      path: target,
      stat: { size: target === 'huge.png' ? 100 : 3 },
    }),
    readBinary: async () => {
      readCount += 1;
      return Uint8Array.from([1, 2, 3]).buffer;
    },
    transformImage: async (bytes) => ({ bytes, mimeType: 'image/png' }),
    embedImages: true,
    maxSourceImageBytes: 10,
    _clipboard: { write: (value) => { payload = value; } },
  });

  assert.equal(readCount, 1);
  assert.equal(result.embeddedCount, 1);
  assert.match(payload.html, /【正文图片 1】/);
  assert.match(payload.html, /data:image\/png;base64,AQID/);
});

test('复制优先按图片记录的精确 filePath 解析，避免文章图与主题素材同名冲突', async () => {
  const resolved = [];
  await copyRenderedArticle({
    html: '<img src="app://article"><img src="app://theme">',
    text: '',
    images: [
      {
        target: 'same.png',
        url: 'app://article',
        origin: 'article',
        filePath: '00｜本库附件/same.png',
      },
      {
        target: 'same.png',
        url: 'app://theme',
        origin: 'theme',
        filePath: '主题/透明装饰素材/same.png',
      },
    ],
    resolveFile: (reference, image) => {
      resolved.push([reference, image.origin]);
      return { path: reference, stat: { size: 3 } };
    },
    readBinary: async () => Uint8Array.from([1, 2, 3]),
    embedImages: true,
    _clipboard: { write: () => {} },
  });
  assert.deepEqual(resolved, [
    ['00｜本库附件/same.png', 'article'],
    ['主题/透明装饰素材/same.png', 'theme'],
  ]);
});

test('8 正文图 + 20 标题图 + 2 主题装饰 + 1 远程背景的分项统计准确', async () => {
  const articleImages = Array.from({ length: 8 }, (_, index) => ({
    target: `article-${index + 1}.png`,
    url: `app://article-${index + 1}.png`,
    origin: 'article',
  }));
  const headingImages = Array.from({ length: 20 }, (_, index) => {
    const bytes = Uint8Array.from([index + 1, 2, 3]);
    return {
      target: `heading-${index + 1}.png`,
      url: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
      origin: 'generated',
      bytes,
      mimeType: 'image/png',
      fallbackHtml: `<span>标题 ${index + 1}</span>`,
    };
  });
  const themeImages = Array.from({ length: 2 }, (_, index) => ({
    target: `theme-${index + 1}.png`,
    url: `app://theme-${index + 1}.png`,
    origin: 'theme',
  }));
  const background = {
    target: 'paper-grain',
    url: 'app://theme/paper-grain.png',
    origin: 'theme',
    wechatUrl: 'https://res.wx.qq.com/example/paper-grain.png',
  };
  const images = [...articleImages, ...headingImages, ...themeImages, background];
  const html = [
    ...articleImages.map((image) => `<img src="${image.url}">`),
    ...headingImages.map((image, index) =>
      `<h1><img src="${image.url}" alt="标题 ${index + 1}"></h1>`),
    ...themeImages.map((image) => `<img src="${image.url}">`),
    `<section style="background-color:#f7f8fa;background-image:url('${background.url}')">正文</section>`,
  ].join('');
  let payload;
  let transforms = 0;
  const result = await copyRenderedArticle({
    html,
    text: '正文',
    images,
    resolveFile: (reference) => ({ path: reference, stat: { size: 3 } }),
    readBinary: async () => Uint8Array.from([1, 2, 3]),
    transformImage: async (bytes) => {
      transforms += 1;
      return { bytes, mimeType: 'image/png' };
    },
    embedImages: true,
    _clipboard: { write: (value) => { payload = value; } },
  });

  assert.deepEqual(result.stats.articleImages, { total: 8, embedded: 8, placeholders: 0 });
  assert.deepEqual(result.stats.headingImages, { total: 20, embedded: 20, textFallbacks: 0 });
  assert.deepEqual(result.stats.themeImages, { total: 2, embedded: 2, remote: 0, omitted: 0 });
  assert.deepEqual(result.stats.remoteBackgrounds, { total: 1, delivered: 1, removed: 0 });
  assert.deepEqual(result.stats.resources, {
    uniqueSeen: 31,
    localProcessed: 30,
    stale: 0,
    safetySkipped: 0,
  });
  assert.equal(transforms, 10, '只有 8 张正文图和 2 张主题图需要 Electron 转换');
  assert.equal(result.embeddedCount, 31);
  assert.match(payload.html, /res\.wx\.qq\.com\/example\/paper-grain\.png/);
  assert.doesNotMatch(payload.html, /app:\/\/changfeng-clipboard-token|file:\/\/|local:\/\//);
  assert.equal(
    formatCopyResultNotice(result),
    '已复制：正文图片 8/8，标题图片 20/20，主题装饰 2/2，主题背景 1/1。',
  );
});

test('图片元数据反转不改变交付结果，容量不足时仍是正文优先、标题其次、主题最后', async () => {
  const headingBytes = Uint8Array.from([4, 5, 6]);
  const headingUrl = `data:image/png;base64,${Buffer.from(headingBytes).toString('base64')}`;
  const images = [
    { target: 'article.png', url: 'app://article.png', origin: 'article' },
    {
      target: 'heading.png',
      url: headingUrl,
      origin: 'generated',
      bytes: headingBytes,
      mimeType: 'image/png',
      fallbackHtml: '<span>标题活文字</span>',
    },
    { target: 'theme.png', url: 'app://theme.png', origin: 'theme' },
  ];
  const html = [
    '<img src="app://article.png">',
    `<h1><img src="${headingUrl}"></h1>`,
    '<img src="app://theme.png">',
  ].join('');
  const run = async (records) => copyRenderedArticle({
    html,
    text: '',
    images: records,
    resolveFile: (reference) => ({ path: reference, stat: { size: 3 } }),
    readBinary: async () => Uint8Array.from([1, 2, 3]),
    embedImages: true,
    maxImageBytes: 6,
    _clipboard: { write: () => {} },
  });
  const forward = await run(images);
  const reversed = await run([...images].reverse());

  assert.equal(forward.html, reversed.html);
  assert.deepEqual(forward.stats, reversed.stats);
  assert.deepEqual(forward.warnings, reversed.warnings);
  assert.deepEqual(forward.stats.articleImages, { total: 1, embedded: 1, placeholders: 0 });
  assert.deepEqual(forward.stats.headingImages, { total: 1, embedded: 1, textFallbacks: 0 });
  assert.deepEqual(forward.stats.themeImages, { total: 1, embedded: 0, remote: 0, omitted: 1 });
  assert.doesNotMatch(forward.html, /app:\/\/theme\.png|【正文图片/);
  assert.match(formatCopyResultNotice(forward), /降级：主题装饰 1 处省略/);
});

test('同一素材重复出现 10 次时只读取和转换一次，HTML 仍展开 10 份', async () => {
  const source = 'app://article/shared.png';
  let reads = 0;
  let transforms = 0;
  const result = await copyRenderedArticle({
    html: Array.from({ length: 10 }, () => `<img src="${source}">`).join(''),
    text: '',
    images: [{ target: 'shared.png', url: source, origin: 'article' }],
    resolveFile: () => ({ stat: { size: 3 } }),
    readBinary: async () => {
      reads += 1;
      return Uint8Array.from([1, 2, 3]);
    },
    transformImage: async (bytes) => {
      transforms += 1;
      return { bytes, mimeType: 'image/png' };
    },
    embedImages: true,
    _clipboard: { write: () => {} },
  });

  assert.equal(reads, 1);
  assert.equal(transforms, 1);
  assert.equal(result.embeddedBytes, 3);
  assert.equal(result.stats.articleImages.total, 10);
  assert.equal(result.stats.articleImages.embedded, 10);
  assert.equal((result.html.match(/data:image\/png;base64,AQID/g) ?? []).length, 10);
});

test('4 MiB 附近按最终 HTML 字节精确跨线', async () => {
  const source = 'app://article/near-limit.png';
  const bytes = Buffer.alloc(3_145_650, 7);
  const input = {
    html: `<img src="${source}">`,
    text: '',
    images: [{ target: 'near-limit.png', url: source, origin: 'article' }],
    resolveFile: () => ({ stat: { size: bytes.byteLength } }),
    readBinary: async () => bytes,
    embedImages: true,
    maxSingleImageBytes: 4 * 1024 * 1024,
    maxImageBytes: 5 * 1024 * 1024,
    _clipboard: { write: () => {} },
  };
  const baseline = await copyRenderedArticle({ ...input, maxHtmlBytes: 5 * 1024 * 1024 });
  const exactBytes = Buffer.byteLength(baseline.html, 'utf8');
  assert.ok(Math.abs(exactBytes - 4 * 1024 * 1024) < 4096);

  const exact = await copyRenderedArticle({ ...input, maxHtmlBytes: exactBytes });
  const crossed = await copyRenderedArticle({ ...input, maxHtmlBytes: exactBytes - 1 });
  assert.equal(exact.stats.articleImages.embedded, 1);
  assert.equal(exact.stats.limits.htmlBytes, exactBytes);
  assert.equal(crossed.stats.articleImages.embedded, 0);
  assert.equal(crossed.stats.articleImages.placeholders, 1);
  assert.ok(crossed.stats.limits.htmlBytes <= exactBytes - 1);
});

test('全文扫描与最终序列化次数不随图片数增长', async () => {
  const run = async (count) => {
    const images = Array.from({ length: count }, (_, index) => ({
      target: `${index}.png`,
      url: `app://scan-${index}.png`,
      origin: 'article',
    }));
    return copyRenderedArticle({
      html: images.map((image) => `<img src="${image.url}">`).join(''),
      text: '',
      images,
      resolveFile: () => ({ stat: { size: 3 } }),
      readBinary: async () => Uint8Array.from([1, 2, 3]),
      embedImages: true,
      _clipboard: { write: () => {} },
    });
  };
  const one = await run(1);
  const fifty = await run(50);
  assert.deepEqual(one._metrics, fifty._metrics);
  assert.deepEqual(fifty._metrics, {
    fullHtmlScanCount: 7,
    finalSerializationPasses: 4,
    referenceIndexPasses: 1,
  });
});

test('resolveFile 异常只降级当前资源，后续正文图仍能复制', async () => {
  const result = await copyRenderedArticle({
    html: '<img src="app://bad.png"><img src="app://good.png">',
    text: '',
    images: [
      { target: 'bad.png', url: 'app://bad.png', origin: 'article' },
      { target: 'good.png', url: 'app://good.png', origin: 'article' },
    ],
    resolveFile: (reference) => {
      if (reference === 'bad.png') throw new Error('解析器测试错误');
      return { stat: { size: 3 } };
    },
    readBinary: async () => Uint8Array.from([1, 2, 3]),
    embedImages: true,
    _clipboard: { write: () => {} },
  });
  assert.match(result.html, /【正文图片 1】/);
  assert.match(result.html, /data:image\/png;base64,AQID/);
  assert.deepEqual(result.stats.articleImages, { total: 2, embedded: 1, placeholders: 1 });
});

test('初始 HTML 已越界时不写剪贴板', async () => {
  let writes = 0;
  await assert.rejects(() => copyRenderedArticle({
    html: `<p>${'x'.repeat(200)}</p>`,
    text: '',
    images: [],
    resolveFile: () => null,
    readBinary: async () => new Uint8Array(),
    embedImages: true,
    maxHtmlBytes: 100,
    _clipboard: { write: () => { writes += 1; } },
  }), /初始|HTML 已超过|HTML.*安全上限/);
  assert.equal(writes, 0);
});

test('原始 HTML 因 H1 Data URL 超过 4 MiB 时仍可先令牌化并安全回退活文字', async () => {
  const bytes = Buffer.alloc(3_145_750, 9);
  const source = `data:image/png;base64,${bytes.toString('base64')}`;
  const result = await copyRenderedArticle({
    html: `<h1><img src="${source}" alt="超长标题"></h1>`,
    text: '超长标题',
    images: [{
      target: 'huge-heading.png',
      url: source,
      origin: 'generated',
      bytes,
      mimeType: 'image/png',
      fallbackHtml: '<span>超长标题</span>',
    }],
    resolveFile: () => null,
    readBinary: async () => { throw new Error('不应读盘'); },
    embedImages: true,
    maxSingleImageBytes: 1024,
    _clipboard: { write: () => {} },
  });

  assert.ok(Buffer.byteLength(source, 'utf8') > 4 * 1024 * 1024);
  assert.equal(result.stats.headingImages.textFallbacks, 1);
  assert.match(result.html, />超长标题<\/span>/);
  assert.doesNotMatch(result.html, /data:image|changfeng-clipboard-token/);
});

test('远程背景只用剩余 HTML 空间，不会挤掉已保留的正文图', async () => {
  const article = { target: 'article.png', url: 'app://article.png', origin: 'article' };
  const remoteBackground = {
    target: 'paper-grain',
    url: 'app://theme/grain.png',
    origin: 'theme',
    wechatUrl: 'https://res.wx.qq.com/example/grain.png',
  };
  const html = [
    `<img src="${article.url}">`,
    `<section style="background-color:#fff;background-image:url('${remoteBackground.url}')">正文</section>`,
  ].join('');
  const common = {
    html,
    text: '正文',
    resolveFile: (reference) => reference === 'article.png'
      ? { stat: { size: 600 } }
      : null,
    readBinary: async () => Buffer.alloc(600, 5),
    embedImages: true,
    _clipboard: { write: () => {} },
  };
  const withoutRemote = await copyRenderedArticle({
    ...common,
    images: [article, { ...remoteBackground, wechatUrl: undefined }],
    maxHtmlBytes: 4096,
  });
  const withRemote = await copyRenderedArticle({
    ...common,
    images: [article, remoteBackground],
    maxHtmlBytes: 4096,
  });
  const removedBytes = Buffer.byteLength(withoutRemote.html, 'utf8');
  const fullBytes = Buffer.byteLength(withRemote.html, 'utf8');
  assert.ok(fullBytes > removedBytes);

  const constrained = await copyRenderedArticle({
    ...common,
    images: [remoteBackground, article],
    maxHtmlBytes: fullBytes - 1,
  });
  assert.equal(constrained.stats.articleImages.embedded, 1);
  assert.equal(constrained.stats.articleImages.placeholders, 0);
  assert.deepEqual(constrained.stats.remoteBackgrounds, {
    total: 1,
    delivered: 0,
    removed: 1,
  });
  assert.match(constrained.html, /data:image\/png;base64/);
  assert.doesNotMatch(constrained.html, /background-image|res\.wx\.qq\.com/);
  assert.match(formatCopyResultNotice(constrained), /背景 1 处移除/);
});

test('重复大背景超限只移除该资源，合法远程背景和较小本地背景仍能交付', async () => {
  const images = [
    { target: 'large.png', url: 'app://large.png', origin: 'theme' },
    { target: 'small.png', url: 'app://small.png', origin: 'theme' },
    { target: 'remote.png', url: 'app://remote.png', origin: 'theme',
      wechatUrl: 'https://res.wx.qq.com/example/paper.png?foo=1&bar=2' },
  ];
  const html = [
    ...Array.from({ length: 20 }, () => '<p style="background-color:#fff;background-image:url(\'app://large.png\')">正文</p>'),
    '<section style="background-image:url(\'app://small.png\')">小背景</section>',
    '<section style="background-image:url(\'app://remote.png\')">远程背景</section>',
  ].join('');
  const result = await copyRenderedArticle({
    html, text: '正文', images,
    resolveFile: (reference) => ({ path: reference, stat: { size: reference === 'large.png' ? 1000 : 40 } }),
    readBinary: (file) => Buffer.alloc(file.stat.size, 5),
    maxHtmlBytes: 5000,
    embedImages: true,
    _clipboard: { write: () => {} },
  });
  assert.deepEqual(result.stats.themeBackgrounds, {
    total: 22, delivered: 2, remote: 1, embedded: 1, removed: 20,
  });
  assert.equal(result.stats.degradationReasons.htmlLimit, 20);
  assert.equal(result.stats.remoteBackgrounds.delivered, 1);
  assert.match(result.html, /paper\.png\?foo=1&amp;bar=2/);
  assert.equal(result._metrics.fullHtmlScanCount, 7);
  assert.ok(Buffer.byteLength(result.html) < 5000);
});

test('背景预算包括引号实体与独立 style 属性开销，精确等于上限时仍通过', async () => {
  const common = {
    html: '<section title="中文 &amp; 符号" style="  background-image : url(\'app://remote.png\') !important; ">正文</section>',
    text: '正文',
    images: [{ target: 'remote.png', url: 'app://remote.png', origin: 'theme',
      wechatUrl: 'https://res.wx.qq.com/example/paper.png?foo=1&bar=2' }],
    embedImages: true,
    _clipboard: { write: () => {} },
  };
  const full = await copyRenderedArticle(common);
  const exact = await copyRenderedArticle({ ...common, maxHtmlBytes: Buffer.byteLength(full.html) });
  const small = await copyRenderedArticle({ ...common, maxHtmlBytes: Buffer.byteLength(full.html) - 1 });
  assert.equal(exact.stats.themeBackgrounds.delivered, 1);
  assert.equal(small.stats.themeBackgrounds.delivered, 0);
});

test('复制转换器收到资源角色，H1 内存图继续跳过转换器', async () => {
  const records = [
    { target: 'body.png', url: 'app://body.png', origin: 'article' },
    { target: 'decoration.png', url: 'app://decoration.png', origin: 'theme' },
    { target: 'h1.png', url: 'app://h1.png', origin: 'generated', bytes: Buffer.from([1, 2, 3]), mimeType: 'image/png' },
  ];
  const received = [];
  const result = await copyRenderedArticle({
    html: records.map((record) => `<img src="${record.url}">`).join(''),
    text: '', images: records,
    resolveFile: (path) => ({ path, stat: { size: 3 } }),
    readBinary: () => Buffer.from([1, 2, 3]),
    transformImage: (bytes, file, mimeType, record) => {
      received.push({ role: record.origin, path: file.path, mimeType });
      return { bytes, mimeType };
    },
    embedImages: true,
    _clipboard: { write: () => {} },
  });
  assert.deepEqual(received, [
    { role: 'article', path: 'body.png', mimeType: 'image/png' },
    { role: 'theme', path: 'decoration.png', mimeType: 'image/png' },
  ]);
  assert.equal(result.stats.headingImages.embedded, 1);
});

for (const scenario of [
  {
    name: '缺文件',
    resolveFile: () => null,
    transformImage: undefined,
    maxSingleImageBytes: undefined,
    reasonCode: 'missingImage',
    reasonLabel: '找不到图片',
  },
  {
    name: '单图超限',
    resolveFile: () => ({ stat: { size: 3 } }),
    transformImage: async () => ({ bytes: Buffer.alloc(20), mimeType: 'image/png' }),
    maxSingleImageBytes: 10,
    reasonCode: 'singleImageLimit',
    reasonLabel: '单图上限',
  },
]) {
  test(`本地-only 背景${scenario.name}时 Notice 明确报移除数和原因`, async () => {
    const source = 'app://theme/local-only.png';
    const result = await copyRenderedArticle({
      html: `<section style="background-color:#fff;background-image:url('${source}')">正文</section>`,
      text: '正文',
      images: [{ target: 'local-only', url: source, origin: 'theme' }],
      resolveFile: scenario.resolveFile,
      readBinary: async () => Uint8Array.from([1, 2, 3]),
      transformImage: scenario.transformImage,
      embedImages: true,
      ...(scenario.maxSingleImageBytes === undefined
        ? {}
        : { maxSingleImageBytes: scenario.maxSingleImageBytes }),
      _clipboard: { write: () => {} },
    });

    assert.deepEqual(result.stats.themeBackgrounds, {
      total: 1,
      delivered: 0,
      remote: 0,
      embedded: 0,
      removed: 1,
    });
    assert.deepEqual(result.stats.remoteBackgrounds, { total: 0, delivered: 0, removed: 0 });
    assert.equal(result.stats.degradationReasons[scenario.reasonCode], 1);
    const notice = formatCopyResultNotice(result);
    assert.match(notice, /主题背景 0\/1/);
    assert.match(notice, /背景 1 处移除/);
    assert.match(notice, new RegExp(`${scenario.reasonLabel} 1 处`));
  });
}

test('本地-only 背景成功时按本地内嵌统计为主题背景 1/1', async () => {
  const source = 'app://theme/local-success.png';
  const result = await copyRenderedArticle({
    html: `<section style="background-color:#fff;background-image:url('${source}')">正文</section>`,
    text: '正文',
    images: [{ target: 'local-success', url: source, origin: 'theme' }],
    resolveFile: () => ({ stat: { size: 3 } }),
    readBinary: async () => Uint8Array.from([1, 2, 3]),
    embedImages: true,
    _clipboard: { write: () => {} },
  });

  assert.deepEqual(result.stats.themeBackgrounds, {
    total: 1,
    delivered: 1,
    remote: 0,
    embedded: 1,
    removed: 0,
  });
  assert.deepEqual(result.stats.remoteBackgrounds, { total: 0, delivered: 0, removed: 0 });
  assert.match(formatCopyResultNotice(result), /主题背景 1\/1/);
});

test('非法 wechat_url 回退本地内嵌时不伪报远程交付', async () => {
  const source = 'app://theme/invalid-remote.png';
  const result = await copyRenderedArticle({
    html: `<section style="background-color:#fff;background-image:url('${source}')">正文</section>`,
    text: '正文',
    images: [{
      target: 'invalid-remote',
      url: source,
      origin: 'theme',
      wechatUrl: 'https://tracker.example.com/grain.png',
    }],
    resolveFile: () => ({ stat: { size: 3 } }),
    readBinary: async () => Uint8Array.from([1, 2, 3]),
    embedImages: true,
    _clipboard: { write: () => {} },
  });

  assert.deepEqual(result.stats.themeBackgrounds, {
    total: 1,
    delivered: 1,
    remote: 0,
    embedded: 1,
    removed: 0,
  });
  assert.deepEqual(result.stats.remoteBackgrounds, { total: 1, delivered: 0, removed: 0 });
  assert.equal(result.remoteBackgroundCount, 0);
  assert.match(formatCopyResultNotice(result), /主题背景 1\/1/);
  assert.match(result.warnings[0], /微信官方/);
});

test('默认熔断允许 128 个本地唯一资源，第 129 个在解析、读取和写入前拒绝', async () => {
  const buildInput = (count) => {
    const images = Array.from({ length: count }, (_, index) => ({
      target: `${index}.png`,
      url: `app://safety-${index}.png`,
      origin: 'article',
    }));
    return { images, html: images.map((image) => `<img src="${image.url}">`).join('') };
  };
  const atLimit = buildInput(128);
  let acceptedReads = 0;
  const accepted = await copyRenderedArticle({
    ...atLimit,
    text: '',
    resolveFile: () => ({ stat: { size: 3 } }),
    readBinary: async () => {
      acceptedReads += 1;
      return Uint8Array.from([1, 2, 3]);
    },
    embedImages: true,
    _clipboard: { write: () => {} },
  });
  assert.equal(acceptedReads, 128);
  assert.equal(accepted.stats.articleImages.embedded, 128);

  const overLimit = buildInput(129);
  let resolves = 0;
  let reads = 0;
  let writes = 0;
  await assert.rejects(
    () => copyRenderedArticle({
      ...overLimit,
      text: '',
      resolveFile: () => {
        resolves += 1;
        return { stat: { size: 3 } };
      },
      readBinary: async () => {
        reads += 1;
        return Uint8Array.from([1, 2, 3]);
      },
      embedImages: true,
      _clipboard: { write: () => { writes += 1; } },
    }),
    (error) => error?.code === 'COPY_RESOURCE_SAFETY_LIMIT',
  );
  assert.equal(resolves, 0);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('同一正文源重复十次且失败时，图位 1 到 10 各出现一次并聚合原因', async () => {
  const source = 'app://article/repeated-missing.png';
  const result = await copyRenderedArticle({
    html: Array.from({ length: 10 }, () => `<img src="${source}">`).join(''),
    text: '',
    images: [{ target: 'repeated-missing.png', url: source, origin: 'article' }],
    resolveFile: () => null,
    readBinary: async () => { throw new Error('不应读取'); },
    embedImages: true,
    _clipboard: { write: () => {} },
  });

  for (let number = 1; number <= 10; number += 1) {
    assert.equal(result.html.split(`【正文图片 ${number}】`).length - 1, 1);
  }
  assert.equal(result.stats.articleImages.placeholders, 10);
  assert.equal(result.stats.degradationReasons.missingImage, 10);
  assert.match(formatCopyResultNotice(result), /找不到图片 10 处/);
});

const preferredThemeImage = (patch = {}) => ({
  target: 'divider.png', url: 'app://theme/divider.png', filePath: 'theme/divider.png',
  origin: 'theme', preferWechatUrl: true,
  wechatUrl: 'https://mmbiz.qpic.cn/mmbiz_png/fixture/0?wx_fmt=png&foo=1&bar=2',
  ...patch,
});

test('显式主题 img 复用微信地址，重复分割图不读本地且保留深色保护属性', async () => {
  const image = preferredThemeImage();
  let payload;
  let writes = 0;
  const result = await copyRenderedArticle({
    html: `<section>${Array.from({ length: 8 }, () => `<img src="${image.url}" data-no-dark="" alt="分割图">`).join('')}</section>`,
    text: '', images: [image], embedImages: true,
    resolveFile: () => { throw Error('远程 img 不应解析本地文件'); },
    readBinary: () => { throw Error('远程 img 不应读取本地字节'); },
    _clipboard: { write: value => { payload = value; writes += 1; } },
  });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.stats.themeImages, { total: 8, embedded: 0, remote: 8, omitted: 0 });
  assert.equal(result.stats.resources.localProcessed, 0);
  assert.equal(result.sourceBytesRead, 0);
  assert.equal(result.totalBytes, 0);
  assert.equal(result.embeddedBytes, 0);
  assert.equal((result.html.match(/data-no-dark/g) ?? []).length, 8);
  assert.equal((result.html.match(/wx_fmt=png&amp;foo=1&amp;bar=2/g) ?? []).length, 8);
  assert.doesNotMatch(result.html, /app:\/\/|data:image/);
  assert.equal(writes, 1);
  assert.equal(payload.html, result.html);
  assert.equal(result._metrics.fullHtmlScanCount, 7);
  assert.match(formatCopyResultNotice(result), /主题装饰 8\/8/);
});

test('显式主题素材同用 img 与背景时两者走微信地址，不重复读取或修改背景统计', async () => {
  const image = preferredThemeImage();
  const result = await copyRenderedArticle({
    html: `<section data-no-dark="" style="background-image:url('${image.url}');background-size:100% auto"><img data-no-dark="" src="${image.url}"></section>`,
    text: '', images: [image], embedImages: true,
    resolveFile: () => { throw Error('不应读取'); }, readBinary: () => { throw Error('不应读取'); },
    _clipboard: { write: () => {} },
  });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.stats.themeImages, { total: 1, embedded: 0, remote: 1, omitted: 0 });
  assert.deepEqual(result.stats.themeBackgrounds, { total: 1, delivered: 1, remote: 1, embedded: 0, removed: 0 });
  assert.equal(result.stats.resources.localProcessed, 0);
  assert.equal(result.remoteBackgroundCount, 1);
  assert.equal((result.html.match(/data-no-dark/g) ?? []).length, 2);
  assert.doesNotMatch(result.html, /app:\/\/|data:image/);
});

test('无标记、非布尔标记和非主题角色均维持图片内嵌行为', async () => {
  for (const patch of [
    { preferWechatUrl: undefined }, { preferWechatUrl: false }, { preferWechatUrl: 'true' },
    { origin: 'article' }, { origin: 'generated' },
  ]) {
    const image = preferredThemeImage(patch);
    let reads = 0;
    const result = await copyRenderedArticle({
      html: `<img src="${image.url}">`, text: '', images: [image], embedImages: true,
      resolveFile: () => ({ stat: { size: 3 } }),
      readBinary: () => { reads += 1; return Buffer.from([1, 2, 3]); },
      _clipboard: { write: () => {} },
    });
    assert.equal(reads, 1);
    assert.deepEqual(result.warnings, []);
    assert.match(result.html, /src="data:image\/png;base64,AQID"/);
    assert.equal(result.stats.themeImages.remote, 0);
  }
});

test('显式主题 img 微信地址缺失或不安全时告警并回退本地内嵌', async () => {
  for (const wechatUrl of [undefined, '', 'https://external.example/image.png', 'http://mmbiz.qpic.cn/a.png', 'https://user:pass@mmbiz.qpic.cn/a.png']) {
    const image = preferredThemeImage({ wechatUrl });
    let reads = 0;
    const result = await copyRenderedArticle({
      html: `<img src="${image.url}">`, text: '', images: [image], embedImages: true,
      resolveFile: () => ({ stat: { size: 3 } }),
      readBinary: () => { reads += 1; return Buffer.from([1, 2, 3]); },
      _clipboard: { write: () => {} },
    });
    assert.equal(reads, 1);
    assert.match(result.html, /src="data:image\/png;base64,AQID"/);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /已改用本地图片内嵌/);
    assert.deepEqual(result.stats.themeImages, { total: 1, embedded: 1, remote: 0, omitted: 0 });
  }
});

test('远程 img 预算包含 URL 实体开销，边界与溢出均不触碰本地或真实剪贴板', async () => {
  const image = preferredThemeImage();
  const input = {
    html: `<p>正文</p><img src="${image.url}" data-no-dark="">`, text: '', images: [image], embedImages: true,
    resolveFile: () => { throw Error('远程图片不应读取'); }, readBinary: () => { throw Error('不应读取'); },
    _clipboard: { write: () => {} },
  };
  const normal = await copyRenderedArticle(input);
  const exactBytes = Buffer.byteLength(normal.html);
  const exact = await copyRenderedArticle({ ...input, maxHtmlBytes: exactBytes });
  assert.equal(exact.stats.themeImages.remote, 1);
  assert.equal(exact.html, normal.html);
  const limited = await copyRenderedArticle({ ...input, maxHtmlBytes: exactBytes - 1 });
  assert.deepEqual(limited.stats.themeImages, { total: 1, embedded: 0, remote: 0, omitted: 1 });
  assert.equal(limited.stats.resources.localProcessed, 0);
  assert.equal(limited.stats.degradationReasons.htmlLimit, 1);
  assert.equal(limited.html, '<p>正文</p>');
  assert.match(limited.warnings[0], /HTML 上限/);
});

test('显式远程 img 不越过正文源优先级，元数据重排结果一致', async () => {
  const theme = preferredThemeImage();
  const article = { ...theme, origin: 'article', target: 'body.png' };
  const run = images => copyRenderedArticle({
    html: `<img src="${theme.url}">`, text: '', images, embedImages: true,
    resolveFile: () => ({ stat: { size: 3 } }), readBinary: () => Buffer.from([1, 2, 3]),
    _clipboard: { write: () => {} },
  });
  const forward = await run([theme, article]);
  const reverse = await run([article, theme]);
  assert.equal(forward.html, reverse.html);
  assert.deepEqual(forward.stats, reverse.stats);
  assert.equal(forward.stats.articleImages.embedded, 1);
  assert.equal(forward.stats.themeImages.remote, 0);
});

test('关闭图片内嵌或仅有 stale 显式元数据时不启用远程图片交付', async () => {
  const image = preferredThemeImage();
  const input = {
    text: '', images: [image], resolveFile: () => { throw Error('不应读取'); },
    readBinary: () => { throw Error('不应读取'); }, _clipboard: { write: () => {} },
  };
  const disabled = await copyRenderedArticle({ ...input, html: `<img src="${image.url}">`, embedImages: false });
  assert.equal(disabled.html, '');
  assert.deepEqual(disabled.stats.themeImages, { total: 1, embedded: 0, remote: 0, omitted: 1 });
  assert.deepEqual(disabled.warnings, []);
  const stale = await copyRenderedArticle({ ...input, html: '<p>正文</p>', embedImages: true });
  assert.equal(stale.html, '<p>正文</p>');
  assert.equal(stale.stats.resources.stale, 1);
  assert.equal(stale.stats.resources.localProcessed, 0);
  assert.equal(stale.warnings.length, 1);
  assert.match(stale.warnings[0], /未找到可替换的图片位置/);
});

test('HTML 中远程主题图先出现也不能挤掉后面的正文图预算', async () => {
  const theme = preferredThemeImage();
  const article = { target: 'body.png', filePath: 'body.png', url: 'app://article/body.png', origin: 'article' };
  const input = {
    html: `<section><img src="${theme.url}"><img src="${article.url}"></section>`,
    text: '', images: [theme, article], embedImages: true,
    resolveFile: reference => {
      assert.equal(reference, 'body.png');
      return { stat: { size: 120 } };
    },
    readBinary: () => Buffer.alloc(120, 1), _clipboard: { write: () => {} },
  };
  const full = await copyRenderedArticle(input);
  const articleOnlyHtml = full.html.replace(/<img src="https:[^"]*"\s*\/?>/, '');
  const limited = await copyRenderedArticle({ ...input, maxHtmlBytes: Buffer.byteLength(articleOnlyHtml) });
  assert.equal(limited.html, articleOnlyHtml);
  assert.equal(limited.stats.articleImages.embedded, 1);
  assert.equal(limited.stats.themeImages.remote, 0);
  assert.equal(limited.stats.themeImages.omitted, 1);
  assert.equal(limited.stats.resources.localProcessed, 1);
});

test('同源主题记录显式标记与普通记录合并稳定，纯远程不占本地资源和字节配额', async () => {
  const preferred = preferredThemeImage();
  const ordinary = { ...preferred, preferWechatUrl: undefined };
  const run = images => copyRenderedArticle({
    html: `<img src="${preferred.url}">`, text: '', images, embedImages: true,
    maxProcessedResources: 0, maxImageBytes: 0, maxSourceTotalBytes: 0,
    resolveFile: () => { throw Error('不应解析'); }, readBinary: () => { throw Error('不应读取'); },
    _clipboard: { write: () => {} },
  });
  const forward = await run([ordinary, preferred]);
  const reverse = await run([preferred, ordinary]);
  assert.equal(forward.html, reverse.html);
  assert.deepEqual(forward.stats, reverse.stats);
  assert.equal(forward.stats.themeImages.remote, 1);
  assert.deepEqual(forward.warnings, []);
});
