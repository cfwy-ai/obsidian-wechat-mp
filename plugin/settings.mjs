import { PluginSettingTab, Setting } from 'obsidian';
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

    new Setting(containerEl)
      .setName('风格目录')
      .setDesc('相对于当前 Vault 的路径。兼容直属 Markdown 主题与包含 manifest.json 的目录式主题包。')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.themeFolder)
          .setValue(this.plugin.settings.themeFolder)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ themeFolder: cleanVaultFolder(value) });
          }),
      );

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

    new Setting(containerEl)
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
      .setDesc('只恢复风格目录、内部资源显示、标题换行工具、预览宽度、预览模式和滚动偏好，不修改任何文章或风格文件。')
      .addButton((button) =>
        button.setButtonText('恢复默认').onClick(async () => {
          await this.plugin.updateSettings({ ...DEFAULT_SETTINGS });
          this.display();
        }),
      );
  }
}
