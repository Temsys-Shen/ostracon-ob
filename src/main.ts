import { Notice, Plugin, normalizePath } from "obsidian";
import {
  VIEW_TYPE_INBOX, DEFAULT_OUTPUT_FOLDER, createDefaultSettings, normalizePacket,
  buildPacketRecord, buildConnectionUrl,
  findAvailablePacketFilePath,
  createId,
  type OstraconCardSummary, type OstraconNotebookSummary,
  type OstraconSettings, type OstraconPacket, type OstraconPacketRecord, type OstraconRecordMeta,
} from "./contract";
import { buildPacketMarkdown } from "./markdown-builder";
import { containsHandwritingSvgDataURL, processBase64InMarkdown } from "./image-service";
import { FileService } from "./file-service";
import { Mutex } from "./mutex";
import { OstraconWsBridge } from "./ws-bridge";
import { OstraconInboxView } from "./inbox-view";
import { OstraconSettingTab } from "./settings";
import { OstraconDiscovery } from "./discovery";
import { OstraconApprovalModal } from "./approval-modal";
import { VaultBrowserService } from "./vault-browser-service";
import { QuoteService } from "./quote-service";
import type { QuoteInsertRequest, QuoteInsertResult, QuoteTargetContext } from "./contract";

interface OstraconPluginState {
  packets: OstraconPacketRecord[];
  logs: Array<{ id: string; level: string; message: string; at: string }>;
}

type StatusBarItem = ReturnType<Plugin["addStatusBarItem"]>;

class OstraconPlugin extends Plugin {
  settings!: OstraconSettings;
  state!: OstraconPluginState;
  bridge!: OstraconWsBridge;
  discovery!: OstraconDiscovery;
  statusBarItem!: StatusBarItem;
  fileService!: FileService;
  mutex: Mutex = new Mutex();
  vaultBrowser!: VaultBrowserService;
  quoteService!: QuoteService;

  async onload(): Promise<void> {
    const saved = await this.loadData() as { settings?: Partial<OstraconSettings>; packets?: OstraconPacketRecord[]; logs?: OstraconPluginState["logs"] } | null;
    this.settings = Object.assign(createDefaultSettings(), saved?.settings ?? {});

    this.state = {
      packets: Array.isArray(saved?.packets) ? saved.packets : [],
      logs: Array.isArray(saved?.logs) ? saved.logs : [],
    };

    this.fileService = new FileService(this.app, this.mutex, this.settings.includeBacklinks, this.settings.autoConvertBase64);
    this.bridge = new OstraconWsBridge(this);
    this.quoteService = new QuoteService(this);
    this.vaultBrowser = new VaultBrowserService(this.app, (revision) => {
      if (this.bridge) this.bridge.broadcastEvent("vaultIndexChanged", { revision });
    });
    this.discovery = new OstraconDiscovery(this.settings.port, this.getVaultName());

    this.registerEvent(this.app.vault.on("create", () => this.vaultBrowser.invalidate()));
    this.registerEvent(this.app.vault.on("modify", () => this.vaultBrowser.invalidate()));
    this.registerEvent(this.app.vault.on("delete", () => this.vaultBrowser.invalidate()));
    this.registerEvent(this.app.vault.on("rename", () => this.vaultBrowser.invalidate()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.vaultBrowser.invalidate()));
    this.registerEvent(this.app.metadataCache.on("deleted", () => this.vaultBrowser.invalidate()));

    this.registerView(VIEW_TYPE_INBOX, (leaf) => new OstraconInboxView(leaf, this));
    this.addRibbonIcon("inbox", "获取MN数据", () => this.activateInboxView());
    this.addCommand({ id: "open-ostracon-inbox", name: "获取MN数据", callback: () => this.activateInboxView() });
    this.addCommand({ id: "restart-ostracon-server", name: "重启Ostracon连接服务", callback: () => this.restartServer() });
    this.addCommand({
      id: "quote-mn",
      name: "Quote MN",
      callback: async () => {
        try {
          await this.quoteService.insert({ target: "cursor" }, true);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logLine("error", `Quote MN: ${message}`);
          new Notice(`Quote MN失败: ${message}`);
        }
      },
    });

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
    this.settings.outputFolder = normalizePath(this.settings.outputFolder || DEFAULT_OUTPUT_FOLDER);
    this.fileService.setIncludeBacklinks(this.settings.includeBacklinks);
    this.fileService.setAutoConvertBase64(this.settings.autoConvertBase64);
    await this.persistState();
    this.updateStatusBar();
  }

  private async persistState(): Promise<void> {
    await this.saveData({ settings: this.settings, packets: this.state.packets, logs: this.state.logs });
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
      this.discovery.start();
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
    this.discovery.stop();
    if (this.bridge) await this.bridge.stop();
    this.updateStatusBar();
    this.refreshViews();
  }

  openSettings(): void {
    (this.app as unknown as { setting: { open: () => void } }).setting.open();
  }

  getConnectionUrl(): string {
    return buildConnectionUrl(this.settings);
  }

  isServerRunning(): boolean {
    return Boolean(this.bridge?.isRunning);
  }

  getClientCount(): number {
    return this.bridge ? this.bridge.clients.size : 0;
  }

  getVaultName(): string {
    return this.app.vault.getName();
  }

