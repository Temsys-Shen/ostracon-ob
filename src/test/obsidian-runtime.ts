class TFile {}

function getAllTags(cache: { tagsRaw?: string[] }) {
  return cache.tagsRaw || [];
}

function normalizePath(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

export { TFile, getAllTags, normalizePath };
