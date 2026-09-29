// The plugin's dialogs: PDF export, adding or editing a base, first-run setup, and confirmations.
import { Modal, Notice, Setting, setIcon } from "obsidian";
import type { App, ButtonComponent } from "obsidian";
import { tidy, slug } from "./bases.ts";
import type { Base } from "./bases.ts";
import { errorText } from "./engine.ts";
import { PAPER } from "./settings-data.ts";
import type { PdfSettings } from "./settings-data.ts";
import type MusicLibrarySync from "./main.ts";

const ICONS = ["disc-3", "disc", "disc-2", "cassette-tape", "album", "music", "music-2", "radio", "headphones", "library", "guitar", "piano"];

// A base as the dialog edits it, before it is saved.
interface BaseDraft { name: string; formats: string[]; icon: string }

class ExportModal extends Modal {
  plugin: MusicLibrarySync;
  constructor(app: App, plugin: MusicLibrarySync) { super(app); this.plugin = plugin; }
  override onOpen(): void {
    const opts: PdfSettings = { ...this.plugin.data.pdf };
    this.titleEl.setText("Export dashboard as PDF");
    new Setting(this.contentEl).setName("Paper size").addDropdown((dd) => {
      for (const [k, [w, h]] of Object.entries(PAPER)) dd.addOption(k, `${k} (${w} × ${h} in)`);
      dd.setValue(opts.size).onChange((v) => { opts.size = v; });
    });
    new Setting(this.contentEl).setName("Orientation").addDropdown((dd) => {
      dd.addOption("portrait", "Portrait").addOption("landscape", "Landscape");
      dd.setValue(opts.orientation).onChange((v) => { opts.orientation = v === "landscape" ? "landscape" : "portrait"; });
    });
    new Setting(this.contentEl).setName("Saved to").setDesc(`${this.plugin.data.folder}/Exports in your vault, then opened in your PDF viewer.`);
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Export PDF").setCta().onClick(async () => {
        b.setDisabled(true); b.setButtonText("Exporting…");
        this.plugin.data.pdf = opts; await this.plugin.saveData(this.plugin.data);
        try { await this.plugin.exportPdf(opts); this.close(); }
        catch (e) { console.error(e); new Notice(`PDF export failed: ${errorText(e)}`, 10000); b.setDisabled(false); b.setButtonText("Export PDF"); }
      }));
  }
  override onClose(): void { this.contentEl.empty(); }
}

class LibraryModal extends Modal {
  plugin: MusicLibrarySync; lib: Base | null; done: (() => void) | undefined;
  // lib = null adds a new base; otherwise edits that one
  constructor(app: App, plugin: MusicLibrarySync, lib: Base | null, done?: () => void) { super(app); this.plugin = plugin; this.lib = lib; this.done = done; }
  override onOpen(): void {
    const { plugin, lib } = this, c = this.contentEl;
    const v: BaseDraft = { name: lib?.name || "", formats: [...(lib?.formats || [])], icon: lib?.icon || "disc-3" };
    let save: ButtonComponent | null = null, touched = !!lib, seq = 0;
    const check = async () => {
      const n = ++seq, e = await plugin.checkLibrary(v, lib);
      if (n !== seq) return;                                    // a newer change is already being checked
      err.setText(touched ? e : ""); save?.setDisabled(!!e);
      if (preview) { const name = tidy(v.name); preview.setText(name && !e ? `Creates ${plugin.data.folder}/${name}/ and the tag #${slug(name)}-library.` : ""); }
    };
    const recheck = () => { check().catch((cause: unknown) => console.error(cause)); };
    this.titleEl.setText(lib ? `Edit “${lib.name}”` : "Add a base");
    if (!lib) c.createEl("p", { cls: "setting-item-description",
      text: `A base takes every record of the formats you choose, from anywhere in your Discogs collection, into its own folder in ${plugin.data.folder}, with its own tag and its own place in the library and on the dashboard.` });
    new Setting(c).setName("Name")
      .setDesc(lib ? `The notes stay in ${lib.dir}.` : `Used for the base's folder in ${plugin.data.folder}. No two bases can have the same name.`)
      .addText((t) => { t.setPlaceholder("MiniDiscs").setValue(v.name).onChange((x) => { v.name = x; touched = true; recheck(); }); window.setTimeout(() => t.inputEl.focus(), 0); });

    // Formats are picked from what Discogs reports for the collection, never typed, so a
    // misspelling can't quietly send records nowhere.
    new Setting(c).setName("Formats").setHeading();
    const formatsEl = c.createDiv();
    const status = formatsEl.createEl("p", { cls: "setting-item-description", text: "Reading the formats in your Discogs collection…" });
    const others = plugin.data.libraries.filter((l) => l !== lib);
    const toggleFor = (name: string, detail: string) => {
      const taken = others.find((l) => l.formats.some((g) => g.toLowerCase() === name.toLowerCase()));
      new Setting(formatsEl).setName(name).setDesc(taken ? `${detail} Taken by “${taken.name}”.` : detail)
        .addToggle((t) => t.setValue(v.formats.includes(name)).setDisabled(!!taken).onChange((on) => {
          v.formats = on ? [...v.formats, name] : v.formats.filter((f) => f !== name); touched = true; recheck();
        }));
    };
    plugin.collectionFormats().then((found) => {
      status.setText("Turn on the formats this base takes. A record goes to the base of its first format that has one.");
      const names = new Set(found.map((f) => f.name));
      for (const f of found) toggleFor(f.name, `${f.count} record${f.count === 1 ? "" : "s"} in your collection.`);
      for (const f of v.formats) if (!names.has(f)) toggleFor(f, "No record in your collection has this format now.");
    }).catch((cause: unknown) => {
      status.setText(`Couldn't read your Discogs collection: ${errorText(cause)}. Formats can only be chosen from your collection; check your username and token with Test, then open this again.`);
      for (const f of v.formats) toggleFor(f, "");
    });

    let iconEl: HTMLElement | null = null;
    const showIcon = () => { if (!iconEl) return; iconEl.empty(); setIcon(iconEl, v.icon); };
    const iconSet = new Setting(c).setName("Icon").addDropdown((dd) => {
      for (const i of ICONS) dd.addOption(i, i);
      dd.setValue(v.icon).onChange((x) => { v.icon = x; showIcon(); });
    });
    iconEl = iconSet.controlEl.createSpan({ cls: "mls-lib-icon" });
    showIcon();
    const preview = lib ? null : c.createDiv({ cls: "setting-item-description mls-form-preview" });
    const err = c.createDiv({ cls: "mls-form-error" });
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => { save = b; b.setButtonText(lib ? "Save" : "Add base").setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          if (lib) { await plugin.updateLibrary(lib, v); new Notice(`Saved “${lib.name}”. The next sync moves records to match.`, 8000); }
          else { const n = await plugin.addLibrary(v); new Notice(`Added the base “${n.name}” — the next sync fills it from Discogs`, 8000); }
          this.close(); this.done?.();
        } catch (e) { err.setText(errorText(e)); b.setDisabled(false); }
      }); });
    recheck();
  }
  override onClose(): void { this.contentEl.empty(); }
}

