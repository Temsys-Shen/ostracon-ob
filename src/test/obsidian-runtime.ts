class TFile { extension = "md"; path = ""; }
class MarkdownView { file: TFile | null = null; getMode() { return "source"; } }
class Notice { constructor(_message: string) {} }
class Component { load() {} unload() {} }
class MarkdownRenderer {
  static async render(_app: unknown, markdown: string, container: HTMLElement, sourcePath: string) {
    container.innerHTML = `<article data-source-path="${sourcePath}">${markdown}</article>`;
  }
}

async function finishRenderMath(): Promise<void> {}

function getAllTags(cache: { tagsRaw?: string[] }) {
  return cache.tagsRaw || [];
}

function normalizePath(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

export { Component, MarkdownRenderer, MarkdownView, Notice, TFile, finishRenderMath, getAllTags, normalizePath };
