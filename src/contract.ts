import crypto from "crypto";
import { normalizePath, type App } from "obsidian";

const PLUGIN_ID = "ostracon-ob";
const VIEW_TYPE_INBOX = "ostracon-inbox-view";
const PROTOCOL_VERSION = 1;
const DEFAULT_OUTPUT_FOLDER = "Ostracon/Inbox";
const DEFAULT_PORT = 27123;

interface OstraconSettings {
  host: string;
  port: number;
  token: string;
  outputFolder: string;
  autoStartServer: boolean;
}

interface OstraconSource {
  platform: string;
  title: string;
  url: string;
}

interface OstraconObject {
  id: string;
  kind: string;
  title: string;
  excerpt: string;
  comment: string;
  sourceAnchor: string;
  hasImage: boolean;
  hasHandwriting: boolean;
}

interface OstraconPacket {
  version: number;
  id: string;
  status: string;
  transport: string;
  createdAt: string;
  updatedAt: string;
  source: OstraconSource;
  summary: string;
  tags: string[] | string;
  objects: OstraconObject[];
  relations: unknown[];
  notes: string;
  destination: { platform: string; vault: string; folder: string };
  format?: string;
}

interface OstraconPacketRecord {
  id: string;
  packet: OstraconPacket;
  summary: ReturnType<typeof summarizePacket>;
  filePath: string;
  source: OstraconSource;
  tags: string[];
  receivedAt: string;
  transport: string;
  requestId: string;
  clientId: string;
  messageType: string;
  version: number;
  autoSynced: boolean;
}

interface OstraconRecordMeta {
  receivedAt?: string;
  transport?: string;
  requestId?: string;
  clientId?: string;
  messageType?: string;
  version?: number;
  autoSynced?: boolean;
}

interface OstraconMessage {
  type: string;
  requestId?: string;
  command?: string;
  payload?: unknown;
  event?: string;
  clientId?: string;
}

interface OstraconNotebookSummary {
  id: string;
  title: string;
  source: string;
  selected?: boolean;
  cardCount?: number;
}

interface OstraconCardSummary {
  id: string;
  title: string;
  excerpt: string;
  comment: string;
  sourceAnchor: string;
  selected?: boolean;
  hasImage?: boolean;
  hasHandwriting?: boolean;
  colorIndex?: number;
  tag?: string;
  children?: OstraconCardSummary[];
}

interface LogEntry {
  id: string;
  level: string;
  message: string;
  at: string;
}

export interface OstraconPluginHost {
  settings: OstraconSettings;
  saveSettings: () => Promise<void>;
  restartServer: () => Promise<void>;
  getConnectionUrl: () => string;
  getPacketSummaries: () => Array<{
    id: string;
    summary: unknown;
    filePath: string;
    receivedAt: string;
  }>;
  getVaultName: () => string;
  ingestPacket: (packet: OstraconPacket, meta?: OstraconRecordMeta) => Promise<OstraconPacketRecord>;
  handleCardUpdated: (payload: {
    noteId: string; title: string; excerpt: string; comment: string;
    sourceAnchor: string; version: number; filePath?: string; format?: string; markdownSection?: string; canvasText?: string; hasImage?: boolean; hasHandwriting?: boolean;
  }) => Promise<void>;
  logLine: (level: string, message: string) => void;
  state: { selectedPacketId: string };
  getPacketRecords: () => OstraconPacketRecord[];
  getSelectedPacket: () => OstraconPacketRecord | null;
  getClientCount: () => number;
  isServerRunning: () => boolean;
  openSettings: () => void;
  listMnNotebooks: () => Promise<OstraconNotebookSummary[]>;
  listMnCards: (notebookId: string) => Promise<OstraconCardSummary[]>;
  fetchCards: (cardIds: string[], format: string) => Promise<string>;
}

function createToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