// First-run setup: lists the formats in the user's Discogs collection, with how many records have
// each, and adds a base for each one they tick, named after the format.
class SetupModal extends Modal {
  plugin: MusicLibrarySync; done: (() => void) | undefined;
  constructor(app: App, plugin: MusicLibrarySync, done?: () => void) { super(app); this.plugin = plugin; this.done = done; }
  override async onOpen(): Promise<void> {
    const { plugin } = this, c = this.contentEl;
    this.titleEl.setText("Set up bases from Discogs");
    const status = c.createEl("p", { cls: "setting-item-description", text: "Reading the formats in your Discogs collection…" });
    let found;
    try { plugin.formatCache = null; found = await plugin.collectionFormats(); }
    catch (e) { status.setText(`Couldn't read your Discogs collection: ${errorText(e)}. Check your username and token with Test, then try again.`); return; }
    const taken = (name: string) => plugin.data.libraries.some((l) => l.formats.some((g) => g.toLowerCase() === name.toLowerCase()));
    const free = found.filter((f) => !taken(f.name));
    if (!found.length) { status.setText("Your Discogs collection has no records yet."); return; }
    if (!free.length) { status.setText("Every format in your Discogs collection already has a base."); return; }
    status.setText("Tick the formats to sync. Each becomes a base with the format's name, which you can rename afterwards. A record with several formats (a box set, say) goes to the base of its first format that has one.");
    const pick = new Map(free.map((f) => [f.name, true]));
    for (const f of free) new Setting(c).setName(f.name)
      .setDesc(`${f.count} record${f.count === 1 ? "" : "s"}. Creates ${plugin.data.folder}/${f.name}/`)
      .addToggle((t) => t.setValue(true).onChange((x) => pick.set(f.name, x)));
    const out = c.createDiv({ cls: "mls-form-error" });
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Add bases").setCta().onClick(async () => {
        const chosen = free.map((f) => f.name).filter((n) => pick.get(n));
        if (!chosen.length) { out.setText("Tick at least one format."); return; }
        b.setDisabled(true);
        const { added, skipped } = await plugin.addFromDiscogs(chosen);
        if (skipped.length) { out.setText(`Not added — ${skipped.join(" ")}`); b.setDisabled(false); }
        else this.close();
        if (added.length) new Notice(`Added ${added.map((l) => l.name).join(", ")}. Run “Sync from Discogs” to fill ${added.length === 1 ? "it" : "them"}.`, 8000);
        this.done?.();
      }));
  }
  override onClose(): void { this.contentEl.empty(); }
}

class ConfirmModal extends Modal {
  heading: string; text: string; action: string; onYes: () => Promise<void>;
  constructor(app: App, heading: string, text: string, action: string, onYes: () => Promise<void>) {
    super(app); this.heading = heading; this.text = text; this.action = action; this.onYes = onYes;
  }
  override onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl("p", { text: this.text });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.action).setDestructive().onClick(async () => { this.close(); await this.onYes(); }));
  }
  override onClose(): void { this.contentEl.empty(); }
}

export type { BaseDraft };
export { ExportModal, LibraryModal, SetupModal, ConfirmModal };
