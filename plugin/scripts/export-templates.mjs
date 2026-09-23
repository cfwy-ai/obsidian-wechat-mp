import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { safeThemeRelativePath, parseThemeManifest } from '../src/theme-package.mjs';
import { createTemplateCatalog, digest, option, validateTemplates } from './template-files.mjs';
import { prepareFontCompatibility } from './font-compatibility.mjs';

// Preserve each manifest's chosen font verbatim. These entries only locate
// existing accompanying notices; they never select or substitute a font.
const fontNotices = {
  'monument-valley/mv-zhuque': { license: 'OFL.txt' },
  'simple-sketch/h1-display': { license: 'LICENSE_Fonts' },
  'nyx-night/h1-zhuque-fangsong': { license: 'OFL.txt' },
  'crayon-sketch/zcool-kuaile': { license: 'OFL.txt' },
  'crayon-sketch/crayon-stroke': { license: 'Crayon-OFL.txt', extras: ['Crayon-FONTLOG.txt'] },
  'cartoon-doodle/maoken-title': { license: 'MaokenAssortedSans-OFL.txt' },
  'deconstructed-illustration/huiwen-mincho': { license: 'HuiwenMincho-LICENSE.txt', licenseTheme: 'pencil-impression' },
  'deconstructed-illustration/zhuque-fangsong': { license: 'Zhuque-LICENSE.txt' },
  'feng-guo-shu-ye/h1-fusion-pixel-12px': { license: 'fusion-pixel-12px/OFL.txt', extras: ['fusion-pixel-12px/LICENSE-OFL', 'fusion-pixel-12px/LICENSES'] },
  'dune-echo/chill-duan-song': { license: 'chill-duan-hei-song/OFL.txt' },
  'dune-echo/quote-zhuque-fangsong': { license: 'zhuque/OFL.txt' },
  'pencil-impression/jyunsai-kaai': { license: 'JyunsaiKaai-OFL.txt' },
  'pencil-impression/huiwen-mincho': { license: 'HuiwenMincho-LICENSE.txt' },
  'pencil-impression/zhuque-fangsong': { license: 'Zhuque-LICENSE.txt' },
};

const sourceArg = option('--source');
const targetArg = option('--target');
if (!sourceArg || !targetArg) throw new Error('用法：node scripts/export-templates.mjs --source <已确认主题目录> --target <新的发布快照目录>');
const source = resolve(sourceArg);
const target = resolve(targetArg);
if (source === target || target.startsWith(source + '/')) throw new Error('发布快照必须离开正式主题目录');
try { if ((await readdir(target)).length) throw new Error('目标必须为空，避免覆盖已审阅的快照'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(target, { recursive: true });
const themes = new Map();
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = join(source, entry.name);
  let raw;
  try { raw = await readFile(join(path, 'manifest.json'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const manifest = JSON.parse(raw);
  parseThemeManifest(raw);
  if (themes.has(manifest.theme_id)) throw new Error(`重复主题：${manifest.theme_id}`);
  themes.set(manifest.theme_id, { path, manifest, sourceHash: digest(raw) });
}
if (themes.size !== 10) throw new Error(`预期 10 套主题，实际 ${themes.size}`);
const catalogThemes = [];
for (const [id, theme] of [...themes].sort((a, b) => a[1].manifest.order - b[1].manifest.order)) {
  // 目录名给人看，用序号加中文名；theme_id 仍是稳定身份，定位靠 catalog 的 directory 字段。
  const directoryName = `${String(theme.manifest.order).padStart(2, '0')}. ${theme.manifest.name}`;
  const output = join(target, directoryName);
  await mkdir(output, { recursive: true });
  const manifest = structuredClone(theme.manifest);
  delete manifest.preview_image; // Historical showcases can contain private articles.
  delete manifest.showcase_image;
  const copy = async (from, relative) => {
    safeThemeRelativePath(relative);
    await mkdir(dirname(join(output, relative)), { recursive: true });
    await cp(from, join(output, relative), { recursive: true });
  };
  for (const relative of ['theme.css', ...(manifest.assets ?? []).map(a => a.file), ...(manifest.components ?? []).map(c => c.file)]) {
    await copy(join(theme.path, relative), relative);
  }
  const fonts = [];
  for (const original of manifest.fonts ?? []) {
    const notices = fontNotices[`${id}/${original.font_id}`] ?? {};
    const font = structuredClone(original);
    const fontRoot = font.file.split('/')[0];
    const sourceBytes = await readFile(join(theme.path, font.file));
    if (digest(sourceBytes) !== font.sha256) throw new Error(`${id}/${font.font_id} 原字体指纹与 manifest 不一致`);
    await copy(join(theme.path, font.file), font.file);
    if (font.coverage_file) await copy(join(theme.path, font.coverage_file), font.coverage_file);
    if (font.compatibility) {
      for (const key of ['source_file', 'source_coverage_file', 'report_file']) {
        const relative = safeThemeRelativePath(font.compatibility[key], `字体 ${font.font_id} 的兼容来源`);
        await copy(join(theme.path, relative), relative);
      }
    }
    const licenseRelative = font.license_file ?? (notices.license ? `${fontRoot}/${notices.license}` : null);
    if (licenseRelative) {
      const licenseOwner = !font.license_file && notices.licenseTheme ? themes.get(notices.licenseTheme) : theme;
      await copy(join(licenseOwner.path, licenseRelative), licenseRelative);
      font.license_file = licenseRelative;
    }
    for (const extra of notices.extras ?? []) await copy(join(theme.path, fontRoot, extra), `${fontRoot}/${extra}`);
    fonts.push(await prepareFontCompatibility(font, output));
  }
  manifest.fonts = fonts;
  parseThemeManifest(JSON.stringify(manifest));
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  catalogThemes.push({ theme_id: id, name: manifest.name, order: manifest.order, directory: directoryName, source_manifest_sha256: theme.sourceHash, font_changes: [] });
}
await writeFile(join(target, 'catalog.json'), JSON.stringify(await createTemplateCatalog(target, catalogThemes), null, 2) + '\n');
console.log(JSON.stringify(await validateTemplates(target)));
