import { App, Component, finishRenderMath, MarkdownRenderer } from "obsidian";

const RENDER_QUIET_MS = 250;
const RENDER_TIMEOUT_MS = 5000;

const SNAPSHOT_STYLE_PROPERTIES = [
  "align-content", "align-items", "align-self", "appearance",
  "background", "background-blend-mode", "border", "border-radius", "border-collapse",
  "border-spacing", "box-shadow", "box-sizing", "color", "column-count", "column-gap",
  "cursor", "display", "fill", "flex", "flex-basis", "flex-direction", "flex-flow",
  "flex-grow", "flex-shrink", "flex-wrap", "float", "font", "font-family", "font-feature-settings",
  "font-kerning", "font-optical-sizing", "font-size", "font-stretch", "font-style", "font-variant",
  "font-weight", "gap", "grid", "grid-area", "grid-auto-columns", "grid-auto-flow",
  "grid-auto-rows", "grid-column", "grid-row", "grid-template", "isolation",
  "justify-content", "justify-items", "justify-self", "letter-spacing", "line-height", "list-style",
  "margin", "mask", "object-fit",
  "object-position", "order", "outline", "overflow", "overflow-wrap", "padding",
  "place-content", "place-items", "place-self", "resize", "stroke", "stroke-width", "tab-size",
  "text-align", "text-decoration", "text-indent", "text-overflow", "text-shadow", "text-transform",
  "user-select", "vertical-align", "white-space", "word-break", "word-spacing", "writing-mode",
] as const;

const SNAPSHOT_GEOMETRY_PROPERTIES = ["width", "height", "min-width", "min-height", "max-width", "max-height"] as const;
const INTRINSIC_GEOMETRY_TAGS = new Set(["SVG", "VIDEO", "CANVAS"]);
const mathFontDataCache = new Map<string, Promise<string>>();
type CssTarget = {
  setCssProps: (properties: Record<string, string>) => void;
  setCssStyles: (styles: Record<string, string>) => void;
};

function normalizePlainText(value: string | null): string {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function preservesIntrinsicGeometry(element: Pick<Element, "tagName" | "childElementCount" | "textContent">, computed: Pick<CSSStyleDeclaration, "getPropertyValue">): boolean {
  if (INTRINSIC_GEOMETRY_TAGS.has(element.tagName.toUpperCase())) return true;
  if (element.childElementCount !== 0 || normalizePlainText(element.textContent)) return false;
  return ["background-image", "mask-image"].some(property => {
    const value = computed.getPropertyValue(property).trim();
    return Boolean(value && value !== "none");
  });
}

function normalizeImageSizing(element: Pick<HTMLImageElement, "tagName" | "removeAttribute" | "setCssProps" | "setCssStyles">): void {
  if (element.tagName.toUpperCase() !== "IMG") return;
  element.removeAttribute("width");
  element.removeAttribute("height");
  element.setCssProps(Object.fromEntries(SNAPSHOT_GEOMETRY_PROPERTIES.map(property => [property, ""])));
  element.setCssStyles({ maxWidth: "100%", width: "auto", height: "auto", objectFit: "contain" });
}

function normalizeMermaidSizing(source: Pick<Element, "tagName" | "closest">, target: CssTarget): void {
  if (source.tagName.toUpperCase() !== "SVG" || !source.closest(".mermaid")) return;
  target.setCssProps(Object.fromEntries(SNAPSHOT_GEOMETRY_PROPERTIES.map(property => [property, ""])));
  target.setCssStyles({ maxWidth: "100%", width: "auto", height: "auto" });
}

type MathRenderContext = { sourcePath?: string };

function dataUrlMimeType(url: string): string {
  return /\.woff2(?:[?#]|$)/i.test(url) ? "font/woff2" : "font/woff";
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const values = new Uint8Array(bytes);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < values.length; offset += chunkSize) {
    binary += String.fromCharCode(...values.subarray(offset, Math.min(offset + chunkSize, values.length)));
  }
  return btoa(binary);
}

function resolveMathFontUrl(rawUrl: string): string {
  return new URL(rawUrl, document.baseURI).href;
}

async function inlineMathFontUrl(rawUrl: string, context: MathRenderContext): Promise<string> {
  if (/^data:/i.test(rawUrl)) return rawUrl;
  if (!/\.(?:woff2?|ttf|otf)(?:[?#]|$)/i.test(rawUrl)) return rawUrl;
  const url = resolveMathFontUrl(rawUrl);
  let pending = mathFontDataCache.get(url);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`MathJax字体读取失败: url=${url}, status=${response.status}`);
      const base64 = bytesToBase64(await response.arrayBuffer());
      return `data:${dataUrlMimeType(url)};base64,${base64}`;
    })();
    mathFontDataCache.set(url, pending);
  }
  try {
    return await pending;
  } catch (error) {
    mathFontDataCache.delete(url);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`MathJax字体内联失败: sourcePath=${context.sourcePath || ""}, url=${url}: ${message}`);
  }
}

