import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverVaultThemes, loadVaultThemeContent } from '../plugin/theme-registry.mjs';
import { renderArticle } from '../src/pipeline.mjs';
import { HeadingImageRuntime } from '../plugin/heading-image.mjs';
import { copyRenderedArticle } from '../plugin/copy.mjs';
import { embedImagesForExport, renderLongImagePng } from '../plugin/export-image.mjs';

/** Run inside Obsidian to use real registered fonts and decoded art. Does not
 * modify notes or the live preview, and captures copy through a test adapter.
 */
export async function verifyQuoteComposition({ app, directory }) {
  await mkdir(directory, { recursive: true });
  const plugin = app.plugins.plugins['changfeng-wechat-mp'];
  const discovered = await discoverVaultThemes({ vault: app.vault, metadataCache: app.metadataCache, themeFolder: plugin.settings.themeFolder });
  const selected = discovered.themes.find(t => t.themeId === 'dune-echo');
  assert.ok(selected);
  const theme = await loadVaultThemeContent(selected, { vault: app.vault });
  const quoteImages = { ...theme.quoteImages, replaceNativeContainer: true, illustration: { ...theme.quoteImages.illustration, layout: 'image' } };
  const runtime = new HeadingImageRuntime({ vault: app.vault });
  const source = '正文 16px，用于比较金句大小。\n\n> 引用块，放金句。\n>\n> 里面也可能出现**加粗**和 `行内代码`。\n\n- 无序列表第一项';
  const report = [];
  try {
    for (const width of [320, 390, 430, 677]) {
      const rendered = renderArticle({ source, themeCss: theme.css, themeAssets: theme.assets, themeDarkMode: theme.wechatDarkMode,
        resolve: () => null, layoutWidth: width, referenceComposition: theme.referenceComposition });
      const materialized = await runtime.materialize({ html: rendered.html, images: rendered.images,
        themeId: 'dune-echo', headingImages: [], fonts: theme.fonts, assets: theme.assets, quoteImages,
        referenceComposition: theme.referenceComposition, layoutWidth: width });
      assert.deepEqual(materialized.warnings, []);
      const composite = materialized.images.find(record => record.quoteComposition);
      assert.ok(composite);
      assert.equal(composite.quoteComposition.glyphScale, 1);
      assert.ok(Math.abs(composite.quoteComposition.fontSizes[0] - 20 * width / 390) < .01);
      const io = { resolveFile: (_ref, img) => app.vault.getAbstractFileByPath(img.filePath), readBinary: f => app.vault.readBinary(f) };
      let payload;
      const copied = await copyRenderedArticle({ html: materialized.html, images: materialized.images, text: source, embedImages: true,
        ...io, _clipboard: { write: value => { payload = value; } } });
      assert.equal(copied.stats.quoteImages.embedded, 1);
      assert.equal(copied.stats.quoteImages.textFallbacks, 0);
      const parsed = new DOMParser().parseFromString(payload.html, 'text/html');
      assert.equal(parsed.querySelectorAll('blockquote,table,td').length, 0);
      assert.equal(parsed.querySelectorAll('[data-wechat-quote-composite]').length, 1);
      // Simulate the already-observed receiving-editor loss of class/data-*.
      for (const node of parsed.querySelectorAll('*')) for (const attribute of [...node.attributes]) {
        if (attribute.name === 'class' || attribute.name.startsWith('data-')) node.removeAttribute(attribute.name);
      }
      const embedded = await embedImagesForExport({ html: materialized.html, images: materialized.images, ...io,
        transformImage: async bytes => ({ bytes, mimeType: 'image/png' }) });
      assert.deepEqual(embedded.warnings, []);
      const specimen = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:${width}px}#nice{width:100%}</style></head><body><main id="wechat-long-image-root">${embedded.html}</main></body></html>`;
      await writeFile(join(directory, `composite-${width}.png`), composite.bytes);
      const image = await renderLongImagePng(specimen, { layoutWidth: width, scale: 2 });
      await writeFile(join(directory, `quote-${width}.png`), image.bytes);
      await writeFile(join(directory, `quote-${width}.html`), specimen);
      await writeFile(join(directory, `composite-${width}.png`), composite.bytes);
      await writeFile(join(directory, `stripped-${width}.html`), parsed.documentElement.outerHTML);
      report.push({ width, geometry: composite.quoteComposition, bytes: composite.bytes.length,
        quoteImages: copied.stats.quoteImages, screenshot: `quote-${width}.png`, warnings: materialized.warnings });
    }
    // Full real source: heading, gallery, ordinary data table, code, footer all
    // remain independent of the quote's new bitmap.
    const article = app.vault.getAbstractFileByPath('06｜个人账号运营/2. 排版配图/1. 正文排版原则/5. 主题测试模板.md');
    const fullSource = await app.vault.read(article);
    const { nativeImage } = require('electron');
    const dimensions = new Map();
    for (const name of ['主题测试图-横版.png', '主题测试图-竖版.png']) {
      const file = app.metadataCache.getFirstLinkpathDest(name, article.path);
      const size = nativeImage.createFromBuffer(Buffer.from(await app.vault.readBinary(file))).getSize();
      dimensions.set(name, { ...size, url: app.vault.getResourcePath(file), filePath: file.path });
    }
    const render = renderArticle({source: fullSource, themeCss: theme.css, themeAssets: theme.assets, themeComponents: theme.components,
      themeDarkMode: theme.wechatDarkMode, referenceComposition: theme.referenceComposition, layoutWidth: 390, resolve: name => dimensions.get(name) ?? null});
    const result = await runtime.materialize({html: render.html, images: render.images, themeId:'dune-echo', headingImages:theme.headingImages,
      fonts:theme.fonts,assets:theme.assets,quoteImages,referenceComposition:theme.referenceComposition,layoutWidth:390});
    assert.deepEqual(result.warnings, []);
    const doc = new DOMParser().parseFromString(result.html,'text/html');
    assert.equal(doc.querySelectorAll('blockquote').length,0);
    assert.equal(doc.querySelectorAll('table').length,1);
    assert.equal(doc.querySelectorAll('[data-wechat-gallery-row]').length,1);
    assert.equal(doc.querySelectorAll('[data-wechat-quote-composite]').length,1);
    assert.equal(doc.querySelectorAll('.dune-footer').length,1);
    await writeFile(join(directory,'report.json'),JSON.stringify({cases:report,fullArticle:{headings:result.generatedCount,quoteImages:result.quoteGeneratedCount,warnings:result.warnings}},null,2));
    return {cases:report,fullArticle:'passed'};
  } finally { runtime.dispose(); }
}
