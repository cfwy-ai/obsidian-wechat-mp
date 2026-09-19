import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCss, themeName, isThemeFile, listThemes } from '../src/theme.mjs';

const fence = (lang, body) => '```' + lang + '\n' + body + '\n```';

test('从 css 代码块里取出样式', () => {
  assert.equal(extractCss(fence('css', '#nice { color: red; }')), '#nice { color: red; }');
});

test('文件带 frontmatter 也能取到', () => {
  const src = '---\ntype: 资源\n---\n\n' + fence('css', '#nice { color: red; }');
  assert.equal(extractCss(src), '#nice { color: red; }');
});

test('有多个代码块时只取第一个 css 块', () => {
  const src = fence('css', 'A') + '\n\n' + fence('css', 'B');
  assert.equal(extractCss(src), 'A');
});

test('跳过非 css 的代码块', () => {
  const src = fence('bash', 'echo hi') + '\n\n' + fence('css', 'A');
  assert.equal(extractCss(src), 'A');
});

test('语言标注大小写不敏感', () => {
  assert.equal(extractCss(fence('CSS', 'A')), 'A');
});

test('保留 CSS 内部的缩进与空行', () => {
  const css = '#nice h1 {\n  color: red;\n}\n\n#nice p {\n  color: blue;\n}';
  assert.equal(extractCss(fence('css', css)), css);
});

test('没有 css 代码块时明确报错，不静默返回空', () => {
  assert.throws(() => extractCss('# 只有标题，没有样式'), /没有找到/);
});

test('配置目录中的 Markdown 不再依赖风格后缀', () => {
  assert.equal(isThemeFile('5. 莫兰迪晨风格.md'), true);
  assert.equal(isThemeFile('科技教程.md'), true);
  assert.equal(isThemeFile('自定义模板.MD'), true);
  assert.equal(isThemeFile('随手记.txt'), false);
});

test('风格名去掉序号前缀与扩展名', () => {
  assert.equal(themeName('5. 莫兰迪晨风格.md'), '莫兰迪晨风格');
  assert.equal(themeName('12. 某某风格.md'), '某某风格');
  assert.equal(themeName('自定义模板.MD'), '自定义模板');
});

test('列出目录里的全部 Markdown 模板，按序号排序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'theme-'));
  writeFileSync(join(dir, '2. 乙风格.md'), fence('css', 'B'));
  writeFileSync(join(dir, '10. 丙风格.md'), fence('css', 'C'));
  writeFileSync(join(dir, '1. 甲风格.md'), fence('css', 'A'));
  writeFileSync(join(dir, '0. 无风格后缀.md'), fence('css', 'X'));
  writeFileSync(join(dir, '说明.txt'), 'not a theme');

  const { themes } = listThemes(dir);
  assert.deepEqual(themes.map((t) => t.name), ['无风格后缀', '甲风格', '乙风格', '丙风格']);
  assert.deepEqual(themes.map((t) => t.css), ['X', 'A', 'B', 'C']);
});

test('提取失败的风格文件进问题清单，不静默丢弃', () => {
  const dir = mkdtempSync(join(tmpdir(), 'theme-'));
  writeFileSync(join(dir, '1. 好的风格.md'), fence('css', 'A'));
  writeFileSync(join(dir, '2. 坏的风格.md'), '# 忘了写 CSS');

  const { themes, problems } = listThemes(dir);
  assert.deepEqual(themes.map((t) => t.name), ['好的风格']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /坏的风格/);
});

