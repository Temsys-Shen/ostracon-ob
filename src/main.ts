import { Notice, Plugin, normalizePath, type View } from "obsidian";
import {
  VIEW_TYPE_INBOX, DEFAULT_OUTPUT_FOLDER, DEFAULT_CARD_TEMPLATE, LEGACY_DEFAULT_CARD_TEMPLATE, createDefaultSettings, normalizePacket,
  buildPacketRecord, buildConnectionUrl,
  findAvailablePacketFilePath,
  createId,
  VAULT_INDEX_CHANGED_EVENT, QUOTE_CONTEXT_CHANGED_EVENT,
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
import { CardDropService } from "./card-drop-service";
import { PdfExportService } from "./pdf-export-service";
import { resolveConnectionUrl } from "./connection-address";

interface OstraconPluginState {
  packets: OstraconPacketRecord[];
  logs: Array<{ id: string; level: string; message: string; at: string }>;
}

type SavedPluginData = {
  settings?: Partial<OstraconSettings>;
  packets?: OstraconPacketRecord[];
  logs?: OstraconPluginState["logs"];
};

function parseSavedPluginData(value: unknown): SavedPluginData | null {
  if (value === null) return null;
  if (typeof value !== "object") throw new Error("Ostracon设置数据必须是对象");
  return value;
}

function hasPacket(value: unknown): value is { packet: OstraconPacket } {
  return typeof value === "object" && value !== null && "packet" in value && typeof value.packet === "object" && value.packet !== null;
}

function isInboxView(view: View): view is OstraconInboxView {
  return view.getViewType() === VIEW_TYPE_INBOX;
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
  cardDropService!: CardDropService;
  pdfExportService!: PdfExportService;

  async onload(): Promise<void> {
    const saved = parseSavedPluginData(await this.loadData());
    this.settings = Object.assign(createDefaultSettings(), saved?.settings ?? {});
    if (this.settings.cardTemplate === LEGACY_DEFAULT_CARD_TEMPLATE) this.settings.cardTemplate = DEFAULT_CARD_TEMPLATE;

    this.state = {
      packets: Array.isArray(saved?.packets) ? saved.packets : [],
      logs: Array.isArray(saved?.logs) ? saved.logs : [],
    };

    this.fileService = new FileService(this.app, this.mutex, this.settings.autoConvertBase64);
    this.bridge = new OstraconWsBridge(this);
    this.quoteService = new QuoteService(this);
    this.cardDropService = new CardDropService(this);
    this.vaultBrowser = new VaultBrowserService(this.app, (revision) => {
      if (this.bridge) this.bridge.broadcastEvent(VAULT_INDEX_CHANGED_EVENT, { revision });
    });
    this.pdfExportService = new PdfExportService(
      async (path) => this.loadPdfSource(path),
      () => this.settings.pdfPrint,
      html => this.bridge.publishPrintHtml(html),
    );
    this.discovery = new OstraconDiscovery(this.settings.port, this.getVaultName(), error => {
      this.logLine("error", `mDNS发现服务失败: ${error.message}`);
      new Notice(`Ostracon局域网发现失败: ${error.message}`);
    });

    this.registerEvent(this.app.vault.on("create", () => this.vaultBrowser.invalidate()));
    this.registerEvent(this.app.vault.on("modify", () => this.vaultBrowser.invalidate()));
    this.registerEvent(this.app.vault.on("delete", () => this.vaultBrowser.invalidate()));
    this.registerEvent(this.app.vault.on("rename", () => this.vaultBrowser.invalidate()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.vaultBrowser.invalidate()));
    this.registerEvent(this.app.metadataCache.on("deleted", () => this.vaultBrowser.invalidate()));
    this.registerEvent(this.app.workspace.on("editor-drop", (event, editor, info) => {
      if (!this.cardDropService.shouldHandleDrop(event, editor, info)) return;
      event.preventDefault();
      void this.cardDropService.handleDrop(event, editor, info).catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.logLine("error", `拖放导入失败: ${message}`);
        new Notice(`拖放导入失败: ${message}`);
      });
    }));
    this.registerDomEvent(this.app.workspace.containerEl, "dragover", (event) => {
      this.cardDropService.handleDragOver(event);
    });

    // 推送引文上下文变化事件，MN 端不再需要 1.5s 轮询 getQuoteContext。
    // active-leaf-change 覆盖切叶子（切文件/切视图模式/切到设置页），file-open 覆盖活动文件变化。
    // 同一文件内光标移动不改变 cursor.available 状态，无需监听 CodeMirror cursorActivity。
    const broadcastQuoteContext = () => {
      if (this.bridge) this.bridge.broadcastEvent(QUOTE_CONTEXT_CHANGED_EVENT, this.quoteService.getContext());
    };
    this.registerEvent(this.app.workspace.on("active-leaf-change", broadcastQuoteContext));
    this.registerEvent(this.app.workspace.on("file-open", broadcastQuoteContext));

    this.registerView(VIEW_TYPE_INBOX, (leaf) => new OstraconInboxView(leaf, this));
    this.addRibbonIcon("inbox", "获取MN数据", () => { this.runTask(() => this.activateInboxView(), "打开MN卡片面板"); });
    this.addCommand({ id: "open-ostracon-inbox", name: "获取MN数据", callback: () => { this.runTask(() => this.activateInboxView(), "打开MN卡片面板"); } });
    this.addCommand({ id: "restart-ostracon-server", name: "重启Ostracon连接服务", callback: () => { this.runTask(() => this.restartServer(), "重启Ostracon连接服务"); } });
    this.addCommand({
      id: "quote-mn",
      name: "Quote MN",
      callback: () => {
        this.runTask(() => this.quoteService.insert({ target: "cursor" }, true).then(() => undefined), "Quote MN");
      },
    });

    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar();
    this.addSettingTab(new OstraconSettingTab(this.app, this));

    if (this.settings.autoStartServer) await this.startServer();

    this.app.workspace.onLayoutReady(() => { this.refreshViews(); });
    this.logLine("info", "plugin loaded");
  }

  onunload(): void {
    this.runTask(() => this.stopServer(), "停止Ostracon服务");
  }

  private runTask(action: () => Promise<void>, context: string): void {
    void action().catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.logLine("error", `${context}: ${message}`);
      new Notice(`${context}失败: ${message}`);
    });
  }

  async saveSettings(): Promise<void> {
    this.settings.outputFolder = normalizePath(this.settings.outputFolder || DEFAULT_OUTPUT_FOLDER);
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
    this.app.setting.open();
  }

  getConnectionUrl(): string {
    return buildConnectionUrl(this.settings);
  }

  resolveConnectionUrl(): Promise<string> {
    return resolveConnectionUrl(this.settings.port);
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
  listVaultDocuments(payload: Record<string, unknown>) { return this.vaultBrowser.listDocuments({ tag: typeof payload.tag === "string" ? payload.tag : undefined, cursor: Number(payload.cursor || 0), limit: Number(payload.limit || 100) }); }
  searchVaultDocuments(payload: Record<string, unknown>) { return this.vaultBrowser.search(String(payload.query || ""), { cursor: Number(payload.cursor || 0), limit: Number(payload.limit || 100) }); }
  getVaultDocument(payload: Record<string, unknown>) { return this.vaultBrowser.getDocument(String(payload.path || "")); }
  getVaultAsset(payload: Record<string, unknown>) { return this.vaultBrowser.getAsset(String(payload.path || "")); }
  createVaultDocumentPdfExport(payload: Record<string, unknown>) { return this.pdfExportService.create(String(payload.path || "")); }
  readVaultDocumentPdfChunk(payload: Record<string, unknown>) { return this.pdfExportService.readChunk(String(payload.sessionId || ""), Number(payload.chunkIndex)); }
  releaseVaultDocumentPdfExport(payload: Record<string, unknown>) { return this.pdfExportService.release(String(payload.sessionId || "")); }
  getQuoteContext(): QuoteTargetContext { return this.quoteService.getContext(); }
  insertQuote(payload: QuoteInsertRequest): Promise<QuoteInsertResult | null> { return this.quoteService.insert(payload); }

  private async loadPdfSource(path: string) {
    const document = await this.vaultBrowser.getDocument(path);
    let renderedHtml = document.renderedHtml;
    for (const asset of document.assets) {
      const loaded = await this.vaultBrowser.getAsset(asset.path);
      const dataUrl = `data:${loaded.mime};base64,${loaded.base64}`;
      renderedHtml = renderedHtml.split(`ostracon-asset://${encodeURIComponent(asset.path)}`).join(dataUrl);
    }
    return { path: document.path, title: document.title, renderedHtml };
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
    void this.persistState().catch(error => {
      console.error("Ostracon failed to persist logs", error);
    });
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
      void this.saveSettings().catch(error => {
        this.logLine("error", `保存设备授权失败: ${error instanceof Error ? error.message : String(error)}`);
      });
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
    const raw = await this.bridge.requestClientCommand("fetchCards", { cardIds, format, cardTemplate: this.settings.cardTemplate }, 20000);
    if (!hasPacket(raw)) {
      throw new Error("MN没有返回可导入的数据包");
    }
    const packet = raw.packet;
    const normalized = normalizePacket(packet);
    const record = buildPacketRecord(normalized, "", { transport: "pull" });
    return buildPacketMarkdown(normalized, record, true);
  }

  async previewCards(cardIds: string[]): Promise<string> {
    if (!this.isServerRunning()) {
      await this.startServer();
    }
    const raw = await this.bridge.requestClientCommand("fetchCards", { cardIds, format: "markdown", cardTemplate: this.settings.cardTemplate }, 30000);
    if (!hasPacket(raw)) {
      throw new Error("MN没有返回可预览的数据");
    }
    const packet = raw.packet;
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
      if (isInboxView(leaf.view)) leaf.view.render();
    }
  }

}

export default OstraconPlugin;