function createSessionId(): string {
  return `session-${crypto.randomBytes(8).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeSegment(value: unknown, fallback = "untitled"): string {
  const raw = String(value || "").trim();
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function sanitizePath(value: unknown, fallback = DEFAULT_OUTPUT_FOLDER): string {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const segments = raw.split(/[\\/]+/).map(s => sanitizeSegment(s, "")).filter(Boolean);
  return segments.length > 0 ? segments.join("/") : fallback;
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(Boolean).map(s => String(s).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(",").map(s => s.trim()).filter(Boolean);
  return [];
}

function createId(prefix: string): string {
  const random = crypto.randomBytes(6).toString("hex");
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function createDefaultSettings(): OstraconSettings {
  return { host: "127.0.0.1", port: DEFAULT_PORT, token: createToken(), outputFolder: DEFAULT_OUTPUT_FOLDER, autoStartServer: true };
}

function normalizePacket(packet: OstraconPacket): OstraconPacket {
  if (!packet || typeof packet !== "object") throw new Error("Packet must be an object");
  if (packet.version !== PROTOCOL_VERSION) throw new Error(`Unsupported packet version: ${packet.version}`);
  if (!packet.id || typeof packet.id !== "string") throw new Error("Packet missing id");
  if (!packet.source || typeof packet.source !== "object") throw new Error("Packet missing source");
  if (!Array.isArray(packet.objects) || packet.objects.length === 0) throw new Error("Packet must contain at least one object");

  return {
    version: PROTOCOL_VERSION,
    id: packet.id,
    status: packet.status || "draft",
    transport: packet.transport || "ws",
    createdAt: packet.createdAt || nowIso(),
    updatedAt: nowIso(),
    source: { platform: packet.source.platform || "MarginNote", title: packet.source.title || "", url: packet.source.url || "" },
    summary: packet.summary || "",
    tags: normalizeTags(packet.tags),
    objects: packet.objects.map(item => ({
      id: item.id || createId("object"),
      kind: item.kind || "Card",
      title: item.title || "",
      excerpt: item.excerpt || "",
      comment: item.comment || "",
      sourceAnchor: item.sourceAnchor || "",
      hasImage: Boolean(item.hasImage),
      hasHandwriting: Boolean(item.hasHandwriting),
    })),
    relations: Array.isArray(packet.relations) ? packet.relations : [],
    notes: packet.notes || "",
    format: packet.format || "",
    destination: packet.destination || { platform: "Obsidian", vault: "", folder: "Inbox" },
  };
}

function summarizePacket(packet: OstraconPacket) {
  const objects = Array.isArray(packet.objects) ? packet.objects : [];
  return {
    id: packet.id, version: packet.version, status: packet.status,
    sourceTitle: packet.source?.title || "",
    objectCount: objects.length, tags: normalizeTags(packet.tags),
    firstObjectKind: objects.length > 0 && objects[0].kind ? objects[0].kind : "",
    destination: packet.destination || null,
  };
}

function buildPacketFilePath(settings: OstraconSettings, packet: OstraconPacket): string {
  const outputFolder = sanitizePath(settings.outputFolder || DEFAULT_OUTPUT_FOLDER);
  const platform = sanitizeSegment(packet.source?.platform || "MarginNote");
  const sourceTitle = sanitizeSegment(packet.source?.title || packet.id, packet.id);
  const ext = packet.format === "canvas" ? ".canvas" : ".md";
  return normalizePath(`${outputFolder}/${platform}/${sourceTitle}/${packet.id}${ext}`);
}

function buildPacketMarkdown(packet: OstraconPacket, record: OstraconPacketRecord): string {
  if (packet.format === "canvas" && packet.notes) {
    return packet.notes.trimEnd();
  }

  if (packet.format === "markdown" && packet.notes) {
    const tags = normalizeTags(packet.tags);
    const lines: string[] = ["---"];
    lines.push(`ostracon_id: ${JSON.stringify(packet.id)}`);
    lines.push(`ostracon_format: markdown`);
    lines.push(`ostracon_received_at: ${JSON.stringify(record.receivedAt)}`);
    lines.push(`ostracon_source_title: ${JSON.stringify(packet.source?.title || "")}`);
    if (tags.length > 0) {
      lines.push("ostracon_tags:");
      for (const tag of tags) lines.push(`  - ${JSON.stringify(tag)}`);
    }
    lines.push("ostracon_note_ids:");
    for (const obj of packet.objects || []) {
      lines.push(`  - ${JSON.stringify(obj.id)}`);
    }
    lines.push("---", "");
    lines.push(packet.notes.trimEnd());
    appendObjectLinks(lines, packet);
    return lines.join("\n");
  }

  const lines: string[] = [];
  const tags = normalizeTags(packet.tags);
  lines.push("---");
  lines.push(`ostracon_id: ${JSON.stringify(packet.id)}`);
  lines.push(`ostracon_status: ${JSON.stringify(packet.status || "draft")}`);
  lines.push(`ostracon_version: ${packet.version || PROTOCOL_VERSION}`);
  lines.push(`ostracon_transport: ${JSON.stringify(packet.transport || "ws")}`);
  lines.push(`ostracon_source_platform: ${JSON.stringify(packet.source?.platform || "")}`);
  lines.push(`ostracon_source_title: ${JSON.stringify(packet.source?.title || "")}`);
  lines.push(`ostracon_source_url: ${JSON.stringify(packet.source?.url || "")}`);
  lines.push(`ostracon_received_at: ${JSON.stringify(record.receivedAt)}`);
  lines.push(`ostracon_file_path: ${JSON.stringify(record.filePath)}`);
  lines.push(`ostracon_object_count: ${Array.isArray(packet.objects) ? packet.objects.length : 0}`);
  lines.push("ostracon_tags:");
  for (const tag of tags) lines.push(`  - ${JSON.stringify(tag)}`);
  lines.push("ostracon_note_ids:");
  for (const obj of packet.objects || []) {
    lines.push(`  - ${JSON.stringify(obj.id)}`);
  }
  lines.push("---", "");
  lines.push(`# ${packet.source?.title || packet.id}`, "");
  lines.push("## Summary", "");
  lines.push(packet.summary ? packet.summary : "未填写摘要", "");
  lines.push("", "## Objects");
  for (const object of packet.objects || []) {
    lines.push(`### ${object.kind || "Card"} <!-- ostracon_noteid:${object.id} -->`);
    lines.push(`- Title: ${object.title || ""}`, `- Excerpt: ${object.excerpt || ""}`, `- Comment: ${object.comment || ""}`);
    lines.push(`- Source Anchor: ${object.sourceAnchor || ""}`);
    if (object.sourceAnchor) lines.push(`- MarginNote Link: [Open in MarginNote](${object.sourceAnchor})`);
    lines.push(`- Has Image: ${object.hasImage ? "yes" : "no"}`, `- Has Handwriting: ${object.hasHandwriting ? "yes" : "no"}`, "");
  }
  lines.push("## Raw Packet", "```json", JSON.stringify(packet, null, 2), "```", "");
  return lines.join("\n");
}

