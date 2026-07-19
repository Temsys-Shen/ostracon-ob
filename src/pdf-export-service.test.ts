import { describe, expect, test, vi } from "vitest";
import { buildPrintHtml, normalizePdfFileName, PdfExportService } from "./pdf-export-service";
import { createDefaultPdfPrintSettings } from "./pdf-print-settings";

function createWindowFixture(pdf = Buffer.from("%PDF-1.7\nexample")) {
  const loadURL = vi.fn().mockResolvedValue(undefined);
  const printToPDF = vi.fn().mockResolvedValue(pdf);
  const destroy = vi.fn();
  const BrowserWindow = vi.fn(function () {
    return { loadURL, webContents: { printToPDF }, destroy };
  });
  return { BrowserWindow, loadURL, printToPDF, destroy };
}

function createPublisherFixture() {
  const release = vi.fn();
  const publish = vi.fn().mockReturnValue({ url: "http://127.0.0.1:27123/ostracon/pdf/token", release });
  return { publish, release };
}

describe("PDF export service", () => {
  test("prints an A4 document and destroys the hidden window", async () => {
    const fixture = createWindowFixture();
    const publisher = createPublisherFixture();
    const service = new PdfExportService(
      async path => ({ path, title: "课程/笔记", renderedHtml: "<h1>正文</h1>" }),
      createDefaultPdfPrintSettings,
      publisher.publish,
      fixture.BrowserWindow as never,
    );

    const result = await service.create("Notes/Lesson.md");

    expect(result).toMatchObject({ fileName: "课程_笔记.pdf", byteLength: 16, chunkCount: 1 });
    expect(fixture.BrowserWindow).toHaveBeenCalledWith({ show: false, width: 794, height: 1123, webPreferences: { offscreen: true } });
    expect(publisher.publish).toHaveBeenCalledWith(expect.stringContaining("<h1>正文</h1>"));
    expect(fixture.loadURL).toHaveBeenCalledWith("http://127.0.0.1:27123/ostracon/pdf/token");
    expect(fixture.printToPDF).toHaveBeenCalledWith(expect.objectContaining({
      pageSize: "A4", landscape: false, scale: 1, printBackground: true,
      displayHeaderFooter: false, preferCSSPageSize: false,
    }));
    expect(fixture.destroy).toHaveBeenCalledOnce();
    expect(publisher.release).toHaveBeenCalledOnce();
  });

  test("reads complete base64 data in strict order and releases the session", async () => {
    const pdf = Buffer.alloc(25_001, 7);
    const fixture = createWindowFixture(pdf);
    const publisher = createPublisherFixture();
    const service = new PdfExportService(
      async path => ({ path, title: "Note", renderedHtml: "<p>Body</p>" }),
      createDefaultPdfPrintSettings,
      publisher.publish,
      fixture.BrowserWindow as never,
    );
    const created = await service.create("Note.md");
    const chunks = [0, 1, 2].map(index => service.readChunk(created.sessionId, index));

    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.base64Chunk, "base64")))).toEqual(pdf);
    expect(() => service.readChunk(created.sessionId, 2)).toThrow("OB端PDF分块顺序错误");
    expect(service.release(created.sessionId)).toEqual({ released: true });
    expect(() => service.readChunk(created.sessionId, 3)).toThrow("OB端PDF导出会话不存在");
  });

  test("destroys the hidden window when Electron printing fails", async () => {
    const fixture = createWindowFixture();
    const publisher = createPublisherFixture();
    fixture.printToPDF.mockRejectedValue(new Error("print failed"));
    const service = new PdfExportService(
      async path => ({ path, title: "Note", renderedHtml: "<p>Body</p>" }),
      createDefaultPdfPrintSettings,
      publisher.publish,
      fixture.BrowserWindow as never,
    );

    await expect(service.create("Note.md")).rejects.toThrow("Electron生成PDF失败: Note.md");
    expect(fixture.destroy).toHaveBeenCalledOnce();
    expect(publisher.release).toHaveBeenCalledOnce();
  });

  test("releases the in-memory page when Electron loading fails", async () => {
    const fixture = createWindowFixture();
    const publisher = createPublisherFixture();
    fixture.loadURL.mockRejectedValue(new Error("load failed"));
    const service = new PdfExportService(
      async path => ({ path, title: "Note", renderedHtml: "<p>Body</p>" }),
      createDefaultPdfPrintSettings,
      publisher.publish,
      fixture.BrowserWindow as never,
    );

    await expect(service.create("Note.md")).rejects.toThrow("Electron生成PDF失败: Note.md");
    expect(fixture.destroy).toHaveBeenCalledOnce();
    expect(publisher.release).toHaveBeenCalledOnce();
  });

  test("builds printable HTML without adding visible metadata", () => {
    const html = buildPrintHtml({ path: "Note.md", title: "A&B", renderedHtml: "<p>Body</p>" });
    expect(html).toContain("<title>A&amp;B</title>");
    expect(html).toContain("@page { size: A4; margin: 16mm 16mm 16mm 16mm; }");
    expect(html).toContain("max-height: 16383px !important;");
    expect(html).toContain("<p>Body</p>");
    expect(normalizePdfFileName("A/B")).toBe("A_B.pdf");
  });

  test("uses the latest print settings for each export", async () => {
    const fixture = createWindowFixture();
    const publisher = createPublisherFixture();
    const settings = createDefaultPdfPrintSettings();
    settings.landscape = true;
    settings.scale = 1.2;
    settings.mediaMaxHeightPx = 8_000;
    const service = new PdfExportService(
      async path => ({ path, title: "Note", renderedHtml: "<img src='x'>" }),
      () => settings,
      publisher.publish,
      fixture.BrowserWindow as never,
    );
    await service.create("Note.md");
    expect(fixture.printToPDF).toHaveBeenCalledWith(expect.objectContaining({ landscape: true, scale: 1.2 }));
    expect(publisher.publish).toHaveBeenCalledWith(expect.stringContaining("max-height: 8000px !important"));
  });
});
