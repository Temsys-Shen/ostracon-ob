class TFile { extension = "md"; path = ""; }
class MarkdownView { file: TFile | null = null; getMode() { return "source"; } }
class Notice { constructor(_message: string) {} }

function getAllTags(cache: { tagsRaw?: string[] }) {
  return cache.tagsRaw || [];
}

function normalizePath(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

export { MarkdownView, Notice, TFile, getAllTags, normalizePath };
