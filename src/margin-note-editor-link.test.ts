import { describe, expect, test, vi } from "vitest";
import { findMarginNoteUrlAtOffset, handleMarginNoteEditorClick } from "./margin-note-editor-link";

function createEditorClickFixture(options: { livePreview: boolean; ctrlKey?: boolean; url?: string }) {
  const link = {} as HTMLElement;
  const target = { closest: vi.fn().mockReturnValue(link) } as unknown as EventTarget;
  const contentDOM = { contains: vi.fn().mockReturnValue(true) } as unknown as HTMLElement;
  const line = `[MarginNote](${options.url ?? "marginnote4app://note/n1"})`;
  const event = {
    button: 0,
    ctrlKey: options.ctrlKey === true,
    metaKey: false,
    target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  } as unknown as MouseEvent;
  const openUrl = vi.fn();
  const view = {
    contentDOM,
    posAtDOM: vi.fn().mockReturnValue(0),
    state: { doc: { lineAt: () => ({ from: 0, text: line }) } },
  } as never;
  return { event, openUrl, view, livePreview: options.livePreview };
}

describe("MarginNote editor links", () => {
  test("resolves a rendered Markdown link from its label offset", () => {
    const line = "> [MarginNote](marginnote4app://note/n1)";
    expect(findMarginNoteUrlAtOffset(line, line.indexOf("["))).toBe("marginnote4app://note/n1");
  });

  test("selects the clicked link when one line contains multiple links", () => {
    const line = "[First](marginnote4app://note/n1) and [Second](marginnote4app://note/n2)";
    expect(findMarginNoteUrlAtOffset(line, line.indexOf("First"))).toBe("marginnote4app://note/n1");
    expect(findMarginNoteUrlAtOffset(line, line.indexOf("Second"))).toBe("marginnote4app://note/n2");
  });

  test("selects the second link when adjacent links share an offset boundary", () => {
    const line = "[First](marginnote4app://note/n1)[Second](marginnote4app://note/n2)";
    expect(findMarginNoteUrlAtOffset(line, line.indexOf("[Second]"))).toBe("marginnote4app://note/n2");
  });

  test("supports nested label brackets and angle-bracket destinations", () => {
    const line = "[Title [nested]](<marginnote4app://note/n1>)";
    expect(findMarginNoteUrlAtOffset(line, line.indexOf("nested"))).toBe("marginnote4app://note/n1");
  });

  test("resolves standalone MarginNote links", () => {
    const line = "Open marginnote4app://note/n1 now";
    expect(findMarginNoteUrlAtOffset(line, line.indexOf("note/n1"))).toBe("marginnote4app://note/n1");
    const wrapped = "Open (marginnote4app://note/n2) now";
    expect(findMarginNoteUrlAtOffset(wrapped, wrapped.indexOf("note/n2"))).toBe("marginnote4app://note/n2");
  });

  test("ignores HTTP links and non-link text", () => {
    const http = "[Site](https://example.com)";
    expect(findMarginNoteUrlAtOffset(http, http.indexOf("Site"))).toBeNull();
    expect(findMarginNoteUrlAtOffset("marginnote4app is only a word", 2)).toBeNull();
  });

  test("handles a live preview click and stops Obsidian from opening it", () => {
    const fixture = createEditorClickFixture({ livePreview: true });

    expect(handleMarginNoteEditorClick(fixture.event, fixture.view, fixture.livePreview, fixture.openUrl)).toBe(true);
    expect(fixture.openUrl).toHaveBeenCalledWith("marginnote4app://note/n1");
    expect(fixture.event.preventDefault).toHaveBeenCalledOnce();
    expect(fixture.event.stopPropagation).toHaveBeenCalledOnce();
    expect(fixture.event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  test("requires Command or Ctrl in source mode", () => {
    const plain = createEditorClickFixture({ livePreview: false });
    expect(handleMarginNoteEditorClick(plain.event, plain.view, plain.livePreview, plain.openUrl)).toBe(false);
    expect(plain.openUrl).not.toHaveBeenCalled();

    const modified = createEditorClickFixture({ livePreview: false, ctrlKey: true });
    expect(handleMarginNoteEditorClick(modified.event, modified.view, modified.livePreview, modified.openUrl)).toBe(true);
    expect(modified.openUrl).toHaveBeenCalledWith("marginnote4app://note/n1");
  });

  test("does not stop ordinary editor links", () => {
    const fixture = createEditorClickFixture({ livePreview: true, url: "https://example.com" });
    expect(handleMarginNoteEditorClick(fixture.event, fixture.view, fixture.livePreview, fixture.openUrl)).toBe(false);
    expect(fixture.event.preventDefault).not.toHaveBeenCalled();
    expect(fixture.openUrl).not.toHaveBeenCalled();
  });
});
