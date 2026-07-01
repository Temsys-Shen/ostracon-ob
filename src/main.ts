import { Notice, Plugin, normalizePath } from "obsidian";
import {
  VIEW_TYPE_INBOX, createDefaultSettings, createToken, normalizePacket,
  buildPacketFilePath, buildPacketMarkdown, buildPacketRecord, buildConnectionUrl,
  summarizePacket, createId,
  type OstraconSettings, type OstraconPacket, type OstraconPacketRecord, type OstraconRecordMeta,
} from "./contract";
import { OstraconWsBridge } from "./ws-bridge";
import { OstraconInboxView } from "./inbox-view";
import { OstraconSettingTab } from "./settings";

interface OstraconPluginState {
  packets: OstraconPacketRecord[];
  selectedPacketId: string;
  logs: Array<{ id: string; level: string; message: string; at: string }>;
}

type StatusBarItem = ReturnType<Plugin["addStatusBarItem"]>;

class OstraconPlugin extends Plugin {
  settings!: OstraconSettings;
  state!: OstraconPluginState;
  bridge!: OstraconWsBridge;
  statusBarItem!: StatusBarItem;

  async onload(): Promise<void> {
    const saved = await this.loadData() as { settings?: Partial<OstraconSettings>; packets?: OstraconPacketRecord[]; selectedPacketId?: string; logs?: OstraconPluginState["logs"] } | null;
    this.settings = Object.assign(createDefaultSettings(), saved?.settings ?? {});
    if (!this.settings.token) this.settings.token = createToken();

    this.state = {
      packets: Array.isArray(saved?.packets) ? saved.packets : [],
      selectedPacketId: saved?.selectedPacketId ?? "",
      logs: Array.isArray(saved?.logs) ? saved.logs : [],
    };

    this.bridge = new OstraconWsBridge(this);

    this.registerView(VIEW_TYPE_INBOX, (leaf) => new OstraconInboxView(leaf, this));
    this.addRibbonIcon("inbox", "打开收件箱", () => this.activateInboxView());
    this.addCommand({ id: "open-ostracon-inbox", name: "打开收件箱", callback: () => this.activateInboxView() });
    this.addCommand({ id: "generate-ostracon-demo", name: "生成示例包", callback: async () => { await this.createDemoPacket(); } });
    this.addCommand({ id: "restart-ostracon-server", name: "重启本地服务", callback: () => this.restartServer() });

    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar();
    this.addSettingTab(new OstraconSettingTab(this.app, this));

    if (this.settings.autoStartServer) await this.startServer();

    this.app.workspace.onLayoutReady(() => { this.refreshViews(); });
    this.logLine("info", "plugin loaded");
  }

  async onunload(): Promise<void> {
    await this.stopServer();
  }

  async saveSettings(): Promise<void> {
    this.settings.outputFolder = normalizePath(this.settings.outputFolder || "Ostracon/Inbox");
    await this.saveData({ settings: this.settings, packets: this.state.packets, selectedPacketId: this.state.selectedPacketId, logs: this.state.logs });
    this.updateStatusBar();
  }

  async restartServer(): Promise<void> {
    if (!this.settings.autoStartServer) {
      await this.stopServer();
      this.updateStatusBar();
      this.refreshViews();
      return;
    }
    await this.stopServer();
    await this.startServer();
    this.refreshViews();
  }

  async startServer(): Promise<void> {
    if (this.bridge?.isRunning) return;
    try {
      await this.bridge.start();
      this.logLine("info", `ws listening on ${this.getConnectionUrl()}`);
      new Notice("Ostracon已启动");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logLine("error", msg);
      new Notice(`Ostracon服务启动失败: ${msg}`);
      throw error;
    } finally {
      this.updateStatusBar();
    }
  }

  async stopServer(): Promise<void> {
    if (this.bridge) await this.bridge.stop();
    this.updateStatusBar();
    this.refreshViews();
  }

  openSettings(): void {
    this.app.setting.open();
  }

  getConnectionUrl(): string {
    return buildConnectionUrl(this.settings, this.bridge ? this.bridge.sessionId : "");
  }

  isServerRunning(): boolean {
    return Boolean(this.bridge?.isRunning);
  }

