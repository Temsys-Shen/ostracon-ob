import crypto from "crypto";
import { normalizePath } from "obsidian";

const PLUGIN_ID = "ostracon-ob";
const VIEW_TYPE_INBOX = "ostracon-inbox-view";
const PROTOCOL_VERSION = 2;
const PACKET_VERSION = 1;
const DEFAULT_OUTPUT_FOLDER = "Marginnote";
const DEFAULT_PORT = 27123;

const DEFAULTS = {
  host: "::",
  transport: "ws",
  status: "draft",
  messageType: "command",
} as const;

interface OstraconSettings {
  host: string;
  port: number;
  outputFolder: string;
  autoStartServer: boolean;
  includeBacklinks: boolean;
  autoConvertBase64: boolean;
  approvedDevices: Array<{ clientId: string; name: string; approvedAt: string }>;
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
  targetFilePath?: string;
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

export interface CardUpdatedPayload {
  noteId: string; title: string; excerpt: string; comment: string;
  sourceAnchor: string; version: number; filePath?: string; format?: string; markdownSection?: string; canvasText?: string; hasImage?: boolean; hasHandwriting?: boolean;
}

export interface SettingsHost {
  settings: OstraconSettings;
  saveSettings: () => Promise<void>;
  restartServer: () => Promise<void>;
  getConnectionUrl: () => string;
}

export interface BridgeHost {
  ingestPacket: (packet: OstraconPacket, meta?: OstraconRecordMeta) => Promise<OstraconPacketRecord>;
  handleCardUpdated: (payload: CardUpdatedPayload) => Promise<void>;
  logLine: (level: string, message: string) => void;
  getVaultName: () => string;
  getPacketSummaries: () => Array<{
    id: string;
    summary: unknown;
    filePath: string;
    receivedAt: string;
  }>;
  settings: Pick<OstraconSettings, "port" | "host" | "outputFolder" | "includeBacklinks">;
  isDeviceApproved: (clientId: string) => boolean;
  approveDevice: (clientId: string, name: string) => void;
  requestApproval: (clientId: string, name: string, callbacks: { onApprove: () => void; onDeny: () => void }) => void;
  getVaultBrowserState: () => unknown;
  listVaultFolder: (payload: Record<string, unknown>) => unknown;
  listVaultTags: () => unknown;
  listVaultDocuments: (payload: Record<string, unknown>) => unknown;
  searchVaultDocuments: (payload: Record<string, unknown>) => Promise<unknown>;
  getVaultDocument: (payload: Record<string, unknown>) => Promise<unknown>;
  getVaultAsset: (payload: Record<string, unknown>) => Promise<unknown>;
}

export interface ViewHost {
  openSettings: () => void;
  isServerRunning: () => boolean;
  getClientCount: () => number;
  getPacketRecords: () => OstraconPacketRecord[];
  getSelectedPacket: () => OstraconPacketRecord | null;
  listMnNotebooks: () => Promise<OstraconNotebookSummary[]>;
  listMnCards: (notebookId: string) => Promise<OstraconCardSummary[]>;
  fetchCards: (cardIds: string[], format: string) => Promise<string>;
  previewCards: (cardIds: string[]) => Promise<string>;
  processBase64InContent: (content: string, targetPath: string) => Promise<string>;
  logLine: (level: string, message: string) => void;
  getConnectionUrl: () => string;
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
  return { host: DEFAULTS.host, port: DEFAULT_PORT, outputFolder: DEFAULT_OUTPUT_FOLDER, autoStartServer: true, includeBacklinks: true, autoConvertBase64: true, approvedDevices: [] };
}

function normalizePacket(packet: OstraconPacket): OstraconPacket {
  if (!packet || typeof packet !== "object") throw new Error("Packet must be an object");
  if (packet.version !== PACKET_VERSION) throw new Error(`Unsupported packet version: ${packet.version}`);
  if (!packet.id || typeof packet.id !== "string") throw new Error("Packet missing id");
  if (!packet.source || typeof packet.source !== "object") throw new Error("Packet missing source");
  if (!Array.isArray(packet.objects)) throw new Error("Packet objects must be an array");

  return {
    version: PACKET_VERSION,
    id: packet.id,
    status: packet.status || DEFAULTS.status,
    transport: packet.transport || DEFAULTS.transport,
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
  const sourceTitle = sanitizeSegment(packet.source?.title || packet.id, packet.id);
  const ext = fileExtensionForFormat(packet.format);
  return normalizePath(`${outputFolder}/${sourceTitle}/${packet.id}${ext}`);
}

function buildPacketRecord(packet: OstraconPacket, filePath: string, meta: OstraconRecordMeta = {}): OstraconPacketRecord {
  const normalized = normalizePacket(packet);
  return {
    id: normalized.id, packet: normalized, summary: summarizePacket(normalized), filePath,
    source: normalized.source, tags: normalized.tags as string[],
    receivedAt: meta.receivedAt || nowIso(), transport: meta.transport || DEFAULTS.transport,
    requestId: meta.requestId || "", clientId: meta.clientId || "",     messageType: meta.messageType || DEFAULTS.messageType,
    version: meta.version ?? 1,
    autoSynced: meta.autoSynced ?? false,
  };
}

function buildConnectionUrl(settings: Pick<OstraconSettings, "host" | "port">): string {
  let host = settings.host || DEFAULTS.host;
  const port = Number(settings.port || DEFAULT_PORT);
  // "::" is a bind address (all interfaces), not a connect address. Use IPv6 loopback instead.
  if (host === "::") host = "::1";
  // Strip existing brackets to avoid double-bracketing
  const clean = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const hostPart = clean.includes(":") ? `[${clean}]` : clean;
  return `ws://${hostPart}:${port}`;
}

function buildHelloPayload(settings: Pick<OstraconSettings, "outputFolder" | "includeBacklinks">, vaultName?: string) {
  return {
    protocolVersion: PROTOCOL_VERSION, pluginId: PLUGIN_ID,
    serverTime: nowIso(), capabilities: ["hello", "ping", "pong", "event", "command", "sync_request", "sync_result", "ack", "error"],
    outputFolder: settings.outputFolder || DEFAULT_OUTPUT_FOLDER,
    vaultName: vaultName || "",
    includeBacklinks: settings.includeBacklinks,
  };
}

function buildAckPayload(message: OstraconMessage) {
  return { requestId: message.requestId || "", ok: true, type: message.type || "unknown", command: message.command || "" };
}

type PacketFormat = "markdown" | "canvas";

function toPacketFormat(f?: string): PacketFormat {
  return f === "canvas" ? "canvas" : "markdown";
}

function fileExtensionForFormat(f?: string): ".md" | ".canvas" {
  return f === "canvas" ? ".canvas" : ".md";
}

export {
  PLUGIN_ID, VIEW_TYPE_INBOX, PROTOCOL_VERSION, PACKET_VERSION, DEFAULTS, DEFAULT_OUTPUT_FOLDER, DEFAULT_PORT,
  nowIso, sanitizeSegment, normalizeTags, createId,
  createDefaultSettings, normalizePacket, summarizePacket, buildPacketFilePath, toPacketFormat, fileExtensionForFormat,
  buildPacketRecord, buildConnectionUrl, buildHelloPayload, buildAckPayload,
};

export type {
  OstraconSettings, OstraconSource, OstraconObject, OstraconPacket, OstraconPacketRecord,
  OstraconRecordMeta, OstraconMessage, OstraconNotebookSummary, OstraconCardSummary,
  LogEntry, PacketFormat,
};