async function inlineMathFontUrls(css: string, context: MathRenderContext): Promise<string> {
  const matches = Array.from(css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi));
  const replacements = await Promise.all(matches.map(async match => ({
    raw: match[0],
    value: await inlineMathFontUrl(match[2], context),
  })));
  let result = css;
  for (const replacement of replacements) result = result.replace(replacement.raw, `url("${replacement.value}")`);
  return result;
}

function serializeStyleElement(style: HTMLStyleElement): string {
  const rules = style.sheet ? Array.from(style.sheet.cssRules) : [];
  if (rules.length > 0) return rules.map(rule => rule.cssText).join("\n");
  return String(style.textContent || "");
}

async function collectMathStyles(context: MathRenderContext = {}): Promise<string> {
  const styles = Array.from(document.querySelectorAll("style"))
    .map(serializeStyleElement)
    .filter(text => /(?:mjx-container|MJX-CHTML|MathJax)/i.test(text));
  if (styles.length === 0) return "";
  const inlined = await Promise.all(styles.map(text => inlineMathFontUrls(text, context)));
  return inlined.map(text => `<style data-ostracon-math="true">${text}</style>`).join("");
}

function isMathJaxElement(element: Element): boolean {
  return element.tagName.toUpperCase() === "MJX-CONTAINER" || Boolean(element.closest("mjx-container"));
}

function containsRenderedMath(container: Pick<Element, "querySelector">): boolean {
  return Boolean(container.querySelector("mjx-container, .math"));
}

async function snapshotRenderedHtml(container: HTMLElement, context: MathRenderContext = {}): Promise<string> {
  const clonedNode = container.cloneNode(true);
  if (!(clonedNode instanceof HTMLElement)) throw new Error("Obsidian文档HTML快照根节点无效");
  const clone = clonedNode;
  const sources = Array.from(container.querySelectorAll<HTMLElement | SVGElement>("*"));
  const targets = Array.from(clone.querySelectorAll<HTMLElement | SVGElement>("*"));
  if (sources.length !== targets.length) throw new Error("Obsidian文档HTML快照结构不一致");
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const target = targets[index];
    if (isMathJaxElement(source)) continue;
    const computed = window.getComputedStyle(source);
    for (const property of SNAPSHOT_STYLE_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (value) target.setCssProps({ [property]: value });
    }
    if (preservesIntrinsicGeometry(source, computed)) {
      for (const property of SNAPSHOT_GEOMETRY_PROPERTIES) {
        const value = computed.getPropertyValue(property);
        if (value) target.setCssProps({ [property]: value });
      }
    }
    if (target instanceof HTMLImageElement) normalizeImageSizing(target);
    normalizeMermaidSizing(source, target);
  }
  const mathStyles = containsRenderedMath(clone) ? await collectMathStyles(context) : "";
  return `${mathStyles}${clone.innerHTML}`;
}

class ObsidianHtmlRenderService {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  private waitForStableDom(container: HTMLElement): Promise<void> {
    return new Promise((resolve, reject) => {
      let quietTimer = window.setTimeout(finish, RENDER_QUIET_MS);
      const timeoutTimer = window.setTimeout(() => {
        observer.disconnect();
        window.clearTimeout(quietTimer);
        reject(new Error("Obsidian文档HTML渲染超时"));
      }, RENDER_TIMEOUT_MS);
      const observer = new MutationObserver(() => {
        window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(finish, RENDER_QUIET_MS);
      });
      function finish() {
        observer.disconnect();
        window.clearTimeout(timeoutTimer);
        resolve();
      }
      observer.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  }

  async render(markdown: string, sourcePath: string): Promise<{ renderedHtml: string; plainText: string; renderVersion: number }> {
    const component = new Component();
    const container = createDiv();
    container.className = "ostracon-html-render-source markdown-rendered";
    document.body.appendChild(container);
    component.load();
    try {
      await MarkdownRenderer.render(this.app, markdown, container, sourcePath, component);
      await this.waitForStableDom(container);
      if (containsRenderedMath(container)) {
        await finishRenderMath();
        await this.waitForStableDom(container);
      }
      const renderedHtml = await snapshotRenderedHtml(container, { sourcePath });
      const plainText = normalizePlainText(container.textContent);
      if (renderedHtml.trim() && !plainText) throw new Error("Obsidian文档HTML缺少可提取的纯文本");
      return {
        renderedHtml,
        plainText,
        renderVersion: 4,
      };
    } finally {
      component.unload();
      container.remove();
    }
  }
}

export { collectMathStyles, containsRenderedMath, inlineMathFontUrls, isMathJaxElement, normalizeImageSizing, normalizeMermaidSizing, ObsidianHtmlRenderService, normalizePlainText, preservesIntrinsicGeometry, serializeStyleElement, snapshotRenderedHtml };
