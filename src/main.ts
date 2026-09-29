/* Discogs music sync and dashboard (plugin ID discogs-music-sync) — Wolf 359 Press.
   Talks to Discogs + Genius with Obsidian's requestUrl and writes notes through the vault (engine.ts),
   shows them in its own Music view (views.ts), and is set up in its settings tab (settings.ts).
   Safety: never overwrites an existing album note (except price fields on "Refresh prices").
   Assumes nothing about the vault: every folder comes from the settings. */
import { FileSystemAdapter, Notice, Plugin, TFile, moment, requestUrl, setIcon } from "obsidian";
import type { TAbstractFile } from "obsidian";
import { tidy, slug, guessIcon, nameProblem, formatCounts, basesNeeded, sameFormat } from "./bases.ts";
import type { Base, HasFormats } from "./bases.ts";
import { DEFAULT_CURRENCY, LEGACY_CURRENCY } from "./currency.ts";
import { decodeCollectionPage, decodeIdentity, decodeProfileCurrency } from "./discogs.ts";
import { isJsonList, isNumber, isText } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { CollectionItem } from "./discogs.ts";
import { Engine, UA, errorText, pause, replyJson, today, vaultFiles } from "./engine.ts";
import type { BasesAdded } from "./engine.ts";
import { ExportModal, LibraryModal } from "./modals.ts";
import type { BaseDraft } from "./modals.ts";
import { decodeRecord, decodeCollectionValue, cssColorToHex, buildReport } from "./report.ts";
import type { CollectionValue, MusicRecord, ReportOptions, Theme } from "./report.ts";
import { MARGIN, defaults, loadSettings, paperSize } from "./settings-data.ts";
import type { PdfSettings, RunMode, Settings } from "./settings-data.ts";
import { MusicSettingTab } from "./settings.ts";
import { VERSION } from "./version.ts";
import { MusicView, MUSIC_VIEW, OLD_VIEWS, openNote } from "./views.ts";
import type { MusicHost } from "./views.ts";

type TokenKind = "discogs" | "genius";
// Files versions before 0.11 kept in the vault, which the plugin no longer uses. Those versions always
// used a folder called Music, so only there. Offered for removal in settings, never removed without
// asking; in any other vault they simply aren't found. (Each base's .base file is added on loading.)
const LEGACY_FILES = ["Music/Music Dashboard.md", "Music/All Media.base", "Music/.discogs-token", "Music/.genius-token",
  "Music/.vinyl-sync/collection-value.json", "Music/.vinyl-sync/last-export.html"];
// Tokens live in Obsidian's secret storage on this device, which the operating system encrypts: never in a
// file, so never in git. (Versions before 0.13 kept them in local storage, under the same names.)
const TOKEN_KEYS: Record<TokenKind, string> = { discogs: "discogs-music-sync-discogs-token", genius: "discogs-music-sync-genius-token" };
// Their names before 0.16, when the plugin's ID was music-library-sync: in the keychain from 0.13, and in
// local storage in 0.11–0.12. Moved to the names above on loading.
const OLD_TOKEN_KEYS: Record<TokenKind, string> = { discogs: "music-library-sync-discogs-token", genius: "music-library-sync-genius-token" };

// The sync panel's progress: a step per base and one for the collection's value.
type StepState = "pending" | "active" | "done" | "error";
interface Step { key: string; label: string; icon: string }
interface RunState {
  running: boolean; mode: RunMode | null; steps: Partial<Record<string, StepState>>; now: string; log: string; progress: number;
  stepList?: Step[]; justDone?: boolean;
}
// One sync panel on screen: in the Music view, or in a note through a music-sync code block.
interface Panel {
  root: HTMLElement; meta: HTMLElement; steps: HTMLElement; bar: HTMLElement; now: HTMLElement; log: HTMLElement;
  sync: HTMLButtonElement; prices: HTMLButtonElement; dash: HTMLButtonElement; pdf: HTMLButtonElement; cancel: HTMLButtonElement;
}

// Obsidian's secret storage can delete a secret, though its published API doesn't say so yet.
interface SecretStore { getSecret(id: string): string | null; setSecret(id: string, secret: string): void; deleteSecret?: (id: string) => void }

// The parts of Electron that PDF export uses, reached through Obsidian's own require.
interface WindowOptions { show: boolean; width: number; height: number; webPreferences: { offscreen: boolean } }
interface PrintOptions {
  pageSize: string; landscape: boolean; printBackground: boolean;
  margins: { top: number; bottom: number; left: number; right: number };
  displayHeaderFooter: boolean; headerTemplate: string; footerTemplate: string;
}
interface PrintWindow {
  loadFile(path: string): Promise<void>;
  webContents: { printToPDF(options: PrintOptions): Promise<Uint8Array> };
  destroy(): void;
}
interface ElectronRemote {
  BrowserWindow: new (options: WindowOptions) => PrintWindow;
  shell?: { openPath(path: string): Promise<string> };
}
declare global { interface Window { require?: (module: string) => object | undefined } }

