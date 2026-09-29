// The settings tab. Obsidian draws it from the definitions below and indexes them for its settings search.
import { Notice, PluginSettingTab, setIcon } from "obsidian";
import type { App, ButtonComponent, ExtraButtonComponent, Setting, SettingDefinitionItem, TextComponent } from "obsidian";
import { currencyCode, currencyOptions } from "./currency.ts";
import { errorText } from "./engine.ts";
import { ConfirmModal, LibraryModal, SetupModal } from "./modals.ts";
import { COLOUR_MODES, DEFAULT_ACCENT, FULL_BASES, SECTIONS, isColourMode } from "./report.ts";
import { DEFAULT_FOLDER, PAPER, cleanFolder, folderProblem, paperSize } from "./settings-data.ts";
import { isText } from "./json.ts";
import type MusicLibrarySync from "./main.ts";
import type { TokenKind } from "./main.ts";

const REPO = "https://github.com/anthonyfitzpatrick/discogs-music-sync-to-obsidian";
// Where each service issues tokens, and the steps, shown under each token field in settings.
const TOKEN_HELP: Record<TokenKind, { url: string; link: string; steps: string[]; note: string }> = {
  discogs: { url: "https://www.discogs.com/settings/developers", link: "discogs.com/settings/developers",
    steps: ["Sign in to Discogs, then open the link above: it goes straight to Settings → Developers.",
      "Press “Generate new token”.",
      "Copy the token, paste it into the field here and press Test."],
    note: "The token lets the plugin read your collection and prices. Treat it like a password." },
  genius: { url: "https://genius.com/api-clients", link: "genius.com/api-clients",
    steps: ["Sign in to Genius, then open the link above: it goes straight to your API clients.",
      "Press “New API Client”. Any app name and website address will do, such as “Obsidian” and https://obsidian.md.",
      "Save it, then press “Generate Access Token” under the new client.",
      "Copy the token, paste it into the field here and press Test."],
    note: "The token is only used to look up lyrics pages. Treat it like a password." },
};
const fullBase = (i: number): string => FULL_BASES[i % FULL_BASES.length] ?? DEFAULT_ACCENT;

type TokenState = "" | "ok" | "error";
// A value a settings control holds.
type ControlValue = string | boolean;

class MusicSettingTab extends PluginSettingTab {
  plugin: MusicLibrarySync;
  legacy: string[] = [];
  tokenStatus: Partial<Record<TokenKind, { text: string; state: TokenState }>> = {};
  startedSteps: [HTMLElement, () => boolean][] = [];

  constructor(app: App, plugin: MusicLibrarySync) { super(app, plugin); this.plugin = plugin; }
  // A token check's answer is kept while the tab is open, and forgotten when it closes.
  override hide(): void { this.tokenStatus = {}; super.hide(); }

