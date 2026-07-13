class TFile {}
class MarkdownView {}

function getAllTags(cache: { tagsRaw?: string[] }) {
  return cache.tagsRaw || [];
}

function normalizePath(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

export { MarkdownView, TFile, getAllTags, normalizePath };
