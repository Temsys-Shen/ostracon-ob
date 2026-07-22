import crypto from "crypto";
import { normalizePath } from "obsidian";
import { DEFAULT_QUOTE_TEMPLATE } from "./quote-template";
import { createDefaultPdfPrintSettings, type PdfPrintSettings } from "./pdf-print-settings";

const PLUGIN_ID = "ostracon-ob";
const VIEW_TYPE_INBOX = "ostracon-inbox-view";
const PROTOCOL_VERSION = 4;
const PACKET_VERSION = 1;
const DEFAULT_OUTPUT_FOLDER = "Marginnote";
const DEFAULT_PORT = 27123;
const LEGACY_DEFAULT_CARD_TEMPLATE = "{{heading}} {{title|link}}\n\n{{content}}";
const TITLE_LINK_DEFAULT_CARD_TEMPLATE = "{{heading}} [{{title}}]({{link}})\n\n{{content}}";
const DEFAULT_CARD_TEMPLATE = "{{heading}} {{title}}{{#link}} [<img src=\"https://www.marginnote.com.cn/assets/logo.png\" width=\"20\">]({{link}}){{/link}}\n\n{{content}}";

// 广播事件名。与 ostracon-mn/web/src/lib/events.js 保持一致（人工同步）。
const VAULT_INDEX_CHANGED_EVENT = "vaultIndexChanged";
const QUOTE_CONTEXT_CHANGED_EVENT = "ostracon:quote-context-changed";

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
  autoConvertBase64: boolean;
  quoteTemplate: string;
  cardTemplate: string;
  createQuoteCard: boolean;
  approvedDevices: Array<{ clientId: string; name: string; approvedAt: string }>;
  pdfPrint: PdfPrintSettings;
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
  fileName?: string;
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
}