  // Plain values are controls, read and saved through getControlValue and setControlValue; rows with
  // buttons, tokens and the list of bases draw themselves. update() redraws after a change that adds or
  // removes rows.
  override getSettingDefinitions(): SettingDefinitionItem[] {
    const P = this.plugin, d = P.data;
    const ready = () => !!d.username && !!P.token("discogs");
    const custom = () => d.colours.mode === "custom";
    const redraw = () => this.update();
    this.checkLegacy().catch((cause: unknown) => console.error(cause));
    return [
      { name: "Getting started", searchable: false, visible: () => !ready() || !d.libraries.length, render: (s) => this.gettingStarted(s) },
      { type: "group", heading: "Discogs", items: [
        { name: "Library folder", desc: "Where new bases get their folders, and where removed records and PDF exports go. Existing bases keep their folders.",
          control: { type: "text", key: "folder", placeholder: DEFAULT_FOLDER, validate: folderProblem } },
        { name: "Username", desc: "The Discogs account whose collection is synced.", control: { type: "text", key: "username", placeholder: "Discogs username" } },
        { name: "Personal access token", aliases: ["Discogs token", "Developers"], desc: "Required. Lets the plugin read your Discogs collection.",
          render: (s) => this.tokenRow(s, "discogs", "Discogs", async () => {
            const who = await P.discogsIdentity();
            if (!d.username) { d.username = who; await P.save(); }          // shown when the check redraws the tab
            if (who.toLowerCase() !== d.username.toLowerCase()) throw new Error(`The token belongs to ${who}, but the username above is ${d.username}. Change one of them`);
            // the account's currency becomes the prices' currency, unless one has been chosen
            if (!d.currency) { const c = await P.discogsCurrency(who); if (c) { d.currency = c; await P.save(); } }
            return `Connected to Discogs as ${who}${d.currency ? ` (prices in ${d.currency})` : ""}`;
          }) },
      ] },
      { type: "group", heading: "Lyrics", items: [
        { name: "Add Genius lyrics links", desc: "Look up each track on Genius when a record is added. Needs a Genius token.", control: { type: "toggle", key: "lyrics" } },
        { name: "Genius access token", aliases: ["API client"], desc: "Optional. Needed for lyrics links.",
          render: (s) => this.tokenRow(s, "genius", "Genius", async () => { await P.geniusCheck(); return "Genius accepted the token"; }) },
      ] },
      { type: "group", heading: "Bases", items: [
        { name: "Create bases automatically", aliases: ["Formats", "Add bases"],
          desc: "Each base takes the records of one Discogs format, such as Vinyl or CD, into its own folder, with its own place in the library and on the dashboard. When on, a sync creates a base, named after the format, for every format in your collection that has none. A box set goes by the media inside it.",
          control: { type: "toggle", key: "autoBases" } },
        { name: "Formats left out", searchable: false, visible: () => d.skippedFormats.length > 0,
          desc: "You stopped syncing these, so no base is created for them.",
          render: (s) => {
            s.descEl.createDiv({ text: d.skippedFormats.join(", ") });
            s.addButton((b) => b.setButtonText("Create them again").onClick(async () => { d.skippedFormats = []; await P.save(); redraw(); }));
          } },
        { name: "Set up from Discogs", aliases: ["Add bases"],
          desc: "Choose which formats in your collection get a base now, instead of waiting for the next sync. Names must be unique.",
          disabled: () => !ready(), action: () => new SetupModal(this.app, P, redraw).open() },
      ] },
      // Removing a base asks first: its notes stay, but it leaves the sync, the library and the dashboard.
      { type: "list", emptyState: "No bases yet. The next sync creates them from your collection's formats.",
        addItem: { name: "Add base", action: () => new LibraryModal(this.app, P, null, redraw).open() },
        onDelete: (i) => {
          const lib = d.libraries[i]; if (!lib) return;
          new ConfirmModal(this.app, `Stop syncing “${lib.name}”?`,
            `It disappears from the sync, the library and the dashboard, and isn't created again automatically. ${lib.dir} and its notes stay in your vault — delete them yourself if you no longer want them.`,
            "Stop syncing", async () => { await P.removeLibrary(lib); redraw(); }).open();
        },
        items: d.libraries.map((lib) => ({ name: lib.name, desc: `Takes ${lib.formats.join(", ")} records → ${lib.dir} · #${lib.tag}`,
          render: (s: Setting) => {
            setIcon(s.nameEl.createSpan({ cls: "mls-lib-icon", prepend: true }), lib.icon);
            s.addExtraButton((b) => b.setIcon("pencil").setTooltip("Rename or edit").onClick(() => new LibraryModal(this.app, P, lib, redraw).open()));
          } })) },
      { type: "group", heading: "Files from earlier versions", visible: () => this.legacy.length > 0, items: [
        { name: "Move to trash", searchable: false,
          desc: "Earlier versions kept these in your vault. The plugin no longer uses them: the dashboard and library views, and tokens kept on this device, have replaced them.",
          render: (s) => {
            const ul = s.descEl.createEl("ul", { cls: "mls-legacy-list" });
            for (const f of this.legacy) ul.createEl("li", { text: f });
            s.addButton((b) => b.setButtonText("Move to trash").setDestructive().onClick(() => new ConfirmModal(this.app, "Move these files to the trash?",
              `${this.legacy.join(", ")}. They go to the trash, so you can get them back.`, "Move to trash",
              async () => { await P.trashLegacyFiles(this.legacy); new Notice("Moved to the trash"); this.legacy = []; redraw(); }).open()));
          } },
      ] },
      { type: "group", heading: "Dashboard", items: SECTIONS.map(([key, label]) =>
        ({ name: label, desc: "Shown on the dashboard and in its PDF.", control: { type: "toggle", key: `section:${key}` } })) },
      { type: "group", heading: "Colours", items: [
        { name: "Chart colours", aliases: ["Colors", "Theme"],
          desc: "Theme uses shades of your theme's colours. Full colour is the plugin's original purple, pink and orange. Custom lets you choose. Text, lines and backgrounds always follow your theme.",
          control: { type: "dropdown", key: "colourMode", options: COLOUR_MODES } },
        ...d.libraries.map((lib, i) => ({ name: lib.name, desc: "This base's colour in every chart and label.", visible: custom,
          control: { type: "color" as const, key: `colour:${lib.id}`, defaultValue: fullBase(i) } })),
        { name: "Accent", desc: "The starting colour for charts with many parts (genres, styles, artists, labels) and for value scales.", visible: custom,
          control: { type: "color", key: "accent", defaultValue: DEFAULT_ACCENT } },
      ] },
      { type: "group", heading: "Prices", items: [
        { name: "Currency", aliases: ["Money", "Prices", "SEK", "USD", "EUR", "GBP"],
          desc: "Prices, values and charts are in this currency. It starts as your Discogs account's; Discogs converts the rest at its own rates. After changing it, run Refresh prices to update your records.",
          control: { type: "dropdown", key: "currency", options: { "": "Same as my Discogs account", ...currencyOptions() } } },
      ] },
      { type: "group", heading: "Sync", items: [
        { name: "Download all images", aliases: ["Covers", "Gallery"], desc: "On: save every Discogs photo of a new record (back cover, labels, inserts). Off: save only its front cover.",
          control: { type: "toggle", key: "gallery" } },
      ] },
      { type: "group", heading: "PDF export", items: [
        { name: "Paper size", control: { type: "dropdown", key: "pdfSize", options: Object.fromEntries(Object.entries(PAPER).map(([k, [w, h]]) => [k, `${k} (${w} × ${h} in)`])) } },
        { name: "Orientation", control: { type: "dropdown", key: "pdfOrientation", options: { portrait: "Portrait", landscape: "Landscape" } } },
      ] },
      { type: "group", heading: "Reset", items: [
        { name: "Start again", aliases: ["Reset", "Remove tokens", "Uninstall"],
          desc: "Removes your Discogs and Genius tokens from this vault, and sets the username, bases and every setting back to how a new install starts. Your record notes, covers and PDFs stay in the vault; the next sync finds them again. Do this before uninstalling to leave no tokens behind.",
          render: (s) => { s.addButton((b) => b.setButtonText("Start again").setDestructive().onClick(() => new ConfirmModal(this.app, "Start again?",
            "Your tokens are removed from this vault, and the username, bases, dashboard sections, colours and PDF settings go back to how a new install starts. Your record notes, covers and PDFs stay in the vault.",
            "Start again", async () => { await P.startAgain(); this.tokenStatus = {}; redraw(); new Notice("Started again: tokens removed and settings reset"); }).open())); } },
      ] },
      // The About block is not a setting: kept out of search, it takes over its row.
      { name: "About Discogs music sync and dashboard", searchable: false, render: (s) => {
        s.settingEl.empty(); s.settingEl.addClass("mls-about-row");
        this.aboutFooter(s.settingEl);
      } },
    ];
  }

