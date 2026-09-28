// The plugin's own views: the Music Dashboard and the Music Library. They replace the dashboard note
// (Dataview + Charts) and the .base files (Obsidian Bases) of earlier versions, so the plugin needs
// no other plugin and puts nothing but record notes and their images in the vault.
const { ItemView, setIcon } = require("obsidian");
const { reportParts } = require("./report.js");
const { COLUMNS, VIEWS, SORTS, libraryGroups } = require("./library.js");

const DASHBOARD_VIEW = "music-library-sync-dashboard";
const LIBRARY_VIEW = "music-library-sync-library";

// Opens a record note from a click: a new tab with Ctrl/Cmd, as Obsidian does for links.
const openNote = (app, path, event) => app.workspace.openLinkText(path, "", event.ctrlKey || event.metaKey);

class DashboardView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return DASHBOARD_VIEW; }
  getDisplayText() { return "Music Dashboard"; }
  getIcon() { return "disc-3"; }

  async onOpen() {
    const c = this.contentEl;
    c.empty(); c.addClass("mls-view");
    this.plugin.renderPanel(c.createDiv());
    this.styleEl = c.createEl("style");
    this.reportEl = c.createDiv({ cls: "mls-report" });
    // Album titles open their notes; ticking Listened records it in the note.
    this.registerDomEvent(this.reportEl, "click", (e) => {
      const link = e.target.closest?.("a.mls-open");
      if (link) { e.preventDefault(); openNote(this.app, link.dataset.path, e); }
    });
    this.registerDomEvent(this.reportEl, "change", (e) => {
      const box = e.target.closest?.("input.mls-listen");
      if (box?.checked) this.plugin.markListened(box.dataset.path, box);
    });
    await this.render();
  }

  async render() {
    if (!this.reportEl) return;
    const theme = { ...this.plugin.themeForReport(), font: "inherit" };
    const { body, css } = reportParts(await this.plugin.collectRecords(), this.plugin.baseNames(), this.plugin.collectionValue(), theme, true);
    this.styleEl.setText(css);
    // The report is built as markup with every value escaped (report.js); parsed here into nodes.
    const parsed = new DOMParser().parseFromString(`<div>${body}</div>`, "text/html").body.firstElementChild;
    this.reportEl.empty();
    this.reportEl.append(...parsed.childNodes);
  }
}

class LibraryView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return LIBRARY_VIEW; }
  getDisplayText() { return "Music Library"; }
  getIcon() { return "library"; }

  async onOpen() {
    const c = this.contentEl, state = this.plugin.data.library;
    c.empty(); c.addClass("mls-view", "mls-library");
    const bar = c.createDiv({ cls: "mls-library-bar" });
    const select = (label, options, value, onChange) => {
      const wrap = bar.createEl("label", { cls: "mls-library-field", text: label });
      const el = wrap.createEl("select", { cls: "dropdown" });
      for (const [k, v] of options) el.createEl("option", { value: k, text: v });
      el.value = value;
      this.registerDomEvent(el, "change", () => onChange(el.value));
      return el;
    };
    this.baseSelect = select("Base", [], state.base, (v) => { state.base = v; this.save(); });
    select("View", Object.entries(VIEWS).map(([k, v]) => [k, v.label]), state.view, (v) => { state.view = v; this.save(); });
    select("Sort", [["", "View's own"], ...Object.entries(SORTS).map(([k, v]) => [k, v.label])], state.sort, (v) => { state.sort = v; this.save(); });
    const search = bar.createEl("input", { type: "search", cls: "mls-library-search", attr: { placeholder: "Search artist, album, label, genre…", "aria-label": "Search" } });
    search.value = state.search;
    this.registerDomEvent(search, "input", () => { state.search = search.value; this.render(); });
    this.countEl = bar.createSpan({ cls: "mls-library-count" });
    this.listEl = c.createDiv({ cls: "mls-library-list" });
    await this.render();
  }

  save() { this.plugin.saveData(this.plugin.data); this.render(); }

  async render() {
    if (!this.listEl) return;
    const state = this.plugin.data.library, names = this.plugin.baseNames();
    // the base list follows the settings; a removed base falls back to all
    if (state.base && !names.includes(state.base)) state.base = "";
    this.baseSelect.empty();
    for (const [k, v] of [["", "All bases"], ...names.map((n) => [n, n])]) this.baseSelect.createEl("option", { value: k, text: v });
    this.baseSelect.value = state.base;

    const records = await this.plugin.collectRecords();
    const groups = libraryGroups(records, state.base, state.view, state.search, state.sort);
    const total = new Set(groups.flatMap((g) => g.records.map((r) => r.path))).size;
    this.countEl.setText(`${total} record${total === 1 ? "" : "s"}`);
    this.listEl.empty();
    if (!names.length) { this.listEl.createEl("p", { cls: "mls-library-empty", text: "No bases yet. Add one in Settings → Discogs music sync and dashboard, then run Sync from Discogs." }); return; }
    if (!total) { this.listEl.createEl("p", { cls: "mls-library-empty", text: "No records match." }); return; }
    const view = VIEWS[state.view] || VIEWS.gallery;
    for (const g of groups) {
      if (g.name) this.listEl.createEl("h3", { cls: "mls-library-group", text: `${g.name} (${g.records.length})` });
      if (view.cards) this.cards(this.listEl.createDiv({ cls: "mls-library-cards" }), g.records);
      else this.table(this.listEl, g.records, view.columns);
    }
  }

  cards(el, records) {
    for (const r of records) {
      const card = el.createEl("a", { cls: "mls-card", attr: { href: "#", "aria-label": `${r.artist} – ${r.title}` } });
      const img = this.plugin.coverFile(r);
      if (img) card.createEl("img", { attr: { src: this.app.vault.getResourcePath(img), alt: "", loading: "lazy" } });
      else setIcon(card.createDiv({ cls: "mls-card-nocover" }), "disc-3");
      card.createDiv({ cls: "mls-card-title", text: r.title });
      card.createDiv({ cls: "mls-card-sub", text: [r.artist, r.year].filter(Boolean).join(" · ") });
      this.registerDomEvent(card, "click", (e) => { e.preventDefault(); openNote(this.app, r.path, e); });
    }
  }

  table(el, records, columns) {
    const t = el.createEl("table", { cls: "mls-library-table" });
    const head = t.createEl("thead").createEl("tr");
    for (const k of columns) head.createEl("th", { text: COLUMNS[k].label, cls: COLUMNS[k].num ? "num" : "" });
    const body = t.createEl("tbody");
    for (const r of records) {
      const tr = body.createEl("tr");
      for (const k of columns) {
        const td = tr.createEl("td", { cls: COLUMNS[k].num ? "num" : "" });
        if (k === "title") {
          const a = td.createEl("a", { text: r.title, attr: { href: "#" } });
          this.registerDomEvent(a, "click", (e) => { e.preventDefault(); openNote(this.app, r.path, e); });
        } else td.setText(COLUMNS[k].get(r));
      }
    }
  }
}

module.exports = { DashboardView, LibraryView, DASHBOARD_VIEW, LIBRARY_VIEW };
