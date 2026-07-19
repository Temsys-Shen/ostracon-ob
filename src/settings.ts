import { App, DropdownComponent, Plugin, PluginSettingTab, Setting, Notice, ToggleComponent, normalizePath, setIcon, setTooltip, type SettingDefinitionItem } from "obsidian";
import { DEFAULTS, DEFAULT_OUTPUT_FOLDER, DEFAULT_QUOTE_TEMPLATE, DEFAULT_CARD_TEMPLATE, type SettingsHost } from "./contract";
import {
  MAX_PRINT_MEDIA_HEIGHT_PX, applyCustomMargin, applyCustomPaperDimension, applyMarginPreset, applyPaperSize, createDefaultPdfPrintSettings,
  isPdfMarginPreset, isPdfPaperSize, validatePdfPrintSettings,
} from "./pdf-print-settings";
import { renderQuoteTemplate, validateQuoteTemplate } from "./quote-template";
import { resolveSettingsTabIndex } from "./settings-ui-logic";

type SettingsTabId = "general" | "pdf" | "templates" | "devices";

class OstraconSettingTab extends PluginSettingTab {
  plugin: SettingsHost;
  private activeTab: SettingsTabId = "general";
  private saveStatusTimer: number | null = null;

  constructor(app: App, plugin: SettingsHost & Plugin) { super(app, plugin); this.plugin = plugin; }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{
      name: "Ostracon设置",
      desc: "MarginNote连接、文档导出、模板和设备",
      aliases: ["常规", "主机", "端口", "自动启动", "导出目录", "Base64", "PDF", "文档导出", "纸张", "方向", "页边距", "缩放", "页眉页脚", "模板", "设备"],
      render: setting => {
        setting.settingEl.empty();
        this.renderLayout(setting.settingEl);
      },
    }];
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderLayout(containerEl);
  }

  private renderLayout(containerEl: HTMLElement): void {
    containerEl.addClass("ostracon-settings");

    const tabs = containerEl.createDiv({ cls: "ostracon-settings-tabs", attr: { role: "tablist" } });
    const content = containerEl.createDiv({ cls: "ostracon-settings-content" });
    const definitions: Array<{ id: SettingsTabId; label: string; tooltip?: string; render: (panel: HTMLElement) => void }> = [
      { id: "general", label: "常规", render: panel => this.renderGeneral(panel) },
      { id: "pdf", label: "文档导出", tooltip: "配置导入到MN文档的样式", render: panel => this.renderPdf(panel) },
      { id: "templates", label: "模板", render: panel => this.renderTemplates(panel) },
      { id: "devices", label: "设备", render: panel => this.renderDevices(panel) },
    ];
    const tabButtons: HTMLButtonElement[] = [];
    const panels = new Map<SettingsTabId, HTMLElement>();

    const activate = (id: SettingsTabId, focus = false) => {
      this.activeTab = id;
      definitions.forEach((definition, index) => {
        const active = definition.id === id;
        tabButtons[index].toggleClass("is-active", active);
        tabButtons[index].setAttr("aria-selected", String(active));
        tabButtons[index].tabIndex = active ? 0 : -1;
        panels.get(definition.id)!.hidden = !active;
      });
      if (focus) tabButtons[definitions.findIndex(definition => definition.id === id)].focus();
    };

    definitions.forEach((definition, index) => {
      const panelId = `ostracon-settings-panel-${definition.id}`;
      const button = tabs.createEl("button", {
        text: definition.label,
        attr: { type: "button", role: "tab", "aria-controls": panelId },
      });
      if (definition.tooltip) {
        const info = button.createSpan({ cls: "ostracon-settings-tab-info", attr: { "aria-label": definition.tooltip } });
        setIcon(info, "info");
        setTooltip(info, definition.tooltip, { placement: "bottom" });
      }
      button.addEventListener("click", () => activate(definition.id));
      button.addEventListener("keydown", event => {
        const next = resolveSettingsTabIndex(index, event.key, definitions.length);
        if (next === null) return;
        event.preventDefault();
        activate(definitions[next].id, true);
      });
      tabButtons.push(button);

      const panel = content.createDiv({
        cls: "ostracon-settings-panel",
        attr: { id: panelId, role: "tabpanel" },
      });
      panels.set(definition.id, panel);
      definition.render(panel);
    });
    activate(this.activeTab);
  }

  private createPanelHeader(container: HTMLElement): HTMLElement {
    const header = container.createDiv({ cls: "ostracon-settings-panel-header" });
    return header.createEl("span", { cls: "ostracon-settings-save-status", attr: { role: "status" } });
  }

  private createGroup(container: HTMLElement, title: string): HTMLElement {
    const group = container.createDiv({ cls: "ostracon-settings-group" });
    new Setting(group).setName(title).setHeading();
    return group.createDiv({ cls: "ostracon-settings-rows" });
  }

  private async save(status: HTMLElement): Promise<void> {
    await this.plugin.saveSettings();
    status.setText("已保存");
    status.addClass("is-visible");
    if (this.saveStatusTimer !== null) window.clearTimeout(this.saveStatusTimer);
    this.saveStatusTimer = window.setTimeout(() => status.removeClass("is-visible"), 1400);
  }

  private run(action: () => Promise<void>, context: string): void {
    void action().catch(error => {
      new Notice(`${context}失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private addReset(container: HTMLElement, action: () => Promise<void>): void {
    const footer = container.createDiv({ cls: "ostracon-settings-footer" });
    const button = footer.createEl("button", { text: "恢复默认值", attr: { type: "button" } });
    let armed = false;
    let timer = 0;
    button.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        button.setText("再次确认");
        timer = window.setTimeout(() => { armed = false; button.setText("恢复默认值"); }, 3000);
        return;
      }
      window.clearTimeout(timer);
      this.run(action, "恢复默认值");
    });
  }

  private addSegmented(setting: Setting, options: Array<{ value: string; label: string }>, current: string, onChange: (value: string) => Promise<void>): void {
    const group = setting.controlEl.createDiv({ cls: "ostracon-settings-segmented", attr: { role: "group" } });
    options.forEach(option => {
      const button = group.createEl("button", { text: option.label, attr: { type: "button", "aria-pressed": String(option.value === current) } });
      button.toggleClass("is-active", option.value === current);
      button.addEventListener("click", () => {
        group.querySelectorAll("button").forEach(item => { item.removeClass("is-active"); item.setAttr("aria-pressed", "false"); });
        button.addClass("is-active");
        button.setAttr("aria-pressed", "true");
        this.run(() => onChange(option.value), "保存设置");
      });
    });
  }

  private addValidatedNumber(setting: Setting, value: number, unit: string, min: number, max: number, commit: (value: number) => Promise<void>): HTMLInputElement {
    const wrap = setting.controlEl.createDiv({ cls: "ostracon-settings-number" });
    const input = wrap.createEl("input", { type: "number", value: String(value), attr: { min: String(min), max: String(max) } });
    wrap.createSpan({ text: unit });
    const error = setting.settingEl.createDiv({ cls: "ostracon-settings-field-error", attr: { role: "alert" } });
    input.addEventListener("input", () => {
      const next = Number(input.value);
      if (Number.isFinite(next) && next > max) input.value = String(max);
    });
    const submit = () => {
      const next = Number(input.value);
      if (!Number.isFinite(next) || next < min || next > max) {
        error.setText(`请输入${min}到${max}`);
        setting.settingEl.addClass("has-error");
        return;
      }
      error.empty();
      setting.settingEl.removeClass("has-error");
      this.run(() => commit(next), "保存设置");
    };
    input.addEventListener("blur", submit);
    input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); submit(); } });
    return input;
  }

  private renderGeneral(container: HTMLElement): void {
    const status = this.createPanelHeader(container);
    const connection = this.createGroup(container, "连接");
    new Setting(connection).setName("主机").setDesc("监听地址").addText(text => {
      text.setValue(this.plugin.settings.host).onChange(value => { this.plugin.settings.host = value.trim() || DEFAULTS.host; this.run(() => this.save(status), "保存主机"); });
    });
    new Setting(connection).setName("端口").setDesc("MN连接端口").addText(text => {
      text.inputEl.type = "number";
      text.setValue(String(this.plugin.settings.port));
      text.inputEl.addEventListener("change", () => {
        const port = Number(text.getValue());
        if (!Number.isInteger(port) || port <= 0 || port > 65535) { new Notice("端口必须是1到65535之间的整数"); return; }
        this.plugin.settings.port = port;
        this.run(async () => { await this.save(status); await this.plugin.restartServer(); this.display(); }, "更新端口");
      });
    });
    new Setting(connection).setName("自动启动").setDesc("打开Obsidian时启动连接服务").addToggle(toggle => {
      toggle.setValue(this.plugin.settings.autoStartServer).onChange(value => { this.plugin.settings.autoStartServer = value; this.run(async () => { await this.save(status); await this.plugin.restartServer(); }, "更新自动启动"); });
    });
    const connectionAddress = new Setting(connection).setName("连接地址").setDesc("获取中");
    connectionAddress.settingEl.addClass("ostracon-connection-address");
    const refreshConnectionAddress = async () => {
      try {
        const url = await this.plugin.resolveConnectionUrl();
        connectionAddress.setDesc(url);
        return url;
      } catch (error) {
        connectionAddress.setDesc("获取失败");
        throw error;
      }
    };
    this.run(async () => { await refreshConnectionAddress(); }, "获取连接地址");
    connectionAddress.addButton(button => {
      button.setButtonText("复制").onClick(() => {
        this.run(async () => {
          button.setDisabled(true);
          try {
            const url = await refreshConnectionAddress();
            await navigator.clipboard.writeText(url);
            new Notice("已复制连接地址");
          } finally {
            button.setDisabled(false);
          }
        }, "复制连接地址");
      });
    });

    const storage = this.createGroup(container, "导入与存储");
    new Setting(storage).setName("导出目录").setDesc("主动推送文件的写入位置").addText(text => {
      text.setValue(this.plugin.settings.outputFolder).onChange(value => { this.plugin.settings.outputFolder = normalizePath(value.trim() || DEFAULT_OUTPUT_FOLDER); this.run(() => this.save(status), "保存导出目录"); });
    });
    new Setting(storage).setName("Base64自动转图片").setDesc("导入时保存为本地图片").addToggle(toggle => {
      toggle.setValue(this.plugin.settings.autoConvertBase64).onChange(value => { this.plugin.settings.autoConvertBase64 = value; this.run(() => this.save(status), "保存Base64设置"); });
    });
    this.addReset(container, async () => {
      this.plugin.settings.host = DEFAULTS.host;
      this.plugin.settings.port = 27123;
      this.plugin.settings.autoStartServer = true;
      this.plugin.settings.outputFolder = DEFAULT_OUTPUT_FOLDER;
      this.plugin.settings.autoConvertBase64 = true;
      await this.plugin.saveSettings();
      this.display();
      await this.plugin.restartServer();
    });
  }

  private renderPdf(container: HTMLElement): void {
    const status = this.createPanelHeader(container);
    const settings = this.plugin.settings.pdfPrint;
    try { validatePdfPrintSettings(settings); } catch (error) {
      container.createDiv({ cls: "ostracon-settings-config-error", text: error instanceof Error ? error.message : String(error) });
    }

    const page = this.createGroup(container, "页面");
    const paper = new Setting(page).setName("纸张");
    paper.controlEl.addClass("ostracon-paper-control");
    let paperDropdown!: DropdownComponent;
    const dimensions = paper.controlEl.createDiv({ cls: "ostracon-paper-dimensions" });
    const widthInput = dimensions.createEl("input", { type: "number", value: String(settings.customPageWidthMm), attr: { min: "25.4", max: "1000", step: "0.1" } });
    dimensions.createSpan({ text: "×" });
    const heightInput = dimensions.createEl("input", { type: "number", value: String(settings.customPageHeightMm), attr: { min: "25.4", max: "1000", step: "0.1" } });
    dimensions.createSpan({ text: "mm" });
    const paperError = paper.settingEl.createDiv({ cls: "ostracon-settings-field-error", attr: { role: "alert" } });
    paper.addDropdown(dropdown => {
      paperDropdown = dropdown;
      dropdown
        .addOptions({ A4: "A4", A3: "A3", Letter: "Letter", Legal: "Legal", custom: "自定义" })
        .setValue(settings.paperSize)
        .onChange(value => {
          if (!isPdfPaperSize(value)) throw new Error(`无效纸张类型: ${value}`);
          applyPaperSize(settings, value);
          widthInput.value = String(settings.customPageWidthMm);
          heightInput.value = String(settings.customPageHeightMm);
          paperError.empty(); paper.settingEl.removeClass("has-error");
          this.run(() => this.save(status), "保存纸张设置");
        });
    });
    const bindDimension = (input: HTMLInputElement, dimension: "width" | "height") => {
      input.addEventListener("input", () => { if (Number(input.value) > 1000) input.value = "1000"; });
      const submit = async () => {
        const value = Number(input.value);
        if (!Number.isFinite(value) || value < 25.4 || value > 1000) {
          paperError.setText("纸张尺寸必须在25.4到1000mm之间"); paper.settingEl.addClass("has-error"); return;
        }
        applyCustomPaperDimension(settings, dimension, value);
        paperDropdown.setValue("custom");
        paperError.empty(); paper.settingEl.removeClass("has-error");
        await this.save(status);
      };
      input.addEventListener("blur", () => { this.run(submit, "保存纸张尺寸"); });
      input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); this.run(submit, "保存纸张尺寸"); } });
    };
    bindDimension(widthInput, "width");
    bindDimension(heightInput, "height");

    const orientation = new Setting(page).setName("方向");
    this.addSegmented(orientation, [{ value: "portrait", label: "纵向" }, { value: "landscape", label: "横向" }], settings.landscape ? "landscape" : "portrait", async value => {
      settings.landscape = value === "landscape"; await this.save(status);
    });

    const margin = new Setting(page).setName("页边距");
    margin.controlEl.addClass("ostracon-margin-control");
    let marginDropdown!: DropdownComponent;
    const marginValues = margin.controlEl.createDiv({ cls: "ostracon-margin-values" });
    const marginInputs = new Map<"top" | "right" | "bottom" | "left", HTMLInputElement>();
    (["top", "right", "bottom", "left"] as const).forEach((side, index) => {
      const field = marginValues.createEl("label");
      field.createSpan({ text: ["上", "右", "下", "左"][index] });
      const input = field.createEl("input", { type: "number", value: String(settings.marginsMm[side]), attr: { min: "0", max: "100", step: "0.5" } });
      marginInputs.set(side, input);
    });
    marginValues.createSpan({ text: "mm", cls: "ostracon-margin-unit" });
    const marginError = margin.settingEl.createDiv({ cls: "ostracon-settings-field-error", attr: { role: "alert" } });
    margin.addDropdown(dropdown => {
      marginDropdown = dropdown;
      dropdown
        .addOptions({ narrow: "窄", standard: "标准", wide: "宽", custom: "自定义" })
        .setValue(settings.marginPreset)
        .onChange(value => {
          if (!isPdfMarginPreset(value)) throw new Error(`无效页边距类型: ${value}`);
          applyMarginPreset(settings, value);
          marginInputs.forEach((input, side) => { input.value = String(settings.marginsMm[side]); });
          marginError.empty(); margin.settingEl.removeClass("has-error");
          this.run(() => this.save(status), "保存页边距");
        });
    });
    margin.controlEl.prepend(marginDropdown.selectEl);
    marginInputs.forEach((input, side) => {
      input.addEventListener("input", () => { if (Number(input.value) > 100) input.value = "100"; });
      const submit = async () => {
        const value = Number(input.value);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          marginError.setText("页边距必须在0到100mm之间"); margin.settingEl.addClass("has-error"); return;
        }
        applyCustomMargin(settings, side, value);
        marginDropdown.setValue("custom");
        marginError.empty(); margin.settingEl.removeClass("has-error");
        await this.save(status);
      };
      input.addEventListener("blur", () => { this.run(submit, "保存页边距"); });
      input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); this.run(submit, "保存页边距"); } });
    });

    const content = this.createGroup(container, "内容");
    new Setting(content).setName("缩放").addSlider(slider => {
      const valueLabel = slider.sliderEl.parentElement?.createSpan({ text: `${Math.round(settings.scale * 100)}%`, cls: "ostracon-settings-slider-value" });
      slider.setLimits(0.5, 2, 0.05).setValue(settings.scale);
      slider.onChange(value => {
        settings.scale = value;
        valueLabel?.setText(`${Math.round(value * 100)}%`);
        slider.sliderEl.setAttr("aria-valuetext", `${Math.round(value * 100)}%`);
        this.run(() => this.save(status), "保存缩放");
      });
      slider.sliderEl.setAttr("aria-valuetext", `${Math.round(settings.scale * 100)}%`);
    });
    new Setting(content).setName("打印背景").addToggle(toggle => {
      toggle.setValue(settings.printBackground).onChange(value => { settings.printBackground = value; this.run(() => this.save(status), "保存打印背景"); });
    });
    const mediaHeight = new Setting(content).setName("媒体最大高度");
    this.addValidatedNumber(mediaHeight, settings.mediaMaxHeightPx, "px", 1, MAX_PRINT_MEDIA_HEIGHT_PX, async value => { settings.mediaMaxHeightPx = Math.round(value); await this.save(status); });

    const advanced = container.createEl("details", { cls: "ostracon-settings-advanced" });
    advanced.createEl("summary", { text: "高级设置" });
    const advancedRows = advanced.createDiv({ cls: "ostracon-settings-rows" });
    const headerRow = new Setting(advancedRows).setName("页眉页脚");
    const templateRows: HTMLElement[] = [];
    headerRow.addToggle(toggle => toggle.setValue(settings.displayHeaderFooter).onChange(value => {
      settings.displayHeaderFooter = value; templateRows.forEach(row => row.hidden = !value); this.run(() => this.save(status), "保存页眉页脚");
    }));
    const templateDesc = "可用变量：{{title}} {{date}} {{page}} {{pages}}";
    const headerTemplate = new Setting(advancedRows).setName("页眉").setDesc(templateDesc).addText(text => text.setValue(settings.headerTemplate).onChange(value => { settings.headerTemplate = value; this.run(() => this.save(status), "保存页眉"); }));
    const footerTemplate = new Setting(advancedRows).setName("页脚").setDesc(templateDesc).addText(text => text.setValue(settings.footerTemplate).onChange(value => { settings.footerTemplate = value; this.run(() => this.save(status), "保存页脚"); }));
    templateRows.push(headerTemplate.settingEl, footerTemplate.settingEl);
    templateRows.forEach(row => row.hidden = !settings.displayHeaderFooter);
    new Setting(advancedRows).setName("优先使用CSS页面尺寸").addToggle(toggle => {
      toggle.setValue(settings.preferCssPageSize).onChange(value => { settings.preferCssPageSize = value; this.run(() => this.save(status), "保存CSS页面尺寸"); });
    });

    this.addReset(container, async () => {
      this.plugin.settings.pdfPrint = createDefaultPdfPrintSettings();
      await this.plugin.saveSettings();
      this.display();
    });
  }

  private renderTemplates(container: HTMLElement): void {
    const status = this.createPanelHeader(container);
    this.renderTemplateWorkspace(container, status);
    this.addReset(container, async () => {
      this.plugin.settings.quoteTemplate = DEFAULT_QUOTE_TEMPLATE;
      this.plugin.settings.cardTemplate = DEFAULT_CARD_TEMPLATE;
      this.plugin.settings.createQuoteCard = true;
      await this.plugin.saveSettings();
      this.display();
    });
  }

  private renderDevices(container: HTMLElement): void {
    this.createPanelHeader(container);
    const rows = this.createGroup(container, "已批准设备");
    const approved = this.plugin.settings.approvedDevices || [];
    if (approved.length === 0) rows.createEl("p", { text: "暂无已批准设备", cls: "ostracon-settings-empty" });
    approved.forEach(device => new Setting(rows).setName(device.name || device.clientId).setDesc(new Date(device.approvedAt).toLocaleString()).addButton(button => {
      button.setButtonText("移除").onClick(() => { this.plugin.settings.approvedDevices = approved.filter(item => item.clientId !== device.clientId); this.run(async () => { await this.plugin.saveSettings(); this.display(); }, "移除设备"); });
    }));
    this.addReset(container, async () => {
      this.plugin.settings.approvedDevices = [];
      await this.plugin.saveSettings();
      this.display();
    });
  }

  private renderTemplateWorkspace(container: HTMLElement, saveStatus: HTMLElement): void {
    const tabs = container.createDiv({ cls: "ostracon-template-tabs", attr: { role: "tablist" } });
    const panels = container.createDiv({ cls: "ostracon-template-workspace" });
    const quoteTab = tabs.createEl("button", { text: "引用模板", cls: "is-active", attr: { type: "button", role: "tab", "aria-selected": "true" } });
    const cardTab = tabs.createEl("button", { text: "卡片模板", attr: { type: "button", role: "tab", "aria-selected": "false" } });
    const quotePanel = this.createTemplatePanel(panels, {
      name: "引用模板", initial: this.plugin.settings.quoteTemplate, defaultValue: DEFAULT_QUOTE_TEMPLATE,
      tokens: ["{{content}}", "{{link}}", "{{#link}}{{/link}}", "|trim", "|singleline", "|blockquote"],
      context: { content: "第一行\n第二行", link: "marginnote4app://note/example" },
      save: value => { this.plugin.settings.quoteTemplate = value; }, quoteToggle: true, saveStatus,
    });
    const cardPanel = this.createTemplatePanel(panels, {
      name: "卡片模板", initial: this.plugin.settings.cardTemplate, defaultValue: DEFAULT_CARD_TEMPLATE,
      tokens: ["{{heading}}", "{{title}}", "{{link}}", "{{content}}", "|trim", "|singleline"],
      context: { heading: "##", title: "示例卡片", content: "示例正文", link: "marginnote4app://note/example" },
      save: value => { this.plugin.settings.cardTemplate = value; }, quoteToggle: false, saveStatus,
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
    context: Parameters<typeof renderQuoteTemplate>[1]; save: (value: string) => void; quoteToggle: boolean; saveStatus: HTMLElement;
  }): HTMLElement {
    const panel = container.createDiv({ cls: "ostracon-template-panel", attr: { role: "tabpanel" } });
    const header = panel.createDiv({ cls: "ostracon-template-header" });
    header.createEl("strong", { text: config.name });
    const actions = header.createDiv({ cls: "ostracon-template-actions" });
    const status = actions.createEl("span", { cls: "ostracon-template-status", attr: { role: "status" } });
    if (config.quoteToggle) {
      const toggleLabel = actions.createEl("label", { cls: "ostracon-template-toggle" });
      toggleLabel.createSpan({ text: "同时在MN创建卡片" });
      new ToggleComponent(toggleLabel).setValue(this.plugin.settings.createQuoteCard).onChange(value => {
        this.plugin.settings.createQuoteCard = value;
        this.run(() => this.save(config.saveStatus), "保存引文卡片设置");
      });
    }
    const reset = actions.createEl("button", { text: "恢复默认", attr: { type: "button" } });
    const tools = panel.createDiv({ cls: "ostracon-template-tools" });
    const input = panel.createEl("textarea", { cls: "ostracon-template-editor", attr: { spellcheck: "false" } });
    input.value = config.initial;
    const previewWrap = panel.createDiv({ cls: "ostracon-template-preview-wrap" });
    previewWrap.createEl("span", { text: "预览", cls: "ostracon-template-preview-label" });
    const preview = previewWrap.createEl("pre", { cls: "ostracon-template-preview" });
    const update = async () => {
      try {
        validateQuoteTemplate(input.value); preview.setText(renderQuoteTemplate(input.value, config.context));
        status.setText("已保存"); status.removeClass("is-error"); config.save(input.value); await this.save(config.saveStatus);
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
