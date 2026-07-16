import { App, Plugin, PluginSettingTab, Setting, Notice, normalizePath } from "obsidian";
import { DEFAULTS, DEFAULT_OUTPUT_FOLDER, type SettingsHost } from "./contract";
import { renderQuoteTemplate, validateQuoteTemplate } from "./quote-template";

class OstraconSettingTab extends PluginSettingTab {
  plugin: SettingsHost;
  constructor(app: App, plugin: SettingsHost & Plugin) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const section = (title: string, open: boolean) => {
      const details = containerEl.createEl("details", { cls: "ostracon-settings-section" });
      details.open = open;
      details.createEl("summary", { text: title });
      return details.createDiv({ cls: "ostracon-settings-section-content" });
    };

    const connection = section("连接", false);
    new Setting(connection).setName("主机").setDesc("监听地址").addText(text => {
      text.setValue(this.plugin.settings.host);
      text.onChange(async value => { this.plugin.settings.host = value.trim() || DEFAULTS.host; await this.plugin.saveSettings(); });
    });
    new Setting(connection).setName("端口").setDesc("MN连接端口").addText(text => {
      text.inputEl.type = "number"; text.setValue(String(this.plugin.settings.port));
      text.onChange(async value => { const port = Number(value); if (!Number.isInteger(port) || port <= 0) { new Notice("端口必须是正整数"); return; } this.plugin.settings.port = port; await this.plugin.saveSettings(); await this.plugin.restartServer(); });
    });
    new Setting(connection).setName("自动启动").setDesc("打开Obsidian时自动启动服务").addToggle(toggle => {
      toggle.setValue(this.plugin.settings.autoStartServer); toggle.onChange(async value => { this.plugin.settings.autoStartServer = value; await this.plugin.saveSettings(); await this.plugin.restartServer(); });
    });
    new Setting(connection).setName("连接地址").setDesc(this.plugin.getConnectionUrl()).addButton(button => {
      button.setButtonText("复制"); button.onClick(async () => { await navigator.clipboard.writeText(this.plugin.getConnectionUrl()); new Notice("已复制连接地址"); });
    });

    const storage = section("导入与存储", false);
    new Setting(storage).setName("导出目录").setDesc("主动推送文件的写入位置").addText(text => {
      text.setValue(this.plugin.settings.outputFolder); text.onChange(async value => { this.plugin.settings.outputFolder = normalizePath(value.trim() || DEFAULT_OUTPUT_FOLDER); await this.plugin.saveSettings(); });
    });
    new Setting(storage).setName("Base64自动转图片").setDesc("导入时将图片数据保存为本地文件").addToggle(toggle => {
      toggle.setValue(this.plugin.settings.autoConvertBase64); toggle.onChange(async value => { this.plugin.settings.autoConvertBase64 = value; await this.plugin.saveSettings(); });
    });

    const templates = section("模板", true);
    new Setting(templates).setName("创建引文卡片").addToggle(toggle => {
      toggle.setValue(this.plugin.settings.createQuoteCard); toggle.onChange(async value => { this.plugin.settings.createQuoteCard = value; await this.plugin.saveSettings(); });
    });
    this.renderTemplate(templates, "引用模板", this.plugin.settings.quoteTemplate, { content: "第一行\n第二行", link: "marginnote4app://note/example" }, value => { this.plugin.settings.quoteTemplate = value; });
    this.renderTemplate(templates, "卡片模板", this.plugin.settings.cardTemplate, { heading: "##", title: "示例卡片", content: "示例正文", link: "marginnote4app://note/example" }, value => { this.plugin.settings.cardTemplate = value; });

    const devices = section("设备", false);
    const approved = this.plugin.settings.approvedDevices || [];
    if (approved.length === 0) devices.createEl("p", { text: "暂无已批准设备", cls: "ostracon-settings-empty" });
    approved.forEach(device => new Setting(devices).setName(device.name || device.clientId).setDesc(`批准于 ${new Date(device.approvedAt).toLocaleString()}`).addButton(button => {
      button.setButtonText("移除"); button.onClick(async () => { this.plugin.settings.approvedDevices = approved.filter(item => item.clientId !== device.clientId); await this.plugin.saveSettings(); this.display(); });
    }));
  }

  private renderTemplate(container: HTMLElement, name: string, initial: string, context: Parameters<typeof renderQuoteTemplate>[1], save: (value: string) => void): void {
    let input!: HTMLTextAreaElement;
    const setting = new Setting(container).setName(name).addTextArea(text => { input = text.inputEl; text.inputEl.rows = 7; text.setValue(initial); });
    setting.settingEl.addClass("ostracon-template-setting");
    const tools = setting.controlEl.createDiv({ cls: "ostracon-template-tools" });
    const status = setting.controlEl.createDiv({ cls: "ostracon-template-status" });
    const preview = setting.controlEl.createEl("pre", { cls: "ostracon-template-preview" });
    const tokens = name === "卡片模板" ? ["{{heading}}", "{{title}}", "{{title|link}}", "{{content}}", "|trim", "|singleline"] : ["{{content}}", "{{link}}", "{{#link}}{{/link}}", "|trim", "|singleline", "|blockquote"];
    const update = async () => { try { validateQuoteTemplate(input.value); preview.setText(renderQuoteTemplate(input.value, context)); status.setText("语法有效"); status.removeClass("is-error"); save(input.value); await this.plugin.saveSettings(); } catch (error) { status.setText(error instanceof Error ? error.message : String(error)); status.addClass("is-error"); } };
    input.addEventListener("input", () => { void update(); });
    tokens.forEach(token => { const button = tools.createEl("button", { text: token, attr: { type: "button" } }); button.addEventListener("click", () => { input.setRangeText(token, input.selectionStart, input.selectionEnd, "end"); input.focus(); void update(); }); });
    void update();
  }
}

export { OstraconSettingTab };
