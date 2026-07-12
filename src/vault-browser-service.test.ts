import { describe, expect, test } from "vitest";

import { TFile } from "obsidian";
import { VaultBrowserService } from "./vault-browser-service";

function position(content: string, token: string) {
  const start = content.indexOf(token);
  return { start: { offset: start }, end: { offset: start + token.length } };
}

describe("VaultBrowserService", () => {
  test("lists folders and rewrites vault links from metadata positions", async () => {
    const content = "---\ntitle: Demo\n---\n![[pic.png]]\n[[Other]]";
    const file = Object.assign(new TFile(), { path: "Folder/Test.md", name: "Test.md", basename: "Test", extension: "md", parent: { path: "Folder" }, stat: { mtime: 2, size: content.length } });
    const image = Object.assign(new TFile(), { path: "Assets/pic.png", name: "pic.png", basename: "pic", extension: "png", stat: { mtime: 1, size: 100 } });
    const other = Object.assign(new TFile(), { path: "Other.md", name: "Other.md", basename: "Other", extension: "md", parent: { path: "/" }, stat: { mtime: 1, size: 10 } });
    const cache = {
      frontmatter: { title: "Demo" },
      frontmatterPosition: { start: { offset: 0 }, end: { offset: content.indexOf("![[") } },
      embeds: [{ link: "pic.png", displayText: "pic", position: position(content, "![[pic.png]]") }],
      links: [{ link: "Other", displayText: "Other", position: position(content, "[[Other]]") }],
      headings: [], tagsRaw: ["#demo"],
    };
    const app = {
      vault: {
        getName: () => "Vault",
        getMarkdownFiles: () => [file, other],
        getAbstractFileByPath: (path: string) => ({ "Folder/Test.md": file, "Assets/pic.png": image, "Other.md": other } as Record<string, unknown>)[path],
        cachedRead: async () => content,
        readBinary: async () => new ArrayBuffer(0),
      },
      metadataCache: {
        getFileCache: (target: unknown) => target === file ? cache : { headings: [], tagsRaw: [] },
        getFirstLinkpathDest: (link: string) => link === "pic.png" ? image : other,
        resolvedLinks: { "Folder/Test.md": { "Other.md": 1 } },
        unresolvedLinks: {},
      },
    };
    const service = new VaultBrowserService(app as never, () => {});
    const root = service.listFolder("");
    expect(root.folders).toEqual([{ path: "Folder", name: "Folder" }]);
    const detail = await service.getDocument("Folder/Test.md");
    expect(detail.title).toBe("Demo");
    expect(detail.markdown).not.toContain("title: Demo");
    expect(detail.markdown).toContain("ostracon-asset://Assets%2Fpic.png");
    expect(detail.markdown).toContain("ostracon-doc://Other.md");
  });
});
