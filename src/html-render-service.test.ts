import { describe, expect, test } from "vitest";
import { normalizeImageSizing, normalizePlainText, preservesIntrinsicGeometry } from "./html-render-service";

function computed(values: Record<string, string>) {
  return { getPropertyValue: (property: string) => values[property] || "" };
}

describe("Obsidian HTML snapshot", () => {
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
      style: {
        removeProperty: (name: string) => properties.delete(name),
        setProperty: (name: string, value: string, priority: string) => properties.set(name, `${value}!${priority}`),
      },
    };
    normalizeImageSizing(image as never);
    expect(removedAttributes).toEqual(["width", "height"]);
    expect(Object.fromEntries(properties)).toMatchObject({
      "max-width": "100%!important",
      width: "auto!important",
      height: "auto!important",
      "object-fit": "contain!important",
    });
    expect(properties.has("min-width")).toBe(false);
  });
});
