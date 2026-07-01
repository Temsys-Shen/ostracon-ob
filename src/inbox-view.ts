import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_INBOX, summarizePacket, type OstraconPacketRecord } from "./contract";

type OstraconPluginLike = {
  state: { selectedPacketId: string };
  getPacketRecords: () => OstraconPacketRecord[];
  getSelectedPacket: () => OstraconPacketRecord | null;
  selectPacket: (id: string) => void;
  getConnectionUrl: () => string;
  getClientCount: () => number;
  isServerRunning: () => boolean;
  openSettings: () => void;
  startServer: () => Promise<void>;
  stopServer: () => Promise<void>;
  createDemoPacket: () => Promise<void>;
};

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

class OstraconInboxView extends ItemView {
  plugin: OstraconPluginLike;

  constructor(leaf: WorkspaceLeaf, plugin: OstraconPluginLike) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_INBOX;
  }

  getDisplayText(): string {
    return "Ostracon";
  }

  getIcon(): string {
    return "inbox";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  async connectAndCopy(): Promise<void> {
    if (!this.plugin.isServerRunning()) {
      await this.plugin.startServer();
    }
    await navigator.clipboard.writeText(this.plugin.getConnectionUrl());
    new Notice("已复制连接");
    this.render();
  }

  render(): void {
    const { contentEl } = this;
    const packets = this.plugin.getPacketRecords();
    const selected = this.plugin.getSelectedPacket();
    const latest = packets[0] || null;

    contentEl.empty();
    contentEl.addClass("ostracon-view");

    const hero = contentEl.createDiv({ cls: "ostracon-hero" });
    const heroCopy = hero.createDiv({ cls: "ostracon-hero-copy" });
    heroCopy.createEl("h2", { text: "连接MN" });
    heroCopy.createEl("div", {
      text: this.plugin.isServerRunning() ? "服务已就绪" : "点击即可连接",
      cls: "ostracon-hero-state",
    });

    const heroAction = hero.createDiv({ cls: "ostracon-hero-action" });
    const primaryButton = heroAction.createEl("button", {
      text: this.plugin.isServerRunning() ? "复制连接" : "一键连接",
      cls: "ostracon-primary-action",
    });
    primaryButton.addEventListener("click", async () => {
      await this.connectAndCopy();
    });

    const statusGrid = hero.createDiv({ cls: "ostracon-status-grid" });
    this.addStatusCell(statusGrid, "状态", this.plugin.isServerRunning() ? "已启动" : "未启动");
    this.addStatusCell(statusGrid, "MN", `${this.plugin.getClientCount()}个`);
    this.addStatusCell(statusGrid, "收件", String(packets.length));
    this.addStatusCell(statusGrid, "最近", latest ? formatTime(latest.receivedAt) : "暂无");

    const secondary = contentEl.createDiv({ cls: "ostracon-secondary-actions" });
    this.addActionButton(secondary, "设置", () => this.plugin.openSettings());
    this.addActionButton(secondary, "示例", async () => {
      await this.plugin.createDemoPacket();
      this.render();
    });
    this.addActionButton(secondary, "刷新", () => this.render());
    this.addActionButton(secondary, "停止", async () => {
      await this.plugin.stopServer();
      this.render();
    });

    const layout = contentEl.createDiv({ cls: "ostracon-grid" });
    this.renderPacketList(layout, packets);
    this.renderDetail(layout, selected);
  }

  renderPacketList(container: HTMLElement, packets: OstraconPacketRecord[]): void {
    const listPane = container.createDiv({ cls: "ostracon-panel ostracon-list-pane" });
    const head = listPane.createDiv({ cls: "ostracon-pane-head" });
    head.createEl("h3", { text: "最近进入" });
    head.createEl("span", { text: `${packets.length}项`, cls: "ostracon-count" });

    if (packets.length === 0) {
      const empty = listPane.createDiv({ cls: "ostracon-empty" });
      empty.createEl("strong", { text: "暂无内容" });
      empty.createEl("span", { text: "先连接MN" });
      return;
    }

    for (const record of packets) {
      const summary = summarizePacket(record.packet);
      const card = listPane.createDiv({ cls: `ostracon-packet-card${record.id === this.plugin.state.selectedPacketId ? " is-active" : ""}` });
      const cardHead = card.createDiv({ cls: "ostracon-card-head" });
      cardHead.createDiv({ text: summary.sourceTitle || record.id, cls: "ostracon-packet-title" });
      cardHead.createEl("span", { text: summary.firstObjectKind || "对象", cls: "ostracon-type" });
      card.createDiv({ text: record.filePath, cls: "ostracon-code" });
      card.createDiv({ text: `${summary.objectCount}对象 · ${summary.tags.length}标签`, cls: "ostracon-muted" });
      card.addEventListener("click", () => {
        this.plugin.selectPacket(record.id);
        this.render();
      });
    }
  }

  renderDetail(container: HTMLElement, selected: OstraconPacketRecord | null): void {
    const detailPane = container.createDiv({ cls: "ostracon-panel ostracon-detail-pane" });
    const head = detailPane.createDiv({ cls: "ostracon-pane-head" });
    head.createEl("h3", { text: "内容详情" });

    if (!selected) {
      const empty = detailPane.createDiv({ cls: "ostracon-empty" });
      empty.createEl("strong", { text: "选择内容" });
      empty.createEl("span", { text: "查看详情" });
      return;
    }

    const summary = summarizePacket(selected.packet);
    head.createEl("span", { text: selected.transport, cls: "ostracon-count" });

    const facts = detailPane.createDiv({ cls: "ostracon-facts" });
    this.addFact(facts, "来源", summary.sourceTitle || "未命名");
    this.addFact(facts, "对象", String(summary.objectCount));
    this.addFact(facts, "标签", String(summary.tags.length));
    this.addFact(facts, "写入", selected.filePath);

    const objects = detailPane.createDiv({ cls: "ostracon-object-list" });
    for (const object of selected.packet.objects || []) {
      const item = objects.createDiv({ cls: "ostracon-object-item" });
      item.createEl("strong", { text: object.title || object.kind || "对象" });
      item.createEl("span", { text: object.excerpt || object.comment || "无摘录" });
    }

    const raw = detailPane.createEl("details", { cls: "ostracon-raw" });
    raw.createEl("summary", { text: "开发详情" });
    raw.createEl("pre", { text: JSON.stringify(selected.packet, null, 2), cls: "ostracon-pre" });
  }

  addStatusCell(container: HTMLElement, label: string, value: string): void {
    const cell = container.createDiv({ cls: "ostracon-status-cell" });
    cell.createEl("span", { text: label });
    cell.createEl("strong", { text: value });
  }

  addFact(container: HTMLElement, label: string, value: string): void {
    const item = container.createDiv({ cls: "ostracon-fact" });
    item.createEl("span", { text: label });
    item.createEl("strong", { text: value });
  }

  addActionButton(container: HTMLElement, label: string, onClick: () => void): HTMLElement {
    const button = container.createEl("button", { text: label, cls: "ostracon-quiet-action" });
    button.addEventListener("click", onClick);
    return button;
  }
}

export { OstraconInboxView };