function appendObjectLinks(lines: string[], packet: OstraconPacket): void {
  const linkedObjects = (packet.objects || []).filter(object => object.sourceAnchor);
  if (linkedObjects.length === 0) return;
  lines.push("", "## MarginNote Links", "");
  for (const object of linkedObjects) {
    const label = object.title || object.excerpt || object.id || "MarginNote Card";
    lines.push(`- [${escapeMarkdownLinkText(label)}](${object.sourceAnchor})`);
  }
}

function escapeMarkdownLinkText(value: string): string {
  return String(value || "").replace(/[[\]\\]/g, "\\$&").replace(/\s+/g, " ").trim() || "MarginNote Card";
}

function buildPacketRecord(packet: OstraconPacket, filePath: string, meta: OstraconRecordMeta = {}): OstraconPacketRecord {
  const normalized = normalizePacket(packet);
  return {
    id: normalized.id, packet: normalized, summary: summarizePacket(normalized), filePath,
    source: normalized.source, tags: normalized.tags as string[],
    receivedAt: meta.receivedAt || nowIso(), transport: meta.transport || "ws",
    requestId: meta.requestId || "", clientId: meta.clientId || "", messageType: meta.messageType || "command",
    version: meta.version ?? 1,
    autoSynced: meta.autoSynced ?? false,
  };
}

function buildConnectionUrl(settings: OstraconSettings, sessionId: string): string {
  const host = settings.host || "127.0.0.1";
  const port = Number(settings.port || DEFAULT_PORT);
  const token = encodeURIComponent(settings.token || "");
  return `ws://${host}:${port}?token=${token}&session=${encodeURIComponent(sessionId || "")}`;
}

function buildHelloPayload(settings: OstraconSettings, sessionId: string, vaultName?: string) {
  return {
    protocolVersion: PROTOCOL_VERSION, pluginId: PLUGIN_ID, sessionId,
    serverTime: nowIso(), capabilities: ["hello", "ping", "pong", "event", "command", "sync_request", "sync_result", "ack", "error"],
    outputFolder: settings.outputFolder || DEFAULT_OUTPUT_FOLDER,
    vaultName: vaultName || "",
  };
}

function buildAckPayload(message: OstraconMessage) {
  return { requestId: message.requestId || "", ok: true, type: message.type || "unknown", command: message.command || "" };
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const segments = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

let debugLogPath = "";

function setDebugLogPath(p: string) {
  debugLogPath = p;
}

function debugLog(msg: string) {
  if (!debugLogPath) return;
  try {
    const fs = require("fs") as typeof import("fs");
    fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch {}
}

export {
  PLUGIN_ID, VIEW_TYPE_INBOX, PROTOCOL_VERSION, DEFAULT_OUTPUT_FOLDER, DEFAULT_PORT,
  createToken, createSessionId, nowIso, sanitizeSegment, normalizeTags, createId,
  createDefaultSettings, normalizePacket, summarizePacket, buildPacketFilePath,
  buildPacketMarkdown, buildPacketRecord, buildConnectionUrl, buildHelloPayload, buildAckPayload,
  ensureFolder,
  setDebugLogPath, debugLog,
};
export type {
  OstraconSettings, OstraconSource, OstraconObject, OstraconPacket, OstraconPacketRecord,
  OstraconRecordMeta, OstraconMessage, OstraconNotebookSummary, OstraconCardSummary,
  LogEntry,
};
