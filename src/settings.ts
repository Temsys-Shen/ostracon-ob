import { App, Plugin, PluginSettingTab, Setting, Notice, ToggleComponent, normalizePath } from "obsidian";
import { DEFAULTS, DEFAULT_OUTPUT_FOLDER, DEFAULT_QUOTE_TEMPLATE, DEFAULT_CARD_TEMPLATE, type SettingsHost } from "./contract";
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
    this.renderTemplateWorkspace(templates);

    const devices = section("设备", false);
    const approved = this.plugin.settings.approvedDevices || [];
    if (approved.length === 0) devices.createEl("p", { text: "暂无已批准设备", cls: "ostracon-settings-empty" });
    approved.forEach(device => new Setting(devices).setName(device.name || device.clientId).setDesc(`批准于 ${new Date(device.approvedAt).toLocaleString()}`).addButton(button => {
      button.setButtonText("移除"); button.onClick(async () => { this.plugin.settings.approvedDevices = approved.filter(item => item.clientId !== device.clientId); await this.plugin.saveSettings(); this.display(); });
    }));
  }

  private renderTemplateWorkspace(container: HTMLElement): void {
    const tabs = container.createDiv({ cls: "ostracon-template-tabs", attr: { role: "tablist", "aria-label": "模板类型" } });
    const panels = container.createDiv({ cls: "ostracon-template-workspace" });
    const quoteTab = tabs.createEl("button", { text: "引用模板", cls: "is-active", attr: { type: "button", role: "tab", "aria-selected": "true" } });
    const cardTab = tabs.createEl("button", { text: "卡片模板", attr: { type: "button", role: "tab", "aria-selected": "false" } });
    const quotePanel = this.createTemplatePanel(panels, {
      name: "引用模板", initial: this.plugin.settings.quoteTemplate, defaultValue: DEFAULT_QUOTE_TEMPLATE,
      tokens: ["{{content}}", "{{link}}", "{{#link}}{{/link}}", "|trim", "|singleline", "|blockquote"],
      context: { content: "第一行\n第二行", link: "marginnote4app://note/example" },
      save: value => { this.plugin.settings.quoteTemplate = value; }, quoteToggle: true,
    });
    const cardPanel = this.createTemplatePanel(panels, {
      name: "卡片模板", initial: this.plugin.settings.cardTemplate, defaultValue: DEFAULT_CARD_TEMPLATE,
      tokens: ["{{heading}}", "{{title}}", "{{title|link}}", "{{content}}", "|trim", "|singleline"],
      context: { heading: "##", title: "示例卡片", content: "示例正文", link: "marginnote4app://note/example" },
      save: value => { this.plugin.settings.cardTemplate = value; }, quoteToggle: false,
    });
    cardPanel.hidden = true;
    const activate = (quote: boolean) => {
      quotePanel.hidden = !quote; cardPanel.hidden = quote;
      quoteTab.toggleClass("is-active", quote); cardTab.toggleClass("is-active", !quote);
      quoteTab.setAttr("aria-selected", String(quote)); cardTab.setAttr("aria-selected", String(!quote));
    };
    quoteTab.addEventListener("click", () => activate(true));
    cardTab.addEventListener("click", () => activate(false));
  }

  private createTemplatePanel(container: HTMLElement, config: {
    name: string; initial: string; defaultValue: string; tokens: string[];
    context: Parameters<typeof renderQuoteTemplate>[1]; save: (value: string) => void; quoteToggle: boolean;
  }): HTMLElement {
    const panel = container.createDiv({ cls: "ostracon-template-panel", attr: { role: "tabpanel" } });
    const header = panel.createDiv({ cls: "ostracon-template-header" });
    header.createEl("strong", { text: config.name });
    const actions = header.createDiv({ cls: "ostracon-template-actions" });
    const status = actions.createEl("span", { cls: "ostracon-template-status", attr: { role: "status" } });
    if (config.quoteToggle) {
      const toggleLabel = actions.createEl("label", { cls: "ostracon-template-toggle" });
      toggleLabel.createSpan({ text: "同时在MN创建卡片" });
      new ToggleComponent(toggleLabel).setValue(this.plugin.settings.createQuoteCard).onChange(async value => {
        this.plugin.settings.createQuoteCard = value; await this.plugin.saveSettings();
      });
    }
    const reset = actions.createEl("button", { text: "恢复默认", attr: { type: "button" } });
    const tools = panel.createDiv({ cls: "ostracon-template-tools" });
    const input = panel.createEl("textarea", { cls: "ostracon-template-editor", attr: { "aria-label": config.name, spellcheck: "false" } });
    input.value = config.initial;
    const previewWrap = panel.createDiv({ cls: "ostracon-template-preview-wrap" });
    previewWrap.createEl("span", { text: "预览", cls: "ostracon-template-preview-label" });
    const preview = previewWrap.createEl("pre", { cls: "ostracon-template-preview" });
    const update = async () => {
      try {
        validateQuoteTemplate(input.value); preview.setText(renderQuoteTemplate(input.value, config.context));
        status.setText("已保存"); status.removeClass("is-error"); config.save(input.value); await this.plugin.saveSettings();
      } catch (error) {
        status.setText(`错误：${error instanceof Error ? error.message : String(error)}`); status.addClass("is-error");
      }
    };
    config.tokens.forEach(token => {
      const button = tools.createEl("button", { text: token, attr: { type: "button" } });
      button.addEventListener("click", () => { input.setRangeText(token, input.selectionStart, input.selectionEnd, "end"); input.focus(); void update(); });
    });
    input.addEventListener("input", () => { void update(); });
    reset.addEventListener("click", () => { input.value = config.defaultValue; input.focus(); void update(); });
    void update();
    return panel;
  }
}

export { OstraconSettingTab };
