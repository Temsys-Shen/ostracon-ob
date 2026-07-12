import { beforeEach, describe, expect, test, vi } from "vitest";
import { TFile } from "obsidian";
import { DEFAULT_QUOTE_TEMPLATE } from "./quote-template";

const mocks = vi.hoisted(() => ({
  processBase64InMarkdown: vi.fn(async (_app: unknown, _path: string, markdown: string) => markdown),
}));
vi.mock("./image-service", () => ({ processBase64InMarkdown: mocks.processBase64InMarkdown }));

import { QuoteService } from "./quote-service";

function markdownFile(path: string) {
  return Object.assign(new TFile(), { path, extension: "md" });
}

function createHost() {
  const file = markdownFile("Notes/Current.md");
  const editor = { replaceSelection: vi.fn() };
  const bridge = { requestClientCommand: vi.fn() };
  const vault = {
    getAbstractFileByPath: vi.fn(),
    process: vi.fn(async (_file: TFile, transform: (content: string) => string) => transform("existing")),
  };
  const workspace: {
    activeEditor: { file: ReturnType<typeof markdownFile>; editor: typeof editor } | null;
    getActiveFile: ReturnType<typeof vi.fn>;
  } = {
    activeEditor: { file, editor },
    getActiveFile: vi.fn(() => file),
  };
  const app = { workspace, vault };
  return {
    host: {
      app,
      settings: { quoteTemplate: DEFAULT_QUOTE_TEMPLATE, createQuoteCard: true },
      bridge,
    } as never,
    file,
    editor,
    bridge,
    vault,
    workspace,
    app,
  };
}

describe("QuoteService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processBase64InMarkdown.mockImplementation(async (_app, _path, markdown) => markdown);
  });

  test("validates the cursor target before requesting MN selection", async () => {
    const fixture = createHost();
    fixture.workspace.activeEditor = null;
    const service = new QuoteService(fixture.host);
    await expect(service.insert({ target: "cursor" }, true)).resolves.toBeNull();
    expect(fixture.bridge.requestClientCommand).not.toHaveBeenCalled();
  });

  test("replaces the editor selection at the cursor target", async () => {
    const fixture = createHost();
    fixture.bridge.requestClientCommand.mockResolvedValue({
      kind: "text", text: "quote", image: null, noteId: "n1", link: "marginnote4app://note/n1",
    });
    const service = new QuoteService(fixture.host);
    await expect(service.insert({ target: "cursor" })).resolves.toEqual({ ok: true, filePath: fixture.file.path });
    expect(fixture.editor.replaceSelection).toHaveBeenCalledWith("> quote\n>\n> [MarginNote](marginnote4app://note/n1)");
    expect(fixture.bridge.requestClientCommand).toHaveBeenCalledWith("getQuoteSelection", { createCard: true }, 30000);
  });

  test("silently stops when MN has no selection", async () => {
    const fixture = createHost();
    fixture.bridge.requestClientCommand.mockResolvedValue(null);
    const service = new QuoteService(fixture.host);
    await expect(service.insert({ target: "cursor" })).resolves.toBeNull();
    expect(fixture.editor.replaceSelection).not.toHaveBeenCalled();
  });

  test("appends to the active markdown file with a paragraph boundary", async () => {
    const fixture = createHost();
    fixture.bridge.requestClientCommand.mockResolvedValue({ kind: "text", text: "quote", image: null, noteId: null, link: null });
    const service = new QuoteService(fixture.host);
    await service.insert({ target: "active-file" });
    const transform = fixture.vault.process.mock.calls[0][1];
    expect(transform("existing")).toBe("existing\n\n> quote\n");
  });

  test("uses an explicitly selected markdown file", async () => {
    const fixture = createHost();
    const selected = markdownFile("Research/Selected.md");
    fixture.vault.getAbstractFileByPath.mockReturnValue(selected);
    fixture.bridge.requestClientCommand.mockResolvedValue({ kind: "text", text: "quote", image: null, noteId: null, link: null });
    const service = new QuoteService(fixture.host);
    await expect(service.insert({ target: "file", filePath: selected.path })).resolves.toEqual({ ok: true, filePath: selected.path });
    expect(fixture.vault.process).toHaveBeenCalledWith(selected, expect.any(Function));
  });

  test("converts image data before writing", async () => {
    const fixture = createHost();
    fixture.bridge.requestClientCommand.mockResolvedValue({
      kind: "image", text: null, image: { mime: "image/png", base64: "aW1hZ2U=" }, noteId: null, link: null,
    });
    mocks.processBase64InMarkdown.mockResolvedValue("> ![MarginNote引文](assets/image.png)\n");
    const service = new QuoteService(fixture.host);
    await service.insert({ target: "cursor" });
    expect(mocks.processBase64InMarkdown).toHaveBeenCalledWith(
      fixture.app,
      fixture.file.path,
      "> ![MarginNote引文](data:image/png;base64,aW1hZ2U=)\n",
    );
    expect(fixture.editor.replaceSelection).toHaveBeenCalledWith("> ![MarginNote引文](assets/image.png)\n");
  });
});
