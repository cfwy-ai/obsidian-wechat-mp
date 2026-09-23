import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const viewSource = await readFile(join(root, 'plugin/view.mjs'), 'utf8');
const styleSource = await readFile(join(root, 'plugin/styles.css'), 'utf8');
const headerStyleSource = await readFile(join(root, 'plugin/header-controls.css'), 'utf8');
const headerSource = await readFile(join(root, 'plugin/header-controls.mjs'), 'utf8');
const buildSource = await readFile(join(root, 'scripts/build.mjs'), 'utf8');
const settingsSource = await readFile(join(root, 'plugin/settings.mjs'), 'utf8');
const exportModalSource = await readFile(join(root, 'plugin/export-modal.mjs'), 'utf8');
const stylesheet = postcss.parse(styleSource);

const declarationsFor = (selector, { topLevel = false } = {}) => {
  let match = null;
  stylesheet.walkRules((rule) => {
    if (match || rule.selector !== selector) return;
    if (topLevel && rule.parent?.type !== 'root') return;
    match = Object.fromEntries(rule.nodes
      .filter((node) => node.type === 'decl')
      .map((node) => [node.prop, node.value]));
  });
  return match;
};

test('静态公众号预览关闭导航历史，并只隐藏自身的 Obsidian 原生 header', () => {
  assert.match(viewSource, /this\.navigation = false;/);

  const header = declarationsFor(
    ".workspace-leaf-content[data-type='changfeng-wechat-mp-preview'] > .view-header",
  );
  const content = declarationsFor(
    ".workspace-leaf-content[data-type='changfeng-wechat-mp-preview'] > .view-content",
  );

  assert.equal(header?.display, 'none');
  assert.equal(content?.height, '100%');
});

