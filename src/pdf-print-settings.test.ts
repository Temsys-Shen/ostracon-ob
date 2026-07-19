import { describe, expect, test } from "vitest";
import {
  buildCssPageRule, buildElectronPdfOptions, compileHeaderFooterTemplate,
  applyCustomMargin, applyCustomPaperDimension, applyMarginPreset, applyPaperSize, createDefaultPdfPrintSettings,
  validatePdfPrintSettings,
} from "./pdf-print-settings";

describe("PDF print settings", () => {
  test("creates the fixed default print configuration", () => {
    const settings = createDefaultPdfPrintSettings();
    expect(settings).toMatchObject({
      paperSize: "A4", landscape: false, scale: 1, printBackground: true,
      displayHeaderFooter: false, mediaMaxHeightPx: 16_383,
    });
    expect(buildCssPageRule(settings)).toBe("@page { size: A4; margin: 16mm 16mm 16mm 16mm; }");
  });

  test("maps custom settings to Electron options", () => {
    const settings = createDefaultPdfPrintSettings();
    Object.assign(settings, {
      paperSize: "custom", customPageWidthMm: 180, customPageHeightMm: 240,
      landscape: true, marginPreset: "custom", marginsMm: { top: 10, right: 12, bottom: 14, left: 16 },
      scale: 1.25, printBackground: false, displayHeaderFooter: true,
      headerTemplate: "{{title}} <x>", footerTemplate: "{{page}} / {{pages}}", preferCssPageSize: true,
    });
    const options = buildElectronPdfOptions(settings);
    expect(options).toMatchObject({
      pageSize: { width: 180_000, height: 240_000 }, landscape: true, scale: 1.25,
      printBackground: false, displayHeaderFooter: true, preferCSSPageSize: true,
    });
    expect(options.margins.top).toBeCloseTo(10 / 25.4);
    expect(options.headerTemplate).toContain('<span class="title"></span> &lt;x&gt;');
    expect(options.footerTemplate).toContain('<span class="pageNumber"></span> / <span class="totalPages"></span>');
    expect(buildCssPageRule(settings)).toBe("@page { size: 240mm 180mm; margin: 10mm 12mm 14mm 16mm; }");
  });

  test("validates ranges and field limits without replacing values", () => {
    const settings = createDefaultPdfPrintSettings();
    settings.mediaMaxHeightPx = 16_384;
    expect(() => validatePdfPrintSettings(settings)).toThrow("pdfPrint.mediaMaxHeightPx");
    expect(settings.mediaMaxHeightPx).toBe(16_384);
  });

  test("keeps paper presets and dimensions synchronized", () => {
    const settings = createDefaultPdfPrintSettings();
    applyPaperSize(settings, "A3");
    expect(settings).toMatchObject({ paperSize: "A3", customPageWidthMm: 297, customPageHeightMm: 420 });
    applyPaperSize(settings, "Letter");
    expect(settings).toMatchObject({ paperSize: "Letter", customPageWidthMm: 215.9, customPageHeightMm: 279.4 });
    applyCustomPaperDimension(settings, "width", 220);
    expect(settings).toMatchObject({ paperSize: "custom", customPageWidthMm: 220, customPageHeightMm: 279.4 });
  });

  test("keeps margin presets and values synchronized", () => {
    const settings = createDefaultPdfPrintSettings();
    applyMarginPreset(settings, "wide");
    expect(settings).toMatchObject({ marginPreset: "wide", marginsMm: { top: 25, right: 25, bottom: 25, left: 25 } });
    applyCustomMargin(settings, "left", 18);
    expect(settings).toMatchObject({ marginPreset: "custom", marginsMm: { top: 25, right: 25, bottom: 25, left: 18 } });
  });

  test("escapes header and footer text before compiling variables", () => {
    const html = compileHeaderFooterTemplate('<b>{{date}}</b>');
    expect(html).toContain('&lt;b&gt;<span class="date"></span>&lt;/b&gt;');
    expect(html).not.toContain("<b>");
  });
});
