import assert from 'node:assert/strict';
import test from 'node:test';
import { PNG } from 'pngjs';
import {
  EXPORT_WIDTH,
  EXPORT_LAYOUT_MODES,
  EXPORT_LAYOUT_MODE_LABELS,
  MOBILE_EXPORT_WIDTH,
  DEFAULT_EXPORT_LAYOUT_MODE,
  DEFAULT_EXPORT_SCALE,
  MAX_EXPORT_HEIGHT,
  assertExportDimensions,
  exportLayoutWidthForMode,
  normalizeExportLayoutMode,
  normalizeExportLayoutWidth,
  buildExportHtml,
  buildExportFilename,
  buildExportPath,
  buildSequencedTargetPath,
  copyCanvasTileToPixels,
  createExportSnapshot,
  embedImagesForExport,
  ensurePngExtension,
  findAvailableExportPath,
  findAvailableTargetPath,
  normalizeExportOptions,
  normalizeExportScale,
  exportWidthForScale,
  planExportRaster,
  resolveDownloadsDirectory,
  resolveExportAuthor,
  saveVerifiedExportPng,
  stitchCanvasTiles,
  verifyPng,
} from '../plugin/export-image.mjs';

test('长图快照拒绝过期文章或过期风格', () => {
  const article = { path: 'A.md' };
  const render = { articlePath: 'A.md', themePath: 'theme.md', html: '<p>A</p>' };
  assert.deepEqual(createExportSnapshot({ render, article, themePath: 'theme.md' }), {
    article,
    render,
  });
  assert.equal(createExportSnapshot({ render, article: { path: 'B.md' }, themePath: 'theme.md' }), null);
  assert.equal(createExportSnapshot({ render, article, themePath: 'other.md' }), null);
});

test('作者只接受用户输入，不再提供默认姓名', () => {
  assert.equal(resolveExportAuthor(' 小明 '), '小明');
  assert.equal(resolveExportAuthor(['小明', ' 小红 ']), '小明、小红');
  assert.equal(resolveExportAuthor(''), '');
  assert.equal(resolveExportAuthor(undefined), '');
});

test('显示作者时必须填姓名，关闭时允许空值', () => {
  assert.deepEqual(normalizeExportOptions({
    showTitle: true,
    showAuthor: true,
    author: '  小明  ',
    destinationPath: ' /tmp/a.png ',
  }), {
    showTitle: true,
    showAuthor: true,
    author: '小明',
    layoutMode: 'desktop',
    layoutWidth: 677,
    scale: 2,
    destinationPath: '/tmp/a.png',
  });
  assert.throws(
    () => normalizeExportOptions({ showAuthor: true, author: '   ' }),
    /请输入作者姓名/,
  );
  assert.deepEqual(normalizeExportOptions({ showAuthor: false, author: '' }), {
    showTitle: true,
    showAuthor: false,
    author: '',
    layoutMode: 'desktop',
    layoutWidth: 677,
    scale: 2,
    destinationPath: null,
  });
});

test('导出格式默认电脑端，手机端跟随手机预览宽度并夹回可用区间', () => {
  assert.equal(DEFAULT_EXPORT_LAYOUT_MODE, 'desktop');
  assert.deepEqual(EXPORT_LAYOUT_MODES, ['desktop', 'mobile']);
  assert.deepEqual(EXPORT_LAYOUT_MODE_LABELS, { desktop: '电脑端', mobile: '手机端' });
  assert.equal(MOBILE_EXPORT_WIDTH, 390);

  assert.equal(exportLayoutWidthForMode('desktop', 320), EXPORT_WIDTH);
  assert.equal(exportLayoutWidthForMode('mobile'), 390);
  assert.equal(exportLayoutWidthForMode('mobile', 430), 430);
  assert.equal(exportLayoutWidthForMode('mobile', '386'), 386);
  // 设置越界不让导出直接失败，只夹回 320–677。
  assert.equal(exportLayoutWidthForMode('mobile', 10), 320);
  assert.equal(exportLayoutWidthForMode('mobile', 9999), EXPORT_WIDTH);
  assert.equal(exportLayoutWidthForMode('mobile', 'abc'), 390);

  for (const invalid of ['phone', 'Desktop', '', null, 0]) {
    assert.throws(() => normalizeExportLayoutMode(invalid), /电脑端|手机端/);
  }
  for (const invalid of [319, 678, 0, -1, Infinity, NaN, '', null]) {
    assert.throws(() => normalizeExportLayoutWidth(invalid), /导出正文宽度/);
  }

  assert.deepEqual(
    normalizeExportOptions({ showAuthor: false, layoutMode: 'mobile', mobileWidth: 412 }),
    {
      showTitle: true,
      showAuthor: false,
      author: '',
      layoutMode: 'mobile',
      layoutWidth: 412,
      scale: 2,
      destinationPath: null,
    },
  );
});

