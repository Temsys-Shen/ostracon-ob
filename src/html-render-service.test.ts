import { describe, expect, test, vi } from "vitest";
import { collectMathStyles, inlineMathFontUrls, isMathJaxElement, normalizeImageSizing, normalizeMermaidSizing, normalizePlainText, preservesIntrinsicGeometry } from "./html-render-service";

function computed(values: Record<string, string>) {
  return { getPropertyValue: (property: string) => values[property] || "" };
}

describe("Obsidian HTML snapshot", () => {
  test("embeds the MathJax CHTML stylesheet in the static HTML snapshot", async () => {
    const previousDocument = globalThis.document;
    globalThis.document = {
      baseURI: "app://obsidian.md/",
      querySelectorAll: () => [
        { textContent: ".mjx-container{display:inline-block}" },
        { textContent: ".markdown-preview{color:red}" },
      ],
    } as never;
    try {
      const result = await collectMathStyles();
      expect(result).toContain('data-ostracon-math="true"');
      expect(result).toContain(".mjx-container{display:inline-block}");
      expect(result).not.toContain("markdown-preview");
    } finally {
      globalThis.document = previousDocument;
    }
  });

  test("inlines MathJax fonts and reuses the font cache", async () => {
    const previousDocument = globalThis.document;
    const previousFetch = globalThis.fetch;
    globalThis.document = { baseURI: "app://obsidian.md/lib/mathjax/output/chtml/" } as never;
    const fetchFont = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer }));
    globalThis.fetch = fetchFont as never;
    try {
      const css = '@font-face{font-family:MJXZERO;src:url("fonts/woff-v2/MathJax_Zero.woff")}';
      const first = await inlineMathFontUrls(css, { sourcePath: "Math.md" });
      const second = await inlineMathFontUrls(css, { sourcePath: "Math.md" });
      expect(first).toContain('url("data:font/woff;base64,AQID")');
      expect(second).toBe(first);
      expect(fetchFont).toHaveBeenCalledOnce();
      expect(fetchFont).toHaveBeenCalledWith("app://obsidian.md/lib/mathjax/output/chtml/fonts/woff-v2/MathJax_Zero.woff");
    } finally {
      globalThis.document = previousDocument;
      globalThis.fetch = previousFetch;
    }
  });

  test("keeps existing data URLs and non-font resources unchanged", async () => {
    const css = '.a{src:url("data:font/woff;base64,AQID");background:url("cover.png")}';
    expect(await inlineMathFontUrls(css, { sourcePath: "Math.md" })).toBe(css);
  });

  test("reports the document path and font URL when inlining fails", async () => {
    const previousDocument = globalThis.document;
    const previousFetch = globalThis.fetch;
    globalThis.document = { baseURI: "app://obsidian.md/lib/mathjax/" } as never;
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 })) as never;
    try {
      await expect(inlineMathFontUrls('@font-face{src:url("Missing.woff2")}', { sourcePath: "Broken.md" }))
        .rejects.toThrow("sourcePath=Broken.md, url=app://obsidian.md/lib/mathjax/Missing.woff2");
    } finally {
      globalThis.document = previousDocument;
      globalThis.fetch = previousFetch;
    }
  });

  test("keeps MathJax CHTML nodes out of computed-style flattening", () => {
    expect(isMathJaxElement({ tagName: "MJX-CONTAINER", closest: () => null } as never)).toBe(true);
    expect(isMathJaxElement({ tagName: "MJX-MTABLE", closest: (selector: string) => selector === "mjx-container" ? {} : null } as never)).toBe(true);
    expect(isMathJaxElement({ tagName: "P", closest: () => null } as never)).toBe(false);
  });

  test("extracts plain text independently from element visibility", () => {
    expect(normalizePlainText("  标题\n\n正文\u00a0内容  ")).toBe("标题 正文 内容");
  });

  test("does not preserve fixed geometry for normal content containers", () => {
    const paragraph = { tagName: "P", childElementCount: 0, textContent: "正文" };
    expect(preservesIntrinsicGeometry(paragraph as never, computed({ "background-image": "none" }) as never)).toBe(false);
  });

  test("preserves geometry for non-image media and background decorations", () => {
    const image = { tagName: "IMG", childElementCount: 0, textContent: "" };
    const svg = { tagName: "SVG", childElementCount: 1, textContent: "" };
    const cover = { tagName: "DIV", childElementCount: 0, textContent: "" };
    expect(preservesIntrinsicGeometry(image as never, computed({}) as never)).toBe(false);
    expect(preservesIntrinsicGeometry(svg as never, computed({}) as never)).toBe(true);
    expect(preservesIntrinsicGeometry(cover as never, computed({ "background-image": "url(cover.png)" }) as never)).toBe(true);
  });

  test("normalizes image sizing without preserving fixed dimensions", () => {
    const properties = new Map<string, string>([["width", "640px"], ["height", "360px"], ["min-width", "200px"]]);
    const removedAttributes: string[] = [];
    const image = {
      tagName: "IMG",
      removeAttribute: (name: string) => removedAttributes.push(name),
      setCssProps: (values: Record<string, string>) => {
        for (const [name, value] of Object.entries(values)) {
          if (value) properties.set(name, value);
          else properties.delete(name);
        }
      },
      setCssStyles: (values: Partial<CSSStyleDeclaration>) => {
        const propertyNames: Record<string, string> = { maxWidth: "max-width", objectFit: "object-fit" };
        for (const [name, value] of Object.entries(values)) properties.set(propertyNames[name] || name, String(value));
      },
    };
    normalizeImageSizing(image as never);
    expect(removedAttributes).toEqual(["width", "height"]);
    expect(Object.fromEntries(properties)).toMatchObject({
      "max-width": "100%",
      width: "auto",
      height: "auto",
      "object-fit": "contain",
    });
    expect(properties.has("min-width")).toBe(false);
  });

  test("normalizes Mermaid SVG sizing while preserving responsive rendering", () => {
    const properties = new Map<string, string>([["width", "1200px"], ["height", "800px"], ["viewBox", "0 0 1200 800"]]);
    const source = { tagName: "SVG", closest: (selector: string) => selector === ".mermaid" ? {} : null };
    const target = {
      setCssProps: (values: Record<string, string>) => {
        for (const [name, value] of Object.entries(values)) {
          if (value) properties.set(name, value);
          else properties.delete(name);
        }
      },
      setCssStyles: (values: Record<string, string>) => {
        for (const [name, value] of Object.entries(values)) properties.set(name, value);
      },
    };
    normalizeMermaidSizing(source as never, target as never);
    expect(Object.fromEntries(properties)).toMatchObject({
      "maxWidth": "100%",
      width: "auto",
      height: "auto",
      viewBox: "0 0 1200 800",
    });
  });
});
