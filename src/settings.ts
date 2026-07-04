import { App, Plugin, PluginSettingTab, Setting, Notice, normalizePath } from "obsidian";
import { createToken, type OstraconSettings } from "./contract";

type OstraconPluginLike = {
  settings: OstraconSettings;
  saveSettings: () => Promise<void>;
  restartServer: () => Promise<void>;
  getConnectionUrl: () => string;
};

class OstraconSettingTab extends PluginSettingTab {
  plugin: OstraconPluginLike;

  constructor(app: App, plugin: OstraconPluginLike & Plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("主机")
      .setDesc("建议127.0.0.1")
      .addText((text) => {
        text.setValue(this.plugin.settings.host);
        text.onChange(async (value) => {
          this.plugin.settings.host = value.trim() || "127.0.0.1";
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
          this.plugin.settings.outputFolder = normalizePath(value.trim() || "Ostracon/Inbox");
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
      .setName("Token")
      .setDesc("本机连接凭据")
      .addText((text) => {
        text.setValue(this.plugin.settings.token);
        text.onChange(async (value) => {
          this.plugin.settings.token = value.trim() || createToken();
          await this.plugin.saveSettings();
          await this.plugin.restartServer();
        });
      })
      .addButton((button) => {
        button.setButtonText("重新生成");
        button.onClick(async () => {
          this.plugin.settings.token = createToken();
          await this.plugin.saveSettings();
          await this.plugin.restartServer();
          this.display();
        });
      });

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