test('手机端长图按窄幅出片，逻辑高度上限与分片规则保持不变', () => {
  assert.deepEqual([1, 1.5, 2].map((scale) => exportWidthForScale(scale, 390)), [390, 585, 780]);

  for (const scale of [1, 1.5, 2]) {
    const plan = planExportRaster(10_001, { scale, layoutWidth: 390 });
    assert.equal(plan.layoutWidth, 390);
    assert.equal(plan.width, exportWidthForScale(scale, 390));
    assert.equal(plan.rasterScale, plan.width / 390);
    assert.equal(plan.height, Math.round(10_001 * plan.width / 390));
    let y = 0;
    for (const tile of plan.tiles) {
      assert.equal(tile.outputY, y);
      assert.ok(tile.outputHeight <= 8192);
      y += tile.outputHeight;
    }
    assert.equal(y, plan.height);
  }

  // 逻辑高度上限只看排版高度，不随窄幅放宽。
  assert.equal(planExportRaster(28_000, { scale: 2, layoutWidth: 390 }).height, 56_000);
  assert.throws(() => planExportRaster(28_001, { scale: 2, layoutWidth: 390 }), /文章过长/);
  // 电脑端物理宽度不再被手机端排版接受，避免两种模式的分片互相串用。
  assert.throws(() => assertExportDimensions(1354, 100, 390), /宽度异常/);
  assert.doesNotThrow(() => assertExportDimensions(780, 100, 390));
});

