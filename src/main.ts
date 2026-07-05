import path from "path";
import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import {
  VIEW_TYPE_INBOX, createDefaultSettings, createToken, normalizePacket,
  buildPacketFilePath, buildPacketMarkdown, buildPacketRecord, buildConnectionUrl,
  summarizePacket, createId, ensureFolder, setDebugLogPath, debugLog,
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
  noteIdMap: Map<string, Map<string, string>> = new Map();
  internalWritePaths: Set<string> = new Set();

  async onload(): Promise<void> {
    const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
    if (vaultPath) {
      setDebugLogPath(path.join(vaultPath, "ostracon-debug.log"));
      debugLog("Ostracon 插件加载");
    }
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

    this.app.workspace.onLayoutReady(() => { this.refreshViews(); });
    this.logLine("info", "plugin loaded");
  }

  async onunload(): Promise<void> {
    await this.stopServer();
  }

  async saveSettings(): Promise<void> {
    this.settings.outputFolder = normalizePath(this.settings.outputFolder || "Ostracon/Inbox");
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
    this.persistState();
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
    return buildPacketMarkdown(normalized, record);
  }

  rebuildNoteIdMap(): void {
    this.noteIdMap = new Map();
    for (const record of this.state.packets) {
      const filePath = record.filePath;
      for (const obj of record.packet.objects || []) {
        this.setNoteFilePath(obj.id, filePath, record.packet.format);
      }
    }
  }

  normalizePacketFormat(format?: string): string {
    return format === "canvas" ? "canvas" : "markdown";
  }

  formatFromFilePath(filePath: string): string {
    return filePath.toLowerCase().endsWith(".canvas") ? "canvas" : "markdown";
  }

  setNoteFilePath(noteId: string, filePath: string, format?: string): void {
    const key = this.normalizePacketFormat(format || this.formatFromFilePath(filePath));
    const existing = this.noteIdMap.get(noteId) || new Map<string, string>();
    existing.set(key, filePath);
    this.noteIdMap.set(noteId, existing);
  }

  getNoteFilePath(noteId: string, format?: string): string {
    const paths = this.noteIdMap.get(noteId);
    if (!paths) return "";
    const key = this.normalizePacketFormat(format);
    return paths.get(key) || "";
  }

  fileLocks: Map<string, Promise<void>> = new Map();

  private async lockFile(filePath: string): Promise<() => void> {
    let release: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const prev = this.fileLocks.get(filePath) || Promise.resolve();
    this.fileLocks.set(filePath, next);
    await prev;
    return release!;
  }

  async handleCardUpdated(payload: { noteId: string; title: string; excerpt: string; comment: string; sourceAnchor: string; version: number; filePath?: string; format?: string; markdownSection?: string; canvasText?: string; hasImage?: boolean; hasHandwriting?: boolean }): Promise<void> {
    const targetFormat = this.normalizePacketFormat(payload.format || (payload.filePath ? this.formatFromFilePath(payload.filePath) : undefined));
    const filePath = payload.filePath || this.getNoteFilePath(payload.noteId, targetFormat);
    if (!filePath) throw new Error(`noteId 未在本地记录: ${payload.noteId}`);

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new Error(`文件不存在: ${filePath}`);

    const unlock = await this.lockFile(filePath);
    try {
      let content = await this.app.vault.read(file);
      if (filePath.toLowerCase().endsWith(".canvas")) {
        if (!payload.canvasText) throw new Error(`缺少MN渲染Canvas内容: ${payload.noteId}`);
        content = this.updateCanvasNode(content, payload.noteId, payload.canvasText);
        await this.processInternalWrite(file, () => content);
        this.setNoteFilePath(payload.noteId, filePath, "canvas");
        this.logLine("info", `updated canvas node ${payload.noteId} in ${filePath}`);
        return;
      }

      const section = this.findCardSection(content, payload.noteId);
      if (!section && !content.includes(payload.noteId)) {
        throw new Error(`文件未包含noteId: ${payload.noteId}`);
      }
      if (!payload.markdownSection) throw new Error(`缺少MN渲染Markdown内容: ${payload.noteId}`);
      const newSection = payload.markdownSection.trimEnd();

      if (section) {
        content = this.replaceCardSection(content, section, newSection);
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
      await this.processInternalWrite(file, () => content);
      this.setNoteFilePath(payload.noteId, filePath, "markdown");
      this.logLine("info", `updated card ${payload.noteId} in ${filePath}`);
    } finally {
      unlock();
    }
  }

  updateCanvasNode(content: string, noteId: string, text: string): string {
    let canvas: { nodes?: Array<Record<string, unknown>>; edges?: unknown[] };
    try {
      canvas = JSON.parse(content) as { nodes?: Array<Record<string, unknown>>; edges?: unknown[] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Canvas JSON解析失败: ${message}`);
    }

    if (!Array.isArray(canvas.nodes)) throw new Error("Canvas缺少nodes数组");
    const node = canvas.nodes.find(item => item.id === noteId);
    if (!node) throw new Error(`Canvas未包含noteId节点: ${noteId}`);

    node.type = "text";
    node.text = text;
    if (typeof node.width !== "number") node.width = 380;
    node.height = this.estimateCanvasNodeHeight(text);

    return JSON.stringify(canvas, null, 2);
  }

  replaceCardSection(content: string, section: { start: number; end: number }, newSection: string): string {
    const before = content.slice(0, section.start);
    const after = content.slice(section.end).replace(/^\r?\n*/, "");
    return before + newSection + (after ? "\n\n" + after : "");
  }

  buildCanvasNodeText(object: OstraconObject): string {
    const lines = [`## ${object.title || "未命名卡片"}`, ""];
    if (object.excerpt) {
      lines.push(...object.excerpt.split(/\r?\n/).map(line => line ? `> ${line}` : ">"));
      lines.push("");
    }
    if (object.comment) {
      lines.push(object.comment);
      lines.push("");
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  estimateCanvasNodeHeight(text: string): number {
    return Math.max(140, 60 + text.split(/\r?\n/).length * 18);
  }

  async ingestPacket(packet: OstraconPacket, meta?: OstraconRecordMeta): Promise<OstraconPacketRecord> {
    const normalized = normalizePacket(packet);

    let filePath = "";
    const packetFormat = this.normalizePacketFormat(normalized.format);
    for (const obj of normalized.objects) {
      const existing = this.getNoteFilePath(obj.id, packetFormat);
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
    this.rebuildNoteIdMap();
    this.state.selectedPacketId = record.id;
    await this.persistState();
    this.refreshViews();
    this.logLine("info", `ingested packet ${record.id}`);
    return record;
  }

  async writePacketToVault(record: OstraconPacketRecord): Promise<void> {
    const folderPath = record.filePath.split("/").slice(0, -1).join("/");
    await ensureFolder(this.app, folderPath);
    const existing = this.app.vault.getAbstractFileByPath(record.filePath);
    const packet = record.packet;

    const unlock = await this.lockFile(record.filePath);
    try {
      if (packet.format === "canvas") {
        const content = buildPacketMarkdown(packet, record);
        if (existing instanceof TFile) {
          await this.processInternalWrite(existing, () => content);
        } else {
          await this.createInternalFile(record.filePath, content);
        }
      } else if (existing instanceof TFile && packet.format !== "markdown") {
        let content = await this.app.vault.read(existing);
        for (const object of packet.objects || []) {
          const section = this.findCardSection(content, object.id);
          const newSection = this.buildCardSection(object, section?.headingMark);
          if (section) {
            content = content.slice(0, section.start) + newSection + content.slice(section.end);
          } else {
            const rawIdx = content.lastIndexOf("## Raw Packet");
            const at = rawIdx >= 0 ? rawIdx : content.length;
            content = content.slice(0, at) + "\n" + newSection.trimEnd() + "\n\n" + content.slice(at);
          }
        }
        content = content.replace(/^ostracon_version:.*$/m, `ostracon_version: ${record.version}`);
        await this.processInternalWrite(existing, () => content);
      } else {
        const content = buildPacketMarkdown(packet, record);
        if (existing instanceof TFile) {
          await this.processInternalWrite(existing, () => content);
        } else {
          await this.createInternalFile(record.filePath, content);
        }
      }
    } finally {
      unlock();
    }
  }

  async processInternalWrite(file: TFile, fn: (content: string) => string): Promise<void> {
    this.internalWritePaths.add(file.path);
    try {
      await this.app.vault.process(file, fn);
    } finally {
      window.setTimeout(() => this.internalWritePaths.delete(file.path), 1000);
    }
  }

  async createInternalFile(filePath: string, content: string): Promise<void> {
    this.internalWritePaths.add(filePath);
    try {
      await this.app.vault.create(filePath, content);
    } finally {
      window.setTimeout(() => this.internalWritePaths.delete(filePath), 1000);
    }
  }

  findCardSection(content: string, noteId: string): { start: number; end: number; headingMark: string } | null {
    const escaped = noteId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headingPattern = new RegExp(`^(#{1,6})\\s+.*<!--\\s*ostracon_noteid:${escaped}\\s*-->\\s*$`);
    const nextCardHeadingPattern = /^#{1,6}\s+.*<!--\s*ostracon_noteid:[^>]+-->\s*$/;
    const lines = content.match(/[^\n]*(?:\n|$)/g) || [];
    let offset = 0;
    let start = -1;
    let end = content.length;
    let headingMark = "###";

    for (const line of lines) {
      const text = line.replace(/\r?\n$/, "");
      const heading = text.match(headingPattern);
      if (start < 0 && heading) {
        start = offset;
        headingMark = heading[1];
      } else if (start >= 0 && nextCardHeadingPattern.test(text)) {
        end = offset;
        break;
      }
      offset += line.length;
    }

    return start >= 0 ? { start, end, headingMark } : null;
  }

  parseCardSection(block: string): { title: string; excerpt: string; comment: string } {
    const structured = {
      title: block.match(/- Title:\s*(.*)/)?.[1]?.trim(),
      excerpt: block.match(/- Excerpt:\s*(.*)/)?.[1]?.trim(),
      comment: block.match(/- Comment:\s*(.*)/)?.[1]?.trim(),
    };
    if (structured.title !== undefined || structured.excerpt !== undefined || structured.comment !== undefined) {
      return {
        title: structured.title || "",
        excerpt: structured.excerpt || "",
        comment: structured.comment || "",
      };
    }

    const heading = block.match(/^#{1,6}\s+(.+?)\s*<!--\s*ostracon_noteid:[^>]+-->/);
    if (!heading) throw new Error("卡片段落缺少ostracon_noteid标题");

    const body = block.slice(heading[0].length).trim();
    const lines = body.split(/\r?\n/);
    const excerptLines: string[] = [];
    let index = 0;
    while (index < lines.length && lines[index].startsWith(">")) {
      excerptLines.push(lines[index].replace(/^>\s?/, ""));
      index++;
    }
    while (index < lines.length && lines[index].trim() === "") index++;

    const comment = lines.slice(index)
      .filter(line => !this.isOstraconMetadataLine(line))
      .join("\n")
      .trim();

    return {
      title: heading[1].trim(),
      excerpt: excerptLines.join("\n").trim(),
      comment,
    };
  }

  buildCardSection(object: OstraconObject, headingMark = "###"): string {
    const lines = [`${headingMark} ${object.title || "未命名卡片"} <!-- ostracon_noteid:${object.id} -->`, ""];
    if (object.excerpt) {
      lines.push(...object.excerpt.split(/\r?\n/).map(line => line ? `> ${line}` : ">"));
      lines.push("");
    }
    if (object.comment) {
      lines.push(object.comment);
    }
    return lines.join("\n").trimEnd();
  }

  isOstraconMetadataLine(line: string): boolean {
    const text = line.trim();
    return /^!\[[^\]]*\]\(.+\)$/.test(text)
      || /^-?\s*(Source Anchor|MarginNote Link|Has Image|Has Handwriting|Comment):/i.test(text)
      || /^-?\s*marginnote4app:\/\/note\//i.test(text);
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
