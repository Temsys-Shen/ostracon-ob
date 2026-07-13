import { describe, expect, test, vi } from "vitest";
import { containsHandwritingSvgDataURL, processBase64InMarkdown } from "./image-service";

function createApp() {
  const files = new Map<string, unknown>();
  const vault = {
    getConfig: vi.fn().mockReturnValue("./assets"),
    getAbstractFileByPath: vi.fn((path: string) => files.get(path) || null),
    createFolder: vi.fn(async (path: string) => { files.set(path, { path }); }),
    createBinary: vi.fn(async (path: string, data: ArrayBuffer) => { files.set(path, { path, data }); }),
  };
  return { app: { vault } as never, vault };
}

describe("processBase64InMarkdown", () => {
  test("writes handwriting SVG data URLs into the note attachment folder", async () => {
    const { app, vault } = createApp();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 L 1 1"/></svg>';
    const base64 = Buffer.from(svg).toString("base64");
    const markdown = `![handwriting](data:image/svg+xml;base64,${base64})`;

    expect(containsHandwritingSvgDataURL(markdown)).toBe(true);
    expect(containsHandwritingSvgDataURL(`![image](data:image/svg+xml;base64,${base64})`)).toBe(false);

    const result = await processBase64InMarkdown(app, "Marginnote/卡片.md", markdown);

    expect(vault.createFolder).toHaveBeenCalledWith("Marginnote/assets");
    expect(vault.createBinary).toHaveBeenCalledOnce();
    const [filePath, data] = vault.createBinary.mock.calls[0];
    expect(filePath).toMatch(/^Marginnote\/assets\/handwriting-[a-f0-9]{32}\.svg$/);
    expect(Buffer.from(data as ArrayBuffer).toString("utf8")).toBe(svg);
    expect(result).toBe(`![handwriting](assets/${String(filePath).split("/").at(-1)})`);
    expect(result).not.toContain("data:image/svg+xml;base64,");
  });
});
