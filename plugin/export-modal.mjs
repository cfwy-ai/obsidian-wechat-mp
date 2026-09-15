import { Modal, Notice, Setting } from 'obsidian';
import {
  DEFAULT_EXPORT_LAYOUT_MODE,
  DEFAULT_EXPORT_SCALE,
  EXPORT_LAYOUT_MODES,
  EXPORT_LAYOUT_MODE_LABELS,
  EXPORT_WIDTH,
  exportLayoutWidthForMode,
  normalizeExportOptions,
} from './export-image.mjs';

let exportModalSequence = 0;

export class ExportLongImageModal extends Modal {
  constructor(app, {
    defaultDirectory,
    suggestedFilename,
    mobileWidth,
    chooseDestination,
    onSubmit,
  }) {
    super(app);
    this.defaultDirectory = defaultDirectory;
    this.suggestedFilename = suggestedFilename;
    // 手机端导出跟随「手机预览内容宽度」，这里先归一化一次，供文案和提交共用。
    this.mobileWidth = exportLayoutWidthForMode('mobile', mobileWidth);
    this.chooseDestination = chooseDestination;
    this.onSubmit = onSubmit;
    this.options = {
      layoutMode: DEFAULT_EXPORT_LAYOUT_MODE,
      mobileWidth: this.mobileWidth,
      showTitle: true,
      showAuthor: true,
      author: '',
      scale: DEFAULT_EXPORT_SCALE,
      destinationPath: null,
    };
  }

  onOpen() {
    this.modalEl.addClass('wechat-mp-export-modal');
    this.titleEl.setText('导出长图');
    this.contentEl.empty();

    new Setting(this.contentEl)
      .setName('显示文档标题')
      .addToggle((toggle) => toggle
        .setValue(this.options.showTitle)
        .onChange((value) => { this.options.showTitle = value; }));

    // 姓名输入框与开关同处一行：开关在最右，输入框紧跟在「显示作者姓名」之后。
    this.authorSetting = new Setting(this.contentEl)
      .setName('显示作者姓名')
      .addText((text) => {
        this.authorInput = text.inputEl;
        this.authorInput.classList.add('wechat-mp-export-author-input');
        text
          .setPlaceholder('请输入作者姓名')
          .setValue(this.options.author)
          .onChange((value) => { this.options.author = value; });
      })
      .addToggle((toggle) => {
        toggle.toggleEl?.setAttribute('aria-label', '显示作者姓名');
        toggle
          .setValue(this.options.showAuthor)
          .onChange((value) => {
            this.options.showAuthor = value;
            this.updateAuthorInput();
            if (value) this.authorInput?.focus();
          });
      });
    if (this.authorSetting?.controlEl && this.authorInput) {
      const inputId = `wechat-mp-export-author-${++exportModalSequence}`;
      const hiddenLabel = document.createElement('label');
      hiddenLabel.className = 'wechat-mp-sr-only';
      hiddenLabel.htmlFor = inputId;
      hiddenLabel.textContent = '作者姓名';
      this.authorInput.id = inputId;
      this.authorInput.removeAttribute('aria-label');
      this.authorInput.removeAttribute('aria-labelledby');
      this.authorSetting.controlEl.prepend(hiddenLabel);
    }
    this.updateAuthorInput();

    // 手机端宽度跟随设置里的「手机预览内容宽度」，说明文案只报当前生效的两个宽度。
    new Setting(this.contentEl)
      .setName('选择导出格式')
      .setDesc(
        `${EXPORT_LAYOUT_MODE_LABELS.desktop}宽度 ${EXPORT_WIDTH}px，`
        + `${EXPORT_LAYOUT_MODE_LABELS.mobile}宽度 ${this.mobileWidth}px`,
      )
      .addDropdown((dropdown) => {
        dropdown.selectEl?.classList.add('wechat-mp-export-format-select');
        for (const mode of EXPORT_LAYOUT_MODES) {
          dropdown.addOption(mode, EXPORT_LAYOUT_MODE_LABELS[mode]);
        }
        dropdown
          .setValue(this.options.layoutMode)
          .onChange((value) => { this.options.layoutMode = value; });
      });

    this.destinationSetting = new Setting(this.contentEl)
      .setName('保存位置')
      .setDesc(`默认：下载文件夹（${this.defaultDirectory}）`)
      .addButton((button) => {
        button
          .setButtonText('选择…')
          .setTooltip('选择长图文件名和保存位置')
          .onClick(async () => {
            button.setDisabled(true).setButtonText('选择中…');
            try {
              const selected = await this.chooseDestination({
                defaultDirectory: this.defaultDirectory,
                suggestedFilename: this.suggestedFilename,
              });
              if (!selected?.path) return;
              this.options.destinationPath = selected.path;
              this.destinationSetting.setDesc(`自选位置：${selected.path}`);
            } catch (error) {
              new Notice(
                `无法选择保存位置：${error instanceof Error ? error.message : String(error)}`,
              );
            } finally {
              button.setDisabled(false).setButtonText('选择…');
            }
          });
      });

    const actions = this.contentEl.createDiv({ cls: 'wechat-mp-export-actions' });
    const cancelButton = actions.createEl('button', { text: '取消' });
    cancelButton.type = 'button';
    cancelButton.addEventListener('click', () => this.close());

    const exportButton = actions.createEl('button', {
      cls: 'mod-cta',
      text: '导出 PNG',
    });
    exportButton.type = 'button';
    exportButton.addEventListener('click', () => {
      let options;
      try {
        options = normalizeExportOptions(this.options);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
        this.authorInput?.focus();
        return;
      }
      this.close();
      void this.onSubmit(options);
    });
  }

  /** 只隐藏输入框本身，开关所在的整行始终留在弹窗里。 */
  updateAuthorInput() {
    const visible = Boolean(this.options.showAuthor);
    if (this.authorInput) {
      this.authorInput.style.display = visible ? '' : 'none';
      this.authorInput.disabled = !visible;
    }
    this.authorSetting?.settingEl?.classList.toggle('has-author-input', visible);
  }

  onClose() {
    this.contentEl.empty();
  }
}
