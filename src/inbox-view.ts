import { ItemView, Notice, WorkspaceLeaf, Modal, SuggestModal, App, TFile, Menu, MarkdownRenderer, type Component } from "obsidian";
import { VIEW_TYPE_INBOX, type ViewHost, type OstraconCardSummary, type OstraconNotebookSummary } from "./contract";
import { ensureFolder } from "./vault-utils";

type Tab = "notebook" | "tag" | "color";

const MN_COLOR_HEX = ["#FFFFAA", "#BEFFBE", "#ADD2FF", "#FFAABE", "#FFFF00", "#00FF00", "#00BEFF", "#FF0000", "#FF8000", "#008040", "#003EB3", "#CF1B11", "#FFFFFF", "#DADADA", "#B4B4B4", "#C39DE0"];
const MN_COLOR_NAMES = ["淡黄", "淡绿", "淡蓝", "淡粉", "黄色", "绿色", "青色", "红色", "橙色", "深绿", "深蓝", "深红", "白色", "浅灰", "中灰", "紫色"];

class OstraconInboxView extends ItemView {
  plugin: ViewHost;
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

  collapsedGroups: Set<string> = new Set();
  expandedContentGroups: Set<string> = new Set();
  cardOrder: string[] = [];
  lastClickedIndex = -1;
  isShiftDown = false;
  isMetaDown = false;

  isDragging = false;
  dragStartIndex = -1;
  dragSelectionOccurred = false;

