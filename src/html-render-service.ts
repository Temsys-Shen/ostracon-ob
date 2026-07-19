import { App, Component, MarkdownRenderer } from "obsidian";

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

function snapshotRenderedHtml(container: HTMLElement): string {
  const clonedNode = container.cloneNode(true);
  if (!(clonedNode instanceof HTMLElement)) throw new Error("Obsidian文档HTML快照根节点无效");
  const clone = clonedNode;
  const sources = Array.from(container.querySelectorAll<HTMLElement | SVGElement>("*"));
  const targets = Array.from(clone.querySelectorAll<HTMLElement | SVGElement>("*"));
  if (sources.length !== targets.length) throw new Error("Obsidian文档HTML快照结构不一致");
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const target = targets[index];
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
  }
  return clone.innerHTML;
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
      const renderedHtml = snapshotRenderedHtml(container);
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

export { normalizeImageSizing, ObsidianHtmlRenderService, normalizePlainText, preservesIntrinsicGeometry, snapshotRenderedHtml };
