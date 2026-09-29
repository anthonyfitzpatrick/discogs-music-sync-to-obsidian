// The plugin's own view: one Music tab, opened from the disc icon, with the sync panel at the top and
// two tabs below it — the Dashboard and the Library. It replaces the dashboard note (Dataview +
// Charts) and the .base files (Obsidian Bases) of earlier versions, so the plugin needs no other
// plugin and puts nothing but record notes and their images in the vault.
import { ItemView, setIcon } from "obsidian";
import type { App, TFile, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { reportParts } from "./report.ts";
import type { CollectionValue, MusicRecord, ReportOptions, Theme } from "./report.ts";
import { COLUMNS, VIEWS, SORTS, SIZES, DEFAULT_SIZE, libraryGroups, viewOf, sizeOf } from "./library.ts";
import type { ColumnKey } from "./library.ts";
import { field, isNumber } from "./json.ts";
import type { JsonValue } from "./json.ts";

const MUSIC_VIEW = "discogs-music-sync-view";
// View types of 0.11.0, when the dashboard and library were separate: still registered so tabs left
// open in a workspace come back as the Music view on the matching tab.
// The Music view of 0.11.1–0.15 (the plugin's ID was music-library-sync then) reopens on the tab used last.
const OLD_VIEWS = new Map([["music-library-sync-dashboard", "dashboard"], ["music-library-sync-library", "library"], ["music-library-sync-music", ""]]);
type TabKey = "dashboard" | "library";
const TABS: [TabKey, string, string][] = [["dashboard", "Dashboard", "layout-dashboard"], ["library", "Library", "library"]];
const isTab = (v: JsonValue | undefined): v is TabKey => TABS.some(([k]) => k === v);

// The Library's last choices, kept in the plugin's settings.
interface LibraryState { base: string; view: string; size: string; sort: string; search: string }
// What the view needs from the plugin: its settings and the records, figures and panel it provides.
interface MusicHost {
  data: { tab: string; library: LibraryState };
  saveSettings(): void;
  renderPanel(el: HTMLElement): void;
  collectRecords(): Promise<MusicRecord[]>;
  baseNames(): string[];
  collectionValue(): CollectionValue;
  themeForReport(): Theme;
  reportOptions(): ReportOptions;
  markListened(path: string, box: HTMLInputElement): Promise<void>;
  coverFile(record: MusicRecord): TFile | null;
}

// Opens a record note from a click, in reading view: a new tab with Ctrl/Cmd, as Obsidian does for links.
const openNote = (app: App, path: string, event: MouseEvent): Promise<void> =>
  app.workspace.openLinkText(path, "", event.ctrlKey || event.metaKey, { state: { mode: "preview" } });
const openNoteLogged = (app: App, path: string, event: MouseEvent): void => {
  openNote(app, path, event).catch((cause: unknown) => console.error("Discogs music sync: couldn't open the note", cause));
};

// The element a click or change inside a view happened on. Events there always come from its
// elements; Obsidian's instanceOf, unlike instanceof, recognises them in a pop-out window too.
function eventElement(e: Event, selector: string): HTMLElement | null {
  // SAFETY: the view only listens on its own elements, so every event it sees targets a DOM node.
  const node = e.target as Node | null;
  const hit = node?.instanceOf(Element) ? node.closest(selector) : null;
  return hit?.instanceOf(HTMLElement) ? hit : null;
}

// What the view keeps in the workspace: its tab, and how far down it is scrolled.
type MusicViewState = { tab: TabKey; scroll: number };

interface Pane { el: HTMLElement; render(): Promise<void> }

class MusicView extends ItemView {
  plugin: MusicHost;
  type: string;
  tab: TabKey;
  panes: Record<TabKey, Pane> | null = null;
  tabButtons: Partial<Record<TabKey, HTMLElement>> = {};
  pendingScroll: number | undefined;

  constructor(leaf: WorkspaceLeaf, plugin: MusicHost, type = MUSIC_VIEW) {
    super(leaf);
    this.plugin = plugin; this.type = type;
    const wanted = OLD_VIEWS.get(type) || plugin.data.tab;
    this.tab = isTab(wanted) ? wanted : "dashboard";
  }
  getViewType(): string { return this.type; }
  getDisplayText(): string { return "Music"; }
  override getIcon(): string { return "disc-3"; }
  // The tab and how far down it is scrolled, so Back from a record returns to the same place.
  override getState(): MusicViewState { return { tab: this.tab, scroll: this.contentEl.scrollTop }; }
  // The state comes from workspace.json, or from openView: JSON either way.
  override async setState(state: JsonValue | undefined, result: ViewStateResult): Promise<void> {
    const tab = field(state, "tab"), scroll = field(state, "scroll");
    if (isTab(tab) && tab !== this.tab) await this.show(tab);
    if (isNumber(scroll)) { this.pendingScroll = scroll; this.applyScroll(); }
    await super.setState(state, result);
  }
  // A scroll position waiting for its tab to be drawn; applied once the content is tall enough.
  applyScroll(): void {
    if (this.pendingScroll === undefined || !this.panes) return;
    this.contentEl.scrollTop = this.pendingScroll;
    if (this.contentEl.scrollTop >= this.pendingScroll - 1) this.pendingScroll = undefined;
  }

  override async onOpen(): Promise<void> {
    const c = this.contentEl;
    c.empty(); c.addClass("mls-view");
    this.plugin.renderPanel(c.createDiv());
    const bar = c.createDiv({ cls: "mls-tabs", attr: { role: "tablist" } });
    this.tabButtons = {};
    for (const [key, label, icon] of TABS) {
      const b = bar.createEl("button", { cls: "mls-tab", attr: { role: "tab", "aria-controls": `mls-pane-${key}` } });
      setIcon(b.createSpan({ cls: "mls-ic" }), icon); b.createSpan({ text: label });
      this.registerDomEvent(b, "click", () => { void this.show(key); });
      this.tabButtons[key] = b;
    }
    this.panes = {
      dashboard: new DashboardPane(this, c.createDiv({ attr: { id: "mls-pane-dashboard", role: "tabpanel" } })),
      library: new LibraryPane(this, c.createDiv({ cls: "mls-library", attr: { id: "mls-pane-library", role: "tabpanel" } })),
    };
    await this.show(this.tab);
  }

  // Shows a tab and remembers it for next time.
  async show(tab: TabKey): Promise<void> {
    this.tab = tab;
    if (this.plugin.data.tab !== tab) { this.plugin.data.tab = tab; this.plugin.saveSettings(); }
    if (!this.panes) return;                                   // not open yet: onOpen shows it
    for (const [key] of TABS) {
      const on = key === tab;
      this.panes[key].el.toggle(on);
      this.tabButtons[key]?.toggleClass("is-active", on);
      this.tabButtons[key]?.setAttr("aria-selected", String(on));
    }
    await this.render();
  }

  // Redraws the tab on show; the other redraws when it is next shown. The scroll position is kept:
  // a redraw after a note changes must not send the reader back to the top.
  async render(): Promise<void> {
    if (!this.panes) return;
    const top = this.contentEl.scrollTop;
    await this.panes[this.tab].render();
    this.contentEl.scrollTop = top;
    this.applyScroll();
  }
}

class DashboardPane implements Pane {
  view: MusicView; plugin: MusicHost; el: HTMLElement; reportEl: HTMLElement;
  shown: string | undefined;

  constructor(view: MusicView, el: HTMLElement) {
    this.view = view; this.plugin = view.plugin; this.el = el;
    this.reportEl = el.createDiv({ cls: "mls-report" });
    // Album titles open their notes; ticking Listened records it in the note.
    view.registerDomEvent(this.reportEl, "click", (e) => {
      const link = eventElement(e, "a.mls-open");
      if (link?.dataset.path) { e.preventDefault(); openNoteLogged(view.app, link.dataset.path, e); }
    });
    view.registerDomEvent(this.reportEl, "change", (e) => {
      const box = eventElement(e, "input.mls-listen");
      if (box?.instanceOf(HTMLInputElement) && box.checked && box.dataset.path) {
        this.plugin.markListened(box.dataset.path, box).catch((cause: unknown) => console.error("Discogs music sync: couldn't mark the record as listened to", cause));
      }
    });
  }

  async render(): Promise<void> {
    // The report's styles are in styles.css; the theme's colours are drawn into the charts, so a theme
    // change shows as a changed body.
    const { body } = reportParts(await this.plugin.collectRecords(), this.plugin.baseNames(), this.plugin.collectionValue(), this.plugin.themeForReport(), true, this.plugin.reportOptions());
    if (body === this.shown) return;          // nothing on the dashboard changed: leave it be
    this.shown = body;
    // The report is built as markup with every value escaped (report.ts); parsed here into nodes.
    const parsed = new DOMParser().parseFromString(`<div>${body}</div>`, "text/html").body.firstElementChild;
    this.reportEl.empty();
    if (parsed) this.reportEl.append(...Array.from(parsed.childNodes));
  }
}

class LibraryPane implements Pane {
  view: MusicView; plugin: MusicHost; el: HTMLElement;
  baseSelect: HTMLSelectElement; sizeSelect: HTMLSelectElement; countEl: HTMLElement; listEl: HTMLElement;
  shown: string | undefined;

  constructor(view: MusicView, el: HTMLElement) {
    this.view = view; this.plugin = view.plugin; this.el = el;
    const state = this.plugin.data.library;
    if (!viewOf(state.view)) state.view = "gallery";       // a view since removed (Not ripped yet)
    if (!sizeOf(state.size)) state.size = DEFAULT_SIZE;
    const bar = el.createDiv({ cls: "mls-library-bar" });
    const select = (label: string, options: [string, string][], value: string, onChange: (v: string) => void) => {
      const wrap = bar.createEl("label", { cls: "mls-library-field", text: label });
      const s = wrap.createEl("select", { cls: "dropdown" });
      for (const [k, v] of options) s.createEl("option", { value: k, text: v });
      s.value = value;
      view.registerDomEvent(s, "change", () => onChange(s.value));
      return s;
    };
    this.baseSelect = select("Base", [], state.base, (v) => { state.base = v; this.save(); });
    select("View", Object.entries(VIEWS).map(([k, v]) => [k, v.label]), state.view, (v) => { state.view = v; this.save(); });
    // card size, for the views that show cards
    this.sizeSelect = select("Size", Object.entries(SIZES).map(([k, v]) => [k, v.label]), state.size, (v) => { state.size = v; this.save(); });
    select("Sort", [["", "View's own"], ...Object.entries(SORTS).map(([k, v]): [string, string] => [k, v.label])], state.sort, (v) => { state.sort = v; this.save(); });
    const search = bar.createEl("input", { type: "search", cls: "mls-library-search", attr: { placeholder: "Search artist, album, label, genre…", "aria-label": "Search" } });
    search.value = state.search;
    view.registerDomEvent(search, "input", () => { state.search = search.value; this.renderLogged(); });
    this.countEl = bar.createSpan({ cls: "mls-library-count" });
    this.listEl = el.createDiv({ cls: "mls-library-list" });
  }

  save(): void { this.plugin.saveSettings(); this.renderLogged(); }
  renderLogged(): void { this.render().catch((cause: unknown) => console.error("Discogs music sync: couldn't draw the library", cause)); }

  async render(): Promise<void> {
    const state = this.plugin.data.library, names = this.plugin.baseNames();
    // the base list follows the settings; a removed base falls back to all
    if (state.base && !names.includes(state.base)) state.base = "";
    const records = await this.plugin.collectRecords();
    const groups = libraryGroups(records, state.base, state.view, state.search, state.sort);
    // Rebuilding the list resets scrolling, so it is rebuilt only when something shown has changed.
    const shown = JSON.stringify([names, state, groups]);
    if (shown === this.shown) return;
    this.shown = shown;
    this.baseSelect.empty();
    for (const [k, v] of [["", "All bases"], ...names.map((n) => [n, n])]) this.baseSelect.createEl("option", { value: k, text: v });
    this.baseSelect.value = state.base;

    const total = new Set(groups.flatMap((g) => g.records.map((r) => r.path))).size;
    this.countEl.setText(`${total} record${total === 1 ? "" : "s"}`);
    this.listEl.empty();
    if (!names.length) { this.listEl.createEl("p", { cls: "mls-library-empty", text: "No records yet. Sync from Discogs: it creates a base for each format in your collection." }); return; }
    if (!total) { this.listEl.createEl("p", { cls: "mls-library-empty", text: "No records match." }); return; }
    const view = viewOf(state.view) ?? VIEWS.gallery;
    this.sizeSelect.parentElement?.toggle(!!view?.cards);
    for (const g of groups) {
      if (g.name) this.listEl.createEl("h3", { cls: "mls-library-group", text: `${g.name} (${g.records.length})` });
      if (view?.cards) this.cards(this.listEl.createDiv({ cls: `mls-library-cards is-${state.size}` }), g.records, sizeOf(state.size)?.text ?? true);
      else this.table(this.listEl, g.records, view?.columns ?? []);
    }
  }

  cards(el: HTMLElement, records: MusicRecord[], withText: boolean): void {
    for (const r of records) {
      const name = `${r.artist} – ${r.title}${r.year ? ` (${r.year})` : ""}`;
      const card = el.createEl("a", { cls: "mls-card", attr: { href: "#", "aria-label": name, title: name } });
      const img = this.plugin.coverFile(r);
      if (img) card.createEl("img", { attr: { src: this.view.app.vault.getResourcePath(img), alt: "", loading: "lazy" } });
      else setIcon(card.createDiv({ cls: "mls-card-nocover" }), "disc-3");
      if (withText) {
        card.createDiv({ cls: "mls-card-title", text: r.title });
        card.createDiv({ cls: "mls-card-sub", text: [r.artist, r.year].filter(Boolean).join(" · ") });
      }
      this.view.registerDomEvent(card, "click", (e) => { e.preventDefault(); openNoteLogged(this.view.app, r.path, e); });
    }
  }

  table(el: HTMLElement, records: MusicRecord[], columns: ColumnKey[]): void {
    const t = el.createEl("table", { cls: "mls-library-table" });
    const head = t.createEl("thead").createEl("tr");
    for (const k of columns) head.createEl("th", { text: COLUMNS[k].label, cls: "num" in COLUMNS[k] ? "num" : "" });
    const body = t.createEl("tbody");
    for (const r of records) {
      const tr = body.createEl("tr");
      for (const k of columns) {
        const td = tr.createEl("td", { cls: "num" in COLUMNS[k] ? "num" : "" });
        if (k === "title") {
          const a = td.createEl("a", { text: r.title, attr: { href: "#" } });
          this.view.registerDomEvent(a, "click", (e) => { e.preventDefault(); openNoteLogged(this.view.app, r.path, e); });
        } else td.setText(COLUMNS[k].get(r));
      }
    }
  }
}

export type { MusicHost, LibraryState };
export { MusicView, MUSIC_VIEW, OLD_VIEWS, openNote };