  override getControlValue(key: string): ControlValue | undefined {
    const d = this.plugin.data;
    if (key.startsWith("section:")) return d.sections[key.slice(8)] !== false;
    if (key.startsWith("colour:")) return d.colours.bases[key.slice(7)];
    switch (key) {
      case "folder": return d.folder;
      case "username": return d.username;
      case "lyrics": return d.lyrics;
      case "gallery": return d.gallery;
      case "autoBases": return d.autoBases;
      case "currency": return d.currency;
      case "colourMode": return d.colours.mode;
      case "accent": return d.colours.accent;
      case "pdfSize": return d.pdf.size;
      case "pdfOrientation": return d.pdf.orientation;
      default: return undefined;
    }
  }

  // Obsidian hands back what its controls hold: text for text, dropdowns and colours, true/false for toggles.
  override async setControlValue(key: string, value: ControlValue): Promise<void> {
    const P = this.plugin, d = P.data;
    const text = isText(value) ? value : "";
    if (key.startsWith("section:")) { if (value) delete d.sections[key.slice(8)]; else d.sections[key.slice(8)] = false; }
    else if (key.startsWith("colour:")) d.colours.bases[key.slice(7)] = text;
    else switch (key) {
      case "folder": if (folderProblem(value)) return; d.folder = cleanFolder(value); break;   // validate has already said why
      case "username": d.username = text.trim(); P.formatCache = null; break;
      case "lyrics": d.lyrics = value === true; break;
      case "gallery": d.gallery = value === true; break;
      case "autoBases": d.autoBases = value === true; break;
      case "currency": {
        const was = d.currency;
        d.currency = currencyCode(value);
        if (d.currency && was && d.currency !== was) new Notice(`Prices are now shown in ${d.currency}. Run Refresh prices to fetch your records' prices in ${d.currency}; until then, prices in ${was} are left out of the dashboard's figures.`, 12000);
        break;
      }
      case "colourMode": d.colours.mode = isColourMode(value) ? value : "theme"; break;
      case "accent": d.colours.accent = text; break;
      case "pdfSize": d.pdf.size = paperSize(text) ? text : "A4"; break;
      case "pdfOrientation": d.pdf.orientation = value === "landscape" ? "landscape" : "portrait"; break;
      default: return;
    }
    await P.save();
    if (key.startsWith("section:") || key.startsWith("colour") || key === "accent" || key === "currency") P.redrawViews();
    this.refreshStarted();                          // getting started, the setup button and the custom colours follow these values
  }