test('导出弹窗把姓名输入框并进开关同一行，开关关闭时只隐藏输入框', () => {
  // 一个 Setting 内先 addText 再 addToggle：输入框跟在「显示作者姓名」之后，开关仍在最右。
  assert.match(
    exportModalSource,
    /setName\('显示作者姓名'\)\s*\.addText\(\([\s\S]*?\)\s*\.addToggle\(\(/,
  );
  assert.doesNotMatch(exportModalSource, /setName\('作者姓名'\)/);
  assert.doesNotMatch(exportModalSource, /data-controls-author-input/);
  assert.match(exportModalSource, /this\.authorInput\.style\.display = visible \? '' : 'none'/);
  assert.doesNotMatch(
    exportModalSource,
    /this\.authorSetting\.settingEl\.style\.display/,
  );
  assert.match(exportModalSource, /setPlaceholder\('请输入作者姓名'\)/);
  assert.match(exportModalSource, /toggleEl\?\.setAttribute\('aria-label', '显示作者姓名'\)/);

  const authorInput = declarationsFor('.wechat-mp-export-author-input');
  assert.equal(authorInput?.width, '160px');
  assert.equal(authorInput?.['min-width'], '0');
  assert.equal(authorInput?.['max-width'], '100%');
});

test('导出弹窗提供电脑端与手机端两种导出格式，说明只报两个宽度', () => {
  assert.match(exportModalSource, /setName\('选择导出格式'\)/);
  assert.match(exportModalSource, /\.addDropdown\(\(dropdown\)/);
  assert.match(exportModalSource, /for \(const mode of EXPORT_LAYOUT_MODES\)/);
  assert.match(exportModalSource, /dropdown\.addOption\(mode, EXPORT_LAYOUT_MODE_LABELS\[mode\]\)/);
  assert.match(exportModalSource, /this\.options\.layoutMode = value/);
  // 说明压成一句「电脑端宽度 677px，手机端宽度 390px」，手机端读当前设置值。
  assert.match(
    exportModalSource,
    /setDesc\(\s*`\$\{EXPORT_LAYOUT_MODE_LABELS\.desktop\}宽度 \$\{EXPORT_WIDTH\}px，`\s*\+ `\$\{EXPORT_LAYOUT_MODE_LABELS\.mobile\}宽度 \$\{this\.mobileWidth\}px`,\s*\)/,
  );
  assert.doesNotMatch(exportModalSource, /跟随「手机预览内容宽度」设置/);
  assert.doesNotMatch(exportModalSource, /正文；/);
  // 手机端宽度来自插件设置，而不是弹窗里再开一个输入项。
  assert.match(exportModalSource, /exportLayoutWidthForMode\('mobile', mobileWidth\)/);
  assert.match(viewSource, /mobileWidth: this\.plugin\.settings\.mobilePreviewWidth/);
  assert.match(
    viewSource,
    /renderLongImagePng\(exportHtml, \{\s*scale: options\.scale,\s*layoutWidth: options\.layoutWidth,\s*\}\)/,
  );
});

test('导出弹窗按标题、作者、格式、保存位置排序，控件宽度统一', () => {
  const order = ['显示文档标题', '显示作者姓名', '选择导出格式', '保存位置']
    .map((name) => exportModalSource.indexOf(`setName('${name}')`));
  assert.ok(order.every((index) => index > 0), `缺少设置行：${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));

  const modalItem = declarationsFor('.wechat-mp-export-modal .setting-item');
  const formatSelect = declarationsFor('.wechat-mp-export-format-select');
  assert.equal(modalItem?.['align-items'], 'center');
  assert.equal(formatSelect?.width, '108px');
  assert.equal(formatSelect?.['min-width'], '108px');
  assert.match(exportModalSource, /dropdown\.selectEl\?\.classList\.add\('wechat-mp-export-format-select'\)/);
});

test('设置页提供默认关闭的主题内部资源显示开关，并说明隐藏不等于删除', () => {
  assert.match(settingsSource, /setName\('显示主题内部资源'\)/);
  assert.match(settingsSource, /配套字体资源/);
  assert.match(settingsSource, /正文组件结构/);
  assert.match(settingsSource, /不会删除文件或停止主题加载/);
  assert.match(settingsSource, /showInternalThemeResources/);
});

test('标题图片运行时接收完整主题素材清单，用于画布内的顺序编号', () => {
  assert.match(
    viewSource,
    /headingImageRuntime\.materialize\(\{[\s\S]*?headingImages,[\s\S]*?fonts,[\s\S]*?assets,[\s\S]*?\}\)/,
  );
});

test('正常宽度工具栏严格复用 Obsidian 40px header，窄面板保留两行布局', () => {
  const toolbar = declarationsFor('.wechat-mp-toolbar', { topLevel: true });
  assert.equal(toolbar?.height, 'var(--header-height, 40px)');
  assert.equal(toolbar?.['min-height'], 'var(--header-height, 40px)');
  assert.equal(toolbar?.['box-sizing'], 'border-box');
  assert.equal(toolbar?.padding, '0');
  assert.equal(toolbar?.['border-bottom'], 'var(--file-header-border)');
  assert.equal(toolbar?.background, 'var(--file-header-background, var(--background-primary))');

  let narrowToolbar = null;
  stylesheet.walkAtRules('container', (container) => {
    if (!container.params.includes('max-width: 600px')) return;
    container.walkRules('.wechat-mp-toolbar', (rule) => {
      narrowToolbar = Object.fromEntries(rule.nodes
        .filter((node) => node.type === 'decl')
        .map((node) => [node.prop, node.value]));
    });
  });
  assert.equal(narrowToolbar?.height, 'auto');
  assert.equal(narrowToolbar?.['min-height'], '68px');
  assert.equal(narrowToolbar?.padding, '5px 0');
});

test('工具栏将头图紧跟复制图文、位于标题换行前，不显示静态图片数量或重复关闭按钮', () => {
  assert.match(
    viewSource,
    /controls\.append\(\s*this\.themeControlEl,\s*this\.copyButtonEl,\s*this\.headerControls\.element,\s*this\.headingBreakControls\.element,\s*this\.exportButtonEl,\s*this\.mobilePreviewButtonEl,\s*this\.syncButtonEl,\s*\);/s,
  );
  assert.match(viewSource, /'wechat-mp-toggle-label', '手机预览'/);
  assert.doesNotMatch(
    viewSource,
    /imageCountEl|wechat-mp-image-count|wechat-mp-toolbar-meta|全文共\s*\$?\{?[^\n]*张图片/,
  );
  assert.doesNotMatch(viewSource, /closeSlotEl|closeButtonEl|wechat-mp-close-action/);
  assert.match(viewSource, /new Notice\(formatCopyResultNotice\(result\)\)/);
  assert.doesNotMatch(viewSource, /result\.embeddedCount === result\.imageCount/);
});

test('主题、复制、导出与两个滑块复用 26px 高度和 7px 圆角', () => {
  const themeControl = declarationsFor('.wechat-mp-theme-control');
  const theme = declarationsFor('.wechat-mp-theme-trigger');
  const tool = declarationsFor('.wechat-mp-tool-button');
  const toggle = declarationsFor('.wechat-mp-toggle-control');
  const themeLabel = declarationsFor('.wechat-mp-theme-label');
  const themeDivider = declarationsFor('.wechat-mp-theme-label::after');

  assert.equal(themeControl?.display, 'flex');
  assert.equal(themeControl?.height, '26px');
  assert.equal(themeControl?.['min-height'], '26px');
  assert.equal(themeControl?.['align-items'], 'center');
  assert.equal(theme?.display, 'flex');
  assert.equal(theme?.['box-sizing'], 'border-box');

  for (const control of [theme, tool, toggle]) {
    assert.equal(control?.height, '26px');
    assert.equal(control?.['min-height'], '26px');
    assert.equal(control?.['border-radius'], '7px');
    assert.equal(control?.background, 'var(--background-primary-alt)');
    assert.equal(control?.['box-shadow'], 'none');
  }
  assert.equal(themeLabel?.['margin-inline-end'], '8px');
  assert.equal(
    themeLabel?.color,
    'color-mix(in srgb, var(--interactive-accent) 68%, var(--text-muted))',
  );
  assert.equal(themeDivider?.content, "'·'");
  assert.equal(themeDivider?.['margin-inline-start'], '8px');
  assert.equal(themeDivider?.color, 'var(--text-faint)');
});

test('操作控件放宽间距并整体下移，不残留图片数量样式', () => {
  const frame = declarationsFor('.wechat-mp-toolbar-frame');
  const controls = declarationsFor('.wechat-mp-toolbar-controls');
  const imageCount = declarationsFor('.wechat-mp-image-count');
  const toolbarMeta = declarationsFor('.wechat-mp-toolbar-meta');

  assert.equal(frame?.transform, 'translateY(1px)');
  assert.equal(controls?.gap, '8px');
  assert.equal(imageCount, null);
  assert.equal(toolbarMeta, null);
});

test('头图尾图采用纯四字按钮与悬停提示，缩略图保持横图且不裁切', () => {
  assert.match(headerSource, /wechat-mp-tool-button wechat-mp-header-trigger', '头图尾图'/);
  assert.doesNotMatch(headerSource, /chevron-down|wechat-mp-header-chevron/);
  assert.match(headerSource, /点击展开页首页尾选项/);
  assert.match(headerSource, /setAttribute\('aria-haspopup', 'dialog'\)/);
  const headerStyles = postcss.parse(headerStyleSource);
  const rules = new Map();
  headerStyles.walkRules(rule => {
    if (rule.parent.type !== 'root') return;
    rules.set(rule.selector, Object.fromEntries(rule.nodes.filter(node => node.type === 'decl')
      .map(node => [node.prop, node.value])));
  });
  assert.equal(rules.get('.wechat-mp-header-control')?.height, '26px');
  assert.equal(rules.get('.wechat-mp-header-popover')?.position, 'fixed');
  assert.equal(rules.get('.wechat-mp-header-popover')?.width, '330px');
  assert.equal(rules.get('.wechat-mp-header-presets')?.['grid-template-columns'], 'repeat(2, minmax(0, 1fr))');
  assert.equal(rules.get('.wechat-mp-header-preset-preview')?.['aspect-ratio'], '3 / 1');
  assert.equal(rules.get('.wechat-mp-header-preset-preview img')?.['object-fit'], 'contain');
});

test('头图样式合并进安装包，窄工具栏取消旧六项网格并按DOM顺序换行', () => {
  assert.match(buildSource, /\['styles\.css', 'header-controls\.css'\]/);
  assert.match(buildSource, /writeFile\(join\(distDir, 'styles\.css'\), styleSources\.join/);
  assert.doesNotMatch(headerStyleSource, /@import|wechat-mp-canvas|wechat-mp-preview-shell|wechat-mp-viewport/);
  const headerStyles = postcss.parse(headerStyleSource);
  const narrow = new Map();
  headerStyles.walkAtRules('container', container => {
    if (!container.params.includes('max-width: 720px')) return;
    container.walkRules(rule => narrow.set(rule.selector, Object.fromEntries(rule.nodes
      .filter(node => node.type === 'decl').map(node => [node.prop, node.value]))));
  });
  assert.equal(narrow.get('.wechat-mp-toolbar-frame')?.display, 'block');
  assert.equal(narrow.get('.wechat-mp-toolbar-controls')?.display, 'flex');
  assert.equal(narrow.get('.wechat-mp-toolbar-controls')?.['flex-wrap'], 'wrap');
  assert.equal(narrow.get('.wechat-mp-toolbar')?.['min-height'], '68px');
  assert.equal(narrow.get('.wechat-mp-toolbar-controls')?.['row-gap'], '0');
  assert.equal(narrow.get('.wechat-mp-toolbar-controls')?.['margin-top'], '-6px');
  assert.equal(narrow.get('.wechat-mp-toolbar-controls > *')?.['margin-top'], '6px');
  assert.equal(narrow.get('.wechat-mp-toolbar-controls::after')?.['flex-basis'], '100%');
  assert.equal(narrow.get('.wechat-mp-toolbar-controls::after')?.height, '0');
  assert.equal(narrow.get('.wechat-mp-toolbar-controls::after')?.order, '1');
  assert.equal(narrow.get('.wechat-mp-toolbar-controls > .wechat-mp-mobile-control,\n  .wechat-mp-toolbar-controls > .wechat-mp-sync-control')?.order, '2');
});

test('复制图文使用中性按钮和两端渐隐下划线，不再铺满亮蓝背景', () => {
  const copy = declarationsFor('.wechat-mp-copy-action');
  const underline = declarationsFor('.wechat-mp-copy-action::after');

  assert.doesNotMatch(viewSource, /wechat-mp-copy-action is-primary/);
  assert.equal(copy?.background, 'var(--background-primary-alt)');
  assert.equal(copy?.['border-color'], 'var(--background-modifier-border)');
  assert.match(copy?.color ?? '', /interactive-accent/);
  assert.match(underline?.background ?? '', /linear-gradient/);
  assert.match(underline?.background ?? '', /transparent/);
  assert.equal(underline?.left, '7px');
  assert.equal(underline?.right, '7px');
  assert.equal(underline?.height, '1px');
  assert.equal(underline?.opacity, '0.72');
});

test('主题菜单压过 Obsidian 默认按钮灰底，并以留白分开未选项', () => {
  const list = declarationsFor('.wechat-mp-theme-list');
  const option = declarationsFor('.wechat-mp-theme-list > button.wechat-mp-theme-option');
  const selected = declarationsFor(
    '.wechat-mp-theme-list > button.wechat-mp-theme-option.is-selected',
  );

  assert.equal(list?.gap, '5px');
  assert.equal(option?.appearance, 'none');
  assert.equal(option?.height, 'auto');
  assert.equal(option?.['background-color'], 'transparent');
  assert.equal(option?.['box-shadow'], 'none');
  assert.equal(option?.border, '1px solid transparent');
  assert.match(selected?.['background-color'] ?? '', /interactive-accent/);
  assert.match(selected?.['border-color'] ?? '', /interactive-accent/);
});

test('风格菜单收窄20px并移除右侧勾，选中浅底和键盘焦点仍清晰', () => {
  const popover = declarationsFor('.wechat-mp-theme-popover', { topLevel: true });
  const option = declarationsFor('.wechat-mp-theme-list > button.wechat-mp-theme-option');
  const selected = declarationsFor('.wechat-mp-theme-list > button.wechat-mp-theme-option.is-selected');
  const focused = declarationsFor('.wechat-mp-theme-list > button.wechat-mp-theme-option:focus-visible');
  assert.equal(popover?.width, '320px');
  assert.equal(option?.['grid-template-columns'], 'minmax(0, 1fr)');
  assert.doesNotMatch(viewSource, /wechat-mp-theme-check/);
  assert.doesNotMatch(styleSource, /wechat-mp-theme-check/);
  assert.match(viewSource, /option\.setAttribute\('aria-selected', String\(selected\)\)/);
  assert.match(selected?.['background-color'] ?? '', /interactive-accent\) 9%/);
  assert.match(selected?.['border-color'] ?? '', /interactive-accent\) 24%/);
  assert.equal(focused?.outline, '2px solid var(--interactive-accent)');
  assert.doesNotMatch(JSON.stringify([selected, focused]), /gradient/);
  assert.match(headerSource, /setIcon\(check, 'check'\)/);

  let narrowWidth;
  stylesheet.walkAtRules('container', container => {
    if (!container.params.includes('max-width: 600px')) return;
    container.walkRules('.wechat-mp-theme-popover', rule => {
      narrowWidth = rule.nodes.find(node => node.type === 'decl' && node.prop === 'width')?.value;
    });
  });
  assert.equal(narrowWidth, 'min(330px, calc(100cqw - 28px))');
});