  retryTimer: ReturnType<typeof setInterval> | null = null;
  cardAreaEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ViewHost) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_INBOX; }
  getDisplayText(): string { return "MN 卡片"; }
  getIcon(): string { return "inbox"; }

  async onOpen(): Promise<void> {
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("mouseup", this.onMouseUp);
    this.render();
    this.connCheckTimer = setInterval(() => this.checkConnection(), 2000);
  }

  async onClose(): Promise<void> {
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("mouseup", this.onMouseUp);
    if (this.connCheckTimer) clearInterval(this.connCheckTimer);
    this.clearRetryTimer();
    this.contentEl.empty();
  }

  onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Shift") this.isShiftDown = true;
    if (e.key === "Meta" || e.key === "Control") this.isMetaDown = true;
  };

  onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "Shift") this.isShiftDown = false;
    if (e.key === "Meta" || e.key === "Control") this.isMetaDown = false;
  };

  onMouseUp = (): void => {
    if (this.isDragging) {
      this.isDragging = false;
      if (this.dragSelectionOccurred) {
        this.dragSelectionOccurred = false;
        this.refresh();
      }
    }
  };

  checkConnection(): void {
    const connected = this.plugin.isServerRunning() && this.plugin.getClientCount() > 0;
    if (connected !== this.isConnected) {
      this.isConnected = connected;
      if (!connected) this.clearRetryTimer();
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
    this.cardAreaEl = contentEl.createDiv({ cls: "ostracon-card-area" });
    this.renderActionBar();
    this.updateCardAreaContent();
    this.restoreSearchFocus();
  }

  refresh(): void {
    if (this.cardAreaEl) {
      this.cardAreaEl.empty();
      this.updateCardAreaContent();
    }
    this.updateActionBarState();
    this.restoreSearchFocus();
  }

  startRetryTimer(): void {
    this.clearRetryTimer();
    this.retryTimer = setInterval(() => {
      if (this.plugin.isServerRunning() && this.plugin.getClientCount() > 0) {
        this.fetchCards();
      } else {
        this.clearRetryTimer();
      }
    }, 5000);
  }

  clearRetryTimer(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  doRetry(): void {
    this.clearRetryTimer();
    this.errorText = "";
    this.fetchCards();
  }

  restoreSearchFocus(): void {
    if (this.searchQuery) {
      const input = this.contentEl.querySelector(".ostracon-search-inline") as HTMLInputElement;
      if (input && document.activeElement !== input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  }

  updateActionBarState(): void {
    const countEl = this.contentEl.querySelector(".ostracon-count");
    if (countEl) countEl.textContent = `已选中 ${this.selectedCardIds.size} 张`;
    const btn = this.contentEl.querySelector(".ostracon-import-btn") as HTMLButtonElement;
    if (btn) btn.disabled = this.selectedCardIds.size === 0;
  }

  renderStatus(): void {
    const { contentEl } = this;
    const row = contentEl.createDiv({ cls: "ostracon-status-row" });
    row.createSpan({ cls: "ostracon-status-dot on" });
    row.createSpan({ cls: "ostracon-status-label", text: "MN 在线" });
    const btn = row.createSpan({ cls: "ostracon-settings-btn", text: "设置", attr: { role: "button", tabindex: "0" } });
    btn.addEventListener("click", () => this.plugin.openSettings());
  }

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
        this.expandedContentGroups.clear();
        this.render();
      });
    }
  }

  renderActionBar(): void {
    const bar = this.contentEl.createDiv({ cls: "ostracon-action-bar" });
    bar.createSpan({ cls: "ostracon-count", text: `已选中 ${this.selectedCardIds.size} 张` });

    const searchInput = bar.createEl("input", {
      cls: "ostracon-search-inline",
      type: "search",
      placeholder: "搜索标题/摘录...",
      value: this.searchQuery,
    });
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      this.refresh();
    });

    const btn = bar.createEl("button", {
      cls: "ostracon-import-btn",
      text: "导入到笔记",
    });
    btn.disabled = this.selectedCardIds.size === 0;
    btn.addEventListener("click", () => this.doImport(Array.from(this.selectedCardIds)));
  }

  updateCardAreaContent(): void {
    const area = this.cardAreaEl;
    if (!area) return;

    if (this.loading) {
      area.createSpan({ cls: "ostracon-loading", text: "读取中..." });
      return;
    }

    if (this.errorText) {
      const errEl = area.createDiv({ cls: "ostracon-error" });
      errEl.createSpan({ text: this.errorText });
      const retry = errEl.createEl("button", {
        text: "重新连接",
        cls: "ostracon-empty-btn",
      });
      retry.style.cssText = "margin-top:8px;display:inline-block";
      retry.addEventListener("click", () => this.doRetry());
      return;
    }

    const displayCards = this.getFilteredCards();

    if (displayCards.length === 0) {
      area.createSpan({
        cls: "ostracon-hint",
        text: this.searchQuery ? "没有匹配的卡片" : "当前笔记本没有卡片",
      });
      return;
    }

    let groups: { key: string; label: string; cards: OstraconCardSummary[] }[];

    if (this.activeTab === "notebook") {
      groups = this.buildNotebookGroups(displayCards);
    } else if (this.activeTab === "tag") {
      groups = this.buildTagGroups(displayCards);
    } else {
      groups = this.buildColorGroups(displayCards);
    }

    this.cardOrder = groups.flatMap((g) => g.cards.map((c) => c.id));

    if (this.collapsedGroups.size === 0) {
      for (let i = 1; i < groups.length; i++) this.collapsedGroups.add(groups[i].key);
    }

    for (const group of groups) {
      this.renderGroup(area, group);
    }

    if (this.backgroundLoading) {
      area.createSpan({ cls: "ostracon-loading", text: "正在加载其他笔记本..." });
    }
  }

  buildNotebookGroups(displayCards: OstraconCardSummary[]): { key: string; label: string; cards: OstraconCardSummary[] }[] {
    const allCardIds = new Set(displayCards.map((c) => c.id));
    const groups: { key: string; label: string; cards: OstraconCardSummary[] }[] = [];
    for (const nb of this.notebooks) {
      const nbCards = (this.notebookCards.get(nb.id) || []).filter((c) => allCardIds.has(c.id));
      if (nbCards.length === 0) continue;
      groups.push({ key: `nb:${nb.id}`, label: nb.title, cards: nbCards });
    }
    return groups;
  }

  buildTagGroups(displayCards: OstraconCardSummary[]): { key: string; label: string; cards: OstraconCardSummary[] }[] {
    const map = new Map<string, OstraconCardSummary[]>();
    for (const c of displayCards) {
      const key = c.tag || "未分类";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return Array.from(map.entries()).map(([label, items]) => ({ key: `tag:${label}`, label, cards: items }));
  }

  buildColorGroups(displayCards: OstraconCardSummary[]): { key: string; label: string; cards: OstraconCardSummary[] }[] {
    const map = new Map<string, OstraconCardSummary[]>();
    for (const c of displayCards) {
      const key = MN_COLOR_NAMES[c.colorIndex ?? 0] ?? `颜色${c.colorIndex}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return Array.from(map.entries()).map(([label, items]) => ({ key: `color:${label}`, label, cards: items }));
  }

  renderGroup(container: HTMLElement, group: { key: string; label: string; cards: OstraconCardSummary[] }): void {
    const g = container.createDiv({ cls: "ostracon-card-group" });
    g.dataset.groupKey = group.key;

    if (this.collapsedGroups.has(group.key)) {
      g.addClass("is-collapsed");
    }

    this.renderGroupHead(g, group);

    const list = g.createDiv({ cls: "ostracon-card-list" });
    for (const card of group.cards) {
      this.renderCardItem(list, card, group);
    }
  }

  renderGroupHead(groupEl: HTMLElement, group: { key: string; label: string; cards: OstraconCardSummary[] }): void {
    const head = groupEl.createDiv({ cls: "ostracon-group-head" });

    const allSelected = group.cards.every((c) => this.selectedCardIds.has(c.id));
    const someSelected = group.cards.some((c) => this.selectedCardIds.has(c.id));

    const cb = head.createEl("input", { type: "checkbox" });
    cb.checked = allSelected;
    cb.indeterminate = someSelected && !allSelected;
    cb.addEventListener("change", (e) => {
      e.stopPropagation();
      for (const card of group.cards) {
        if (cb.checked) this.selectedCardIds.add(card.id);
        else this.selectedCardIds.delete(card.id);
      }
      this.refresh();
    });
    cb.addEventListener("click", (e) => e.stopPropagation());

    const isCollapsed = this.collapsedGroups.has(group.key);
    const arrow = head.createSpan({
      cls: "ostracon-collapse-arrow",
      text: isCollapsed ? "▶" : "▼",
    });

    head.createSpan({
      cls: "ostracon-group-label",
      text: `${group.label}（${group.cards.length}）`,
    });

    const isExpanded = this.expandedContentGroups.has(group.key);
    const contentBtn = head.createSpan({
      cls: `ostracon-group-content-btn${isExpanded ? " is-active" : ""}`,
      text: "≡",
      attr: { role: "button", tabindex: "0" },
    });
    contentBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.expandedContentGroups.has(group.key)) {
        this.expandedContentGroups.delete(group.key);
      } else {
        this.expandedContentGroups.add(group.key);
      }
      this.refresh();
    });

    head.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("input, .ostracon-group-content-btn")) return;
      if (this.collapsedGroups.has(group.key)) {
        this.collapsedGroups.delete(group.key);
      } else {
        this.collapsedGroups.add(group.key);
      }
      this.refresh();
    });
  }

  renderCardItem(container: HTMLElement, card: OstraconCardSummary, group: { key: string; cards: OstraconCardSummary[] }): void {
    const isChecked = this.selectedCardIds.has(card.id);
    const item = container.createDiv({
      cls: `ostracon-card-item${isChecked ? " is-checked" : ""}`,
    });
    item.dataset.cardId = card.id;
    item.dataset.groupKey = group.key;

    const cb = item.createEl("input", { type: "checkbox" });
    cb.checked = isChecked;
    cb.addEventListener("change", () => {
      if (cb.checked) this.selectedCardIds.add(card.id);
      else this.selectedCardIds.delete(card.id);
      this.lastClickedIndex = this.getCardOrderIndex(card.id);
      this.refresh();
    });

    const dot = item.createSpan({ cls: "ostracon-card-dot" });
    if (card.colorIndex !== undefined) {
      dot.style.background = MN_COLOR_HEX[card.colorIndex % MN_COLOR_HEX.length];
    }

    item.createSpan({ cls: "ostracon-card-title", text: card.title || "(无标题)" });

    const showExcerpt = this.expandedContentGroups.has(group.key);
    if (showExcerpt && card.excerpt) {
      item.createDiv({
        cls: "ostracon-card-excerpt",
        text: card.excerpt.length > 60 ? card.excerpt.slice(0, 60) + "…" : card.excerpt,
      });
    }

    item.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;

      if (this.isShiftDown) {
        e.preventDefault();
        this.handleShiftClick(card.id);
        return;
      }

      if (this.isMetaDown) {
        e.preventDefault();
        this.handleMetaClick(card.id);
        return;
      }

      this.isDragging = true;
      this.dragSelectionOccurred = false;
      this.dragStartIndex = this.getCardOrderIndex(card.id);
      this.lastClickedIndex = this.dragStartIndex;
    });

    item.addEventListener("mouseenter", () => {
      if (!this.isDragging) return;
      if (this.dragStartIndex < 0) return;

      const currentIdx = this.getCardOrderIndex(card.id);
      if (currentIdx < 0) return;

      if (!this.dragSelectionOccurred) {
        this.dragSelectionOccurred = true;
      }

      this.selectedCardIds.clear();
      this.selectRange(this.dragStartIndex, currentIdx);

      const cardItems = this.cardAreaEl?.querySelectorAll(".ostracon-card-item");
      if (cardItems) {
        for (const el of cardItems) {
          const id = (el as HTMLElement).dataset.cardId;
          if (id) {
            const checked = this.selectedCardIds.has(id);
            (el.querySelector('input[type="checkbox"]') as HTMLInputElement).checked = checked;
            el.toggleClass("is-checked", checked);
          }
        }
      }

      const groupEl = this.cardAreaEl?.querySelector(`.ostracon-card-group[data-group-key="${group.key}"]`);
      if (groupEl) {
        const headCb = groupEl.querySelector(".ostracon-group-head input[type='checkbox']") as HTMLInputElement;
        if (headCb) {
          const cardEls = groupEl.querySelectorAll(".ostracon-card-item");
          let checkedCount = 0;
          for (const el of cardEls) {
            const id = (el as HTMLElement).dataset.cardId;
            if (id && this.selectedCardIds.has(id)) checkedCount++;
          }
          headCb.checked = checkedCount === cardEls.length;
          headCb.indeterminate = checkedCount > 0 && checkedCount < cardEls.length;
        }
      }

      this.updateActionBarState();
    });

    item.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (this.isShiftDown || this.isMetaDown) return;
      if (this.dragSelectionOccurred) return;
      new CardDetailModal(this.app, this, card, () => this.doImport([card.id]), (id) => this.plugin.previewCards([id])).open();
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
          this.lastClickedIndex = this.getCardOrderIndex(card.id);
          this.refresh();
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

  getCardOrderIndex(cardId: string): number {
    return this.cardOrder.indexOf(cardId);
  }

  handleShiftClick(cardId: string): void {
    const currentIdx = this.getCardOrderIndex(cardId);
    if (currentIdx < 0) return;

    if (this.lastClickedIndex >= 0) {
      this.selectRange(this.lastClickedIndex, currentIdx);
    } else {
      this.selectedCardIds.add(cardId);
    }
    this.lastClickedIndex = currentIdx;
    this.refresh();
  }

  handleMetaClick(cardId: string): void {
    if (this.selectedCardIds.has(cardId)) {
      this.selectedCardIds.delete(cardId);
    } else {
      this.selectedCardIds.add(cardId);
    }
    this.lastClickedIndex = this.getCardOrderIndex(cardId);
    this.refresh();
  }

  selectRange(from: number, to: number): void {
    const [start, end] = from <= to ? [from, to] : [to, from];
    for (let i = start; i <= end; i++) {
      if (this.cardOrder[i]) {
        this.selectedCardIds.add(this.cardOrder[i]);
      }
    }
  }

  renderDisconnected(): void {
    const { contentEl } = this;
    const el = contentEl.createDiv({ cls: "ostracon-disconnected" });
    el.createEl("strong", { text: "未连接 MarginNote" });
    el.createEl("span", { text: "打开 MarginNote 中的 Ostracon 面板完成连接" });
    const btn = el.createEl("button", { text: "打开设置", cls: "ostracon-empty-btn" });
    btn.addEventListener("click", () => this.plugin.openSettings());
  }

  async fetchCards(): Promise<void> {
    this.clearRetryTimer();
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
      const currentDeduped = currentCards.filter((c, i, a) => a.findIndex(x => x.id === c.id) === i);
      this.notebookCards.set(currentNb.id, currentDeduped);
      this.cards = [...currentDeduped];
      this.loading = false;
      this.render();

      const remaining = this.notebooks.filter((n) => n.id !== currentNb.id);
      if (remaining.length > 0) {
        this.backgroundLoading = true;
        this.render();
        for (const nb of remaining) {
          try {
            const nbCards = await this.plugin.listMnCards(nb.id);
            const nbDeduped = nbCards.filter((c, i, a) => a.findIndex(x => x.id === c.id) === i);
            this.notebookCards.set(nb.id, nbDeduped);
            this.cards = [...this.cards, ...nbDeduped];
            this.render();
          } catch (e) { console.warn("background notebook load failed", e); }
        }
        this.backgroundLoading = false;
        this.cards = this.cards.filter((c, i, a) => a.findIndex(x => x.id === c.id) === i);
        this.render();
      }
    } catch (e) {
      this.errorText = e instanceof Error ? e.message : String(e);
      this.loading = false;
      this.render();
      this.startRetryTimer();
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
      let content = await this.plugin.fetchCards(cardIds, "markdown");
      content = await this.plugin.processBase64InContent(content, targetPath);
      const folder = targetPath.split("/").slice(0, -1).join("/");
      if (folder) await ensureFolder(this.app, folder);

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
}

class CardDetailModal extends Modal {
  renderComponent: Component;
  card: OstraconCardSummary;
  onImport: () => void;
  previewFn: (cardId: string) => Promise<string>;
  contentLoaded = false;

  constructor(app: App, renderComponent: Component, card: OstraconCardSummary, onImport: () => void, previewFn: (cardId: string) => Promise<string>) {
    super(app);
    this.renderComponent = renderComponent;
    this.card = card;
    this.onImport = onImport;
    this.previewFn = previewFn;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("ostracon-detail-modal");

    this.renderLocalContent();
    this.loadFullContent();
  }

  renderLocalContent(): void {
    const { contentEl } = this;

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

    contentEl.createDiv({ cls: "ostracon-detail-loading", text: "正在加载完整内容…" });

    const btnRow = contentEl.createDiv({ cls: "ostracon-detail-actions" });
    const btn = btnRow.createEl("button", { cls: "ostracon-import-btn", text: "导入此卡片到笔记" });
    btn.addEventListener("click", () => {
      this.onImport();
      this.close();
    });
  }

  async loadFullContent(): Promise<void> {
    let markdown: string;
    try {
      markdown = await Promise.race([
        this.previewFn(this.card.id),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("连接MN超时")), 10000),
        ),
      ]);
    } catch (e) {
      this.showLoadError(e instanceof Error ? e.message : "加载失败");
      return;
    }
    if (!markdown) {
      this.showLoadError("完整内容为空");
      return;
    }
    this.contentLoaded = true;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ostracon-detail-modal");

    contentEl.createEl("h2", { text: this.card.title || "(无标题)" });

    const md = contentEl.createDiv({ cls: "ostracon-detail-markdown" });
    await MarkdownRenderer.render(this.app, markdown, md, "", this.renderComponent);

    const btnRow = contentEl.createDiv({ cls: "ostracon-detail-actions" });
    const btn = btnRow.createEl("button", { cls: "ostracon-import-btn", text: "导入此卡片到笔记" });
    btn.addEventListener("click", () => {
      this.onImport();
      this.close();
    });
  }

  showLoadError(message: string): void {
    const loadingEl = this.contentEl.querySelector(".ostracon-detail-loading");
    if (!loadingEl) return;
    loadingEl.replaceChildren();
    loadingEl.createSpan({ text: `完整内容加载失败: ${message}。` });
    const retry = loadingEl.createEl("a", {
      text: "重试",
      cls: "ostracon-detail-retry",
      attr: { href: "#", style: "cursor:pointer;text-decoration:underline;color:var(--interactive-accent);margin-left:4px" },
    });
    retry.addEventListener("click", (e) => {
      e.preventDefault();
      loadingEl.replaceChildren();
      loadingEl.createSpan({ text: "正在加载完整内容…" });
      this.loadFullContent();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export { OstraconInboxView };