// Whether a module is Electron's remote module: the print window class is what export needs.
const isElectronRemote = (v: unknown): v is ElectronRemote =>
  typeof v === "object" && v !== null && "BrowserWindow" in v && typeof v.BrowserWindow === "function";

// Electron's remote module, when this is Obsidian's desktop app, or null.
function electronRemote(): ElectronRemote | null {
  const load = (name: string): object | null => { try { return window.require?.(name) ?? null; } catch { return null; } };
  const electron = load("electron");
  const remote = electron && "remote" in electron ? electron.remote : null;
  if (isElectronRemote(remote)) return remote;
  const separate = load("@electron/remote");
  return isElectronRemote(separate) ? separate : null;
}

// The tags a note's frontmatter gives it, lowercase and without #.
const noteTags = (fm: JsonObject): string[] => {
  const tags = isJsonList(fm.tags) ? fm.tags : fm.tags === undefined || fm.tags === null ? [] : [fm.tags];
  return tags.filter((t) => isText(t) || isNumber(t)).map((t) => String(t).replace(/^#/, "").toLowerCase());
};
// What ticking Listened writes into a note's properties.
interface ListenedMark { listened: boolean; listened_on: string }

class MusicLibrarySync extends Plugin implements MusicHost {
  data: Settings = defaults();
  state: RunState = { running: false, mode: null, steps: {}, now: "", log: "", progress: 0 };
  panels = new Set<Panel>();
  cancelled = false;
  updating = false;
  formatCache: { name: string; count: number }[] | null = null;
  redrawTimer = 0;

  override async onload(): Promise<void> {
    // SAFETY: loadData reads data.json with JSON.parse, so it is JSON, or undefined before the first save.
    this.data = loadSettings((await this.loadData()) as JsonValue | undefined);
    await this.importTokenFiles();
    this.state = { running: false, mode: null, steps: {}, now: "", log: "", progress: 0 };
    this.panels = new Set();
    this.registerMarkdownCodeBlockProcessor("music-sync", (_src, el) => this.renderPanel(el));
    this.registerView(MUSIC_VIEW, (leaf) => new MusicView(leaf, this));
    for (const type of OLD_VIEWS.keys()) this.registerView(type, (leaf) => new MusicView(leaf, this, type));
    this.addRibbonIcon("disc-3", "Open music dashboard and library", () => this.openViewLogged());
    this.addCommand({ id: "open-dashboard", name: "Open dashboard", callback: () => this.openViewLogged("dashboard") });
    this.addCommand({ id: "open-library", name: "Open library", callback: () => this.openViewLogged("library") });
    this.addCommand({ id: "sync", name: "Sync from Discogs", callback: () => this.runLogged("sync") });
    this.addCommand({ id: "prices", name: "Refresh prices", callback: () => this.runLogged("prices") });
    this.addCommand({ id: "dashboard", name: "Refresh collection value", callback: () => this.runLogged("dashboard") });
    this.addCommand({ id: "cancel", name: "Cancel running sync", callback: () => { this.cancelled = true; } });
    this.addCommand({ id: "export-pdf", name: "Export dashboard as PDF…", callback: () => new ExportModal(this.app, this).open() });
    this.addCommand({ id: "add-base", name: "Add a base…", callback: () => new LibraryModal(this.app, this, null).open() });
    this.addCommand({ id: "update-record", name: "Update this record from Discogs", checkCallback: (checking) => {
      const file = this.app.workspace.getActiveFile();
      if (!file || !this.baseOfNote(file)) return false;
      if (!checking) void this.updateRecord(file);
      return true;
    } });
    // the same, from a record note's menu (right-click, or the note's ⋯ menu)
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (file instanceof TFile && this.baseOfNote(file)) menu.addItem((i) => i.setTitle("Update from Discogs").setIcon("refresh-cw").onClick(() => void this.updateRecord(file)));
    }));
    this.addSettingTab(new MusicSettingTab(this.app, this));
    this.registerInterval(window.setInterval(() => this.refresh(), 60 * 1000));
    // The views follow the notes: redraw shortly after record notes change, move or go, and on theme changes.
    const soon = () => { window.clearTimeout(this.redrawTimer); this.redrawTimer = window.setTimeout(() => this.redrawViews(), 600); };
    const inMusic = (path: string | undefined) => [this.data.folder, ...this.data.libraries.map((l) => l.dir)].some((d) => (path ?? "").startsWith(`${d}/`));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => { if (inMusic(file.path)) soon(); }));
    this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => { if (inMusic(file.path) || inMusic(oldPath)) soon(); }));
    this.registerEvent(this.app.vault.on("delete", (file) => { if (inMusic(file.path)) soon(); }));
    this.registerEvent(this.app.workspace.on("css-change", soon));
  }

  // Saves the settings; a failure is logged, as there is nothing the user could do about it there and then.
  saveSettings(): void { this.saveData(this.data).catch((cause: unknown) => console.error("Discogs music sync: couldn't save the settings", cause)); }

  /* ---- views ---- */
  // The Music tab, on the given tab ("dashboard" or "library") or the one used last. An open Music tab
  // is brought forward rather than opening another.
  musicLeaves() { return [MUSIC_VIEW, ...OLD_VIEWS.keys()].flatMap((t) => this.app.workspace.getLeavesOfType(t)); }
  async openView(tab?: "dashboard" | "library"): Promise<void> {
    const open = this.musicLeaves()[0];
    if (open) { await this.app.workspace.revealLeaf(open); if (tab && open.view instanceof MusicView) await open.view.show(tab); return; }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: MUSIC_VIEW, active: true, state: { tab: tab || this.data.tab } });
    await this.app.workspace.revealLeaf(leaf);
  }
  openViewLogged(tab?: "dashboard" | "library"): void { this.openView(tab).catch((cause: unknown) => console.error("Discogs music sync: couldn't open the Music view", cause)); }
  redrawViews(): void {
    for (const leaf of this.musicLeaves()) if (leaf.view instanceof MusicView) leaf.view.render().catch((cause: unknown) => console.error(cause));
  }
  baseNames(): string[] { return this.data.libraries.map((l) => l.name); }
  // The currency prices are shown in: the one chosen, else (before the first sync has found the Discogs
  // account's) the default.
  currency(): string { return this.data.currency || DEFAULT_CURRENCY; }
  // What the dashboard and PDF need besides the records: sections on or off, colours, value history, currency.
  reportOptions(): ReportOptions {
    const c = this.data.colours;
    return { sections: this.data.sections, history: this.data.valueHistory, currency: this.currency(),
      colours: { mode: c.mode, accent: c.accent, bases: this.data.libraries.map((l) => c.bases[l.id]) } };
  }
  collectionValue(): CollectionValue {
    const v = this.data.value;
    return decodeCollectionValue(v && { discogs_value_min: v.min, discogs_value_median: v.med, discogs_value_max: v.max, currency: v.currency || LEGACY_CURRENCY });
  }
  // A record's cover image, found the way Obsidian resolves the note's link to it.
  coverFile(record: MusicRecord): TFile | null { return record.cover ? this.app.metadataCache.getFirstLinkpathDest(record.cover, record.path) : null; }
  // Ticking Listened on the dashboard records it in the note's properties.
  async markListened(path: string, box: HTMLInputElement): Promise<void> {
    const f = this.app.vault.getFileByPath(path);
    try {
      if (!f) throw new Error("the note isn't there any more");
      await this.app.fileManager.processFrontMatter(f, (fm: ListenedMark) => { fm.listened = true; fm.listened_on = today(); });
    } catch (e) { box.checked = false; new Notice(`Couldn't mark it as listened to: ${errorText(e)}`); console.error(e); }
  }

  // A note's frontmatter, or undefined when it has none.
  frontmatter(file: TFile): JsonObject | undefined {
    // Obsidian parses frontmatter YAML into plain values: text, numbers, true/false, null, lists and maps.
    return this.app.metadataCache.getFileCache(file)?.frontmatter;
  }

  /* ---- one record ---- */
  // The base a record note belongs to (by its tag), or null for any other file.
  baseOfNote(file: TFile): Base | null {
    const fm = this.frontmatter(file);
    if (!fm?.discogs_id) return null;
    const tags = noteTags(fm);
    return this.data.libraries.find((l) => tags.includes(l.tag.toLowerCase())) ?? null;
  }
  // Brings one record note up to date with Discogs (Engine.updateRecord), leaving what the user wrote.
  async updateRecord(file: TFile): Promise<void> {
    const lib = this.baseOfNote(file), d = this.data;
    if (!lib) { new Notice("Open a record note from one of your bases first"); return; }
    if (this.state.running || this.updating) { new Notice("Music sync is already running"); return; }
    if (!d.username || !this.token("discogs")) { new Notice("Enter your Discogs username and token in settings first", 8000); return; }
    this.updating = true;
    const notice = new Notice(`Updating ${file.basename} from Discogs…`, 0);
    const eng = new Engine(vaultFiles(this.app), () => {}, () => false, { username: d.username, lyrics: d.lyrics, gallery: d.gallery, libraries: [],
      discogsToken: this.token("discogs"), geniusToken: this.token("genius"), folder: d.folder,
      currency: d.currency, rates: d.rates, onCurrency: (c) => { d.currency = c; } });
    try {
      await eng.init();
      const changed = await eng.updateRecord(lib, file.path);
      await this.saveData(d);
      new Notice(changed ? `Updated ${file.basename} from Discogs` : `${file.basename} was already up to date`, 6000);
      this.redrawViews();
    } catch (e) { new Notice(`Couldn't update from Discogs: ${errorText(e)}`, 10000); console.error(e); }
    finally { notice.hide(); this.updating = false; }
  }

  /* ---- libraries ("bases") ---- */
  steps(): Step[] {
    return [...this.data.libraries.map((l) => ({ key: l.id, label: l.name, icon: l.icon })),
      { key: "dashboard", label: "Collection value", icon: "coins" }];
  }
  libraryNames(): string {
    const n = this.data.libraries.map((l) => l.name);
    return n.length < 2 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1] ?? ""}`;
  }
  async save(): Promise<void> { await this.saveData(this.data); this.refresh(); }

  // Why a proposed name (and its formats) can't be used, or "" when it can. `self` is the library
  // being edited, so it doesn't clash with itself. No two bases may share a name, ignoring case and spacing.
  // `adopt` lets a base named after its Discogs format take over an existing folder of that name: after
  // Start again, or a reinstall, the notes are already there and the sync finds them.
  async checkLibrary(v: BaseDraft, self: Base | null = null, adopt = false): Promise<string> {
    const problem = nameProblem(v, this.data.libraries.filter((l) => l !== self), !!self);
    if (problem) return problem;
    const name = tidy(v.name);
    if (!self && !adopt && (await this.app.vault.adapter.exists(`${this.data.folder}/${name}`))) return `${this.data.folder} already has a folder called “${name}”.`;
    return "";
  }

  // Creates the base's folder (or adopts it, see checkLibrary) and starts syncing it.
  async addLibrary(v: BaseDraft, adopt = false): Promise<Base> {
    const err = await this.checkLibrary(v, null, adopt); if (err) throw new Error(err);
    const name = tidy(v.name), s = slug(name);
    let id = s, n = 2; while (this.data.libraries.some((l) => l.id === id)) id = `${s}-${n++}`;
    const lib: Base = { id, name, formats: [...v.formats], dir: `${this.data.folder}/${name}`, tag: `${s}-library`, icon: v.icon || "disc-3" };
    await this.ensureLibraryFiles(lib);
    this.data.libraries.push(lib);
    this.unskip(lib.formats);
    await this.save();
    return lib;
  }

  // Renames the base and updates its formats and icon. Notes aren't moved here; the next sync
  // moves any record whose format now belongs to another base.
  async updateLibrary(lib: Base, v: BaseDraft): Promise<void> {
    const err = await this.checkLibrary(v, lib); if (err) throw new Error(err);
    lib.name = tidy(v.name);
    lib.formats = [...v.formats];
    lib.icon = v.icon || lib.icon;
    this.unskip(lib.formats);
    await this.save();
  }

  // Creates the base's folder if it's missing.
  async ensureLibraryFiles(lib: Base): Promise<void> {
    const vault = this.app.vault;
    if (!vault.getAbstractFileByPath(lib.dir)) await vault.createFolder(lib.dir);
  }

  // Adds a base for each chosen format, named after the format. Returns what was added and
  // what was skipped, with the reason.
  async addFromDiscogs(formats: string[]): Promise<BasesAdded> {
    const added: Base[] = [], skipped: string[] = [];
    for (const f of formats) {
      const v = { name: f, formats: [f], icon: guessIcon(f) };
      const err = await this.checkLibrary(v, null, true);
      if (err) { skipped.push(`${f}: ${err}`); continue; }
      added.push(await this.addLibrary(v, true));
    }
    return { added, skipped };
  }

  // Stops syncing a base. Its folder and notes are left in the vault.
  // Its formats are remembered, so a sync doesn't create the base again.
  async removeLibrary(lib: Base): Promise<void> {
    this.data.libraries = this.data.libraries.filter((l) => l !== lib);
    for (const f of lib.formats) if (!this.data.skippedFormats.some((x) => sameFormat(x, f))) this.data.skippedFormats.push(f);
    await this.save();
  }
  // A format given a base again, by hand, is no longer left out.
  unskip(formats: string[]): void { this.data.skippedFormats = this.data.skippedFormats.filter((x) => !formats.some((f) => sameFormat(f, x))); }

  // During a sync: a base, named after the format, for each format in the collection that no base
  // takes, so a new install needs no setting up. Formats the user stopped syncing are left out.
  async createBasesFor(items: HasFormats[]): Promise<BasesAdded> {
    if (!this.data.autoBases) return { added: [], skipped: [] };
    const { added, skipped } = await this.addFromDiscogs(basesNeeded(items, this.data.libraries, this.data.skippedFormats));
    return { added: structuredClone(added), skipped };
  }

  /* ---- Discogs / Genius helpers for the settings page ---- */
  secrets(): SecretStore { return this.app.secretStorage; }
  token(kind: TokenKind): string { return this.secrets().getSecret(TOKEN_KEYS[kind]) ?? ""; }
  saveToken(kind: TokenKind, value: string): void {
    if (!value.trim()) { this.forgetToken(kind); return; }
    this.secrets().setSecret(TOKEN_KEYS[kind], value.trim()); this.formatCache = null;
  }
  // Removes a secret from this vault's keychain. Obsidian's published API can't delete a secret yet, but
  // its keychain can; where it can't, the secret is emptied, which the plugin reads as no token.
  deleteSecret(id: string): void {
    const store = this.secrets();
    if (store.deleteSecret) store.deleteSecret(id); else store.setSecret(id, "");
  }
  forgetToken(kind: TokenKind): void { this.deleteSecret(TOKEN_KEYS[kind]); this.formatCache = null; }
  // Back to how a new install starts: tokens removed, username, bases and every setting reset. Record notes,
  // covers and PDFs stay in the vault, and the next sync finds them again (bases adopt their old folders).
  async startAgain(): Promise<void> {
    for (const kind of ["discogs", "genius"] as const) this.forgetToken(kind);
    const library = this.data.library;                          // the open Library view holds on to this one
    for (const k of Object.keys(this.data)) Reflect.deleteProperty(this.data, k);
    Object.assign(this.data, defaults());
    this.data.library = Object.assign(library, defaults().library);
    await this.save();
    this.redrawViews();
  }
  // Tokens kept in local storage by 0.11 and 0.12 move to secret storage, and leave local storage. Tokens
  // kept in files by earlier versions are read in once; the files are then offered for removal.
  async importTokenFiles(): Promise<void> {
    for (const kind of ["discogs", "genius"] as const) {
      const key = OLD_TOKEN_KEYS[kind];
      const kept = (this.secrets().getSecret(key) ?? "").trim();                          // 0.13–0.15
      if (kept) {
        if (!this.token(kind)) this.saveToken(kind, kept);
        this.deleteSecret(key);
      }
      // SAFETY: Obsidian keeps local storage as JSON text and hands it back parsed.
      const stored = this.app.loadLocalStorage(key) as JsonValue;                       // 0.11–0.12
      const local = isText(stored) ? stored.trim() : "";
      if (!local) continue;
      if (!this.token(kind)) this.saveToken(kind, local);
      this.app.saveLocalStorage(key, null);
    }
    const files: [TokenKind, string][] = [["discogs", "Music/.discogs-token"], ["genius", "Music/.genius-token"]];   // where versions before 0.11 kept them
    for (const [kind, file] of files) {
      if (this.token(kind) || !(await this.app.vault.adapter.exists(file))) continue;
      const t = (await this.app.vault.adapter.read(file)).trim();
      if (t) this.saveToken(kind, t);
    }
  }
  // Files earlier versions made that are still in the vault.
  async legacyFilesPresent(): Promise<string[]> {
    const out: string[] = [];
    for (const p of new Set([...LEGACY_FILES, ...this.data.legacyFiles])) if (await this.app.vault.adapter.exists(p)) out.push(p);
    return out;
  }
  // Moves them to the trash (recoverable): through Obsidian, which follows the user's choice of system or
  // vault trash, except files in dot-folders or dot-files, which Obsidian doesn't index.
  async trashLegacyFiles(paths: string[]): Promise<void> {
    for (const p of paths) {
      const hidden = p.split("/").some((part) => part.startsWith("."));
      const f = hidden ? null : this.app.vault.getAbstractFileByPath(p);
      if (f) await this.app.fileManager.trashFile(f); else await this.app.vault.adapter.trashSystem(p);
    }
    this.data.legacyFiles = [];
    await this.save();
  }
  async discogsIdentity(): Promise<string> {
    const t = this.token("discogs"); if (!t) throw new Error("No Discogs token saved yet");
    const r = await requestUrl({ url: "https://api.discogs.com/oauth/identity", headers: { Authorization: `Discogs token=${t}`, "User-Agent": UA }, throw: false });
    if (r.status >= 400) throw new Error(r.status === 401 ? "Discogs didn't accept the token" : `Discogs answered ${r.status}`);
    return decodeIdentity(replyJson(r));
  }
  // The currency the Discogs account prices in, or "" when Discogs doesn't say.
  async discogsCurrency(username: string): Promise<string> {
    const r = await requestUrl({ url: `https://api.discogs.com/users/${encodeURIComponent(username)}`, headers: { Authorization: `Discogs token=${this.token("discogs")}`, "User-Agent": UA }, throw: false });
    return r.status < 400 ? decodeProfileCurrency(replyJson(r)) : "";
  }
  async geniusCheck(): Promise<void> {
    const t = this.token("genius"); if (!t) throw new Error("No Genius token saved yet");
    const r = await requestUrl({ url: "https://api.genius.com/search?q=test", headers: { Authorization: `Bearer ${t}` }, throw: false });
    if (r.status >= 400) throw new Error(r.status === 401 ? "Genius didn't accept the token" : `Genius answered ${r.status}`);
  }
  // The formats in the user's Discogs collection, with how many records include each — read from
  // Discogs, so a base's formats are always chosen from real names and never typed.
  async collectionFormats(): Promise<{ name: string; count: number }[]> {
    if (this.formatCache) return this.formatCache;
    const t = this.token("discogs");
    if (!t) throw new Error("No Discogs token saved yet");
    if (!this.data.username) throw new Error("No Discogs username entered yet");
    let items: CollectionItem[] = [], page = 1;
    for (;;) {
      if (page > 1) await pause(1100);                                   // Discogs' rate limit
      const r = await requestUrl({ url: `https://api.discogs.com/users/${encodeURIComponent(this.data.username)}/collection/folders/0/releases?per_page=100&page=${page}`,
        headers: { Authorization: `Discogs token=${t}`, "User-Agent": UA }, throw: false });
      if (r.status === 401) throw new Error("Discogs didn't accept the token");
      if (r.status === 404) throw new Error(`Discogs has no user called “${this.data.username}”`);
      if (r.status >= 400) throw new Error(`Discogs answered ${r.status}`);
      const d = decodeCollectionPage(replyJson(r));
      items = items.concat(d.items);
      if (page >= d.pages) break; page++;
    }
    return (this.formatCache = formatCounts(items));
  }

  // Every record note of every base, decoded for the views and the PDF report. Reads Obsidian's own metadata
  // cache and the notes themselves, so it needs no other plugin.
  async collectRecords(): Promise<MusicRecord[]> {
    const byTag = new Map(this.data.libraries.map((l) => [l.tag.toLowerCase(), l.name]));
    const records: MusicRecord[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.frontmatter(file);
      if (!fm) continue;
      const media = noteTags(fm).map((t) => byTag.get(t)).find(Boolean);
      if (!media) continue;
      records.push(decodeRecord(fm, media, await this.app.vault.cachedRead(file), file.basename, file.path));
    }
    return records;
  }

  // The active theme's colours and font, resolved to values a standalone page can use.
  themeForReport(): Theme {
    const probe = document.body.createDiv({ cls: "mls-theme-probe" });
    const color = (name: string, fallback: string) => { probe.setCssProps({ color: `var(${name}, ${fallback})` }); return cssColorToHex(getComputedStyle(probe).color, fallback); };
    const theme = { fg: color("--text-normal", "#222222"), bg: color("--background-primary", "#ffffff"), muted: color("--text-muted", "#666666"),
      border: color("--background-modifier-border", "#cccccc"), font: getComputedStyle(probe).fontFamily || "sans-serif" };
    probe.remove();
    return theme;
  }

  // Builds the Music Dashboard as its own page from the notes (report.ts) and prints it to PDF with
  // Obsidian's desktop app. The dashboard needn't be open.
  async exportPdf({ size = "A4", orientation = "portrait" }: Partial<PdfSettings> = {}): Promise<void> {
    // Electron is reached through Obsidian's own require, when the export runs, so the plugin loads
    // even where PDF export can't run.
    const remote = electronRemote();
    const adapter = this.app.vault.adapter;
    if (!remote || !(adapter instanceof FileSystemAdapter)) throw new Error("PDF export isn't available in this version of Obsidian. Please report it with “Report a bug” in the plugin's settings.");
    if (!this.data.libraries.length) throw new Error("Add a base first — there's nothing to export yet");
    const notice = new Notice("Preparing PDF…", 0);
    try {
      const value = this.collectionValue();
      const theme = this.themeForReport();
      const stamp = moment().format("D MMMM YYYY, HH:mm");
      // the report's rules are in the plugin's styles.css, which the page embeds
      const css = await adapter.read(`${this.manifest.dir ?? ""}/styles.css`).catch(() => "");
      const html = buildReport(await this.collectRecords(), this.data.libraries.map((l) => l.name), value, theme, stamp, { ...this.reportOptions(), css });
      // The page is written to the plugin's own folder through the vault adapter, so the plugin never
      // touches the file system outside the vault; the print window loads it from there.
      const tmp = `${this.manifest.dir ?? ""}/.export-${Date.now()}.html`;
      await adapter.write(tmp, html);
      const [w, h] = paperSize(size) ?? [8.27, 11.69];
      const printableW = Math.round(((orientation === "landscape" ? h : w) - 2 * MARGIN) * 96);
      const win = new remote.BrowserWindow({ show: false, width: printableW, height: 1200, webPreferences: { offscreen: false } });
      try {
        await win.loadFile(adapter.getFullPath(tmp));
        // the footer is rendered in isolation, without the page's CSS, so it gets the resolved colour
        const footer = `<div style="font-size:8px;width:100%;padding:0 ${MARGIN}in;color:${theme.muted};display:flex;justify-content:space-between;font-family:sans-serif">
          <span>Music Dashboard · ${stamp}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
        const pdf = await win.webContents.printToPDF({
          pageSize: size, landscape: orientation === "landscape", printBackground: true,
          margins: { top: MARGIN, bottom: MARGIN + 0.1, left: MARGIN, right: MARGIN },
          displayHeaderFooter: true, headerTemplate: "<div></div>", footerTemplate: footer,
        });
        const dir = `${this.data.folder}/Exports`;
        const files = vaultFiles(this.app);
        if (!(await files.exists(dir))) await files.mkdir(dir);
        const out = `${dir}/Music Dashboard ${moment().format("YYYY-MM-DD HHmm")} ${size} ${orientation}.pdf`;
        // SAFETY: printToPDF returns a Node Buffer, whose memory is a plain ArrayBuffer, never a shared one.
        await files.writeBinary(out, pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer);
        notice.hide();
        new Notice(`PDF saved: ${out}`, 8000);
        // opened in the computer's PDF viewer; the notice above already gives the path
        remote.shell?.openPath(adapter.getFullPath(out)).catch((cause: unknown) => console.warn("Discogs music sync: couldn't open the PDF viewer", cause));
      } finally { win.destroy(); await adapter.remove(tmp).catch(() => { /* a leftover page in the plugin folder is harmless */ }); }
    } finally { notice.hide(); }
  }

  renderPanel(el: HTMLElement): void {
    const root = el.createDiv({ cls: "mls-panel" });
    const top = root.createDiv({ cls: "mls-top" });
    const badge = top.createDiv({ cls: "mls-badge" }); setIcon(badge, "disc-3");
    const txt = top.createDiv({ cls: "mls-text" });
    const tt = txt.createDiv({ cls: "mls-title", text: "Discogs music sync and dashboard " }); tt.createSpan({ cls: "mls-ver", text: `v${VERSION}` });
    const meta = txt.createDiv({ cls: "mls-meta" });
    const act = root.createDiv({ cls: "mls-actions" });
    const btn = (label: string, ic: string, cls: string, fn: () => void, tip: string) => {
      const b = act.createEl("button", { cls: `mls-btn ${cls}` });
      const s = b.createSpan({ cls: "mls-ic" }); setIcon(s, ic); b.createSpan({ text: label });
      b.setAttr("aria-label", tip); b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
      return b;
    };
    const sync = btn("Sync from Discogs", "refresh-cw", "mls-primary", () => this.runLogged("sync"), `Add new ${this.libraryNames()} records from Discogs`);
    const prices = btn("Refresh prices", "coins", "mls-secondary", () => this.runLogged("prices"), "Update the price fields on every record");
    const dash = btn("Library", "library", "mls-secondary", () => this.openViewLogged("library"), "Browse your records by base, as a gallery or tables");
    const pdf = btn("Export PDF", "file-down", "mls-secondary", () => new ExportModal(this.app, this).open(), "Save the dashboard as a PDF in the paper size you choose");
    const cancel = btn("Cancel", "x-circle", "mls-cancel", () => { this.cancelled = true; }, "Stop after the current record");
    const steps = root.createDiv({ cls: "mls-steps" });
    const barWrap = root.createDiv({ cls: "mls-bar" }), bar = barWrap.createDiv();
    const now = root.createDiv({ cls: "mls-now" });
    const det = root.createEl("details", { cls: "mls-log" });
    det.createEl("summary", { text: "Sync log" }); const log = det.createEl("pre");
    const p: Panel = { root, meta, steps, bar, now, log, sync, prices, dash, pdf, cancel };
    this.panels.add(p); this.paint(p);
  }

  paint(p: Panel): void {
    const s = this.state, last = this.data.last;
    p.root.toggleClass("is-running", s.running);
    p.root.toggleClass("is-done", !!s.justDone && !s.running);
    [p.sync, p.prices, p.dash, p.pdf].forEach((b) => { b.disabled = s.running; });
    p.cancel.toggle(s.running);
    if (s.running) p.meta.setText(s.mode === "sync" ? "Syncing with Discogs…" : s.mode === "prices" ? "Refreshing prices…" : "Refreshing the collection value…");
    else if (last) p.meta.setText(`${last.ok ? "✓" : "⚠"} Last ${last.mode === "sync" ? "sync" : last.mode === "prices" ? "price refresh" : "value refresh"} ${moment(last.at).fromNow()} · ${last.summary}`);
    else p.meta.setText("Nothing synced yet");
    p.steps.empty();
    const all = s.stepList || this.steps();
    const shown = s.mode === "dashboard" ? all.slice(-1) : all;
    if (s.running || Object.keys(s.steps).length) for (const st of shown) {
      const state = s.steps[st.key] || "pending";
      const pill = p.steps.createSpan({ cls: `mls-step is-${state}` });
      setIcon(pill.createSpan({ cls: "mls-ic" }), state === "done" ? "check" : state === "error" ? "x" : state === "active" ? "loader" : st.icon);
      pill.createSpan({ text: st.label });
    }
    p.bar.parentElement?.toggle(s.running || !!s.justDone);
    p.bar.setCssProps({ width: `${Math.round(s.progress * 100)}%` });
    p.now.setText(s.running ? s.now : "");
    p.log.setText(s.log || "No run yet in this session.");
  }
  refresh(): void { for (const p of this.panels) { if (!p.root.isConnected) { this.panels.delete(p); continue; } this.paint(p); } }

  runLogged(mode: RunMode): void { this.run(mode).catch((cause: unknown) => console.error("Discogs music sync: the run failed", cause)); }
  async run(mode: RunMode): Promise<void> {
    const s = this.state;
    if (s.running) { new Notice("Music sync is already running"); return; }
    const need = !this.data.username ? "Enter your Discogs username" : !this.token("discogs") ? "Save your Discogs token" :
      mode !== "dashboard" && !this.data.libraries.length && !(mode === "sync" && this.data.autoBases) ? "Add a base" : "";
    if (need) { new Notice(`${need} in Settings → Discogs music sync and dashboard first.`, 8000); return; }
    const libs = structuredClone(this.data.libraries);
    if (mode === "sync") for (const lib of libs) { try { await this.ensureLibraryFiles(lib); } catch (e) { console.error(e); } }
    Object.assign(s, { running: true, mode, steps: {}, now: "Starting…", log: "", progress: 0, stepList: this.steps() });
    this.cancelled = false;
    const started = Date.now();
    const lines: string[] = [];
    const log = (l: string) => { lines.push(l); s.log = lines.slice(-400).join("\n"); s.now = l.trim(); this.refresh(); };
    const d = this.data;
    const eng = new Engine(vaultFiles(this.app), log, () => this.cancelled, { username: d.username, lyrics: d.lyrics, gallery: d.gallery, libraries: libs,
      discogsToken: this.token("discogs"), geniusToken: this.token("genius"), folder: d.folder,
      currency: d.currency, rates: d.rates, onCurrency: (c) => { d.currency = c; },
      createBases: async (items) => { const r = await this.createBasesFor(items); s.stepList = this.steps(); this.refresh(); return r; } });
    const steps = mode === "dashboard" ? [] : libs;
    const work = () => steps.length + 1;                     // bases a sync creates add steps
    let failed = false, created = 0, priced = 0;
    this.refresh();
    try {
      await eng.init();
      if (mode === "sync") {
        try {
          created = await eng.syncAll((lib, i, done, total) => {
            libs.slice(0, i).forEach((l) => { s.steps[l.id] = "done"; });
            s.steps[lib.id] = done >= total ? "done" : "active";
            s.progress = (i + (total ? done / total : 1)) / work(); this.refresh();
          });
        } catch (e) { failed = true; for (const l of libs) if (s.steps[l.id] !== "done") s.steps[l.id] = "error"; log(`ERROR: ${errorText(e)}`); console.error(e); }
      }
      for (let i = 0; mode === "prices" && i < steps.length && !this.cancelled; i++) {
        const st = steps[i];
        if (!st) continue;
        s.steps[st.id] = "active"; s.progress = i / work(); this.refresh();
        const prog = (done: number, total: number) => { s.progress = (i + (total ? done / total : 1)) / work(); this.refresh(); };
        try {
          priced += await eng.refreshPrices(st, prog);
          s.steps[st.id] = "done";
        } catch (e) { failed = true; s.steps[st.id] = "error"; log(`ERROR (${st.name}): ${errorText(e)}`); console.error(e); }
      }
      s.steps.dashboard = "active"; s.progress = steps.length / work(); this.refresh();
      try {
        const value = await eng.collectionValue();
        this.data.value = value;
        // one entry per day, for the value-over-time chart; a later fetch the same day replaces it
        if (value.med !== null) {
          const h = this.data.valueHistory.filter((e) => e.date !== value.checked);
          h.push({ date: value.checked, min: value.min, med: value.med, max: value.max, currency: value.currency });
          this.data.valueHistory = h.sort((a, b) => a.date.localeCompare(b.date)).slice(-1000);
        }
        s.steps.dashboard = "done";
      }
      catch (e) { failed = true; s.steps.dashboard = "error"; log(`ERROR (collection value): ${errorText(e)}`); console.error(e); }
      this.redrawViews();
    } catch (e) { failed = true; log(`ERROR: ${errorText(e)}`); console.error(e); }
    finally {
      const shown = Date.now() - started; if (shown < 1500) await pause(1500 - shown);
      const summary = this.cancelled ? `cancelled after ${created} new` : failed ? "finished with errors — open Sync log" :
        mode === "sync" ? ([created ? `${created} new record${created === 1 ? "" : "s"} added` : "", eng.moved ? `${eng.moved} moved to the right base` : "",
          eng.removed ? `${eng.removed} removed` : "", eng.unplaced ? `${eng.unplaced} with no base for their format — see Sync log` : ""].filter(Boolean).join(", ") || "already up to date") :
        mode === "prices" ? `prices updated on ${priced} records` : "collection value refreshed";
      this.data.last = { at: Date.now(), mode, ok: !failed && !this.cancelled, summary };
      await this.saveData(this.data);
      Object.assign(s, { running: false, progress: 1, now: "", justDone: true });
      this.refresh();
      window.setTimeout(() => { s.justDone = false; this.refresh(); }, 5000);
      new Notice(`Discogs music sync and dashboard: ${summary}`, 7000);
    }
  }
}

export default MusicLibrarySync;
export type { TokenKind };
export { Engine, vaultFiles, openNote, MusicView };          // exported for testing
