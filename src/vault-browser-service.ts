import MiniSearch from "minisearch";
import { App, TFile, getAllTags, normalizePath } from "obsidian";
import { ObsidianHtmlRenderService } from "./html-render-service";

type DocumentSummary = {
  path: string;
  name: string;
  title: string;
  folder: string;
  tags: string[];
  mtime: number;
  size: number;
  outgoingCount: number;
  backlinkCount: number;
};

type BrowserChangeHandler = (revision: number) => void;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

function mimeForExtension(extension: string): string {
  const ext = extension.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  return "image/png";
}

function titleForFile(file: TFile, frontmatter: Record<string, unknown> | undefined): string {
  const title = frontmatter && typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";
  return title || file.basename;
}

function stripFrontmatter(content: string, cache: ReturnType<App["metadataCache"]["getFileCache"]>): string {
  const position = cache?.frontmatterPosition;
  if (!position) return content;
  return content.slice(0, position.start.offset) + content.slice(position.end.offset);
}

class VaultBrowserService {
  private app: App;
  private revision = 1;
  private searchIndex: MiniSearch | null = null;
  private searchStatus: "idle" | "building" | "ready" | "error" = "idle";
  private searchError = "";
  private searchBuild: Promise<void> | null = null;
  private onChange: BrowserChangeHandler;
  private htmlRenderer: Pick<ObsidianHtmlRenderService, "render">;
  private invalidateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, onChange: BrowserChangeHandler, htmlRenderer?: Pick<ObsidianHtmlRenderService, "render">) {
    this.app = app;
    this.onChange = onChange;
    this.htmlRenderer = htmlRenderer || new ObsidianHtmlRenderService(app);
  }

  invalidate(): void {
    if (this.invalidateTimer) clearTimeout(this.invalidateTimer);
    this.invalidateTimer = setTimeout(() => {
      this.invalidateTimer = null;
      this.applyInvalidation();
    }, 100);
  }

  private applyInvalidation(): void {
    this.revision += 1;
    this.searchIndex = null;
    this.searchStatus = "idle";
    this.searchError = "";
    this.searchBuild = null;
    this.onChange(this.revision);
  }

  getState() {
    return {
      vaultName: this.app.vault.getName(),
      documentCount: this.app.vault.getMarkdownFiles().length,
      revision: this.revision,
      searchStatus: this.searchStatus,
      searchError: this.searchError,
    };
  }

  private backlinksFor(path: string): string[] {
    const result: string[] = [];
    const links = this.app.metadataCache.resolvedLinks;
    for (const source of Object.keys(links)) {
      if (links[source]?.[path]) result.push(source);
    }
    return result.sort();
  }

  private summarize(file: TFile): DocumentSummary {
    const cache = this.app.metadataCache.getFileCache(file);
    const tags = getAllTags(cache || {}) || [];
    const outgoing = Object.keys(this.app.metadataCache.resolvedLinks[file.path] || {});
    return {
      path: file.path,
      name: file.name,
      title: titleForFile(file, cache?.frontmatter as Record<string, unknown> | undefined),
      folder: file.parent?.path === "/" ? "" : file.parent?.path || "",
      tags,
      mtime: file.stat.mtime,
      size: file.stat.size,
      outgoingCount: outgoing.length,
      backlinkCount: this.backlinksFor(file.path).length,
    };
  }

  listFolder(folderPath = "") {
    const normalized = folderPath ? normalizePath(folderPath) : "";
    const prefix = normalized ? normalized + "/" : "";
    const folders = new Set<string>();
    const documents: DocumentSummary[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(prefix)) continue;
      const rest = file.path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash >= 0) folders.add(prefix + rest.slice(0, slash));
      else documents.push(this.summarize(file));
    }
    return {
      path: normalized,
      revision: this.revision,
      folders: Array.from(folders).sort().map(path => ({ path, name: path.split("/").pop() || path })),
      documents: documents.sort((a, b) => a.title.localeCompare(b.title)),
    };
  }

  listTags() {
    const counts = new Map<string, number>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const tags = getAllTags(this.app.metadataCache.getFileCache(file) || {}) || [];
      for (const tag of tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return {
      revision: this.revision,
      tags: Array.from(counts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    };
  }

  listDocuments(options: { tag?: string; cursor?: number; limit?: number } = {}) {
    const tag = String(options.tag || "");
    const cursor = Math.max(0, Number(options.cursor || 0));
    const limit = Math.min(100, Math.max(1, Number(options.limit || 100)));
    const all = this.app.vault.getMarkdownFiles()
      .map(file => this.summarize(file))
      .filter(doc => !tag || doc.tags.includes(tag))
      .sort((a, b) => b.mtime - a.mtime);
    return { revision: this.revision, items: all.slice(cursor, cursor + limit), nextCursor: cursor + limit < all.length ? cursor + limit : null, total: all.length };
  }

  async ensureSearchIndex(): Promise<void> {
    if (this.searchStatus === "ready" && this.searchIndex) return;
    if (this.searchBuild) return this.searchBuild;
    this.searchStatus = "building";
    this.searchBuild = (async () => {
      const index = new MiniSearch({ fields: ["title", "path", "tags", "headings", "content"], storeFields: ["path", "title", "tags", "mtime"] });
      const docs = [];
      for (const file of this.app.vault.getMarkdownFiles()) {
        const cache = this.app.metadataCache.getFileCache(file);
        const content = stripFrontmatter(await this.app.vault.cachedRead(file), cache);
        docs.push({
          id: file.path,
          path: file.path,
          title: titleForFile(file, cache?.frontmatter as Record<string, unknown> | undefined),
          tags: (getAllTags(cache || {}) || []).join(" "),
          headings: (cache?.headings || []).map(item => item.heading).join(" "),
          content,
          mtime: file.stat.mtime,
        });
      }
      index.addAll(docs);
      this.searchIndex = index;
      this.searchStatus = "ready";
      this.searchError = "";
    })().catch(error => {
      this.searchStatus = "error";
      this.searchError = error instanceof Error ? error.message : String(error);
      throw error;
    }).finally(() => { this.searchBuild = null; });
    return this.searchBuild;
  }

  async search(query: string, options: { cursor?: number; limit?: number } = {}) {
    const text = String(query || "").trim();
    if (!text) return { revision: this.revision, items: [], nextCursor: null, total: 0 };
    await this.ensureSearchIndex();
    const cursor = Math.max(0, Number(options.cursor || 0));
    const limit = Math.min(100, Math.max(1, Number(options.limit || 100)));
    const results = this.searchIndex!.search(text, { prefix: true, fuzzy: 0.2, combineWith: "AND" });
    const items = results.slice(cursor, cursor + limit).map(result => {
      const file = this.app.vault.getAbstractFileByPath(String(result.path));
      return file instanceof TFile ? { ...this.summarize(file), score: result.score, terms: result.terms } : null;
    }).filter(Boolean);
    return { revision: this.revision, items, nextCursor: cursor + limit < results.length ? cursor + limit : null, total: results.length };
  }

  private rewriteMarkdown(file: TFile, content: string) {
    const cache = this.app.metadataCache.getFileCache(file);
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    const assets: Array<{ path: string; name: string; mime: string; size: number; mtime: number }> = [];
    const occupied = new Set<string>();
    for (const embed of cache?.embeds || []) {
      const target = this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
      if (!(target instanceof TFile)) continue;
      const start = embed.position.start.offset;
      const end = embed.position.end.offset;
      occupied.add(`${start}:${end}`);
      if (IMAGE_EXTENSIONS.has(target.extension.toLowerCase())) {
        if (target.stat.size > 20 * 1024 * 1024) throw new Error(`本地图片超过20MB: ${target.path}`);
        assets.push({ path: target.path, name: target.name, mime: mimeForExtension(target.extension), size: target.stat.size, mtime: target.stat.mtime });
        replacements.push({ start, end, value: `![${embed.displayText || target.basename}](ostracon-asset://${encodeURIComponent(target.path)})` });
      } else {
        replacements.push({ start, end, value: `[${embed.displayText || target.basename}](ostracon-doc://${encodeURIComponent(target.path)})` });
      }
    }
    for (const link of cache?.links || []) {
      const start = link.position.start.offset;
      const end = link.position.end.offset;
      if (occupied.has(`${start}:${end}`)) continue;
      const target = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
      if (target instanceof TFile && target.extension === "md") {
        replacements.push({ start, end, value: `[${link.displayText || target.basename}](ostracon-doc://${encodeURIComponent(target.path)})` });
      }
    }
    const frontmatter = cache?.frontmatterPosition;
    if (frontmatter) {
      replacements.push({ start: frontmatter.start.offset, end: frontmatter.end.offset, value: "" });
    }
    let markdown = content;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      markdown = markdown.slice(0, replacement.start) + replacement.value + markdown.slice(replacement.end);
    }
    return { markdown: markdown.trim(), assets };
  }

  private rewriteImageEmbeds(file: TFile, content: string): string {
    const cache = this.app.metadataCache.getFileCache(file);
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    for (const embed of cache?.embeds || []) {
      const target = this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
      if (!(target instanceof TFile) || !IMAGE_EXTENSIONS.has(target.extension.toLowerCase())) continue;
      replacements.push({
        start: embed.position.start.offset,
        end: embed.position.end.offset,
        value: `![${embed.displayText || target.basename}](ostracon-asset://${encodeURIComponent(target.path)})`,
      });
    }
    let markdown = content;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      markdown = markdown.slice(0, replacement.start) + replacement.value + markdown.slice(replacement.end);
    }
    return markdown;
  }

  async getDocument(path: string) {
    const normalized = normalizePath(String(path || ""));
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile) || file.extension !== "md") throw new Error(`未找到Obsidian文档: ${normalized}`);
    const cache = this.app.metadataCache.getFileCache(file);
    const content = await this.app.vault.cachedRead(file);
    const transformed = this.rewriteMarkdown(file, content);
    const rendered = await this.htmlRenderer.render(this.rewriteImageEmbeds(file, content), file.path);
    const outgoing = Object.keys(this.app.metadataCache.resolvedLinks[file.path] || {});
    return {
      ...this.summarize(file),
      markdown: transformed.markdown,
      ...rendered,
      assets: transformed.assets,
      headings: (cache?.headings || []).map(item => ({ heading: item.heading, level: item.level })),
      outgoing,
      backlinks: this.backlinksFor(file.path),
      unresolved: Object.keys(this.app.metadataCache.unresolvedLinks[file.path] || {}),
      revision: this.revision,
    };
  }

  async getAsset(path: string) {
    const normalized = normalizePath(String(path || ""));
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile) || !IMAGE_EXTENSIONS.has(file.extension.toLowerCase())) throw new Error(`未找到本地图片: ${normalized}`);
    if (file.stat.size > 20 * 1024 * 1024) throw new Error(`本地图片超过20MB: ${normalized}`);
    const data = await this.app.vault.readBinary(file);
    return { path: file.path, mime: mimeForExtension(file.extension), size: file.stat.size, mtime: file.stat.mtime, base64: Buffer.from(data).toString("base64") };
  }
}

export { VaultBrowserService };
