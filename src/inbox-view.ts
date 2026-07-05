import { ItemView, Notice, WorkspaceLeaf, Modal, SuggestModal, App, TFile, Menu } from "obsidian";
import { VIEW_TYPE_INBOX, type OstraconCardSummary, type OstraconNotebookSummary, type OstraconPacketRecord } from "./contract";

type Tab = "notebook" | "tag" | "color";

type OstraconPluginLike = {
  state: { selectedPacketId: string };
  getPacketRecords: () => OstraconPacketRecord[];
  getSelectedPacket: () => OstraconPacketRecord | null;
  getClientCount: () => number;
  isServerRunning: () => boolean;
  openSettings: () => void;
  listMnNotebooks: () => Promise<OstraconNotebookSummary[]>;
  listMnCards: (notebookId: string) => Promise<OstraconCardSummary[]>;
  fetchMnCards: (cardIds: string[], format: string) => Promise<OstraconPacketRecord>;
  getCardsContent: (cardIds: string[], format: string) => Promise<string>;
};

const MN_COLOR_HEX = ["#FFFFAA", "#BEFFBE", "#ADD2FF", "#FFAABE", "#FFFF00", "#00FF00", "#00BEFF", "#FF0000", "#FF8000", "#008040", "#003EB3", "#CF1B11", "#FFFFFF", "#DADADA", "#B4B4B4", "#C39DE0"];
const MN_COLOR_NAMES = ["淡黄", "淡绿", "淡蓝", "淡粉", "黄色", "绿色", "青色", "红色", "橙色", "深绿", "深蓝", "深红", "白色", "浅灰", "中灰", "紫色"];

class OstraconInboxView extends ItemView {
  plugin: OstraconPluginLike;
  activeTab: Tab = "notebook";
  cards: OstraconCardSummary[] = [];
  notebooks: OstraconNotebookSummary[] = [];
  notebookCards: Map<string, OstraconCardSummary[]> = new Map();
  selectedCardIds: Set<string> = new Set();
  searchQuery = "";
  loading = false;
  backgroundLoading = false;
  errorText = "";
  connCheckTimer: ReturnType<typeof setInterval> | null = null;
  isConnected = false;