interface OstraconRecordMeta {
  receivedAt?: string;
  transport?: string;
  requestId?: string;
  clientId?: string;
  messageType?: string;
  version?: number;
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

type QuoteSelection =
  | { kind: "text"; text: string; image: null; noteId: string | null; link: string | null }
  | { kind: "image"; text: null; image: { mime: "image/png"; base64: string }; noteId: string | null; link: string | null };

type QuoteInsertRequest = {
  target: "cursor" | "active-file" | "file";
  filePath?: string;
};

type QuoteInsertResult = { ok: true; filePath: string };

type QuoteTargetContext = {
  cursor: { available: boolean; filePath: string | null };
  activeFile: { available: boolean; filePath: string | null };
};

export interface SettingsHost {
  settings: OstraconSettings;
  saveSettings: () => Promise<void>;
  restartServer: () => Promise<void>;
  getConnectionUrl: () => string;
  resolveConnectionUrl: () => Promise<string>;
}

export interface BridgeHost {
  ingestPacket: (packet: OstraconPacket, meta?: OstraconRecordMeta) => Promise<OstraconPacketRecord>;
  logLine: (level: string, message: string) => void;
  getVaultName: () => string;
  settings: Pick<OstraconSettings, "port" | "host" | "outputFolder">;
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
  createVaultDocumentPdfExport: (payload: Record<string, unknown>) => Promise<unknown>;
  readVaultDocumentPdfChunk: (payload: Record<string, unknown>) => unknown;
  releaseVaultDocumentPdfExport: (payload: Record<string, unknown>) => unknown;
  getQuoteContext: () => QuoteTargetContext;
  insertQuote: (payload: QuoteInsertRequest) => Promise<QuoteInsertResult | null>;
}

export interface ViewHost {
  openSettings: () => void;
  isServerRunning: () => boolean;
  getClientCount: () => number;
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
  return {
    host: DEFAULTS.host,
    port: DEFAULT_PORT,
    outputFolder: DEFAULT_OUTPUT_FOLDER,
    autoStartServer: true,
    autoConvertBase64: true,
    quoteTemplate: DEFAULT_QUOTE_TEMPLATE,
    cardTemplate: DEFAULT_CARD_TEMPLATE,
    createQuoteCard: true,
    approvedDevices: [],
    pdfPrint: createDefaultPdfPrintSettings(),
  };
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return Object.fromEntries(Object.entries(value));
}

function normalizePacket(value: unknown): OstraconPacket {
  const packet = objectRecord(value, "Packet");
  if (packet.version !== PACKET_VERSION) throw new Error(`Unsupported packet version: ${String(packet.version)}`);
  if (!packet.id || typeof packet.id !== "string") throw new Error("Packet missing id");
  const source = objectRecord(packet.source, "Packet source");
  if (!Array.isArray(packet.objects)) throw new Error("Packet objects must be an array");

  return {
    version: PACKET_VERSION,
    id: packet.id,
    status: String(packet.status || DEFAULTS.status),
    transport: String(packet.transport || DEFAULTS.transport),
    createdAt: String(packet.createdAt || nowIso()),
    updatedAt: nowIso(),
    source: { platform: String(source.platform || "MarginNote"), title: String(source.title || ""), url: String(source.url || "") },
    summary: String(packet.summary || ""),
    tags: normalizeTags(packet.tags),
    objects: packet.objects.map((value, index) => {
      const item = objectRecord(value, `Packet object ${index}`);
      return {
        id: String(item.id || createId("object")),
        kind: String(item.kind || "Card"),
        title: String(item.title || ""),
        comment: String(item.comment || ""),
        sourceAnchor: String(item.sourceAnchor || ""),
        hasImage: Boolean(item.hasImage),
        hasHandwriting: Boolean(item.hasHandwriting),
      };
    }),
    relations: Array.isArray(packet.relations) ? packet.relations : [],
    notes: String(packet.notes || ""),
    format: String(packet.format || ""),
    fileName: String(packet.fileName || ""),
    destination: packet.destination
      ? (() => { const destination = objectRecord(packet.destination, "Packet destination"); return { platform: String(destination.platform || "Obsidian"), vault: String(destination.vault || ""), folder: String(destination.folder || "Inbox") }; })()
      : { platform: "Obsidian", vault: "", folder: "Inbox" },
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

function buildPacketFilePath(settings: OstraconSettings, packet: OstraconPacket, suffix = 0): string {
  const outputFolder = sanitizePath(settings.outputFolder || DEFAULT_OUTPUT_FOLDER);
  const firstCardTitle = packet.objects && packet.objects[0] ? packet.objects[0].title : "";
  const sourceTitle = sanitizeSegment(packet.fileName || firstCardTitle || packet.source?.title || "Untitled", "Untitled");
  const fileName = suffix > 0 ? `${sourceTitle} ${suffix}` : sourceTitle;
  const ext = fileExtensionForFormat(packet.format);
  return normalizePath(`${outputFolder}/${fileName}${ext}`);
}

function findAvailablePacketFilePath(settings: OstraconSettings, packet: OstraconPacket, pathExists: (path: string) => boolean): string {
  let suffix = 0;
  let filePath = buildPacketFilePath(settings, packet, suffix);
  while (pathExists(filePath)) {
    suffix += 1;
    filePath = buildPacketFilePath(settings, packet, suffix);
  }
  return filePath;
}

function buildPacketRecord(packet: OstraconPacket, filePath: string, meta: OstraconRecordMeta = {}): OstraconPacketRecord {
  const normalized = normalizePacket(packet);
  return {
    id: normalized.id, packet: normalized, summary: summarizePacket(normalized), filePath,
    source: normalized.source, tags: normalizeTags(normalized.tags),
    receivedAt: meta.receivedAt || nowIso(), transport: meta.transport || DEFAULTS.transport,
    requestId: meta.requestId || "", clientId: meta.clientId || "",     messageType: meta.messageType || DEFAULTS.messageType,
    version: meta.version ?? 1,
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

function buildHelloPayload(settings: Pick<OstraconSettings, "outputFolder" | "cardTemplate">, vaultName?: string) {
  return {
    protocolVersion: PROTOCOL_VERSION, pluginId: PLUGIN_ID,
    serverTime: nowIso(), capabilities: ["hello", "ping", "pong", "event", "command", "command_result", "ack", "error"],
    outputFolder: settings.outputFolder || DEFAULT_OUTPUT_FOLDER,
    cardTemplate: settings.cardTemplate,
    vaultName: vaultName || "",
  };
}

function buildAckPayload(message: OstraconMessage) {
  return { requestId: message.requestId || "", ok: true, type: message.type || "unknown", command: message.command || "" };
}

function fileExtensionForFormat(f?: string): ".md" | ".canvas" {
  return f === "canvas" ? ".canvas" : ".md";
}

export {
  PLUGIN_ID, VIEW_TYPE_INBOX, PROTOCOL_VERSION, PACKET_VERSION, DEFAULTS, DEFAULT_OUTPUT_FOLDER, DEFAULT_PORT, DEFAULT_QUOTE_TEMPLATE, LEGACY_DEFAULT_CARD_TEMPLATE, TITLE_LINK_DEFAULT_CARD_TEMPLATE, DEFAULT_CARD_TEMPLATE,
  VAULT_INDEX_CHANGED_EVENT, QUOTE_CONTEXT_CHANGED_EVENT,
  nowIso, sanitizeSegment, normalizeTags, createId,
  createDefaultSettings, normalizePacket, summarizePacket, buildPacketFilePath, findAvailablePacketFilePath, fileExtensionForFormat,
  buildPacketRecord, buildConnectionUrl, buildHelloPayload, buildAckPayload,
};

export type {
  OstraconSettings, OstraconSource, OstraconObject, OstraconPacket, OstraconPacketRecord,
  OstraconRecordMeta, OstraconMessage, OstraconNotebookSummary, OstraconCardSummary,
  LogEntry, QuoteSelection, QuoteInsertRequest, QuoteInsertResult, QuoteTargetContext,
};
