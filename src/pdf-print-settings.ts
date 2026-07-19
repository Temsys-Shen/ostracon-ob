type PdfPaperSize = "A4" | "A3" | "Letter" | "Legal" | "custom";
type PdfMarginPreset = "narrow" | "standard" | "wide" | "custom";

interface PdfMarginsMm {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface PdfPrintSettings {
  paperSize: PdfPaperSize;
  customPageWidthMm: number;
  customPageHeightMm: number;
  landscape: boolean;
  marginPreset: PdfMarginPreset;
  marginsMm: PdfMarginsMm;
  scale: number;
  printBackground: boolean;
  mediaMaxHeightPx: number;
  displayHeaderFooter: boolean;
  headerTemplate: string;
  footerTemplate: string;
  preferCssPageSize: boolean;
}

type ElectronPdfOptions = {
  pageSize: "A4" | "A3" | "Letter" | "Legal" | { width: number; height: number };
  landscape: boolean;
  margins: { top: number; right: number; bottom: number; left: number };
  scale: number;
  printBackground: boolean;
  displayHeaderFooter: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
  preferCSSPageSize: boolean;
};

const MAX_PRINT_MEDIA_HEIGHT_PX = 16_383;
const PDF_PAPER_DIMENSIONS_MM: Record<Exclude<PdfPaperSize, "custom">, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  A3: { width: 297, height: 420 },
  Letter: { width: 215.9, height: 279.4 },
  Legal: { width: 215.9, height: 355.6 },
};
const PDF_MARGIN_PRESETS: Record<Exclude<PdfMarginPreset, "custom">, PdfMarginsMm> = {
  narrow: { top: 8, right: 8, bottom: 8, left: 8 },
  standard: { top: 16, right: 16, bottom: 16, left: 16 },
  wide: { top: 25, right: 25, bottom: 25, left: 25 },
};

function createDefaultPdfPrintSettings(): PdfPrintSettings {
  return {
    paperSize: "A4",
    customPageWidthMm: 210,
    customPageHeightMm: 297,
    landscape: false,
    marginPreset: "standard",
    marginsMm: { ...PDF_MARGIN_PRESETS.standard },
    scale: 1,
    printBackground: true,
    mediaMaxHeightPx: MAX_PRINT_MEDIA_HEIGHT_PX,
    displayHeaderFooter: false,
    headerTemplate: "{{title}}",
    footerTemplate: "{{page}} / {{pages}}",
    preferCssPageSize: false,
  };
}

function applyPaperSize(settings: PdfPrintSettings, paperSize: PdfPaperSize): void {
  settings.paperSize = paperSize;
  if (paperSize === "custom") return;
  const dimensions = PDF_PAPER_DIMENSIONS_MM[paperSize];
  settings.customPageWidthMm = dimensions.width;
  settings.customPageHeightMm = dimensions.height;
}

function applyCustomPaperDimension(settings: PdfPrintSettings, dimension: "width" | "height", value: number): void {
  assertFiniteRange(`pdfPrint.customPage${dimension === "width" ? "Width" : "Height"}Mm`, value, 25.4, 1000);
  settings.paperSize = "custom";
  if (dimension === "width") settings.customPageWidthMm = value;
  else settings.customPageHeightMm = value;
}

function applyMarginPreset(settings: PdfPrintSettings, preset: PdfMarginPreset): void {
  settings.marginPreset = preset;
  if (preset !== "custom") settings.marginsMm = { ...PDF_MARGIN_PRESETS[preset] };
}

function applyCustomMargin(settings: PdfPrintSettings, side: keyof PdfMarginsMm, value: number): void {
  assertFiniteRange(`pdfPrint.marginsMm.${side}`, value, 0, 100);
  settings.marginPreset = "custom";
  settings.marginsMm[side] = value;
}

function assertFiniteRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name}必须在${min}到${max}之间`);
  }
}

function validatePdfPrintSettings(settings: PdfPrintSettings): void {
  if (!["A4", "A3", "Letter", "Legal", "custom"].includes(settings.paperSize)) throw new Error("pdfPrint.paperSize无效");
  if (!["narrow", "standard", "wide", "custom"].includes(settings.marginPreset)) throw new Error("pdfPrint.marginPreset无效");
  if (typeof settings.landscape !== "boolean") throw new Error("pdfPrint.landscape必须是布尔值");
  if (typeof settings.printBackground !== "boolean") throw new Error("pdfPrint.printBackground必须是布尔值");
  if (typeof settings.displayHeaderFooter !== "boolean") throw new Error("pdfPrint.displayHeaderFooter必须是布尔值");
  if (typeof settings.preferCssPageSize !== "boolean") throw new Error("pdfPrint.preferCssPageSize必须是布尔值");
  if (typeof settings.headerTemplate !== "string") throw new Error("pdfPrint.headerTemplate必须是文本");
  if (typeof settings.footerTemplate !== "string") throw new Error("pdfPrint.footerTemplate必须是文本");
  assertFiniteRange("pdfPrint.customPageWidthMm", settings.customPageWidthMm, 25.4, 1000);
  assertFiniteRange("pdfPrint.customPageHeightMm", settings.customPageHeightMm, 25.4, 1000);
  assertFiniteRange("pdfPrint.scale", settings.scale, 0.5, 2);
  assertFiniteRange("pdfPrint.mediaMaxHeightPx", settings.mediaMaxHeightPx, 1, MAX_PRINT_MEDIA_HEIGHT_PX);
  for (const side of ["top", "right", "bottom", "left"] as const) {
    assertFiniteRange(`pdfPrint.marginsMm.${side}`, settings.marginsMm[side], 0, 100);
  }
}

function effectiveMargins(settings: PdfPrintSettings): PdfMarginsMm {
  return settings.marginPreset === "custom" ? settings.marginsMm : PDF_MARGIN_PRESETS[settings.marginPreset];
}

function mmToInches(value: number): number {
  return value / 25.4;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function compileHeaderFooterTemplate(template: string): string {
  const tokens: Record<string, string> = {
    "{{title}}": '<span class="title"></span>',
    "{{date}}": '<span class="date"></span>',
    "{{page}}": '<span class="pageNumber"></span>',
    "{{pages}}": '<span class="totalPages"></span>',
  };
  let compiled = escapeHtml(template);
  for (const [token, html] of Object.entries(tokens)) compiled = compiled.replaceAll(token, html);
  return `<div style="width:100%;font-size:9px;padding:0 12mm;color:#555;">${compiled}</div>`;
}

function buildElectronPdfOptions(settings: PdfPrintSettings): ElectronPdfOptions {
  validatePdfPrintSettings(settings);
  const margins = effectiveMargins(settings);
  const options: ElectronPdfOptions = {
    pageSize: settings.paperSize === "custom"
      ? { width: Math.round(settings.customPageWidthMm * 1000), height: Math.round(settings.customPageHeightMm * 1000) }
      : settings.paperSize,
    landscape: settings.landscape,
    margins: {
      top: mmToInches(margins.top),
      right: mmToInches(margins.right),
      bottom: mmToInches(margins.bottom),
      left: mmToInches(margins.left),
    },
    scale: settings.scale,
    printBackground: settings.printBackground,
    displayHeaderFooter: settings.displayHeaderFooter,
    preferCSSPageSize: settings.preferCssPageSize,
  };
  if (settings.displayHeaderFooter) {
    options.headerTemplate = compileHeaderFooterTemplate(settings.headerTemplate);
    options.footerTemplate = compileHeaderFooterTemplate(settings.footerTemplate);
  }
  return options;
}

function buildCssPageRule(settings: PdfPrintSettings): string {
  validatePdfPrintSettings(settings);
  const margins = effectiveMargins(settings);
  let size = settings.paperSize === "custom"
    ? `${settings.customPageWidthMm}mm ${settings.customPageHeightMm}mm`
    : settings.paperSize;
  if (settings.landscape && settings.paperSize !== "custom") size += " landscape";
  if (settings.landscape && settings.paperSize === "custom") size = `${settings.customPageHeightMm}mm ${settings.customPageWidthMm}mm`;
  return `@page { size: ${size}; margin: ${margins.top}mm ${margins.right}mm ${margins.bottom}mm ${margins.left}mm; }`;
}

export {
  MAX_PRINT_MEDIA_HEIGHT_PX, PDF_MARGIN_PRESETS, PDF_PAPER_DIMENSIONS_MM, applyCustomPaperDimension,
  applyMarginPreset, applyCustomMargin, applyPaperSize, buildCssPageRule, buildElectronPdfOptions,
  compileHeaderFooterTemplate, createDefaultPdfPrintSettings, effectiveMargins,
  validatePdfPrintSettings,
};
export type { ElectronPdfOptions, PdfMarginPreset, PdfMarginsMm, PdfPaperSize, PdfPrintSettings };
