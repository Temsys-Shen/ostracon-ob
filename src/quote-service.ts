import { MarkdownView, TFile, normalizePath, type App, type Editor } from "obsidian";
import { processBase64InMarkdown } from "./image-service";
import { renderQuoteTemplate } from "./quote-template";
import type { QuoteInsertRequest, QuoteInsertResult, QuoteSelection, QuoteTargetContext } from "./contract";

type QuoteServiceHost = {
  app: App;
  settings: { quoteTemplate: string; createQuoteCard: boolean };
  bridge: { requestClientCommand: (command: string, payload?: unknown, timeoutMs?: number) => Promise<unknown> };
};

type ResolvedTarget = {
  file: TFile;
  editor: Editor | null;
};

function isMarkdownFile(value: unknown): value is TFile {
  return value instanceof TFile && value.extension.toLowerCase() === "md";
}

function normalizeQuoteSelection(value: unknown): QuoteSelection | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("MN返回的引文格式不正确");
  const selection = value as QuoteSelection;
  const link = selection.link === null ? null : String(selection.link || "");
  const noteId = selection.noteId === null ? null : String(selection.noteId || "");

  if (selection.kind === "text" && typeof selection.text === "string" && selection.image === null) {
    return { kind: "text", text: selection.text, image: null, noteId, link };
  }
  if (
    selection.kind === "image" && selection.text === null && selection.image &&
    selection.image.mime === "image/png" && typeof selection.image.base64 === "string" && selection.image.base64
  ) {
    return { kind: "image", text: null, image: { mime: "image/png", base64: selection.image.base64 }, noteId, link };
  }
  throw new Error("MN返回的引文格式不正确");
}

class QuoteService {
  private host: QuoteServiceHost;

  constructor(host: QuoteServiceHost) {
    this.host = host;
  }

  private focusedCursorTarget(): ResolvedTarget | null {
    const activeEditor = this.host.app.workspace.activeEditor;
    const view = this.host.app.workspace.getActiveViewOfType(MarkdownView);
    const activeElement = document.activeElement;
    if (
      !activeEditor?.editor || !view || view.getMode() !== "source" ||
      activeEditor.editor !== view.editor || !isMarkdownFile(view.file) ||
      !activeElement || !view.contentEl.contains(activeElement)
    ) {
      return null;
    }
    return { file: view.file, editor: view.editor };
  }

  getContext(): QuoteTargetContext {
    const cursorTarget = this.focusedCursorTarget();
    const activeFile = this.host.app.workspace.getActiveFile();
    return {
      cursor: {
        available: Boolean(cursorTarget),
        filePath: cursorTarget ? cursorTarget.file.path : null,
      },
      activeFile: {
        available: isMarkdownFile(activeFile),
        filePath: isMarkdownFile(activeFile) ? activeFile.path : null,
      },
    };
  }

  private resolveTarget(request: QuoteInsertRequest): ResolvedTarget | null {
    if (request.target === "cursor") {
      return this.focusedCursorTarget();
    }

    if (request.target === "active-file") {
      const activeFile = this.host.app.workspace.getActiveFile();
      return isMarkdownFile(activeFile) ? { file: activeFile, editor: null } : null;
    }

    if (request.target === "file") {
      const path = normalizePath(String(request.filePath || ""));
      const file = this.host.app.vault.getAbstractFileByPath(path);
      return isMarkdownFile(file) ? { file, editor: null } : null;
    }

    throw new Error(`不支持的引文目标: ${String((request as { target?: unknown }).target || "")}`);
  }

  private async requestSelection(): Promise<QuoteSelection | null> {
    const payload = await this.host.bridge.requestClientCommand(
      "getQuoteSelection",
      { createCard: this.host.settings.createQuoteCard },
      30000,
    );
    return normalizeQuoteSelection(payload);
  }

  private async renderSelection(selection: QuoteSelection, filePath: string): Promise<string> {
    const content = selection.kind === "text"
      ? selection.text
      : `![MarginNote引文](data:${selection.image.mime};base64,${selection.image.base64})`;
    const rendered = renderQuoteTemplate(this.host.settings.quoteTemplate, { content, link: selection.link });
    return processBase64InMarkdown(this.host.app, filePath, rendered);
  }

  async insert(request: QuoteInsertRequest, silentUnavailable = false): Promise<QuoteInsertResult | null> {
    const target = this.resolveTarget(request);
    if (!target) {
      if (silentUnavailable) return null;
      throw new Error(request.target === "cursor" ? "当前没有可用光标" : "当前没有可用Markdown文件");
    }

    const selection = await this.requestSelection();
    if (!selection) return null;
    const markdown = await this.renderSelection(selection, target.file.path);

    if (target.editor) {
      target.editor.replaceSelection(markdown);
    } else {
      await this.host.app.vault.process(target.file, current => {
        if (!current) return markdown;
        if (current.endsWith("\n\n")) return current + markdown;
        if (current.endsWith("\n")) return current + "\n" + markdown;
        return current + "\n\n" + markdown;
      });
    }

    return { ok: true, filePath: target.file.path };
  }
}

export { QuoteService, normalizeQuoteSelection };
export type { QuoteServiceHost };
