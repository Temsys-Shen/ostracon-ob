import { App, Plugin, PluginSettingTab, Setting, Notice, normalizePath } from "obsidian";
import { DEFAULTS, DEFAULT_OUTPUT_FOLDER, type SettingsHost } from "./contract";
import { renderQuoteTemplate, validateQuoteTemplate } from "./quote-template";

class OstraconSettingTab extends PluginSettingTab {
  plugin: SettingsHost;

  constructor(app: App, plugin: SettingsHost & Plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("主机")
      .setDesc("默认 :: 监听所有地址（IPv4/IPv6），可改为具体IP")
      .addText((text) => {
        text.setValue(this.plugin.settings.host);
        text.onChange(async (value) => {
          this.plugin.settings.host = value.trim() || DEFAULTS.host;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("端口")
      .setDesc("MN连接端口")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.plugin.settings.port));
        text.onChange(async (value) => {
          const nextPort = Number(value);
          if (!Number.isInteger(nextPort) || nextPort <= 0) {
            new Notice("端口必须是正整数");
            return;
          }
          this.plugin.settings.port = nextPort;
          await this.plugin.saveSettings();
          await this.plugin.restartServer();
        });
      });

    new Setting(containerEl)
      .setName("导出目录")
      .setDesc("写入位置")
      .addText((text) => {
        text.setValue(this.plugin.settings.outputFolder);
        text.onChange(async (value) => {
          this.plugin.settings.outputFolder = normalizePath(value.trim() || DEFAULT_OUTPUT_FOLDER);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("自动启动")
      .setDesc("打开即就绪")
      .addToggle((toggle) => {
        toggle.setValue(Boolean(this.plugin.settings.autoStartServer));
        toggle.onChange(async (value) => {
          this.plugin.settings.autoStartServer = value;
          await this.plugin.saveSettings();
          await this.plugin.restartServer();
        });
      });

    new Setting(containerEl)
      .setName("包含 MarginNote 回链")
      .setDesc("将卡片标题链接到MarginNote")
      .addToggle((toggle) => {
        toggle.setValue(Boolean(this.plugin.settings.includeBacklinks));
        toggle.onChange(async (value) => {
          this.plugin.settings.includeBacklinks = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Base64 自动转图片")
      .setDesc("导入时自动将 base64 编码的图片转为本地文件")
      .addToggle((toggle) => {
        toggle.setValue(Boolean(this.plugin.settings.autoConvertBase64));
        toggle.onChange(async (value) => {
          this.plugin.settings.autoConvertBase64 = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("创建引文卡片")
      .addToggle((toggle) => {
        toggle.setValue(Boolean(this.plugin.settings.createQuoteCard));
        toggle.onChange(async (value) => {
          this.plugin.settings.createQuoteCard = value;
          await this.plugin.saveSettings();
        });
      });

    let templateInput!: HTMLTextAreaElement;
    const templateSetting = new Setting(containerEl)
      .setName("引用模板")
      .addTextArea((text) => {
        templateInput = text.inputEl;
        text.inputEl.rows = 6;
        text.setValue(this.plugin.settings.quoteTemplate);
      });
    templateSetting.settingEl.addClass("ostracon-quote-template-setting");

    const tools = templateSetting.controlEl.createDiv({ cls: "ostracon-template-tools" });
    const status = templateSetting.controlEl.createDiv({ cls: "ostracon-template-status" });
    const preview = templateSetting.controlEl.createEl("pre", { cls: "ostracon-template-preview" });
    const samples = [
      ["内容", "{{content}}"], ["链接", "{{link}}"], ["有链接", "{{#link}}{{/link}}"],
      ["清理", "|trim"], ["单行", "|singleline"], ["引用", "|blockquote"],
    ];

    const updateTemplate = async () => {
      const value = templateInput.value;
      try {
        validateQuoteTemplate(value);
        preview.setText(renderQuoteTemplate(value, { content: "第一行\n第二行", link: "marginnote4app://note/example" }));
        status.setText("语法有效");
        status.removeClass("is-error");
        this.plugin.settings.quoteTemplate = value;
        await this.plugin.saveSettings();
      } catch (error) {
        status.setText(error instanceof Error ? error.message : String(error));
        status.addClass("is-error");
      }
    };
    templateInput.addEventListener("input", () => { void updateTemplate(); });

    for (const [label, token] of samples) {
      const button = tools.createEl("button", { text: label, attr: { type: "button" } });
      button.addEventListener("click", () => {
        const start = templateInput.selectionStart;
        const end = templateInput.selectionEnd;
        templateInput.setRangeText(token, start, end, "end");
        templateInput.focus();
        void updateTemplate();
      });
    }
    void updateTemplate();

    const approvedDevices = this.plugin.settings.approvedDevices || [];
    if (approvedDevices.length > 0) {
      containerEl.createEl("h4", { text: "已批准设备" });
      for (const device of approvedDevices) {
        new Setting(containerEl)
          .setName(device.name || device.clientId)
          .setDesc(`批准于 ${new Date(device.approvedAt).toLocaleString()}`)
          .addButton((button) => {
            button.setButtonText("移除");
            button.onClick(async () => {
              this.plugin.settings.approvedDevices = approvedDevices.filter(
                (d) => d.clientId !== device.clientId,
              );
              await this.plugin.saveSettings();
              this.display();
            });
          });
      }
    }

    new Setting(containerEl)
      .setName("连接")
      .setDesc(this.plugin.getConnectionUrl())
      .addButton((button) => {
        button.setButtonText("复制连接");
        button.onClick(async () => {
          await navigator.clipboard.writeText(this.plugin.getConnectionUrl());
          new Notice("已复制连接");
        });
      });
  }
}

export { OstraconSettingTab };
