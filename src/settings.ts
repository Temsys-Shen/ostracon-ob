import { App, Plugin, PluginSettingTab, Setting, Notice, normalizePath } from "obsidian";
import { DEFAULTS, DEFAULT_OUTPUT_FOLDER, type SettingsHost } from "./contract";

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
      .setDesc("在笔记末尾添加指向 MN 卡片的链接")
      .addToggle((toggle) => {
        toggle.setValue(Boolean(this.plugin.settings.includeBacklinks));
        toggle.onChange(async (value) => {
          this.plugin.settings.includeBacklinks = value;
          await this.plugin.saveSettings();
        });
      });

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
