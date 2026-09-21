import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createTemplateCatalog, digest, validateTemplates } from '../scripts/template-files.mjs';

test('导出保留manifest指定原字体、覆盖表与已有许可，不改写或自动换字库', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-original-fonts-'));
  try {
    const source = join(root, 'source');
    const target = join(root, 'target');
    const expected = [];
    for (let index = 1; index <= 10; index += 1) {
      const themeId = `theme-${index}`;
      const path = join(source, themeId);
      await mkdir(join(path, '配套字体资源'), { recursive: true });
      const bytes = Buffer.from(`Original font ${index}: 原定字库`);
      const font = { font_id: 'display', family: `Original ${index}`, file: '配套字体资源/原定字库.ttf',
        sha256: digest(bytes), weight: 400, style: 'normal', coverage_file: '配套字体资源/coverage.json',
        ...(index === 1 ? { license_file: '配套字体资源/NOTICE.txt' } : {}) };
      await writeFile(join(path, font.file), bytes);
      await writeFile(join(path, font.coverage_file), '[19968]');
      if (font.license_file) await writeFile(join(path, font.license_file), 'Original accompanying notice\n');
      await writeFile(join(path, 'theme.css'), '#nice{color:#222}');
      await writeFile(join(path, 'manifest.json'), JSON.stringify({ schema_version:3, theme_id:themeId, name:'原定字体', order:index, fonts:[font],
        heading_images:[{heading_image_id:'title', heading_levels:[1], font_id:'display'}] }));
      expected.push({themeId, font, bytes});
    }
    const script = fileURLToPath(new URL('../scripts/export-templates.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--source', source, '--target', target], { encoding:'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const {themeId, font, bytes} of expected) {
      const manifest = JSON.parse(await readFile(join(target, themeId, 'manifest.json'), 'utf8'));
      assert.deepEqual(manifest.fonts, [font]);
      assert.deepEqual(await readFile(join(target, themeId, font.file)), bytes);
      assert.equal(await readFile(join(target, themeId, font.coverage_file), 'utf8'), '[19968]');
    }
    assert.equal(await readFile(join(target, 'theme-1/配套字体资源/NOTICE.txt'), 'utf8'), 'Original accompanying notice\n');
    const catalog = JSON.parse(await readFile(join(target, 'catalog.json'), 'utf8'));
    assert.ok(catalog.themes.every(theme => theme.font_changes.length === 0));
    assert.equal((await validateTemplates(target)).themes, 10);

    // A declared notice remains a real resource contract, not a generated claim.
    const notice = join(target, 'theme-1/配套字体资源/NOTICE.txt');
    await rm(notice);
    await writeFile(join(target, 'catalog.json'), JSON.stringify(await createTemplateCatalog(target, catalog.themes)));
    await assert.rejects(validateTemplates(target), /未打包已登记的字体许可/);
  } finally { await rm(root, { recursive:true, force:true }); }
});

test('无附带许可的原字体仍须通过真实字节指纹校验', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-font-integrity-'));
  try {
    const directory = 'original-font';
    await mkdir(join(root, directory, '配套字体资源'), {recursive:true});
    await writeFile(join(root, directory, 'theme.css'), '#nice{}');
    await writeFile(join(root, directory, '配套字体资源/original.ttf'), 'changed bytes');
    await writeFile(join(root, directory, 'manifest.json'), JSON.stringify({schema_version:3,theme_id:directory,name:'原定字体',
      fonts:[{font_id:'display',family:'Original',file:'配套字体资源/original.ttf',sha256:digest(Buffer.from('original bytes'))}]}));
    const themes = [{theme_id:directory,directory}];
    await writeFile(join(root,'catalog.json'), JSON.stringify(await createTemplateCatalog(root,themes)));
    await assert.rejects(validateTemplates(root,{expectedCount:1}), /字体指纹错误/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('同字形兼容字体必须保留原字库、原覆盖表和对应验证报告', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-font-provenance-'));
  try {
    const directory = 'original-font';
    const path = join(root, directory);
    await mkdir(join(path, '配套字体资源'), {recursive:true});
    const relative = name => `配套字体资源/${name}`;
    const files = {'original.woff2':'source', 'compat.woff2':'encoding repair', 'original.json':'[32,47,19968]', 'compat.json':'[32,19968]'};
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(path, relative(name)), bytes);
    const hash = name => digest(Buffer.from(files[name]));
    const font = {font_id:'display',family:'Original',file:relative('compat.woff2'),sha256:hash('compat.woff2'),coverage_file:relative('compat.json'),
      compatibility:{source_file:relative('original.woff2'),source_sha256:hash('original.woff2'),source_coverage_file:relative('original.json'),source_coverage_sha256:hash('original.json'),report_file:relative('report.json')}};
    const report = {source:{sha256:hash('original.woff2')},source_coverage:{sha256:hash('original.json')},output:{sha256:hash('compat.woff2')},output_coverage:{sha256:hash('compat.json')},
      verification:{all_outlines_equal:true,cmap_equal:true,advance_widths_equal:true,names_equal:true}};
    await writeFile(join(path,'theme.css'),'#nice{}');
    await writeFile(join(path,'manifest.json'),JSON.stringify({schema_version:3,theme_id:directory,name:'原定字体',fonts:[font]}));
    const themes = [{theme_id:directory,directory}];
    const refresh = async () => {
      await writeFile(join(path,relative('report.json')),JSON.stringify(report));
      await writeFile(join(root,'catalog.json'),JSON.stringify(await createTemplateCatalog(root,themes)));
    };
    await refresh();
    assert.equal((await validateTemplates(root,{expectedCount:1})).themes,1);
    report.output.sha256 = 'wrong source';
    await refresh();
    await assert.rejects(validateTemplates(root,{expectedCount:1}),/字体兼容来源或验证报告不一致/);
    report.output.sha256 = hash('compat.woff2');
    await rm(join(path,relative('original.woff2')));
    await refresh();
    await assert.rejects(validateTemplates(root,{expectedCount:1}),/未保留字体兼容来源/);
  } finally {await rm(root,{recursive:true,force:true});}
});
