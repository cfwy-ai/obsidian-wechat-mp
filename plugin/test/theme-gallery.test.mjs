import test from 'node:test';
import assert from 'node:assert/strict';
import { loadThemeGallery } from '../plugin/theme-gallery.mjs';

const settings = Object.freeze({ themeSource: 'vault', themeFolder: 'My Themes', selectedThemeId: 'local-choice' });
const artwork = name => Object.freeze({ url: `app://test/${name}.png` });
const descriptor = overrides => Object.freeze({ themeId: 'simple-sketch', name: '简笔手绘', path: 'My Themes/manifest.json', ...overrides });
const setup = (local, bundled) => {
  const calls = [];
  const resources = { discover: async input => {
    calls.push(input);
    return { themes: input.themeSource === 'vault' ? local : bundled, problems: [] };
  } };
  return { resources, calls };
};

test('同ID的发行版介绍图补充库内主题，并保留原主题对象和用户设置', async () => {
  for (const status of ['draft', 'approved']) {
    const local = descriptor({ previewImage: artwork('local-cover') });
    const bundled = descriptor({ showcaseImage: artwork('bundled'), showcaseStatus: status });
    const fixture = setup([local], [bundled]);
    const result = await loadThemeGallery({ ...fixture, settings });
    assert.equal(result.items[0].image, bundled.showcaseImage);
    assert.equal(result.items[0].theme, local);
    assert.equal(result.items[0].label, status === 'draft' ? '发行版视觉样张（待确认）' : '发行版介绍图');
    assert.deepEqual(fixture.calls.map(value => value.themeSource), ['vault', 'bundled']);
    assert.notEqual(fixture.calls[1], settings);
    assert.deepEqual(settings, { themeSource: 'vault', themeFolder: 'My Themes', selectedThemeId: 'local-choice' });
  }
});

test('名称相同但ID不同或缺失时，不借用其他主题介绍图', async () => {
  const preview = artwork('local-preview');
  const local = [descriptor({ themeId: 'custom-sketch', previewImage: preview }), descriptor({ themeId: '', previewImage: null })];
  const fixture = setup(local, [descriptor({ showcaseImage: artwork('bundled') })]);
  const result = await loadThemeGallery({ ...fixture, settings });
  assert.equal(result.items[0].image, preview);
  assert.equal(result.items[0].label, '预览图 · 介绍图待补充');
  assert.equal(result.items[1].image, null);
});

test('当前介绍图始终优先，其他主题触发发行版读取时也不会被覆盖', async () => {
  for (const needsFallback of [false, true]) {
    const own = artwork('own-showcase');
    const local = descriptor({ showcaseImage: own, showcaseStatus: 'draft' });
    const fixture = setup([local, ...(needsFallback ? [descriptor({ themeId: 'dune-echo' })] : [])],
      [descriptor({ showcaseImage: artwork('bundled') })]);
    const result = await loadThemeGallery({ ...fixture, settings });
    assert.equal(result.items[0].image, own);
    assert.equal(result.items[0].label, '视觉样张（待确认）');
    assert.equal(fixture.calls.length, needsFallback ? 2 : 1);
  }
});

test('发行版没有介绍图、不可用或读取失败，均保留库内预览与原始问题', async () => {
  for (const state of ['preview-only', 'missing', 'failure']) {
    const preview = artwork('local-preview');
    const local = [descriptor({ previewImage: preview }), descriptor({ themeId: 'no-artwork' })];
    const resources = { discover: async input => {
      if (input.themeSource === 'vault') return { themes: local, problems: ['本地提示'] };
      if (state === 'failure') throw new Error('不可读取');
      return { themes: state === 'preview-only' ? [descriptor({ previewImage: artwork('bundled-preview') })] : [], problems: ['发行版不可用'] };
    } };
    const result = await loadThemeGallery({ resources, settings });
    assert.equal(result.items[0].image, preview);
    assert.equal(result.items[1].image, null);
    assert.deepEqual(result.problems, ['本地提示']);
  }
});

test('当前来源为内置模板时只读一次，不重新选择主题', async () => {
  const theme = descriptor({ showcaseImage: artwork('bundled'), showcaseStatus: 'approved' });
  const fixture = setup([], [theme]);
  const result = await loadThemeGallery({ ...fixture, settings: Object.freeze({ ...settings, themeSource: 'bundled' }) });
  assert.equal(fixture.calls.length, 1);
  assert.equal(result.items[0].theme, theme);
  assert.equal(result.items[0].label, '模板介绍图');
});