test('手机端导出页面整体收窄，标题按比例缩小但不低于 24px', () => {
  const articleHtml = '<section id="nice"><p>正文</p></section>';
  const desktop = buildExportHtml({ articleHtml, showTitle: false, showAuthor: false });
  assert.match(desktop, /content="width=677, initial-scale=1"/);
  assert.match(desktop, /html,body\{margin:0;padding:0;width:677px;/);
  assert.match(desktop, /#wechat-long-image-root\{width:677px;/);
  // Chromium 把「、【」里的开括号收窄成半角，canvas 仍按全角字形绘制，
  // 开括号的墨迹会压到下一个字上。长图页必须关掉这项收窄。
  assert.match(desktop, /html\{text-spacing-trim:space-all;\}/);
  assert.match(desktop, /\.wechat-long-image-title\{[^}]*font-size:34px;/);

  const mobile = buildExportHtml({
    articleHtml,
    showTitle: false,
    showAuthor: false,
    layoutWidth: 390,
  });
  assert.match(mobile, /content="width=390, initial-scale=1"/);
  assert.match(mobile, /html,body\{margin:0;padding:0;width:390px;/);
  assert.match(mobile, /#wechat-long-image-root\{width:390px;/);
  assert.match(mobile, /\.wechat-long-image-title\{[^}]*font-size:24px;/);
  assert.doesNotMatch(mobile, /677px/);

  assert.match(
    buildExportHtml({ articleHtml, showTitle: false, showAuthor: false, layoutWidth: 600 }),
    /\.wechat-long-image-title\{[^}]*font-size:30px;/,
  );
  assert.throws(
    () => buildExportHtml({ articleHtml, showTitle: false, showAuthor: false, layoutWidth: 200 }),
    /导出正文宽度/,
  );
});

test('导出默认 2×，三档均增加像素且不改变 677px 排版宽度', () => {
  assert.equal(DEFAULT_EXPORT_SCALE, 2);
  assert.equal(normalizeExportOptions({ showAuthor: false }).scale, 2);
  assert.deepEqual([1, 1.5, 2].map((scale) => exportWidthForScale(scale)), [677, 1016, 1354]);
  for (const invalid of [0, -1, 3, Infinity, NaN, '', null]) {
    assert.throws(() => normalizeExportScale(invalid), /导出清晰度/);
  }
  for (const scale of [1, 1.5, 2]) {
    const plan = planExportRaster(10_001, { scale });
    assert.equal(plan.width, exportWidthForScale(scale));
    assert.equal(plan.height, Math.round(10_001 * plan.width / 677));
    let y = 0;
    for (const tile of plan.tiles) {
      assert.equal(tile.outputY, y);
      assert.ok(tile.outputHeight <= 8192);
      assert.ok(Math.abs(tile.y * plan.rasterScale - tile.outputY) < 1e-8);
      assert.ok(Math.abs(tile.height * plan.rasterScale - tile.outputHeight) < 1e-8);
      y += tile.outputHeight;
    }
    assert.equal(y, plan.height);
  }
});

test('高分辨率保留原逻辑高度上限，分片尺寸与像素预算在分配前校验', () => {
  assert.equal(planExportRaster(28_000, { scale: 2 }).height, 56_000);
  assert.throws(() => planExportRaster(28_001, { scale: 2 }), /文章过长/);
  for (const tileHeight of [0, -1, 8193, 1.5, Infinity]) {
    assert.throws(() => planExportRaster(100, { tileHeight }), /分片高度/);
  }
});

test('三档 PNG 写入和回读均核对对应物理宽度，1.5× 跨片接缝不漏行', async () => {
  for (const scale of [1, 1.5, 2]) {
    const width = exportWidthForScale(scale);
    const makeTile = (height, value) => ({ width, height, getContext: () => ({
      getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4).fill(value) }),
    }) });
    const bytes = stitchCanvasTiles([makeTile(2, 100), makeTile(1, 200)], width, 3);
    const decoded = PNG.sync.read(bytes);
    assert.equal(decoded.data[width * 2 * 4 - 1], 100);
    assert.equal(decoded.data[width * 2 * 4], 200);
    let saved;
    await saveVerifiedExportPng({ targetPath: '/tmp/test-scale.png', bytes, expectedWidth: width,
      expectedHeight: 3, exists: () => false, write: async (_p, b) => { saved = b; },
      read: async () => saved, remove: async () => {},
    });
    assert.deepEqual(verifyPng(saved, { expectedWidth: width, expectedHeight: 3 }), { width, height: 3 });
  }
});

test('长图头部可独立显示标题和作者，正文 HTML 保持原样', () => {
  const articleHtml = '<section id="nice"><p style="color:red">正文</p></section>';
  const full = buildExportHtml({
    articleHtml,
    title: '<文章>',
    author: '长风&无月',
  });
  assert.match(full, /&lt;文章&gt;/);
  assert.match(full, /长风&amp;无月/);
  assert.match(full, /<section id="nice"><header class="wechat-long-image-header">/);
  assert.ok(full.includes('<p style="color:red">正文</p>'));
  assert.ok(full.indexOf('wechat-long-image-title') < full.indexOf('wechat-long-image-author'));
  assert.match(full, /<\/header><p style="color:red">正文<\/p><\/section>/);

  const bodyOnly = buildExportHtml({
    articleHtml,
    title: '文章',
    author: '作者',
    showTitle: false,
    showAuthor: false,
  });
  assert.doesNotMatch(bodyOnly, /<header/);
  assert.ok(bodyOnly.includes(articleHtml));

  const titleOnly = buildExportHtml({
    articleHtml,
    title: '文章',
    author: '作者',
    showAuthor: false,
  });
  assert.match(titleOnly, /<div class="wechat-long-image-title" role="heading" aria-level="1">/);
  assert.doesNotMatch(titleOnly, /<p class="wechat-long-image-author">/);

  const authorOnly = buildExportHtml({
    articleHtml,
    title: '文章',
    author: '作者',
    showTitle: false,
  });
  assert.doesNotMatch(authorOnly, /<div class="wechat-long-image-title"/);
  assert.match(authorOnly, /<p class="wechat-long-image-author">/);
  assert.throws(
    () => buildExportHtml({ articleHtml, title: '文章', author: '   ' }),
    /请输入作者姓名/,
  );
});

test('默认导出到系统下载目录，不可用时回退 Downloads', () => {
  assert.equal(
    resolveDownloadsDirectory(() => '/System/Downloads', '/Users/test'),
    '/System/Downloads',
  );
  assert.equal(
    resolveDownloadsDirectory(() => { throw new Error('remote unavailable'); }, '/Users/test'),
    '/Users/test/Downloads',
  );
});

test('默认文件名与自选文件名都会在冲突时递增后缀', async () => {
  assert.equal(buildExportFilename('文章'), '文章-公众号长图.png');
  assert.equal(buildExportPath('06/正文', '文章'), '06/正文/文章-公众号长图.png');
  assert.equal(buildExportPath('', '文章', 2), '文章-公众号长图-2.png');
  const occupied = new Set([
    '06/正文/文章-公众号长图.png',
    '06/正文/文章-公众号长图-2.png',
  ]);
  assert.equal(await findAvailableExportPath({
    folder: '06/正文',
    basename: '文章',
    exists: (path) => occupied.has(path),
  }), '06/正文/文章-公众号长图-3.png');

  assert.equal(ensurePngExtension('/tmp/文章'), '/tmp/文章.png');
  assert.equal(ensurePngExtension('/tmp/文章.PNG'), '/tmp/文章.PNG');
  assert.equal(buildSequencedTargetPath('/tmp/自选.png', 2), '/tmp/自选-2.png');
  assert.equal(await findAvailableTargetPath({
    targetPath: '/tmp/自选.png',
    exists: (path) => path === '/tmp/自选.png',
  }), '/tmp/自选-2.png');
});

test('非 vault 路径保存会避让冲突、回读 PNG 并比对字节', async () => {
  const bytes = PNG.sync.write({
    width: EXPORT_WIDTH,
    height: 1,
    data: Buffer.alloc(EXPORT_WIDTH * 4, 255),
  });
  const files = new Map([['/tmp/长图.png', Buffer.from('occupied')]]);
  const path = await saveVerifiedExportPng({
    targetPath: '/tmp/长图.png',
    bytes,
    expectedHeight: 1,
    exists: async (candidate) => files.has(candidate),
    write: async (candidate, value) => {
      if (files.has(candidate)) throw Object.assign(new Error('冲突'), { code: 'EEXIST' });
      files.set(candidate, Buffer.from(value));
    },
    read: async (candidate) => files.get(candidate),
    remove: async (candidate) => { files.delete(candidate); },
  });
  assert.equal(path, '/tmp/长图-2.png');
  assert.ok(files.get(path).equals(bytes));
});

test('非 vault 路径回读校验失败时清理本次产物', async () => {
  const bytes = PNG.sync.write({
    width: EXPORT_WIDTH,
    height: 1,
    data: Buffer.alloc(EXPORT_WIDTH * 4, 255),
  });
  const files = new Map();
  await assert.rejects(
    () => saveVerifiedExportPng({
      targetPath: '/tmp/长图.png',
      bytes,
      expectedHeight: 1,
      exists: async (candidate) => files.has(candidate),
      write: async (candidate, value) => { files.set(candidate, Buffer.from(value)); },
      read: async () => Buffer.from('not a png'),
      remove: async (candidate) => { files.delete(candidate); },
    }),
    /有效 PNG/,
  );
  assert.equal(files.size, 0);
});

test('写入中途失败也会尝试清理残片，空路径则提前拒绝', async () => {
  const bytes = PNG.sync.write({
    width: EXPORT_WIDTH,
    height: 1,
    data: Buffer.alloc(EXPORT_WIDTH * 4, 255),
  });
  const files = new Map();
  await assert.rejects(
    () => saveVerifiedExportPng({
      targetPath: '/tmp/长图.png',
      bytes,
      expectedHeight: 1,
      exists: async () => false,
      write: async (candidate, value) => {
        files.set(candidate, Buffer.from(value).subarray(0, 20));
        throw new Error('磁盘写入失败');
      },
      read: async (candidate) => files.get(candidate),
      remove: async (candidate) => { files.delete(candidate); },
    }),
    /磁盘写入失败/,
  );
  assert.equal(files.size, 0);
  await assert.rejects(
    () => saveVerifiedExportPng({
      targetPath: '   ',
      bytes,
      expectedHeight: 1,
      exists: async () => false,
      write: async () => {},
      read: async () => bytes,
      remove: async () => {},
    }),
    /保存路径为空/,
  );
});

test('长图导出内嵌可读图片，失败图片改成可见图位', async () => {
  const html = '<section><img src="app://ok"><img src="app://missing"></section>';
  const result = await embedImagesForExport({
    html,
    images: [
      { target: 'ok.png', url: 'app://ok' },
      { target: 'missing.png', url: 'app://missing' },
    ],
    resolveFile: (target) => target === 'ok.png' ? { stat: { size: 3 } } : null,
    readBinary: async () => new Uint8Array([1, 2, 3]),
    transformImage: async (bytes) => ({ bytes, mimeType: 'image/png' }),
  });
  assert.equal(result.embeddedCount, 1);
  assert.match(result.html, /data:image\/png;base64,AQID/);
  assert.match(result.html, /【图片 2 加载失败】/);
  assert.equal(result.warnings.length, 1);
});

test('长图复用内存标题 PNG，失败时恢复原活文字', async () => {
  const source = 'data:image/png;base64,AA==';
  const base = {
    html: `<h1><img src="${source}" alt="核心参数"></h1>`,
    images: [{
      target: 'generated-heading.png',
      url: source,
      origin: 'generated',
      bytes: Uint8Array.from([1, 2, 3]),
      fallbackHtml: '<span style="font-size:28px">核心参数</span>',
    }],
    resolveFile: () => { throw new Error('不应解析本地文件'); },
    readBinary: async () => { throw new Error('不应读取本地文件'); },
  };
  const embedded = await embedImagesForExport({
    ...base,
    transformImage: async (bytes) => ({ bytes, mimeType: 'image/png' }),
  });
  assert.equal(embedded.embeddedCount, 1);
  assert.match(embedded.html, /data:image\/png;base64,AQID/);

  const failed = await embedImagesForExport({
    ...base,
    transformImage: async () => ({
      bytes: Uint8Array.from([1, 2, 3]),
      mimeType: 'image/png',
    }),
    maxSingleImageBytes: 2,
  });
  assert.equal(failed.embeddedCount, 0);
  assert.match(failed.html, />核心参数<\/span>/);
  assert.doesNotMatch(failed.html, /加载失败|data:image/);
});

test('长图导出优先按主题素材的精确 filePath 解析', async () => {
  let reference = '';
  const result = await embedImagesForExport({
    html: '<img src="app://theme">',
    images: [{
      target: 'mark.png',
      url: 'app://theme',
      origin: 'theme',
      filePath: '主题/透明装饰素材/mark.png',
    }],
    resolveFile: (value, image) => {
      reference = `${value}|${image.origin}`;
      return { stat: { size: 3 } };
    },
    readBinary: async () => new Uint8Array([1, 2, 3]),
    transformImage: async (bytes) => ({ bytes, mimeType: 'image/png' }),
  });
  assert.equal(reference, '主题/透明装饰素材/mark.png|theme');
  assert.equal(result.embeddedCount, 1);
});

test('长图导出内嵌 CSS 背景，失败时仅移除背景图', async () => {
  const source = 'app://theme/grain';
  const html = `<section style="background-color:#F7F8FA;background-image:url('${source}');background-size:320px 320px"><p>正文</p></section>`;
  const base = {
    html,
    images: [{
      target: 'paper-grain',
      url: source,
      origin: 'theme',
      filePath: '主题/透明装饰素材/grain.png',
      wechatUrl: 'https://res.wx.qq.com/example/grain.png',
    }],
    readBinary: async () => new Uint8Array([1, 2, 3]),
    transformImage: async (bytes) => ({ bytes, mimeType: 'image/png' }),
  };
  const embedded = await embedImagesForExport({
    ...base,
    resolveFile: () => ({ stat: { size: 3 } }),
  });
  assert.equal(embedded.embeddedCount, 1);
  assert.match(embedded.html, /background-image:url\([^)]*data:image\/png;base64,AQID[^)]*\)/);
  assert.doesNotMatch(embedded.html, /res\.wx\.qq\.com/);

  const failed = await embedImagesForExport({
    ...base,
    resolveFile: () => null,
  });
  assert.equal(failed.embeddedCount, 0);
  assert.match(failed.html, /background-color:#F7F8FA/);
  assert.doesNotMatch(failed.html, /background-image|app:\/\/|加载失败/);
});