const writeThemePackage = (
  root,
  directory,
  {
    themeId = 'package-theme',
    name = '目录主题',
    previewImage = true,
    withHeadingImage = false,
    legacyFontDirectory = false,
  } = {},
) => {
  const packageDir = join(root, directory);
  mkdirSync(join(packageDir, '主题视觉规范'), { recursive: true });
  mkdirSync(join(packageDir, '正文组件结构'), { recursive: true });
  mkdirSync(join(packageDir, '透明装饰素材'), { recursive: true });
  mkdirSync(join(packageDir, '主题展示案例'), { recursive: true });
  const fontDirectory = legacyFontDirectory ? '字体资源' : '配套字体资源';
  if (withHeadingImage) mkdirSync(join(packageDir, fontDirectory), { recursive: true });
  const fontBytes = Buffer.from('test-font');
  const fontHash = createHash('sha256').update(fontBytes).digest('hex');
  writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify({
    schema_version: 3,
    theme_id: themeId,
    name,
    theme_palette: ['暖白'],
    theme_scenes: ['长文'],
    ...(previewImage ? { preview_image: '主题展示案例/主题预览图.png' } : {}),
    assets: [{ asset_id: 'mark', file: '透明装饰素材/mark.png' }],
    components: [{
      component_id: 'divider',
      file: '正文组件结构/divider.html',
      slot: 'before_heading',
      heading_levels: [2],
      asset_ids: ['mark'],
    }],
    ...(withHeadingImage ? {
      fonts: [{
        font_id: 'display',
        file: `${fontDirectory}/display.ttf`,
        family: 'Display',
        sha256: fontHash,
      }],
      heading_images: [{
        heading_image_id: 'h1-display',
        heading_levels: [1],
        font_id: 'display',
      }],
    } : {}),
  }));
  writeFileSync(join(packageDir, 'theme.css'), '#nice .divider { width: 24px; }');
  writeFileSync(join(packageDir, '主题视觉规范/1. 视觉风格总则.md'), '视觉风格总则');
  writeFileSync(join(packageDir, '主题视觉规范/2. 文章封图规范.md'), '文章封图规范');
  writeFileSync(join(packageDir, '主题视觉规范/3. 正文配图规范.md'), '正文配图规范');
  writeFileSync(join(packageDir, '正文组件结构/divider.html'), '<img class="divider" src="theme-asset://mark">');
  writeFileSync(join(packageDir, '透明装饰素材/mark.png'), Buffer.from([1, 2, 3]));
  if (withHeadingImage) writeFileSync(join(packageDir, fontDirectory, 'display.ttf'), fontBytes);
  if (previewImage) {
    writeFileSync(join(packageDir, '主题展示案例/主题预览图.png'), Buffer.from([4, 5, 6]));
  }
};

test('v1 平铺主题与 v3 目录主题并存并按数字前缀排序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'theme-mixed-'));
  writeFileSync(join(dir, '2. 旧版主题.md'), fence('css', '#nice{color:#222}'));
  writeThemePackage(dir, '1. 目录主题');

  const { themes, problems } = listThemes(dir);
  assert.deepEqual(problems, []);
  assert.deepEqual(themes.map((theme) => theme.kind), ['v3', 'v1']);
  assert.equal(themes[0].themeId, 'package-theme');
  assert.equal(themes[0].css, '#nice .divider { width: 24px; }');
  assert.equal(themes[0].components[0].id, 'divider');
  assert.equal(themes[0].assets[0].id, 'mark');
  assert.equal(themes[0].previewImage.file, '主题展示案例/主题预览图.png');
});

test('文件系统 loader 验证主题字体哈希并保留标题图片声明', () => {
  const dir = mkdtempSync(join(tmpdir(), 'theme-font-'));
  writeThemePackage(dir, '1. 目录主题', { withHeadingImage: true });
  const first = listThemes(dir);
  assert.deepEqual(first.problems, []);
  assert.equal(first.themes[0].fonts.length, 1);
  assert.equal(first.themes[0].headingImages.length, 1);

  writeFileSync(join(dir, '1. 目录主题/配套字体资源/display.ttf'), 'changed');
  const second = listThemes(dir);
  assert.equal(second.themes.length, 1);
  assert.deepEqual(second.themes[0].fonts, []);
  assert.ok(second.problems.some((problem) => /SHA-256/.test(problem)));
});

test('文件系统 loader 在迁移期继续读取旧「字体资源」主题', () => {
  const dir = mkdtempSync(join(tmpdir(), 'theme-legacy-font-'));
  writeThemePackage(dir, '1. 目录主题', {
    withHeadingImage: true,
    legacyFontDirectory: true,
  });
  const result = listThemes(dir);
  assert.deepEqual(result.problems, []);
  assert.match(result.themes[0].fonts[0].filePath, /字体资源\/display\.ttf$/);
});

