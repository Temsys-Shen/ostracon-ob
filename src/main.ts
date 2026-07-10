import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import {
  VIEW_TYPE_INBOX, DEFAULT_OUTPUT_FOLDER, createDefaultSettings, normalizePacket,
  buildPacketFilePath, buildPacketRecord, buildConnectionUrl,
  summarizePacket, createId,
  toPacketFormat, fileExtensionForFormat,
  type OstraconCardSummary, type OstraconNotebookSummary,
  type OstraconSettings, type OstraconPacket, type OstraconPacketRecord, type OstraconRecordMeta,
} from "./contract";
import { buildPacketMarkdown } from "./markdown-builder";
import { processBase64InMarkdown } from "./image-service";
import { FileService } from "./file-service";
import { NoteIndex } from "./note-index";
import { Mutex } from "./mutex";
import { updateCanvasNode, findCardSection, replaceCardSection } from "./card-content";
import { OstraconWsBridge } from "./ws-bridge";
import { OstraconInboxView } from "./inbox-view";
import { OstraconSettingTab } from "./settings";
import { OstraconDiscovery } from "./discovery";
import { OstraconApprovalModal } from "./approval-modal";

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
  discovery!: OstraconDiscovery;
  statusBarItem!: StatusBarItem;
  fileService!: FileService;
  noteIndex: NoteIndex = new NoteIndex();
  mutex: Mutex = new Mutex();

  async onload(): Promise<void> {
    const saved = await this.loadData() as { settings?: Partial<OstraconSettings>; packets?: OstraconPacketRecord[]; selectedPacketId?: string; logs?: OstraconPluginState["logs"] } | null;
    this.settings = Object.assign(createDefaultSettings(), saved?.settings ?? {});

    this.state = {
      packets: Array.isArray(saved?.packets) ? saved.packets : [],
      selectedPacketId: saved?.selectedPacketId ?? "",
      logs: Array.isArray(saved?.logs) ? saved.logs : [],
    };

    this.rebuildNoteIdMap();

    this.fileService = new FileService(this.app, this.mutex, this.settings.includeBacklinks, this.settings.autoConvertBase64);
    this.bridge = new OstraconWsBridge(this);
    this.discovery = new OstraconDiscovery(this.settings.port, this.getVaultName());

    this.registerView(VIEW_TYPE_INBOX, (leaf) => new OstraconInboxView(leaf, this));
    this.addRibbonIcon("inbox", "获取MN数据", () => this.activateInboxView());
    this.addCommand({ id: "open-ostracon-inbox", name: "获取MN数据", callback: () => this.activateInboxView() });
    this.addCommand({ id: "restart-ostracon-server", name: "重启Ostracon连接服务", callback: () => this.restartServer() });

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
    await this.saveData({ settings: this.settings, packets: this.state.packets, selectedPacketId: this.state.selectedPacketId, logs: this.state.logs });
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
    return buildConnectionUrl(this.settings, this.bridge ? this.bridge.sessionId : "");
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

  getPacketRecords(): OstraconPacketRecord[] {
    return this.state.packets;
  }

  getSelectedPacket(): OstraconPacketRecord | null {
    return this.state.packets.find(item => item.id === this.state.selectedPacketId) || null;
  }

  selectPacket(packetId: string): void {
    this.state.selectedPacketId = packetId;
    this.persistState();
  }

  getPacketSummaries(): Array<{ id: string; summary: ReturnType<typeof summarizePacket>; filePath: string; receivedAt: string }> {
    return this.state.packets.map(record => ({
      id: record.id, summary: summarizePacket(record.packet), filePath: record.filePath, receivedAt: record.receivedAt,
    }));
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
    if (!this.settings.autoConvertBase64 || !content) return content;
    try {
      return await processBase64InMarkdown(this.app, targetPath, content);
    } catch (e) {
      this.logLine("error", `Base64转换失败: ${e instanceof Error ? e.message : String(e)}`);
      return content;
    }
  }

  rebuildNoteIdMap(): void {
    this.noteIndex.rebuild(this.state.packets.map(r => ({
      filePath: r.filePath,
      objects: r.packet.objects || [],
      format: r.packet.format,
    })));
  }



  async handleCardUpdated(payload: { noteId: string; title: string; excerpt: string; comment: string; sourceAnchor: string; version: number; filePath?: string; format?: string; markdownSection?: string; canvasText?: string; hasImage?: boolean; hasHandwriting?: boolean }): Promise<void> {
    const targetFormat = toPacketFormat(payload.format || (payload.filePath ? this.fileService.formatFromFilePath(payload.filePath) : undefined));
    const filePath = payload.filePath || this.noteIndex.get(payload.noteId, targetFormat);
    if (!filePath) throw new Error(`noteId 未在本地记录: ${payload.noteId}`);

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new Error(`文件不存在: ${filePath}`);

    const unlock = await this.mutex.acquire(filePath);
    try {
      let content = await this.app.vault.read(file);
      if (filePath.toLowerCase().endsWith(".canvas")) {
        if (!payload.canvasText) throw new Error(`缺少MN渲染Canvas内容: ${payload.noteId}`);
        content = updateCanvasNode(content, payload.noteId, payload.canvasText);
        await this.fileService.processInternalWrite(file, () => content);
        this.noteIndex.set(payload.noteId, filePath, "canvas");
        this.logLine("info", `updated canvas node ${payload.noteId} in ${filePath}`);
        return;
      }

      const section = findCardSection(content, payload.noteId);
      if (!section && !content.includes(payload.noteId)) {
        throw new Error(`文件未包含noteId: ${payload.noteId}`);
      }
      if (!payload.markdownSection) throw new Error(`缺少MN渲染Markdown内容: ${payload.noteId}`);
      let newSection = payload.markdownSection.trimEnd();
      if (this.settings.autoConvertBase64) {
        newSection = await this.processBase64InContent(newSection, filePath);
      }

      if (section) {
        content = replaceCardSection(content, section, newSection);
      } else {
        if (content.includes(payload.noteId)) {
          throw new Error(`文件未包含可更新的noteId标题: ${payload.noteId}`);
        }
        const at = content.lastIndexOf("## Objects");
        if (at < 0) {
          throw new Error(`文件缺少可插入的Objects区: ${filePath}`);
        }
        const insertAt = at + "## Objects".length;
        content = content.slice(0, insertAt) + "\n\n" + newSection + content.slice(insertAt);
      }

      content = content.replace(/^ostracon_version:.*$/m, `ostracon_version: ${payload.version}`);
      await this.fileService.processInternalWrite(file, () => content);
      this.noteIndex.set(payload.noteId, filePath, "markdown");
      this.logLine("info", `updated card ${payload.noteId} in ${filePath}`);
    } finally {
      unlock();
    }
  }



  async ingestPacket(packet: OstraconPacket, meta?: OstraconRecordMeta): Promise<OstraconPacketRecord> {
    const normalized = normalizePacket(packet);

    let filePath = meta?.targetFilePath ? normalizePath(meta.targetFilePath) : "";
    const packetFormat = toPacketFormat(normalized.format);
    if (!filePath) {
      for (const obj of normalized.objects) {
        const existing = this.noteIndex.get(obj.id, packetFormat);
        if (existing) { filePath = existing; break; }
      }
    }
    if (!filePath) {
      filePath = buildPacketFilePath(this.settings, normalized);
    }

    if (this.settings.autoConvertBase64 && normalized.notes) {
      normalized.notes = await this.processBase64InContent(normalized.notes, filePath);
    }

    const existingRecords = this.state.packets.filter(r => r.filePath === filePath);
    const maxVersion = existingRecords.length > 0 ? Math.max(...existingRecords.map(r => r.version)) : 0;
    const nextVersion = maxVersion + 1;

    const record = buildPacketRecord(normalized, filePath, { ...meta, version: nextVersion });
    await this.fileService.writePacketToVault(record);

    this.state.packets = [record, ...this.state.packets.filter(item => item.id !== record.id)].slice(0, 100);
    this.rebuildNoteIdMap();
    this.state.selectedPacketId = record.id;
    await this.persistState();
    this.refreshViews();
    this.logLine("info", `ingested packet ${record.id}`);
    return record;
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
      const inboxView = view as unknown as OstraconInboxView;
      if (inboxView && typeof inboxView.render === "function") {
        inboxView.render();
      }
    }
  }

}

export default OstraconPlugin;