  // Files from earlier versions are found on disk, so after the tab is drawn; it is redrawn if there are any.
  async checkLegacy(): Promise<void> {
    const found = await this.plugin.legacyFilesPresent();
    if (found.join("\n") === this.legacy.join("\n")) return;
    this.legacy = found;
    if (this.containerEl.isConnected) this.update();          // otherwise the next showing draws them
  }

  // The first steps, ticked off as they are done; shown until there is a token, a username and a base.
  // Each step is crossed out as it is done, as it happens: refreshStarted() is called whenever a
  // username or token is saved.
  gettingStarted(s: Setting): void {
    const P = this.plugin, d = P.data;
    s.settingEl.empty();
    const g = s.settingEl.createDiv({ cls: "mls-getting-started" });
    g.createEl("strong", { text: "Getting started" });
    const ol = g.createEl("ol");
    const steps: [string, () => boolean][] = [
      ["Enter your Discogs username below.", () => !!d.username],
      ["Add your Discogs token: open the link under “Personal access token”, generate a token, paste it into the field and press Test.", () => !!P.token("discogs")],
      ["Optional, for lyrics links: add your Genius token the same way, under “Genius access token”.", () => !!P.token("genius")],
      ["Run “Sync from Discogs” from the command palette. It creates a base for each format in your collection, such as Vinyl and CD, and fills them.", () => d.libraries.length > 0],
      ["Press the disc icon in the ribbon to open the dashboard and library.", () => false],
    ];
    this.startedSteps = steps.map(([t, done]) => [ol.createEl("li", { text: t }), done]);
    this.refreshStarted();
  }
  refreshStarted(): void {
    for (const [li, done] of this.startedSteps) if (li.isConnected) li.toggleClass("is-done", done());
    this.refreshDomState();                                   // the list shows until the required steps are done
  }

  // A token is kept in Obsidian's secret storage on this device: never in a file, the vault or the plugin's settings.
  // Pasting a token saves it (as do Enter and leaving the field); Test checks it with the service, saving
  // first whatever is in the field, so one press is enough. Saving doesn't redraw the tab, so a click on
  // Test is never lost. The answer shows under the field, and is kept when the tab redraws.
  tokenRow(s: Setting, kind: TokenKind, service: string, test: () => Promise<string>): void {
    const P = this.plugin, help = TOKEN_HELP[kind];
    // the description with a link to where the token is made, and the steps, folded away until wanted
    const desc = s.descEl.createDiv({ cls: "mls-token-link" });
    desc.appendText("Get one at ");
    desc.createEl("a", { text: help.link, href: help.url, attr: { target: "_blank", rel: "noopener" } });
    const how = s.descEl.createEl("details", { cls: "mls-token-help" });
    how.createEl("summary", { text: "How to get a token" });
    const steps = how.createEl("ol");
    for (const step of help.steps) steps.createEl("li", { text: step });
    how.createDiv({ cls: "mls-token-note", text: help.note });
    const status = s.descEl.createDiv({ cls: "mls-token-status" });
    const show = (text: string, state: TokenState = "") => {
      this.tokenStatus[kind] = { text, state };
      status.setText(text);
      status.toggleClass("is-ok", state === "ok"); status.toggleClass("is-error", state === "error");
    };
    const kept = this.tokenStatus[kind];
    if (kept) show(kept.text, kept.state); else show(P.token(kind) ? "A token is saved on this device." : "No token saved yet.");
    let input: TextComponent | null = null, button: ButtonComponent | null = null, remove: ExtraButtonComponent | null = null, run = 0;
    const save = (): boolean => {
      const typed = input?.getValue().trim() ?? "";
      if (!typed) return false;
      P.saveToken(kind, typed); input?.setValue(""); input?.setPlaceholder("Paste to replace");
      run++;                                                   // any check still running was for the old token
      button?.setDisabled(false).setButtonText("Test");
      remove?.setDisabled(false);
      show("Saved on this device. Press Test to check it.");
      this.refreshStarted();
      return true;
    };
    const check = async () => {
      const typed = save();
      if (!P.token(kind)) { show("No token saved yet. Paste one into the field.", "error"); return; }
      const mine = ++run;                                      // a newer check replaces this one's answer
      button?.setDisabled(true).setButtonText("Checking…");
      show(`${typed ? "Saved on this device. " : ""}Checking with ${service}…`);
      let answer: string, ok = false;
      try { answer = await test(); ok = true; } catch (e) { answer = errorText(e); }
      if (mine !== run) return;
      show(ok ? `✓ ${answer}. The token is saved on this device.` : `✗ ${answer}. Paste a new token to replace it.`, ok ? "ok" : "error");
      button?.setDisabled(false).setButtonText("Test");
      this.update();                                           // the getting-started steps, the username and the setup button follow
    };
    s.addText((t) => {
      input = t;
      t.inputEl.type = "password";
      t.setPlaceholder(P.token(kind) ? "Paste to replace" : "Paste token here");
      // A pasted token is complete, so it is saved at once. A typed one waits for Enter or leaving the
      // field, so a half-typed token is never stored.
      t.inputEl.addEventListener("paste", () => window.setTimeout(save, 0));
      t.inputEl.addEventListener("change", save);
    });
    s.addButton((b) => { button = b; b.setButtonText("Test").onClick(() => void check()); });
    // Removes the saved token from this vault's keychain; pasting a token again puts it back.
    s.addExtraButton((b) => {
      remove = b;
      b.setIcon("trash-2").setTooltip(`Remove the saved ${service} token from this vault`).setDisabled(!P.token(kind)).onClick(() => {
        if (!P.token(kind)) return;
        P.forgetToken(kind); run++;
        b.setDisabled(true); button?.setDisabled(false).setButtonText("Test"); input?.setPlaceholder("Paste token here");
        show("Removed from this vault. No token saved.");
        this.refreshStarted();
      });
    });
  }

