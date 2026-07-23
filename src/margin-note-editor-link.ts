import { EditorView } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { normalizeMarginNoteUrl } from "./margin-note-url-router";

type MarginNoteEditorUrlHandler = (url: string) => void;

type LinkRange = {
  from: number;
  to: number;
  url: string;
};

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function findClosingBracket(text: string, start: number, opening: string, closing: string): number {
  let depth = 0;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    if (isEscaped(text, cursor)) continue;
    if (text[cursor] === opening) depth += 1;
    if (text[cursor] !== closing) continue;
    depth -= 1;
    if (depth === 0) return cursor;
  }
  return -1;
}

function parseInlineLink(text: string, openingBracket: number): LinkRange | null {
  const labelEnd = findClosingBracket(text, openingBracket, "[", "]");
  if (labelEnd < 0) return null;

  let cursor = labelEnd + 1;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  if (text[cursor] !== "(") return null;
  const linkEnd = findClosingBracket(text, cursor, "(", ")");
  if (linkEnd < 0) return null;

  cursor += 1;
  while (cursor < linkEnd && /\s/.test(text[cursor])) cursor += 1;

  let destination = "";
  if (text[cursor] === "<") {
    const destinationEnd = text.indexOf(">", cursor + 1);
    if (destinationEnd < 0 || destinationEnd > linkEnd) return null;
    destination = text.slice(cursor + 1, destinationEnd);
  } else {
    let nestedParentheses = 0;
    const destinationStart = cursor;
    for (; cursor < linkEnd; cursor += 1) {
      if (isEscaped(text, cursor)) continue;
      const character = text[cursor];
      if (/\s/.test(character) && nestedParentheses === 0) break;
      if (character === "(") nestedParentheses += 1;
      if (character === ")") {
        if (nestedParentheses === 0) break;
        nestedParentheses -= 1;
      }
    }
    destination = text.slice(destinationStart, cursor);
  }

  try {
    return { from: openingBracket, to: linkEnd + 1, url: normalizeMarginNoteUrl(destination) };
  } catch {
    return null;
  }
}

function findInlineLinks(text: string): LinkRange[] {
  const links: LinkRange[] = [];
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (text[cursor] !== "[" || isEscaped(text, cursor)) continue;
    const link = parseInlineLink(text, cursor);
    if (!link) continue;
    links.push(link);
    cursor = link.to - 1;
  }
  return links;
}

function findStandaloneLinks(text: string): LinkRange[] {
  const links: LinkRange[] = [];
  const pattern = /marginnote4app:[^\s<>]+/gi;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    let value = match[0];
    while (/[.,;!?]$/.test(value)) value = value.slice(0, -1);
    while (value.endsWith(")") && value.split(")").length > value.split("(").length) value = value.slice(0, -1);
    while (value.endsWith("]") && value.split("]").length > value.split("[").length) value = value.slice(0, -1);
    if (!value) continue;
    try {
      links.push({
        from: match.index,
        to: match.index + value.length,
        url: normalizeMarginNoteUrl(value),
      });
    } catch {
      continue;
    }
  }
  return links;
}

function findMarginNoteUrlAtOffset(text: string, offset: number): string | null {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const inlineLinks = findInlineLinks(text);
  const inline = inlineLinks
    .filter(link => safeOffset >= link.from && safeOffset <= link.to)
    .sort((left, right) => right.from - left.from)[0];
  if (inline) return inline.url;

  const standalone = findStandaloneLinks(text).find(link => {
    const insideInlineLink = inlineLinks.some(inlineLink => link.from >= inlineLink.from && link.to <= inlineLink.to);
    return !insideInlineLink && safeOffset >= link.from && safeOffset <= link.to;
  });
  return standalone?.url || null;
}

function findClickableEditorElement(target: EventTarget | null, contentDOM: HTMLElement): HTMLElement | null {
  const candidate = target as (EventTarget & { closest?: (selector: string) => Element | null }) | null;
  if (typeof candidate?.closest !== "function") return null;
  const element = candidate.closest(".cm-link, .cm-url.external-link") as HTMLElement | null;
  return element && contentDOM.contains(element) ? element : null;
}

function handleMarginNoteEditorClick(
  event: MouseEvent,
  view: Pick<EditorView, "contentDOM" | "posAtDOM" | "state">,
  livePreview: boolean,
  openUrl: MarginNoteEditorUrlHandler,
): boolean {
  if (event.button !== 0) return false;
  if (!livePreview && !event.metaKey && !event.ctrlKey) return false;

  const clickable = findClickableEditorElement(event.target, view.contentDOM);
  if (!clickable) return false;

  const position = view.posAtDOM(clickable);
  const line = view.state.doc.lineAt(position);
  const url = findMarginNoteUrlAtOffset(line.text, position - line.from);
  if (!url) return false;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  openUrl(url);
  return true;
}

function createMarginNoteEditorLinkExtension(openUrl: MarginNoteEditorUrlHandler) {
  return EditorView.domEventHandlers({
    click(event, view) {
      const livePreview = view.state.field(editorLivePreviewField, false) === true;
      return handleMarginNoteEditorClick(event, view, livePreview, openUrl);
    },
  });
}

export { createMarginNoteEditorLinkExtension, findMarginNoteUrlAtOffset, handleMarginNoteEditorClick };
export type { MarginNoteEditorUrlHandler };
