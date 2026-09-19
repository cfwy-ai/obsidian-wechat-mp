import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyVerifiedTemplates, resolveTemplatesRoot, validateTemplates } from './template-files.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginDir = join(root, 'plugin');
const distDir = join(root, 'dist');
const templatesRoot = resolveTemplatesRoot(root);
const templateSummary = await validateTemplates(templatesRoot);

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await build({
  entryPoints: [join(pluginDir, 'main.mjs')],
  outfile: join(distDir, 'main.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['obsidian', 'electron'],
  sourcemap: false,
  minify: false,
  treeShaking: true,
  logLevel: 'info',
  banner: { js: '/* 长风·公众号排版：由 scripts/build.mjs 生成，请修改 plugin/ 下的源码。 */' },
});

const styleSources = await Promise.all(
  ['styles.css', 'header-controls.css'].map(file => readFile(join(pluginDir, file), 'utf8')),
);

await Promise.all([
  cp(join(pluginDir, 'manifest.json'), join(distDir, 'manifest.json')),
  writeFile(join(distDir, 'styles.css'), styleSources.join('\n\n'), 'utf8'),
  copyVerifiedTemplates(templatesRoot, join(distDir, 'templates')),
]);

try { await cp(join(root, '..', 'LICENSE'), join(distDir, 'LICENSE')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

console.log(`构建完成：${distDir}`);
console.log(`内置模板：${templateSummary.themes} 套，已验证 ${templateSummary.files} 个文件。`);
