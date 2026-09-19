import { load } from 'cheerio';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { ThemeResources } from '../plugin/theme-resources.mjs';
import { loadVaultThemeContent } from '../plugin/theme-registry.mjs';
import { renderArticle } from '../src/pipeline.mjs';
import { copyRenderedArticle } from '../plugin/copy.mjs';
import { resolveTemplatesRoot, validateTemplates } from './template-files.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const templatesRoot = resolveTemplatesRoot(root);
const summary = await validateTemplates(templatesRoot);
const pluginDir = '.obsidian/plugins/changfeng-wechat-mp';
const virtualRoot = `${pluginDir}/templates/`;
const physical = path => {
  assert.ok(path.startsWith(virtualRoot), `意外访问 Vault：${path}`);
  return join(templatesRoot, path.slice(virtualRoot.length));
};
const resources = await new ThemeResources({ pluginDir, metadataCache: {}, vault: {
  adapter: {
    read: path => readFile(physical(path), 'utf8'),
    readBinary: async path => { const bytes = await readFile(physical(path)); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    getResourcePath: path => pathToFileURL(physical(path)).href,
  },
  getAbstractFileByPath: () => null,
} }).initialize();
const discovered = await resources.discover({ themeSource: 'bundled' });
assert.deepEqual(discovered.problems, []);
assert.equal(discovered.themes.length, 10);
const sources = [
  '# 把时间还给创作\n\n正文保持原样。\n\n> 重要的一句话。\n\n## 一个具体步骤\n\n1. 打开文章\n2. 选择模板\n\n| 项目 | 说明 |\n| --- | --- |\n| 示例 | 保留完整内容 |',
  '## 长文本压力测试\n\n' + '这是用于检测排版的公开示例句。'.repeat(80) + '\n\n- 列表\n  - 嵌套列表\n\n```js\nconst value = 1;\n```',
];
let renders = 0;
let copiedResources = 0;
for (const theme of discovered.themes) {
  const content = await loadVaultThemeContent(theme, { vault: resources });
  assert.deepEqual(content.problems, []);
  for (const source of sources) for (const layoutWidth of [320, 390, 677]) {
    const result = renderArticle({ source, resolve: () => null, themeCss: content.css, themeComponents: content.components,
      themeAssets: content.assets, themeHeader: content.articleHeader, themeDarkMode: content.wechatDarkMode,
      orderedListImages: content.orderedListImages, referenceComposition: content.referenceComposition, layoutWidth });
    assert.equal(result.inlineLevel, 'full', theme.name);
    assert.match(result.html, /<section id="nice"/);
    assert.doesNotMatch(result.html, /theme-asset:\/\//);
    assert.ok(load(result.html).text().includes(source.startsWith('# 把') ? '正文保持原样。' : '长文本压力测试'), theme.name);
    renders += 1;
  }
  const asset = [...content.assets].sort((a, b) => a.file.stat.size - b.file.stat.size)[0];
  if (asset) {
    let clipboardHtml = '';
    await copyRenderedArticle({ html: `<section id="nice"><img src="${asset.url}"></section>`,
      images: [asset], embedImages: true, resolveFile: () => resources.getAbstractFileByPath(asset.filePath),
      readBinary: file => resources.readBinary(file),
      _clipboard: { write: data => { clipboardHtml = data.html; } },
    });
    assert.match(clipboardHtml, /data:image\//, `${theme.name} 内置图片未复制`);
    copiedResources += 1;
  }
}
console.log(JSON.stringify({ ...summary, renders, copiedResources, authorVaultRequired: false }, null, 2));