test('转换后单图超限只回退当前图片', async () => {
  let size = 20;
  const result = await embedImagesForExport({
    html: '<img src="app://a"><img src="app://b">',
    images: [
      { target: 'a.png', url: 'app://a' },
      { target: 'b.png', url: 'app://b' },
    ],
    resolveFile: (target) => ({ path: target, stat: { size: 3 } }),
    readBinary: async () => new Uint8Array([1, 2, 3]),
    transformImage: async () => ({
      bytes: Uint8Array.from({ length: size-- === 20 ? 20 : 3 }, () => 1),
      mimeType: 'image/png',
    }),
    maxSingleImageBytes: 10,
  });

  assert.equal(result.embeddedCount, 1);
  assert.match(result.html, /【图片 1 加载失败】/);
  assert.match(result.html, /data:image\/png;base64/);
});

test('转换后累计体积与最终 HTML 均按图逐张回退', async () => {
  const base = {
    html: '<img src="app://a"><img src="app://b">',
    images: [
      { target: 'a.png', url: 'app://a' },
      { target: 'b.png', url: 'app://b' },
    ],
    resolveFile: (target) => ({ path: target, stat: { size: 3 } }),
    readBinary: async () => new Uint8Array([1, 2, 3]),
    transformImage: async (bytes) => ({ bytes, mimeType: 'image/png' }),
  };

  const byImages = await embedImagesForExport({ ...base, maxImageBytes: 4 });
  assert.equal(byImages.embeddedCount, 1);
  assert.match(byImages.html, /【图片 2 加载失败】/);

  const byHtml = await embedImagesForExport({ ...base, maxHtmlBytes: 70 });
  assert.equal(byHtml.embeddedCount, 1);
  assert.match(byHtml.html, /【图片 2 加载失败】/);
});

