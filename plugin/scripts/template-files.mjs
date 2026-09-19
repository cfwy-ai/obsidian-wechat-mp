import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { safeThemeRelativePath, parseThemeManifest } from '../src/theme-package.mjs';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function listFiles(root, prefix = '') {
  const output = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`发布资源不能是软链接：${path}`);
    if (entry.isDirectory()) output.push(...await listFiles(root, path));
    else if (entry.isFile()) output.push(path);
  }
  return output.sort();
}

export async function createTemplateCatalog(root, themes) {
  const files = [];
  for (const path of (await listFiles(root)).filter(path => path !== 'catalog.json')) {
    const bytes = await readFile(join(root, path));
    files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  return { schema_version: 1, themes, files };
}

export async function validateTemplates(root, { expectedCount = 10 } = {}) {
  const realRoot = await realpath(root);
  const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'));
  if (catalog.schema_version !== 1 || catalog.themes?.length !== expectedCount) {
    throw new Error(`内置模板应有 ${expectedCount} 套`);
  }
  const records = new Map();
  for (const item of catalog.files ?? []) {
    const path = safeThemeRelativePath(item.path);
    if (records.has(path)) throw new Error(`重复文件：${path}`);
    const absolute = join(root, path);
    if (!(await lstat(absolute)).isFile() || !(await realpath(absolute)).startsWith(realRoot + sep)) {
      throw new Error(`资源不是包内普通文件：${path}`);
    }
    const bytes = await readFile(absolute);
    if (digest(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error(`资源校验失败：${path}`);
    records.set(path, item);
  }
  const ids = new Set();
  for (const item of catalog.themes) {
    const directory = safeThemeRelativePath(item.directory);
    const raw = JSON.parse(await readFile(join(root, directory, 'manifest.json'), 'utf8'));
    const manifest = parseThemeManifest(JSON.stringify(raw));
    if (ids.has(manifest.themeId) || manifest.themeId !== item.theme_id) throw new Error(`主题 ID 不一致：${item.theme_id}`);
    ids.add(manifest.themeId);
    const required = ['manifest.json', 'theme.css',
      ...manifest.assets.map(value => value.file),
      ...manifest.components.map(value => value.file),
      ...manifest.fonts.flatMap(value => [value.file, value.coverageFile].filter(Boolean)),
      ...[manifest.previewImage, manifest.showcaseImage].filter(Boolean)];
    for (const file of required) if (!records.has(`${directory}/${file}`)) throw new Error(`${manifest.name} 未打包资源：${file}`);
    for (const font of raw.fonts ?? []) {
      if (!font.license_file || !records.has(`${directory}/${font.license_file}`)) throw new Error(`${manifest.name} 字体缺少许可：${font.font_id}`);
      if (digest(await readFile(join(root, directory, font.file))) !== font.sha256) throw new Error(`${manifest.name} 字体指纹错误：${font.font_id}`);
    }
  }
  return { themes: ids.size, files: records.size, bytes: [...records.values()].reduce((sum, value) => sum + value.bytes, 0) };
}

/** Copy only the reviewed inventory, never stray files next to it. */
export async function copyVerifiedTemplates(source, target) {
  const summary = await validateTemplates(source);
  const catalog = JSON.parse(await readFile(join(source, 'catalog.json'), 'utf8'));
  for (const relative of ['catalog.json', ...catalog.files.map(file => file.path)]) {
    await mkdir(dirname(join(target, relative)), { recursive: true });
    await cp(join(source, relative), join(target, relative));
  }
  return summary;
}

export const option = (name, fallback = '') => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? '';
};

export const resolveTemplatesRoot = (root) => resolve(option('--templates', process.env.WECHAT_MP_TEMPLATES || join(root, '..', 'templates')));