  getClientCount(): number {
    return this.bridge ? this.bridge.clients.size : 0;
  }

  getServerStatusText(): string {
    return this.bridge?.isRunning ? "Ostracon: 已启动" : "Ostracon: 已停止";
  }

  updateStatusBar(): void {
    if (this.statusBarItem) this.statusBarItem.setText(this.getServerStatusText());
  }

  logLine(level: string, message: string): void {
    const entry = { id: createId("log"), level, message, at: new Date().toISOString() };
    this.state.logs = [entry, ...this.state.logs].slice(0, 100);
    this.saveData({ settings: this.settings, packets: this.state.packets, selectedPacketId: this.state.selectedPacketId, logs: this.state.logs });
    this.refreshViews();
  }

  getPacketRecords(): OstraconPacketRecord[] {
    return this.state.packets;
  }

  getSelectedPacket(): OstraconPacketRecord | null {
    return this.state.packets.find(item => item.id === this.state.selectedPacketId) || null;
  }

  selectPacket(packetId: string): void {
    this.state.selectedPacketId = packetId;
    this.saveData({ settings: this.settings, packets: this.state.packets, selectedPacketId: this.state.selectedPacketId, logs: this.state.logs });
  }

  getPacketSummaries(): Array<{ id: string; summary: ReturnType<typeof summarizePacket>; filePath: string; receivedAt: string }> {
    return this.state.packets.map(record => ({
      id: record.id, summary: summarizePacket(record.packet), filePath: record.filePath, receivedAt: record.receivedAt,
    }));
  }

  async ingestPacket(packet: OstraconPacket, meta?: OstraconRecordMeta): Promise<OstraconPacketRecord> {
    const normalized = normalizePacket(packet);
    const filePath = buildPacketFilePath(this.settings, normalized);
    const record = buildPacketRecord(normalized, filePath, meta);
    await this.writePacketToVault(record);

    this.state.packets = [record, ...this.state.packets.filter(item => item.id !== record.id)].slice(0, 100);
    this.state.selectedPacketId = record.id;
    await this.saveData({ settings: this.settings, packets: this.state.packets, selectedPacketId: this.state.selectedPacketId, logs: this.state.logs });
    this.refreshViews();
    this.logLine("info", `ingested packet ${record.id}`);
    return record;
  }

  async writePacketToVault(record: OstraconPacketRecord): Promise<void> {
    const folderPath = record.filePath.split("/").slice(0, -1).join("/");
    await this.ensureFolder(folderPath);
    const existing = this.app.vault.getAbstractFileByPath(record.filePath);
    const content = buildPacketMarkdown(record.packet, record);
    if (existing) {
      await this.app.vault.process(existing, () => content);
    } else {
      await this.app.vault.create(record.filePath, content);
    }
  }

  async ensureFolder(folderPath: string): Promise<void> {
    const segments = folderPath.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async activateInboxView(): Promise<void> {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_INBOX, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  refreshViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_INBOX);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view && typeof (view as OstraconInboxView).render === "function") {
        (view as OstraconInboxView).render();
      }
    }
  }

  async createDemoPacket(): Promise<OstraconPacketRecord> {
    const packet: OstraconPacket = {
      version: 1, id: `demo-${Date.now().toString(36)}`, status: "sent", transport: "manual",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      source: { platform: "MarginNote", title: "演示学习集", url: "" },
      summary: "这是一个示例知识包，用于验证OB接收和展示。",
      tags: ["MN", "OB", "demo"],
      objects: [{
        id: `card-${Date.now().toString(36)}`, kind: "Card", title: "演示卡片",
        excerpt: "这是一条从MN导入到OB的示例摘录。",
        comment: "可在这里继续补充双链、标签和回流内容。",
        sourceAnchor: "learning-set/demo", hasImage: false, hasHandwriting: false,
      }],
      relations: [], notes: "",
      destination: { platform: "Obsidian", vault: "DemoVault", folder: "Inbox" },
    };
    return this.ingestPacket(packet, { transport: "manual", requestId: `demo-${Date.now().toString(36)}`, messageType: "command" });
  }
}

export default OstraconPlugin;
