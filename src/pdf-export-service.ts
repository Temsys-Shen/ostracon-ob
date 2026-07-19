import { randomUUID } from "crypto";
import { remote } from "electron";
import {
  buildCssPageRule, buildElectronPdfOptions, createDefaultPdfPrintSettings,
  type ElectronPdfOptions, type PdfPrintSettings,
} from "./pdf-print-settings";

const MAX_PDF_BYTES = 200 * 1024 * 1024;
const PDF_CHUNK_BYTES = 12_000;
type BrowserWindowLike = {
  loadURL: (url: string) => Promise<void>;
  webContents: {
    printToPDF: (options: ElectronPdfOptions) => Promise<Buffer>;
  };
  destroy: () => void;
};

type BrowserWindowConstructor = new (options: {
  show: false;
  width: number;
  height: number;
  webPreferences: { offscreen: true };
}) => BrowserWindowLike;

type PdfSource = {
  path: string;
  title: string;
  renderedHtml: string;
};

type PdfExportSession = {
  data: Buffer;
  fileName: string;
  nextChunkIndex: number;
};

type PdfSourceLoader = (path: string) => Promise<PdfSource>;
type PdfPrintSettingsProvider = () => PdfPrintSettings;
type PublishedPrintHtml = { url: string; release: () => void };
type PrintHtmlPublisher = (html: string) => PublishedPrintHtml;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizePdfFileName(title: string): string {
  const normalized = String(title || "Obsidian文档").trim().replace(/[\\/:*?"<>|]/g, "_") || "Obsidian文档";
  return normalized.toLowerCase().endsWith(".pdf") ? normalized : `${normalized}.pdf`;
}

function buildPrintHtml(source: PdfSource, settings = createDefaultPdfPrintSettings()): string {
  const pageRule = buildCssPageRule(settings);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(source.title)}</title>
<style>
${pageRule}
html, body { margin: 0; padding: 0; background: #fff; color: #111; }
body { overflow-wrap: anywhere; word-break: break-word; }
.ostracon-pdf-document { width: 100%; max-width: 100%; }
.ostracon-pdf-document * { box-sizing: border-box; max-width: 100%; }
.ostracon-pdf-document img,
.ostracon-pdf-document canvas,
.ostracon-pdf-document svg,
.ostracon-pdf-document video {
  max-width: 100% !important;
  max-height: ${settings.mediaMaxHeightPx}px !important;
  width: auto !important;
  height: auto !important;
  object-fit: contain !important;
}
</style>
</head>
<body><main class="ostracon-pdf-document markdown-rendered">${source.renderedHtml}</main></body>
</html>`;
}

function defaultBrowserWindowConstructor(): BrowserWindowConstructor {
  return remote.BrowserWindow;
}

class PdfExportService {
  private readonly loadSource: PdfSourceLoader;
  private readonly getPrintSettings: PdfPrintSettingsProvider;
  private readonly publishPrintHtml: PrintHtmlPublisher;
  private readonly BrowserWindow: BrowserWindowConstructor;
  private readonly sessions = new Map<string, PdfExportSession>();

  constructor(
    loadSource: PdfSourceLoader,
    getPrintSettings: PdfPrintSettingsProvider = createDefaultPdfPrintSettings,
    publishPrintHtml: PrintHtmlPublisher,
    BrowserWindow = defaultBrowserWindowConstructor(),
  ) {
    this.loadSource = loadSource;
    this.getPrintSettings = getPrintSettings;
    this.publishPrintHtml = publishPrintHtml;
    this.BrowserWindow = BrowserWindow;
  }

  async create(path: string) {
    const normalizedPath = String(path || "").trim();
    let source: PdfSource;
    try {
      source = await this.loadSource(normalizedPath);
    } catch (error) {
      throw new Error(`生成PDF读取文档失败: ${normalizedPath}: ${errorMessage(error)}`);
    }

    const window = new this.BrowserWindow({
      show: false,
      width: 794,
      height: 1123,
      webPreferences: { offscreen: true },
    });
    let data: Buffer;
    let publishedHtml: PublishedPrintHtml | null = null;
    try {
      const settings = this.getPrintSettings();
      const html = buildPrintHtml(source, settings);
      publishedHtml = this.publishPrintHtml(html);
      await window.loadURL(publishedHtml.url);
      data = await window.webContents.printToPDF(buildElectronPdfOptions(settings));
    } catch (error) {
      throw new Error(`Electron生成PDF失败: ${normalizedPath}: ${errorMessage(error)}`);
    } finally {
      window.destroy();
      publishedHtml?.release();
    }

    if (data.length <= 0) throw new Error(`Electron生成的PDF为空: ${normalizedPath}`);
    if (data.length > MAX_PDF_BYTES) throw new Error(`PDF超过200MB: ${normalizedPath}`);

    const sessionId = randomUUID();
    const fileName = normalizePdfFileName(source.title);
    this.sessions.set(sessionId, { data, fileName, nextChunkIndex: 0 });
    return {
      sessionId,
      fileName,
      byteLength: data.length,
      chunkCount: Math.ceil(data.length / PDF_CHUNK_BYTES),
    };
  }

  readChunk(sessionId: string, chunkIndex: number) {
    const session = this.sessions.get(String(sessionId || ""));
    if (!session) throw new Error("OB端PDF导出会话不存在");
    const index = Number(chunkIndex);
    if (!Number.isInteger(index) || index !== session.nextChunkIndex) throw new Error(`OB端PDF分块顺序错误: ${index}`);
    const start = index * PDF_CHUNK_BYTES;
    if (start >= session.data.length) throw new Error(`OB端PDF分块越界: ${index}`);
    const end = Math.min(session.data.length, start + PDF_CHUNK_BYTES);
    session.nextChunkIndex += 1;
    return {
      chunkIndex: index,
      base64Chunk: session.data.subarray(start, end).toString("base64"),
      byteLength: end - start,
    };
  }

  release(sessionId: string) {
    const normalizedSessionId = String(sessionId || "");
    if (!this.sessions.delete(normalizedSessionId)) throw new Error("OB端PDF导出会话不存在");
    return { released: true };
  }
}

export { buildPrintHtml, normalizePdfFileName, PdfExportService };