  getVaultBrowserState() { return this.vaultBrowser.getState(); }
  listVaultFolder(payload: Record<string, unknown>) { return this.vaultBrowser.listFolder(String(payload.path || "")); }
  listVaultTags() { return this.vaultBrowser.listTags(); }
  listVaultDocuments(payload: Record<string, unknown>) { return this.vaultBrowser.listDocuments(payload as { tag?: string; cursor?: number; limit?: number }); }
  searchVaultDocuments(payload: Record<string, unknown>) { return this.vaultBrowser.search(String(payload.query || ""), payload as { cursor?: number; limit?: number }); }
  getVaultDocument(payload: Record<string, unknown>) { return this.vaultBrowser.getDocument(String(payload.path || "")); }
  getVaultAsset(payload: Record<string, unknown>) { return this.vaultBrowser.getAsset(String(payload.path || "")); }
  getQuoteContext(): QuoteTargetContext { return this.quoteService.getContext(); }
  insertQuote(payload: QuoteInsertRequest): Promise<QuoteInsertResult | null> { return this.quoteService.insert(payload); }

  getServerStatusText(): string {
    return this.bridge?.isRunning ? "Ostracon: 已启动" : "Ostracon: 已停止";
  }

  updateStatusBar(): void {
    if (this.statusBarItem) this.statusBarItem.setText(this.getServerStatusText());
  }

  logLine(level: string, message: string): void {
    const entry = { id: createId("log"), level, message, at: new Date().toISOString() };
    this.state.logs = [entry, ...this.state.logs].slice(0, 100);
    this.persistState();
    this.refreshViews();
  }

  isDeviceApproved(clientId: string): boolean {
    if (!this.settings.approvedDevices) return false;
    return this.settings.approvedDevices.some((d) => d.clientId === clientId);
  }

  approveDevice(clientId: string, name: string): void {
    if (!this.settings.approvedDevices) {
      this.settings.approvedDevices = [];
    }
    if (!this.isDeviceApproved(clientId)) {
      this.settings.approvedDevices.push({
        clientId,
        name: name || clientId,
        approvedAt: new Date().toISOString(),
      });
      this.saveSettings();
      this.logLine("info", `device approved: ${name || clientId}`);
    }
  }

  requestApproval(
    clientId: string,
    name: string,
    callbacks: { onApprove: () => void; onDeny: () => void },
  ): void {
    const modal = new OstraconApprovalModal(this.app, clientId, name, callbacks);
    modal.open();
  }

  async listMnNotebooks(): Promise<OstraconNotebookSummary[]> {
    if (!this.isServerRunning()) {
      await this.startServer();
    }
    return this.bridge.listNotebooks();
  }

  async listMnCards(notebookId: string): Promise<OstraconCardSummary[]> {
    if (!this.isServerRunning()) {
      await this.startServer();
    }
    return this.bridge.listCards(notebookId);
  }

  async fetchCards(cardIds: string[], format: string): Promise<string> {
    if (!this.isServerRunning()) {
      await this.startServer();
    }
    const raw = await this.bridge.requestClientCommand("fetchCards", { cardIds, format }, 20000);
    if (!raw || typeof raw !== "object" || !(raw as { packet?: unknown }).packet) {
      throw new Error("MN没有返回可导入的数据包");
    }
    const packet = (raw as { packet: OstraconPacket }).packet;
    const normalized = normalizePacket(packet);
    const record = buildPacketRecord(normalized, "", { transport: "pull" });
    return buildPacketMarkdown(normalized, record, this.settings.includeBacklinks);
  }

  async previewCards(cardIds: string[]): Promise<string> {
    if (!this.isServerRunning()) {
      await this.startServer();
    }
    const raw = await this.bridge.requestClientCommand("fetchCards", { cardIds, format: "markdown" }, 30000);
    if (!raw || typeof raw !== "object" || !(raw as { packet?: unknown }).packet) {
      throw new Error("MN没有返回可预览的数据");
    }
    const packet = (raw as { packet: OstraconPacket }).packet;
    return packet.notes || "";
  }

  async processBase64InContent(content: string, targetPath: string): Promise<string> {
    if (!content || (!this.settings.autoConvertBase64 && !containsHandwritingSvgDataURL(content))) return content;
    try {
      return await processBase64InMarkdown(this.app, targetPath, content);
    } catch (e) {
      this.logLine("error", `Base64转换失败: ${e instanceof Error ? e.message : String(e)}`);
      return content;
    }
  }

  async ingestPacket(packet: OstraconPacket, meta?: OstraconRecordMeta): Promise<OstraconPacketRecord> {
    const normalized = normalizePacket(packet);
    const previousRecord = this.state.packets.find(item => item.id === normalized.id);
    const filePath = previousRecord?.filePath || findAvailablePacketFilePath(
      this.settings,
      normalized,
      path => Boolean(this.app.vault.getAbstractFileByPath(path)),
    );

    if (normalized.notes && (this.settings.autoConvertBase64 || containsHandwritingSvgDataURL(normalized.notes))) {
      normalized.notes = await this.processBase64InContent(normalized.notes, filePath);
    }

    const existingRecords = this.state.packets.filter(r => r.filePath === filePath);
    const maxVersion = existingRecords.length > 0 ? Math.max(...existingRecords.map(r => r.version)) : 0;
    const nextVersion = maxVersion + 1;

    const record = buildPacketRecord(normalized, filePath, { ...meta, version: nextVersion });
    await this.fileService.writePacketToVault(record);

    this.state.packets = [record, ...this.state.packets.filter(item => item.id !== record.id)].slice(0, 100);
    await this.persistState();
    this.refreshViews();
    this.logLine("info", `ingested packet ${record.id}`);
    return record;
  }





  async activateInboxView(): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      throw new Error("Unable to open Ostracon inbox in the right sidebar");
    }
    await leaf.setViewState({ type: VIEW_TYPE_INBOX, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  refreshViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_INBOX);
    for (const leaf of leaves) {
      const view = leaf.view;
      const inboxView = view as unknown as OstraconInboxView;
      if (inboxView && typeof inboxView.render === "function") {
        inboxView.render();
      }
    }
  }

}

export default OstraconPlugin;
