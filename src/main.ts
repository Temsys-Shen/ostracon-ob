import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import {
  VIEW_TYPE_INBOX, createDefaultSettings, createToken, normalizePacket,
  buildPacketFilePath, buildPacketMarkdown, buildPacketRecord, buildConnectionUrl,
  summarizePacket, createId,
  type OstraconCardSummary, type OstraconNotebookSummary,
  type OstraconObject, type OstraconSettings, type OstraconPacket, type OstraconPacketRecord, type OstraconRecordMeta,
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
  noteIdMap: Map<string, string> = new Map();

  async onload(): Promise<void> {
    const saved = await this.loadData() as { settings?: Partial<OstraconSettings>; packets?: OstraconPacketRecord[]; selectedPacketId?: string; logs?: OstraconPluginState["logs"] } | null;
    this.settings = Object.assign(createDefaultSettings(), saved?.settings ?? {});
    if (!this.settings.token) this.settings.token = createToken();

    this.state = {
      packets: Array.isArray(saved?.packets) ? saved.packets : [],
      selectedPacketId: saved?.selectedPacketId ?? "",
      logs: Array.isArray(saved?.logs) ? saved.logs : [],
    };

    this.rebuildNoteIdMap();

    this.bridge = new OstraconWsBridge(this);

    this.registerView(VIEW_TYPE_INBOX, (leaf) => new OstraconInboxView(leaf, this));
    this.addRibbonIcon("inbox", "获取MN数据", () => this.activateInboxView());
    this.addCommand({ id: "open-ostracon-inbox", name: "获取MN数据", callback: () => this.activateInboxView() });
    this.addCommand({ id: "restart-ostracon-server", name: "重启Ostracon连接服务", callback: () => this.restartServer() });

    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar();
    this.addSettingTab(new OstraconSettingTab(this.app, this));

    if (this.settings.autoStartServer) await this.startServer();

    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!(file instanceof TFile) || !file.path.startsWith(this.settings.outputFolder)) return;
      if (file.extension !== "md") return;
      const hasAutoSync = this.state.packets.some(r => r.filePath === file.path && r.autoSynced);
      if (!hasAutoSync) return;
      this.queuePushCardChanges(file.path);
    }));

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

  async fetchMnCards(cardIds: string[], format: string): Promise<OstraconPacketRecord> {
    if (!this.isServerRunning()) {
      await this.startServer();
    }
    return this.bridge.fetchCards(cardIds, format);
  }

  async getCardsContent(cardIds: string[], format: string): Promise<string> {
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
    return buildPacketMarkdown(normalized, record);
  }

  queuePushCardChanges(filePath: string): void {
    if (this.pushCardChangesDebounceTimer) clearTimeout(this.pushCardChangesDebounceTimer);
    this.pushCardChangesDebounceTimer = setTimeout(() => this.pushCardChanges(filePath), 3000);
  }

  async pushCardChanges(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;
    if (!this.bridge.isRunning || this.bridge.getOpenClients().length === 0) return;

    const content = await this.app.vault.read(file);
    if (!content.includes("ostracon_note_ids:")) return;

    const noteIds: string[] = [];
    for (const raw of content.matchAll(/^\s*-\s+"([^"]+)"$/gm)) {
      if (raw[1]) noteIds.push(raw[1]);
    }
    if (noteIds.length === 0) return;

    for (const id of noteIds) {
      const section = this.findCardSection(content, id);
      if (!section) continue;
      const block = content.slice(section.start, section.end);
      const title = block.match(/- Title:\s*(.*)/)?.[1]?.trim() || "";
      const excerpt = block.match(/- Excerpt:\s*(.*)/)?.[1]?.trim() || "";
      const comment = block.match(/- Comment:\s*(.*)/)?.[1]?.trim() || "";
      const existingRecords = this.state.packets.filter((r: OstraconPacketRecord) => r.filePath === filePath);
      const nextVersion = existingRecords.length > 0 ? Math.max(...existingRecords.map((r: OstraconPacketRecord) => r.version)) + 1 : 1;
      try {
        await this.bridge.requestClientCommand("syncCard", { noteId: id, title, excerpt, comment, version: nextVersion });
        for (const r of this.state.packets) {
          if (r.filePath === filePath && r.version < nextVersion) r.version = nextVersion;
        }
      } catch (e) {
        this.logLine("warn", `推送卡片到MN失败: ${id}`);
      }
    }
    await this.saveData({ settings: this.settings, packets: this.state.packets, selectedPacketId: this.state.selectedPacketId, logs: this.state.logs });
  }

  rebuildNoteIdMap(): void {
    this.noteIdMap = new Map();
    for (const record of this.state.packets) {
      const filePath = record.filePath;
      for (const obj of record.packet.objects || []) {
        this.noteIdMap.set(obj.id, filePath);
      }
    }
  }

  pushCardChangesDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  fileLocks: Map<string, Promise<void>> = new Map();

  private async lockFile(filePath: string): Promise<() => void> {
    let release: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const prev = this.fileLocks.get(filePath) || Promise.resolve();
    this.fileLocks.set(filePath, next);
    await prev;
    return release!;
  }

  async handleCardUpdated(payload: { noteId: string; title: string; excerpt: string; comment: string; sourceAnchor: string; version: number; hasImage?: boolean; hasHandwriting?: boolean }): Promise<void> {
    const filePath = this.noteIdMap.get(payload.noteId);
    if (!filePath) throw new Error(`noteId 未在本地记录: ${payload.noteId}`);

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new Error(`文件不存在: ${filePath}`);

    const object: OstraconObject = {
      id: payload.noteId, kind: "Card", title: payload.title || "",
      excerpt: payload.excerpt || "", comment: payload.comment || "",
      sourceAnchor: payload.sourceAnchor || "", hasImage: Boolean(payload.hasImage),
      hasHandwriting: Boolean(payload.hasHandwriting),
    };

    const unlock = await this.lockFile(filePath);
    try {
      let content = await this.app.vault.read(file);
      const section = this.findCardSection(content, payload.noteId);
      const newSection = this.buildCardSection(object);

      if (section) {
        content = content.slice(0, section.start) + newSection + content.slice(section.end);
      } else {
        const at = content.lastIndexOf("## Objects");
        const insertAt = at >= 0 ? at + "## Objects".length : 0;
        content = content.slice(0, insertAt) + "\n\n" + newSection + content.slice(insertAt);
      }

      content = content.replace(/^ostracon_version:.*$/m, `ostracon_version: ${payload.version}`);
      await this.app.vault.process(file, () => content);
      this.logLine("info", `updated card ${payload.noteId} in ${filePath}`);
    } finally {
      unlock();
    }
  }

  async ingestPacket(packet: OstraconPacket, meta?: OstraconRecordMeta): Promise<OstraconPacketRecord> {
    const normalized = normalizePacket(packet);

    let filePath = "";
    for (const obj of normalized.objects) {
      const existing = this.noteIdMap.get(obj.id);
      if (existing) { filePath = existing; break; }
    }
    if (!filePath) {
      filePath = buildPacketFilePath(this.settings, normalized);
    }

    const existingRecords = this.state.packets.filter(r => r.filePath === filePath);
    const maxVersion = existingRecords.length > 0 ? Math.max(...existingRecords.map(r => r.version)) : 0;
    const nextVersion = maxVersion + 1;

    const record = buildPacketRecord(normalized, filePath, { ...meta, version: nextVersion });
    await this.writePacketToVault(record);

    this.state.packets = [record, ...this.state.packets.filter(item => item.id !== record.id)].slice(0, 100);
    for (const obj of normalized.objects) {
      this.noteIdMap.set(obj.id, record.filePath);
    }
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
    const packet = record.packet;

    const unlock = await this.lockFile(record.filePath);
    try {
      if (existing instanceof TFile && packet.format !== "markdown") {
        let content = await this.app.vault.read(existing);
        for (const object of packet.objects || []) {
          const section = this.findCardSection(content, object.id);
          const newSection = this.buildCardSection(object);
          if (section) {
            content = content.slice(0, section.start) + newSection + content.slice(section.end);
          } else {
            const rawIdx = content.lastIndexOf("## Raw Packet");
            const at = rawIdx >= 0 ? rawIdx : content.length;
            content = content.slice(0, at) + "\n" + newSection.trimEnd() + "\n\n" + content.slice(at);
          }
        }
        content = content.replace(/^ostracon_version:.*$/m, `ostracon_version: ${record.version}`);
        await this.app.vault.process(existing, () => content);
      } else {
        const content = buildPacketMarkdown(packet, record);
        if (existing instanceof TFile) {
          await this.app.vault.process(existing, () => content);
        } else {
          await this.app.vault.create(record.filePath, content);
        }
      }
    } finally {
      unlock();
    }
  }

  findCardSection(content: string, noteId: string): { start: number; end: number } | null {
    const escaped = noteId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`#{2,6} [^<]*<!-- ostracon_noteid:${escaped} -->[\\s\\S]*?(?=\\n#{1,6} |\\n---|$)`);
    const m = re.exec(content);
    return m ? { start: m.index, end: m.index + m[0].length } : null;
  }

  buildCardSection(object: OstraconObject): string {
    const lines = [`### ${object.kind || "Card"} <!-- ostracon_noteid:${object.id} -->`];
    lines.push(`- Title: ${object.title || ""}`);
    lines.push(`- Excerpt: ${object.excerpt || ""}`);
    lines.push(`- Comment: ${object.comment || ""}`);
    lines.push(`- Source Anchor: ${object.sourceAnchor || ""}`);
    if (object.sourceAnchor) lines.push(`- MarginNote Link: [Open in MarginNote](${object.sourceAnchor})`);
    lines.push(`- Has Image: ${object.hasImage ? "yes" : "no"}`);
    lines.push(`- Has Handwriting: ${object.hasHandwriting ? "yes" : "no"}`);
    return lines.join("\n");
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
      const inboxView = view as unknown as OstraconInboxView;
      if (inboxView && typeof inboxView.render === "function") {
        inboxView.render();
      }
    }
  }

}

export default OstraconPlugin;
