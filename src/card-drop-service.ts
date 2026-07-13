import { Notice, TFile, type App, type Editor, type EditorPosition, type MarkdownFileInfo, type MarkdownView } from "obsidian";
import type { EditorView } from "@codemirror/view";

const CARD_DRAG_MIME = "application/x-ostracon-mn-card";
const CARD_DRAG_TEXT_PREFIX = "ostracon-mn-card:";

type CardDropHost = {
  app: App;
  fetchCards: (cardIds: string[], format: string) => Promise<string>;
  processBase64InContent: (content: string, targetPath: string) => Promise<string>;
  logLine: (level: string, message: string) => void;
};

type EditorWithCodeMirror = Editor & { cm?: EditorView };

function serializeCardDrag(cardId: string): string {
  return JSON.stringify({ cardId });
}

function serializeCardDragText(cardId: string): string {
  return `${CARD_DRAG_TEXT_PREFIX}${cardId}`;
}

function parseCardDrag(value: string): string {
  if (!value) return "";
  const payload = JSON.parse(value) as { cardId?: unknown };
  return typeof payload.cardId === "string" ? payload.cardId.trim() : "";
}

function isMarkdownFile(file: unknown): file is TFile {
  return file instanceof TFile && file.extension.toLowerCase() === "md";
}

function formatInsertion(editor: Editor, position: EditorPosition, markdown: string): string {
  const content = markdown.trim();
  if (!content) return "";
  const line = editor.getLine(position.line);
  const before = line.slice(0, position.ch);
  const after = line.slice(position.ch);
  const prefix = before.trim() ? "\n\n" : "";
  const suffix = after.trim() ? "\n\n" : "";
  return prefix + content + suffix;
}

class CardDropService {
  private host: CardDropHost;

  constructor(host: CardDropHost) {
    this.host = host;
  }

  handleDragOver(event: DragEvent): boolean {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes(CARD_DRAG_MIME)) return false;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.closest(".cm-content")) return false;
    if (target.closest(".inline-title, .metadata-container, .metadata-properties, .metadata-property")) return false;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    return true;
  }

  async handleDrop(event: DragEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo): Promise<boolean> {
    if (event.defaultPrevented || !event.dataTransfer) return false;
    const rawPayload = event.dataTransfer.getData(CARD_DRAG_MIME);
    if (!rawPayload) return false;

    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.closest(".cm-content")) return false;
    if (target.closest(".inline-title, .metadata-container, .metadata-properties, .metadata-property")) return false;
    if (!isMarkdownFile(info.file)) return false;

    const codeMirror = (editor as EditorWithCodeMirror).cm;
    if (!codeMirror || !codeMirror.contentDOM.contains(target)) return false;
    const offset = codeMirror.posAtCoords({ x: event.clientX, y: event.clientY });
    if (offset === null) return false;

    let cardId: string;
    try {
      cardId = parseCardDrag(rawPayload);
    } catch (error) {
      this.host.logLine("error", `卡片拖拽数据无效: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!cardId) return false;

    event.preventDefault();
    try {
      const markdown = await this.host.fetchCards([cardId], "markdown");
      const localized = await this.host.processBase64InContent(markdown, info.file.path);
      const position = editor.offsetToPos(offset);
      const insertion = formatInsertion(editor, position, localized);
      if (!insertion) throw new Error("MN卡片内容为空");
      editor.replaceRange(insertion, position, undefined, "ostracon-card-drop");
      editor.setCursor(editor.offsetToPos(offset + insertion.length));
      editor.focus();
      new Notice("已插入MN卡片");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.host.logLine("error", `拖拽插入MN卡片失败: ${message}`);
      new Notice(`插入失败: ${message}`);
      return false;
    }
  }
}

export { CARD_DRAG_MIME, CardDropService, formatInsertion, parseCardDrag, serializeCardDrag, serializeCardDragText };
export type { CardDropHost };
