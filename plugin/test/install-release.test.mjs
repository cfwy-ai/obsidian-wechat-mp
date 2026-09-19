import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPlugin } from '../scripts/install.mjs';
import { createTemplateCatalog } from '../scripts/template-files.mjs';

test('新安装完整包含10模板，升级保留data.json，损坏包不会触碰旧版', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-release-'));
  try {
    const source = join(root, 'dist');
    const vault = join(root, 'fresh-vault');
    await mkdir(join(vault, '.obsidian'), { recursive: true });
    await mkdir(source);
    await writeFile(join(source, 'manifest.json'), JSON.stringify({ id: 'changfeng-wechat-mp', version: '0.10.0' }));
    await writeFile(join(source, 'main.js'), 'first version');
    await writeFile(join(source, 'styles.css'), 'body{}');
    const templates = join(source, 'templates');
    const themes = [];
    for (let i = 1; i <= 10; i += 1) {
      const directory = `theme-${i}`;
      await mkdir(join(templates, directory), { recursive: true });
      const manifest = { schema_version: 3, theme_id: directory, name: `模板${i}` };
      await writeFile(join(templates, directory, 'manifest.json'), JSON.stringify(manifest));
      await writeFile(join(templates, directory, 'theme.css'), '#nice{}');
      themes.push({ theme_id: directory, directory });
    }
    await writeFile(join(templates, 'catalog.json'), JSON.stringify(await createTemplateCatalog(templates, themes)));
    await assert.rejects(installPlugin({ source }), /先确认目标 Vault/);
    await assert.rejects(installPlugin({ source, vault: root }), /缺少 .obsidian/);
    const checked = await installPlugin({ vault, source, dryRun: true });
    await assert.rejects(stat(checked.target), { code: 'ENOENT' });
    const first = await installPlugin({ vault, source });
    assert.equal(first.themes, 10);
    assert.equal(first.preservesData, false);
    const data = '{"selectedThemeId":"theme-7","themeSource":"vault","themeFolder":"My Templates"}';
    await writeFile(join(first.target, 'data.json'), data);
    await mkdir(join(first.target, 'themes'));
    await writeFile(join(first.target, 'themes', 'old-font.ttf'), 'old');
    await writeFile(join(source, 'main.js'), 'second version');
    const update = await installPlugin({ vault, source });
    assert.equal(update.preservesData, true);
    assert.equal(await readFile(join(first.target, 'data.json'), 'utf8'), data);
    assert.equal(await readFile(join(first.target, 'main.js'), 'utf8'), 'second version');
    await assert.rejects(stat(join(first.target, 'themes')), { code: 'ENOENT' });
    await writeFile(join(templates, 'theme-1/theme.css'), 'tampered');
    await assert.rejects(installPlugin({ vault, source }), /资源校验失败/);
    assert.equal(await readFile(join(first.target, 'main.js'), 'utf8'), 'second version');
    assert.equal(await readFile(join(first.target, 'data.json'), 'utf8'), data);
  } finally { await rm(root, { recursive: true, force: true }); }
});