  constructor(leaf: WorkspaceLeaf, plugin: OstraconPluginLike) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_INBOX; }
  getDisplayText(): string { return "MN 卡片"; }
  getIcon(): string { return "inbox"; }

  async onOpen(): Promise<void> {
    this.render();
    this.connCheckTimer = setInterval(() => this.checkConnection(), 2000);
  }

  async onClose(): Promise<void> {
    if (this.connCheckTimer) clearInterval(this.connCheckTimer);
    this.contentEl.empty();
  }

  checkConnection(): void {
    const connected = this.plugin.isServerRunning() && this.plugin.getClientCount() > 0;
    if (connected !== this.isConnected) {
      this.isConnected = connected;
      this.render();
      if (connected) this.fetchCards();
    }
  }

  render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ostracon-view");

    if (!this.plugin.isServerRunning() || this.plugin.getClientCount() === 0) {
      this.renderDisconnected();
      return;
    }

    this.renderStatus();
    this.renderTabs();
    this.renderCardArea();
    this.renderActionBar();
  }

  /* ── Status ── */

  renderStatus(): void {
    const { contentEl } = this;
    const row = contentEl.createDiv({ cls: "ostracon-status-row" });
    row.createSpan({ cls: "ostracon-status-dot on" });
    row.createSpan({ cls: "ostracon-status-label", text: "MN 在线" });
    const btn = row.createEl("button", { cls: "ostracon-settings-btn", text: "设置" });
    btn.addEventListener("click", () => this.plugin.openSettings());
  }

  /* ── Tabs ── */

  renderTabs(): void {
    const { contentEl } = this;
    const bar = contentEl.createDiv({ cls: "ostracon-tabs" });
    const items: { id: Tab; label: string }[] = [
      { id: "notebook", label: "按笔记本" },
      { id: "tag", label: "按标签" },
      { id: "color", label: "按颜色" },
    ];
    for (const item of items) {
      const btn = bar.createEl("button", {
        cls: `ostracon-tab${this.activeTab === item.id ? " is-active" : ""}`,
        text: item.label,
      });
      btn.addEventListener("click", () => {
        this.activeTab = item.id;
        this.render();
      });
    }
  }

  /* ── Card area ── */

  renderCardArea(): void {
    const { contentEl } = this;
    const area = contentEl.createDiv({ cls: "ostracon-card-area" });

    if (this.loading) {
      area.createSpan({ cls: "ostracon-loading", text: "读取中..." });
      return;
    }

    if (this.errorText) {
      area.createSpan({ cls: "ostracon-error", text: this.errorText });
    }

    const displayCards = this.getFilteredCards();

    if (displayCards.length === 0) {
      area.createSpan({
        cls: "ostracon-hint",
        text: this.searchQuery ? "没有匹配的卡片" : this.loading ? "读取中..." : "当前笔记本没有卡片",
      });
      return;
    }

    if (this.activeTab === "notebook") {
      this.renderNotebookView(area, displayCards);
    } else if (this.activeTab === "tag") {
      this.renderGrouped(area, displayCards, "tag");
    } else if (this.activeTab === "color") {
      this.renderGrouped(area, displayCards, "color");
    }
  }

  renderNotebookView(container: HTMLElement, displayCards: OstraconCardSummary[]): void {
    const allCardIds = new Set(displayCards.map((c) => c.id));

    for (const nb of this.notebooks) {
      const nbCards = (this.notebookCards.get(nb.id) || []).filter((c) => allCardIds.has(c.id));
      if (nbCards.length === 0) continue;

      const g = container.createDiv({ cls: "ostracon-card-group" });
      g.createDiv({ cls: "ostracon-group-head", text: `${nb.title}（${nb.cardCount}）` });
      const list = g.createDiv({ cls: "ostracon-card-list" });
      for (const card of nbCards) {
        this.renderCardItem(list, card);
      }
    }

    if (this.backgroundLoading) {
      container.createSpan({ cls: "ostracon-loading", text: "正在加载其他笔记本..." });
    }
  }

  renderGrouped(container: HTMLElement, cards: OstraconCardSummary[], by: "tag" | "color"): void {
    const groups = by === "tag" ? this.groupByTag(cards) : this.groupByColor(cards);
    for (const group of groups) {
      const g = container.createDiv({ cls: "ostracon-card-group" });
      g.createDiv({ cls: "ostracon-group-head", text: group.label });
      const list = g.createDiv({ cls: "ostracon-card-list" });
      for (const card of group.cards) {
        this.renderCardItem(list, card);
      }
    }
  }

  renderCardItem(container: HTMLElement, card: OstraconCardSummary): void {
    const item = container.createDiv({
      cls: `ostracon-card-item${this.selectedCardIds.has(card.id) ? " is-checked" : ""}`,
    });

    const cb = item.createEl("input", { type: "checkbox" });
    cb.checked = this.selectedCardIds.has(card.id);
    cb.addEventListener("change", () => {
      if (cb.checked) this.selectedCardIds.add(card.id);
      else this.selectedCardIds.delete(card.id);
      this.render();
    });

    const dot = item.createSpan({ cls: "ostracon-card-dot" });
    if (card.colorIndex !== undefined) {
      dot.style.background = MN_COLOR_HEX[card.colorIndex % MN_COLOR_HEX.length];
    }

    item.createSpan({ cls: "ostracon-card-title", text: card.title || "(无标题)" });

    item.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      new CardDetailModal(this.app, card, () => this.doImport([card.id])).open();
    });

    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((i) =>
        i.setTitle("导入此卡片").onClick(() => this.doImport([card.id]))
      );
      menu.addItem((i) =>
        i.setTitle("选中/取消选中").onClick(() => {
          this.selectedCardIds.has(card.id)
            ? this.selectedCardIds.delete(card.id)
            : this.selectedCardIds.add(card.id);
          this.render();
        })
      );
      if (this.selectedCardIds.size > 0) {
        menu.addItem((i) =>
          i.setTitle(`导入所有选中 (${this.selectedCardIds.size})`).onClick(() => this.doImport(Array.from(this.selectedCardIds)))
        );
      }
      menu.showAtPosition({ x: e.clientX, y: e.clientY });
    });
  }

  /* ── Action bar ── */

  renderActionBar(): void {
    const { contentEl } = this;
    const bar = contentEl.createDiv({ cls: "ostracon-action-bar" });
    bar.createSpan({ cls: "ostracon-count", text: `已选中 ${this.selectedCardIds.size} 张` });

    const searchInput = bar.createEl("input", {
      cls: "ostracon-search-inline",
      type: "search",
      placeholder: "搜索标题/摘录...",
      value: this.searchQuery,
    });
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      this.render();
    });

    const btn = bar.createEl("button", {
      cls: "ostracon-import-btn",
      text: "导入到笔记",
    });
    btn.disabled = this.selectedCardIds.size === 0;
    btn.addEventListener("click", () => this.doImport(Array.from(this.selectedCardIds)));
  }

  /* ── Disconnected ── */

  renderDisconnected(): void {
    const { contentEl } = this;
    const el = contentEl.createDiv({ cls: "ostracon-disconnected" });
    el.createEl("strong", { text: "未连接 MarginNote" });
    el.createEl("span", { text: "打开 MarginNote 中的 Ostracon 面板完成连接" });
    const btn = el.createEl("button", { text: "打开设置", cls: "ostracon-empty-btn" });
    btn.addEventListener("click", () => this.plugin.openSettings());
  }

  /* ── Data ── */

  async fetchCards(): Promise<void> {
    this.loading = true;
    this.errorText = "";
    this.notebookCards.clear();
    this.cards = [];
    this.render();
    try {
      this.notebooks = await this.plugin.listMnNotebooks();

      const currentNb = this.notebooks.find((n) => n.selected) || this.notebooks[0];
      if (!currentNb) { this.loading = false; this.render(); return; }

      const currentCards = await this.plugin.listMnCards(currentNb.id);
      this.notebookCards.set(currentNb.id, currentCards);
      this.cards = [...currentCards];
      this.loading = false;
      this.render();

      const remaining = this.notebooks.filter((n) => n.id !== currentNb.id);
      if (remaining.length > 0) {
        this.backgroundLoading = true;
        this.render();
        for (const nb of remaining) {
          try {
            const nbCards = await this.plugin.listMnCards(nb.id);
            this.notebookCards.set(nb.id, nbCards);
            this.cards = [...this.cards, ...nbCards];
            this.render();
          } catch (_) {}
        }
        this.backgroundLoading = false;
        this.render();
      }
    } catch (e) {
      this.errorText = e instanceof Error ? e.message : String(e);
      this.loading = false;
      this.render();
    }
  }

  async doImport(cardIds: string[]): Promise<void> {
    if (cardIds.length === 0) {
      new Notice("请选择要导入的卡片");
      return;
    }

    const targetPath = await this.pickTargetFile();
    if (!targetPath) return;

    this.loading = true;
    this.render();
    try {
      const content = await this.plugin.getCardsContent(cardIds, "markdown");
      const folder = targetPath.split("/").slice(0, -1).join("/");
      if (folder) await this.ensureFolder(folder);

      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      if (existing instanceof TFile) {
        await this.app.vault.process(existing, (prev) => prev + "\n\n---\n\n" + content);
      } else {
        await this.app.vault.create(targetPath, content);
      }

      new Notice(`已导入 ${cardIds.length} 张卡片到 ${targetPath}`);
      this.selectedCardIds.clear();
    } catch (e) {
      new Notice(`导入失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  pickTargetFile(): Promise<string | null> {
    const app = this.app;
    return new Promise((resolve) => {
      const modal = new (class extends SuggestModal<string> {
        constructor() {
          super(app);
          this.setPlaceholder("选择目标笔记，或输入新路径创建...");
          this.limit = 20;
        }
        getSuggestions(query: string): string[] {
          const q = query.toLowerCase();
          const files = app.vault.getMarkdownFiles();
          const matches = files.filter((f: TFile) => f.path.toLowerCase().includes(q)).map((f: TFile) => f.path);
          if (query && !matches.includes(query)) {
            matches.unshift(`📄 ${query.endsWith(".md") ? query : query + ".md"}`);
          }
          return matches;
        }
        renderSuggestion(path: string, el: HTMLElement): void {
          el.setText(path);
        }
        onChooseSuggestion(path: string): void {
          resolve(path.replace(/^📄 /, ""));
        }
      })();
      modal.open();
    });
  }

  async ensureFolder(path: string): Promise<void> {
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (const seg of segments) {
      current = current ? `${current}/${seg}` : seg;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  getFilteredCards(): OstraconCardSummary[] {
    if (!this.searchQuery) return this.cards;
    const q = this.searchQuery.toLowerCase();
    return this.cards.filter(
      (c) =>
        (c.title || "").toLowerCase().includes(q) ||
        (c.excerpt || "").toLowerCase().includes(q) ||
        (c.comment || "").toLowerCase().includes(q)
    );
  }

  groupByTag(cards: OstraconCardSummary[]): { label: string; cards: OstraconCardSummary[] }[] {
    const map = new Map<string, OstraconCardSummary[]>();
    for (const c of cards) {
      const key = c.tag || "未分类";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return Array.from(map.entries()).map(([label, items]) => ({ label, cards: items }));
  }

  groupByColor(cards: OstraconCardSummary[]): { label: string; cards: OstraconCardSummary[] }[] {
    const map = new Map<string, OstraconCardSummary[]>();
    for (const c of cards) {
      const key = MN_COLOR_NAMES[c.colorIndex ?? 0] ?? `颜色${c.colorIndex}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return Array.from(map.entries()).map(([label, items]) => ({ label, cards: items }));
  }
}

/* ── Detail Modal ── */

class CardDetailModal extends Modal {
  card: OstraconCardSummary;
  onImport: () => void;

  constructor(app: App, card: OstraconCardSummary, onImport: () => void) {
    super(app);
    this.card = card;
    this.onImport = onImport;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("ostracon-detail-modal");

    contentEl.createEl("h2", { text: this.card.title || "(无标题)" });

    if (this.card.tag || this.card.colorIndex !== undefined) {
      const meta = contentEl.createDiv({ cls: "ostracon-detail-meta" });
      if (this.card.tag) meta.createSpan({ text: `标签: ${this.card.tag}`, cls: "ostracon-detail-tag" });
      if (this.card.colorIndex !== undefined) {
        meta.createSpan({ text: `颜色: ${MN_COLOR_NAMES[this.card.colorIndex % MN_COLOR_NAMES.length]}`, cls: "ostracon-detail-color" });
      }
    }

    if (this.card.excerpt) {
      contentEl.createEl("h3", { text: "摘录" });
      contentEl.createEl("div", { cls: "ostracon-detail-block", text: this.card.excerpt });
    }

    if (this.card.comment) {
      contentEl.createEl("h3", { text: "评论" });
      contentEl.createEl("div", { cls: "ostracon-detail-block", text: this.card.comment });
    }

    if (this.card.sourceAnchor) {
      contentEl.createEl("h3", { text: "来源" });
      const link = contentEl.createEl("a", { text: "在 MarginNote 中打开", href: this.card.sourceAnchor });
      link.target = "_blank";
    }

    const btnRow = contentEl.createDiv({ cls: "ostracon-detail-actions" });
    const btn = btnRow.createEl("button", { cls: "ostracon-import-btn", text: "导入此卡片到笔记" });
    btn.addEventListener("click", () => {
      this.onImport();
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export { OstraconInboxView };