test('v3 缺核心文件与重复 theme_id 都进入明确问题清单', () => {
  const dir = mkdtempSync(join(tmpdir(), 'theme-problem-'));
  writeThemePackage(dir, '1. 甲主题包', { themeId: 'duplicate-id', name: '甲主题包' });
  writeThemePackage(dir, '2. 乙主题包', { themeId: 'duplicate-id', name: '乙主题包' });
  mkdirSync(join(dir, '3. 缺失主题'));

  const { themes, problems } = listThemes(dir);
  assert.equal(themes.length, 1);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((problem) => /重复/.test(problem)));
  assert.ok(problems.some((problem) => /manifest\.json/.test(problem)));
});

test('v3 缺少视觉规范文件时不注册主题', () => {
  const dir = mkdtempSync(join(tmpdir(), 'theme-spec-missing-'));
  writeThemePackage(dir, '1. 目录主题');
  const missing = join(dir, '1. 目录主题/主题视觉规范/2. 文章封图规范.md');
  // 用一个同名目录替换必需文件，覆盖「路径存在但不是文件」的错误分支。
  const renamed = `${missing}.bak`;
  renameSync(missing, renamed);
  mkdirSync(missing);

  const { themes, problems } = listThemes(dir);
  assert.deepEqual(themes, []);
  assert.match(problems[0], /文章封图规范\.md.*不是文件/);
});

test('preview_image 缺失时保留主题并明确告警', () => {
  const dir = mkdtempSync(join(tmpdir(), 'theme-preview-missing-'));
  writeThemePackage(dir, '1. 目录主题', { previewImage: false });
  const manifestPath = join(dir, '1. 目录主题/manifest.json');
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  parsed.preview_image = '主题展示案例/不存在.png';
  writeFileSync(manifestPath, JSON.stringify(parsed));

  const { themes, problems } = listThemes(dir);
  assert.equal(themes.length, 1);
  assert.equal(themes[0].previewImage, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /preview_image 不可用/);
});

test('文件系统 loader 缺失登记素材时保留主题，但停用该素材并告警', () => {
  const dir = mkdtempSync(join(tmpdir(), 'theme-asset-missing-'));
  writeThemePackage(dir, '1. 目录主题');
  unlinkSync(join(dir, '1. 目录主题/透明装饰素材/mark.png'));

  const { themes, problems } = listThemes(dir);
  assert.equal(themes.length, 1);
  assert.deepEqual(themes[0].assets, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /素材 mark 不可用/);
});

test('preview_image 符号链接越出主题包时拒绝整个主题', () => {
  const dir = mkdtempSync(join(tmpdir(), 'theme-preview-symlink-'));
  writeThemePackage(dir, '1. 安全主题', { previewImage: false });
  const manifestPath = join(dir, '1. 安全主题/manifest.json');
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  parsed.preview_image = '主题展示案例/主题预览图.png';
  writeFileSync(manifestPath, JSON.stringify(parsed));
  const outside = join(mkdtempSync(join(tmpdir(), 'theme-preview-outside-')), 'outside.png');
  writeFileSync(outside, 'outside');
  symlinkSync(outside, join(dir, '1. 安全主题/主题展示案例/主题预览图.png'));

  const { themes, problems } = listThemes(dir);
  assert.equal(themes.length, 0);
  assert.match(problems[0], /不能越出主题包/);
});

test('文件系统 loader 阻止主题包内符号链接逃到包外', () => {
  const dir = mkdtempSync(join(tmpdir(), 'theme-symlink-'));
  writeThemePackage(dir, '1. 安全主题');
  const outside = join(mkdtempSync(join(tmpdir(), 'theme-outside-')), 'outside.png');
  writeFileSync(outside, 'outside');
  // writeThemePackage 已创建普通文件，改用另一个登记素材做越界探针。
  const manifestPath = join(dir, '1. 安全主题/manifest.json');
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  parsed.assets = [{ asset_id: 'escape', file: '透明装饰素材/escape.png' }];
  parsed.components = [];
  writeFileSync(manifestPath, JSON.stringify(parsed));
  symlinkSync(outside, join(dir, '1. 安全主题/透明装饰素材/escape.png'));

  const { themes, problems } = listThemes(dir);
  assert.equal(themes.length, 0);
  assert.match(problems[0], /不能越出主题包/);
});
