import { Modal, PluginSettingTab, Setting } from 'obsidian';
import { DEFAULT_SETTINGS } from './constants.mjs';
import { cleanVaultFolder } from '../src/vault-path.mjs';

export class WechatMpSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: '长风·公众号排版' });
    containerEl.createEl('p', { text: '把时间还给创作。选择模板，复制图文，粘贴到公众号。' });

    new Setting(containerEl)
      .setName('模板介绍')
      .setDesc('查看模板的配色、适用文章和介绍图。')
      .addButton((button) => button.setButtonText('浏览模板').onClick(() => {
        new ThemeGalleryModal(this.app, this.plugin).open();
      }));

    new Setting(containerEl)
      .setName('模板来源')
      .setDesc('内置 10 套模板，安装后即可使用。开发主题时可切换到当前库中的目录。')
      .addDropdown((dropdown) => dropdown
        .addOption('bundled', '内置模板')
        .addOption('vault', '库内主题（开发者）')
        .setValue(this.plugin.settings.themeSource)
        .onChange(async (themeSource) => {
          await this.plugin.updateSettings({ themeSource });
          this.display();
        }));

    if (this.plugin.settings.themeSource === 'vault') {
      new Setting(containerEl)
        .setName('风格目录')
        .setDesc('相对于当前 Vault 的路径。兼容直属 Markdown 主题与包含 manifest.json 的目录式主题包。')
        .addText((text) =>
          text
            .setPlaceholder('例如：我的主题')
            .setValue(this.plugin.settings.themeFolder)
            .onChange(async (value) => {
              await this.plugin.updateSettings({ themeFolder: cleanVaultFolder(value) });
            }),
        );
    }

    new Setting(containerEl)
      .setName('桌面预览内容宽度')
      .setDesc('默认 677px，对齐公众号桌面编辑器的正文区。窄窗口会自动缩到可用宽度。')
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.previewWidth))
          .setValue(String(this.plugin.settings.previewWidth))
          .onChange(async (value) => {
            await this.plugin.updateSettings({ previewWidth: value });
          }),
      );

    new Setting(containerEl)
      .setName('手机预览内容宽度')
      .setDesc('默认 390px；支持 320–430px，用于模拟目标手机的文章外框，不能消除不同机型和字体设置的差异。')
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.mobilePreviewWidth))
          .setValue(String(this.plugin.settings.mobilePreviewWidth))
          .onChange(async (value) => {
            await this.plugin.updateSettings({ mobilePreviewWidth: value });
          }),
      );

    if (this.plugin.settings.themeSource === 'vault') new Setting(containerEl)
      .setName('显示主题内部资源')
      .setDesc('默认关闭；关闭时只在文件树隐藏每套主题的「配套字体资源」（兼容旧「字体资源」）和「正文组件结构」，不会删除文件或停止主题加载。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showInternalThemeResources)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ showInternalThemeResources: value });
          }),
      );

    new Setting(containerEl)
      .setName('标题换行工具（试用）')
      .setDesc('在公众号工具栏和编辑区右键菜单显示一至六级标题的换行入口。关闭只隐藏工具，不删除已写入的换行，也不影响其他排版功能。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.headingBreakToolsEnabled !== false)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ headingBreakToolsEnabled: value });
          }),
      );

    new Setting(containerEl)
      .setName('默认联动滚动')
      .setDesc('排版模式打开后，原文和预览按阅读进度同步；面板内可随时关闭。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncScroll)
          .onChange(async (value) => {
            await this.plugin.setScrollSync(value);
          }),
      );

    new Setting(containerEl)
      .setName('恢复默认')
      .setDesc('恢复内置模板与预览偏好；文章和自定义主题文件不会被修改。')
      .addButton((button) =>
        button.setButtonText('恢复默认').onClick(async () => {
          await this.plugin.updateSettings({ ...DEFAULT_SETTINGS });
          this.display();
        }),
      );

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '「简笔手绘」使用 HarmonyOS Sans 字体。字体版权与完整许可随插件的 templates 目录提供。',
    });
  }
}

class ThemeGalleryModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    this.titleEl.setText('模板介绍');
    this.modalEl.addClass('wechat-mp-theme-gallery-modal');
    this.contentEl.createEl('p', { text: '正文样式沿用已完成的模板；标注「视觉样张（待确认）」的介绍图仍在评选。' });
    const { themes, problems } = await this.plugin.themeResources.discover(this.plugin.settings);
    if (problems.length) this.contentEl.createEl('p', { text: problems.join('；'), cls: 'mod-warning' });
    for (const theme of themes) {
      const section = this.contentEl.createDiv({ cls: 'wechat-mp-theme-gallery-item' });
      section.createEl('h3', { text: theme.name });
      section.createEl('p', { text: theme.summary || '可在文章预览中查看实际排版。' });
      const image = theme.showcaseImage ?? theme.previewImage;
      if (image) {
        const label = theme.showcaseImage
          ? (theme.showcaseStatus === 'draft' ? '视觉样张（待确认）' : '模板介绍图')
          : '正文预览 · 介绍图待补充';
        section.createEl('small', { text: label });
        const img = section.createEl('img', { attr: { src: image.url, alt: `${theme.name} · ${label}`, loading: 'lazy' } });
        img.addEventListener('error', () => {
          img.remove();
          section.createEl('p', { text: '介绍图暂不可用，请在文章预览中查看模板。' });
        }, { once: true });
      } else {
        section.createEl('small', { text: '介绍图待补充 · 可直接打开文章预览查看模板。' });
      }
      new Setting(section).addButton((button) => button.setButtonText('使用此模板').onClick(async () => {
        await this.plugin.selectTheme({ path: theme.path, themeId: theme.themeId });
        this.plugin.scheduleRefresh();
        this.close();
      }));
    }
  }

  onClose() { this.contentEl.empty(); }
}