  // The About / Support footer shared with the other Wolf 359 Press plugins.
  aboutFooter(el: HTMLElement): void {
    const footer = el.createDiv("mls-about-footer");
    const identity = footer.createDiv("mls-about-identity");
    setIcon(identity.createDiv({ cls: "mls-about-logo", attr: { "aria-label": "Discogs music sync and dashboard logo", role: "img" } }), "disc-3");
    const text = identity.createDiv("mls-about-identity-text");
    text.createDiv({ cls: "mls-about-title", text: "Discogs music sync and dashboard" });
    text.createDiv({ cls: "mls-about-version", text: `Version ${this.plugin.manifest.version}` });
    text.createDiv({ cls: "mls-about-credit", text: "Created by Anthony Fitzpatrick" });
    text.createDiv({ cls: "mls-about-credit", text: "Wolf 359 Press AB" });
    const links = footer.createDiv("mls-about-links");
    const primary = links.createDiv("mls-about-links-row"), secondary = links.createDiv("mls-about-links-row");
    // The issue forms in .github/ISSUE_TEMPLATE apply the bug / enhancement label themselves,
    // so reports are labelled even when the reporter can't set labels.
    const LINKS: { icon?: string; cls?: string; label: string; primary?: boolean; url: string }[] = [
      { icon: "bug", label: "Report a bug", primary: true, url: `${REPO}/issues/new?template=bug_report.yml&labels=bug` },
      { icon: "lightbulb", label: "Request a feature", primary: true, url: `${REPO}/issues/new?template=feature_request.yml&labels=enhancement` },
      { icon: "user-round", label: "Anthony Fitzpatrick", primary: true, url: "https://anthonyfitzpatrick.me/" },
      { icon: "globe", label: "wolf359.app", url: "https://wolf359.app/" },
      { icon: "book-open", label: "wolf359.press", url: "https://wolf359.press/" },
      { cls: "mls-about-link-coffee", label: "Buy me a coffee", url: "https://buymeacoffee.com/wolf359pressab" },
    ];
    for (const link of LINKS) {
      const b = (link.primary ? primary : secondary).createEl("button", { cls: "mls-about-link", type: "button" });
      if (link.cls) b.addClass(link.cls);
      const ic = b.createSpan({ cls: "mls-about-link-icon", attr: { "aria-hidden": "true" } });
      if (link.icon) setIcon(ic, link.icon); else ic.addClass("mls-about-link-image-icon");
      b.createSpan({ cls: "mls-about-link-text", text: link.label });
      b.addEventListener("click", () => window.open(link.url, "_blank", "noopener"));
    }
  }
}

export { MusicSettingTab };
