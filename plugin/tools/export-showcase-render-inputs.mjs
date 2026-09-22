import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ThemeResources } from '../plugin/theme-resources.mjs';
import { loadVaultThemeContent } from '../plugin/theme-registry.mjs';
import { renderArticle } from '../src/pipeline.mjs';
import { digest, option } from '../scripts/template-files.mjs';

const templatesArg = option('--templates');
const inventoryArg = option('--inventory');
const outputArg = option('--output');
if (!templatesArg || !inventoryArg || !outputArg) {
  throw new Error('用法：node tools/export-showcase-render-inputs.mjs --templates <已核对模板根> --inventory <统一样文 inventory.json> --output <输出目录>');
}
const templates = resolve(templatesArg);
const output = resolve(outputArg);
const baseline = JSON.parse(await readFile(resolve(inventoryArg), 'utf8'));
const source = baseline.themes.find(theme => theme.theme_id === 'simple-sketch') ?? baseline.themes[0];
if (!source?.article?.source || !source.components) throw new Error('缺少统一文章或组件原文');
const sampleRecords = [['article', source.article], ...['h1', 'h2', 'quote', 'table', 'code'].map(key => [key, source.components[key]])];
if (sampleRecords.some(([, record]) => !record?.source)) throw new Error('统一样例必须包含 article/h1/h2/quote/table/code');
const prefix = '.obsidian/plugins/changfeng-wechat-mp/templates/';
const actual = path => {
  if (!path.startsWith(prefix)) throw new Error('只能读取已指定的模板资源');
  const result = resolve(templates, path.slice(prefix.length));
  if (!result.startsWith(templates + '/')) throw new Error('模板资源越界');
  return result;
};
const resources = await new ThemeResources({ pluginDir: '.obsidian/plugins/changfeng-wechat-mp', metadataCache: {}, vault: {
  adapter: {
    read: path => readFile(actual(path), 'utf8'),
    readBinary: async path => { const bytes = await readFile(actual(path)); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    getResourcePath: path => pathToFileURL(actual(path)).href,
  }, getAbstractFileByPath: () => null,
} }).initialize();
const discovered = await resources.discover({ themeSource: 'bundled' });
if (discovered.problems.length) throw new Error(discovered.problems.join(';'));
const binaryMap = {}, textFiles = {}, fileMetadata = {}, fileURLs = {}, themes = [];
const remember = async path => {
  if (binaryMap[path]) return;
  const file = resources.getAbstractFileByPath(path);
  if (!file) throw new Error(`缺少文件 ${path}`);
  const bytes = await readFile(actual(path));
  binaryMap[path] = bytes.toString('base64');
  fileMetadata[path] = { path: file.path, name: file.name, basename: file.basename, extension: file.extension, stat: file.stat };
  fileURLs[path] = resources.getResourcePath(file);
  if (/\.json$/i.test(path)) textFiles[path] = bytes.toString('utf8');
};
for (const descriptor of discovered.themes) {
  const themeId = descriptor.themeId;
  const theme = await loadVaultThemeContent(descriptor, { vault: resources });
  if (theme.problems.length) throw new Error(theme.problems.join(';'));
  const manifest = JSON.parse(await readFile(join(templates, themeId, 'manifest.json'), 'utf8'));
  for (const asset of theme.assets) await remember(asset.filePath);
  for (const font of theme.fonts) {
    await remember(font.filePath);
    if (font.coverageFile) await remember(`${prefix}${themeId}/${font.coverageFile}`);
  }
  const samples = [];
  for (const [key, record] of sampleRecords) {
    const rendered = renderArticle({ source: record.source, resolve: () => null, themeCss: theme.css, themeAssets: theme.assets,
      themeComponents: theme.components.filter(component => !['before_article', 'after_article'].includes(component.slot)),
      themeHeader: null, themeDarkMode: theme.wechatDarkMode, referenceComposition: theme.referenceComposition,
      orderedListImages: theme.orderedListImages, layoutWidth: 390 });
    if (rendered.warnings.length) throw new Error(`${themeId}/${key}: ${rendered.warnings.join(';')}`);
    samples.push({ key, source: record.source, html: rendered.html, images: rendered.images, layoutWidth: 390, warnings: rendered.warnings });
  }
  themes.push({ themeId, name: descriptor.name, css: theme.css, headingImages: theme.headingImages,
    fonts: theme.fonts, assets: theme.assets, articleHeader: manifest.article_header ?? null,
    manifest, quoteImages: theme.quoteImages, orderedListImages: theme.orderedListImages,
    referenceComposition: theme.referenceComposition, wechatDarkMode: theme.wechatDarkMode, samples });
}
await mkdir(output, { recursive: true });
const stripParents = (key, value) => key === 'parent' || key === 'children' ? undefined : value;
const inputData = JSON.stringify({ schema_version: 1, layoutWidth: 390, binaries_file: 'render-binaries.json',
  binary_encoding: 'base64_by_filePath', fileMetadata, fileURLs, textFiles, themes }, stripParents);
const binaryData = JSON.stringify({ encoding: 'base64_by_filePath', binaryMap });
await writeFile(join(output, 'render-inputs.json'), inputData);
await writeFile(join(output, 'render-binaries.json'), binaryData);
const report = { themes: themes.length, samples: themes.reduce((n, theme) => n + theme.samples.length, 0),
  layoutWidth: 390, automaticArticleDecorations: false, binaries: Object.keys(binaryMap).length,
  input_sha256: digest(inputData), binary_sha256: digest(binaryData), source_inventory: resolve(inventoryArg),
  theme_summary: themes.map(theme => ({ theme_id: theme.themeId, fonts: theme.fonts.map(font => ({ id: font.id, family: font.family, sha256: font.sha256 })),
    header_presets: theme.articleHeader?.presets?.length ?? 0 })) };
await writeFile(join(output, 'render-inputs-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ themes: report.themes, samples: report.samples, binaries: report.binaries, output }));
