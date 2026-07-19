import { beforeAll, describe, expect, test, vi } from "vitest";
import { MarkdownView, TFile } from "obsidian";
import { CARD_DRAG_MIME, CardDropService, formatInsertion, parseCardDrag, serializeCardDrag, serializeCardDragText } from "./card-drop-service";

class TestElement {
  isEditorContent = true;
  isMetadata = false;
  closest(selector: string) {
    if (selector === ".cm-content") return this.isEditorContent ? this : null;
    if (selector.includes(".metadata-container")) return this.isMetadata ? this : null;
    return null;
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, "HTMLElement", { value: TestElement, configurable: true });
});

function createEditor(line = "prefix suffix") {
  const target = new TestElement();
  const editor = {
    cm: {
      contentDOM: { contains: (value: unknown) => value === target },
      posAtCoords: vi.fn().mockReturnValue(7),
    },
    getLine: vi.fn().mockReturnValue(line),
    offsetToPos: vi.fn((offset: number) => ({ line: 0, ch: offset })),
    replaceRange: vi.fn(),
    setCursor: vi.fn(),
    focus: vi.fn(),
  };
  return { editor, target };
}

function createEvent(target: TestElement, payload = serializeCardDrag("card-1")) {
  return {
    defaultPrevented: false,
    target,
    clientX: 120,
    clientY: 240,
    dataTransfer: { getData: (type: string) => type === CARD_DRAG_MIME ? payload : "" },
    preventDefault: vi.fn(),
  };
}

describe("CardDropService", () => {
  test("serializes and validates card drag payloads", () => {
    expect(parseCardDrag(serializeCardDrag("card-1"))).toBe("card-1");
    expect(serializeCardDragText("card-1")).toBe("ostracon-mn-card:card-1");
    expect(parseCardDrag(JSON.stringify({ cardId: 1 }))).toBe("");
  });

  test("accepts card dragover only on the Markdown content surface", () => {
    const host = { app: {}, fetchCards: vi.fn(), processBase64InContent: vi.fn(), logLine: vi.fn() };
    const service = new CardDropService(host as never);
    const target = new TestElement();
    const event = {
      target,
      dataTransfer: { types: [CARD_DRAG_MIME, "text/plain"], dropEffect: "none" },
      preventDefault: vi.fn(),
    };

    expect(service.handleDragOver(event as never)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.dataTransfer.dropEffect).toBe("copy");

    target.isEditorContent = false;
    expect(service.handleDragOver(event as never)).toBe(false);
  });

  test("inserts localized Markdown at the pointer position", async () => {
    const fetchCards = vi.fn().mockResolvedValue("## Card\n\nBody");
    const processBase64InContent = vi.fn().mockResolvedValue("## Card\n\nBody");
    const host = { app: {}, fetchCards, processBase64InContent, logLine: vi.fn() };
    const service = new CardDropService(host as never);
    const { editor, target } = createEditor();
    const event = createEvent(target);
    const file = Object.assign(new TFile(), { path: "Notes/Target.md", extension: "md" });
    const view = Object.assign(new MarkdownView(null as never), { file, getMode: () => "source" });

    expect(service.shouldHandleDrop(event as never, editor as never, view)).toBe(true);
    event.preventDefault();
    await expect(service.handleDrop(event as never, editor as never, view)).resolves.toBe(true);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(editor.cm.posAtCoords).toHaveBeenCalledWith({ x: 120, y: 240 });
    expect(fetchCards).toHaveBeenCalledWith(["card-1"], "markdown");
    expect(processBase64InContent).toHaveBeenCalledWith("## Card\n\nBody", "Notes/Target.md");
    expect(editor.replaceRange).toHaveBeenCalledWith("\n\n## Card\n\nBody\n\n", { line: 0, ch: 7 }, undefined, "ostracon-card-drop");
  });

  test("accepts the MarkdownFileInfo context emitted by the live editor", async () => {
    const host = {
      app: {},
      fetchCards: vi.fn().mockResolvedValue("## Card"),
      processBase64InContent: vi.fn().mockResolvedValue("## Card"),
      logLine: vi.fn(),
    };
    const service = new CardDropService(host as never);
    const { editor, target } = createEditor("");
    const event = createEvent(target);
    const info = { file: Object.assign(new TFile(), { path: "Target.md", extension: "md" }), editor };

    expect(service.shouldHandleDrop(event as never, editor as never, info as never)).toBe(true);
    event.preventDefault();
    await expect(service.handleDrop(event as never, editor as never, info as never)).resolves.toBe(true);
    expect(editor.replaceRange).toHaveBeenCalledWith("## Card", { line: 0, ch: 7 }, undefined, "ostracon-card-drop");
  });

  test("ignores drops outside the Markdown content surface", async () => {
    const host = { app: {}, fetchCards: vi.fn(), processBase64InContent: vi.fn(), logLine: vi.fn() };
    const service = new CardDropService(host as never);
    const { editor, target } = createEditor();
    target.isEditorContent = false;
    const event = createEvent(target);
    const view = Object.assign(new MarkdownView(null as never), { file: Object.assign(new TFile(), { path: "Target.md" }) });

    expect(service.shouldHandleDrop(event as never, editor as never, view)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(host.fetchCards).not.toHaveBeenCalled();
  });

  test("ignores drops on the properties editor", async () => {
    const host = { app: {}, fetchCards: vi.fn(), processBase64InContent: vi.fn(), logLine: vi.fn() };
    const service = new CardDropService(host as never);
    const { editor, target } = createEditor();
    target.isMetadata = true;
    const event = createEvent(target);
    const view = Object.assign(new MarkdownView(null as never), { file: Object.assign(new TFile(), { path: "Target.md" }) });

    expect(service.shouldHandleDrop(event as never, editor as never, view)).toBe(false);
    expect(host.fetchCards).not.toHaveBeenCalled();
  });
});

test("formatInsertion preserves a clean block at empty-line drops", () => {
  const editor = { getLine: () => "" };
  expect(formatInsertion(editor as never, { line: 0, ch: 0 }, "\n## Card\n")).toBe("## Card");
});