test('文章 HTML 本身超限时在创建 iframe 前拒绝', async () => {
  await assert.rejects(
    () => embedImagesForExport({
      html: '<p>1234567890</p>',
      images: [],
      resolveFile: () => null,
      readBinary: async () => new Uint8Array(),
      transformImage: async (bytes) => ({ bytes, mimeType: 'image/png' }),
      maxHtmlBytes: 10,
    }),
    /HTML 本身/,
  );
});

test('超长文章在分配巨大画布前明确拒绝', () => {
  assert.doesNotThrow(() => assertExportDimensions(EXPORT_WIDTH, 10_000));
  assert.throws(
    () => assertExportDimensions(EXPORT_WIDTH, MAX_EXPORT_HEIGHT + 1),
    /文章过长/,
  );
  assert.throws(() => assertExportDimensions(676, 100), /宽度异常/);
});

test('分片能拼成单张 677px PNG 并回读验证', () => {
  const makeTile = (height, rgba) => ({
    width: EXPORT_WIDTH,
    height,
    getContext: () => ({
      getImageData: () => ({
        data: new Uint8ClampedArray(
          Array.from({ length: EXPORT_WIDTH * height }, () => rgba).flat(),
        ),
      }),
    }),
  });
  const bytes = stitchCanvasTiles([
    makeTile(1, [255, 0, 0, 255]),
    makeTile(1, [0, 0, 255, 255]),
  ], EXPORT_WIDTH, 2);
  assert.deepEqual(verifyPng(bytes, { expectedHeight: 2 }), { width: EXPORT_WIDTH, height: 2 });
  const decoded = PNG.sync.read(bytes);
  assert.deepEqual([...decoded.data.subarray(0, 4)], [255, 0, 0, 255]);
  const secondRow = EXPORT_WIDTH * 4;
  assert.deepEqual([...decoded.data.subarray(secondRow, secondRow + 4)], [0, 0, 255, 255]);
  assert.throws(() => verifyPng(new Uint8Array([1, 2, 3])), /有效 PNG/);
});

test('单片可直接写入最终 RGBA Buffer', () => {
  const pixels = Buffer.alloc(EXPORT_WIDTH * 2 * 4, 255);
  const canvas = {
    width: EXPORT_WIDTH,
    height: 1,
    getContext: () => ({
      getImageData: () => ({
        data: new Uint8ClampedArray(
          Array.from({ length: EXPORT_WIDTH }, () => [12, 34, 56, 255]).flat(),
        ),
      }),
    }),
  };
  assert.equal(copyCanvasTileToPixels(canvas, pixels, EXPORT_WIDTH, 2, 1), 1);
  assert.deepEqual(
    [...pixels.subarray(EXPORT_WIDTH * 4, EXPORT_WIDTH * 4 + 4)],
    [12, 34, 56, 255],
  );
});
