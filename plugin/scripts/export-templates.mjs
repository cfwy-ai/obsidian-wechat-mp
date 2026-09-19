import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { safeThemeRelativePath, parseThemeManifest } from '../src/theme-package.mjs';
import { createTemplateCatalog, digest, option, validateTemplates } from './template-files.mjs';

// Explicit allowlist. A new font needs its own redistribution evidence before
// a release can include it. The developer's editable templates stay unchanged.
const policies = {
  'monument-valley/mv-zhuque': { license: 'OFL.txt' },
  'cobalt-orbit/h1-display': { replace: 'monument-valley/mv-zhuque', reason: '方正清刻本悦宋未附再分发许可，公开版使用朱雀仿宋。' },
  'simple-sketch/h1-display': { license: 'LICENSE_Fonts' },
  'nyx-night/h1-zhuque-fangsong': { license: 'OFL.txt' },
  'crayon-sketch/zcool-kuaile': { license: 'OFL.txt' },
  'crayon-sketch/crayon-stroke': { license: 'Crayon-OFL.txt', extras: ['Crayon-FONTLOG.txt'] },
  'crayon-sketch/wenxin-xile': { replace: 'crayon-sketch/zcool-kuaile', reason: '文心喜乐体仅有本地使用说明，公开版使用站酷快乐体。' },
  'cartoon-doodle/maoken-title': { license: 'MaokenAssortedSans-OFL.txt' },
  'deconstructed-illustration/huiwen-mincho': { license: 'HuiwenMincho-LICENSE.txt', licenseTheme: 'pencil-impression' },
  'deconstructed-illustration/zhuque-fangsong': { license: 'Zhuque-LICENSE.txt' },
  'deconstructed-illustration/kinghwa-oldsong': { replace: 'deconstructed-illustration/zhuque-fangsong', reason: '京华老宋未附作者完整再分发协议，公开版二级标题使用朱雀仿宋。' },
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
  const output = join(target, id);
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
  const changes = [];
  const fonts = [];
  for (const original of manifest.fonts ?? []) {
    let policy = policies[`${id}/${original.font_id}`];
    if (!policy) throw new Error(`字体未经分发审核：${id}/${original.font_id}`);
    let owner = theme;
    let font = structuredClone(original);
    if (policy.replace) {
      changes.push({ font_id: original.font_id, original_family: original.family, reason: policy.reason });
      const [themeId, fontId] = policy.replace.split('/');
      owner = themes.get(themeId);
      font = { ...structuredClone(owner.manifest.fonts.find(f => f.font_id === fontId)), font_id: original.font_id };
      policy = policies[policy.replace];
      changes.at(-1).public_family = font.family;
    }
    const fontRoot = font.file.split('/')[0];
    const licenseRelative = `${fontRoot}/${policy.license}`;
    const licenseOwner = policy.licenseTheme ? themes.get(policy.licenseTheme) : owner;
    await copy(join(owner.path, font.file), font.file);
    if (font.coverage_file) await copy(join(owner.path, font.coverage_file), font.coverage_file);
    await copy(join(licenseOwner.path, licenseRelative), licenseRelative);
    for (const extra of policy.extras ?? []) await copy(join(owner.path, fontRoot, extra), `${fontRoot}/${extra}`);
    font.license_file = licenseRelative;
    font.sha256 = digest(await readFile(join(output, font.file)));
    fonts.push(font);
  }
  manifest.fonts = fonts;
  parseThemeManifest(JSON.stringify(manifest));
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  catalogThemes.push({ theme_id: id, name: manifest.name, order: manifest.order, directory: id, source_manifest_sha256: theme.sourceHash, font_changes: changes });
}
await writeFile(join(target, 'catalog.json'), JSON.stringify(await createTemplateCatalog(target, catalogThemes), null, 2) + '\n');
console.log(JSON.stringify(await validateTemplates(target)));
