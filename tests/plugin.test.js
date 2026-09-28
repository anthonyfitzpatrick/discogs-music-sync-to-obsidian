// Tests the built main.js against a stand-in for Obsidian and an in-memory vault.
// Run with `npm test` (which builds first).
const { test } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");

global.window = { setInterval: () => 0, setTimeout: () => 0 };   // onload's refresh timer; nothing else needs a browser
const notices = [];
// What the stand-in for Obsidian's requestUrl answers; a test replaces it to play Discogs.
let network = async () => ({ status: 500, json: {} });
const stub = {
  Plugin: class {
    constructor() { this.saved = undefined; }
    async loadData() { return this.saved; }
    async saveData(d) { this.saved = JSON.parse(JSON.stringify(d)); }
    registerMarkdownCodeBlockProcessor() {} addRibbonIcon() {} addCommand() {} addSettingTab() {} registerInterval() {} registerView() {} registerEvent() {}
  },
  PluginSettingTab: class { constructor(app) { this.app = app; } },
  ItemView: class { constructor(leaf) { this.leaf = leaf; } },
  Modal: class { constructor(app) { this.app = app; } },
  Setting: class {},
  Notice: class { constructor(msg) { notices.push(msg); } },
  requestUrl: (req) => network(req),
  setIcon() {},
  moment: () => ({ format: () => "" }),
};
const load = Module._load;
Module._load = function (req, ...rest) { return req === "obsidian" ? stub : load.call(this, req, ...rest); };
const Plugin = require(path.join(__dirname, "..", "main.js"));
const { Engine, vaultFiles } = Plugin;

// An in-memory vault whose paths are case-insensitive, like the default macOS and Windows disks.
function makeVault(entries = {}) {
  const files = new Map(), calls = [];   // calls: what went through Obsidian's Vault API
  const local = new Map();                // Obsidian's local storage for this vault
  const put = (p, text = null) => files.set(p.toLowerCase(), { path: p, text });
  for (const [p, t] of Object.entries(entries)) put(p, t);
  const adapter = {
    exists: async (p) => files.has(p.toLowerCase()),
    read: async (p) => files.get(p.toLowerCase()).text,
    write: async (p, t) => put(p, t),
    mkdir: async (p) => put(p),
    writeBinary: async (p) => put(p, "<binary>"),
    trashSystem: async (p) => { calls.push(`trashSystem ${p}`); files.delete(p.toLowerCase()); },
    rename: async (from, to) => { const f = files.get(from.toLowerCase()); files.delete(from.toLowerCase()); f.path = to; files.set(to.toLowerCase(), f); },
    list: async (dir) => ({ files: [...files.values()].filter((f) => f.text !== null && path.posix.dirname(f.path) === dir).map((f) => f.path), folders: [] }),
  };
  const app = {
    vault: {
      adapter,
      getAbstractFileByPath: (p) => { const f = files.get(p.toLowerCase()); return f && f.path === p ? f : null; },
      createFolder: async (p) => put(p),
      create: async (p, t) => { if (files.has(p.toLowerCase())) throw new Error("File already exists"); put(p, t); calls.push(`create ${p}`); },
      process: async (f, fn) => { f.text = fn(f.text); },
      on: () => ({}),
      trash: async (f) => { calls.push(`trash ${f.path}`); files.delete(f.path.toLowerCase()); },
      modify: async (f, text) => { f.text = text; calls.push(`modify ${f.path}`); },
      createBinary: async (p) => { put(p, "<binary>"); calls.push(`createBinary ${p}`); },
      modifyBinary: async (f) => { calls.push(`modifyBinary ${f.path}`); },
    },
    fileManager: { renameFile: async (f, to) => { calls.push(`renameFile ${f.path} → ${to}`); files.delete(f.path.toLowerCase()); f.path = to; files.set(to.toLowerCase(), f); } },
    plugins: { enabledPlugins: new Set(), plugins: {} },
    workspace: { getLeavesOfType: () => [], on: () => ({}) },
    metadataCache: { on: () => ({}) },
    loadLocalStorage: (k) => local.get(k) ?? null,
    saveLocalStorage: (k, v) => { if (v === null) local.delete(k); else local.set(k, v); },
  };
  return { app, files, calls, local, text: (p) => files.get(p.toLowerCase())?.text };
}

// A collection item as Discogs sends it.
const item = (instance, formats) => ({ id: instance * 10, instance_id: instance, date_added: "2026-09-01T12:00:00-07:00", notes: [],
  basic_information: { formats: formats.map((name) => ({ name, qty: "1" })) } });

// Three bases as saved settings, for the tests that need some.
const THREE = () => ({ username: "someone", libraries: [
  { id: "vinyl", name: "Vinyl", formats: ["Vinyl"], dir: "Music/Vinyl", tag: "vinyl-library", icon: "disc-3" },
  { id: "cds", name: "CDs", formats: ["CD"], dir: "Music/CDs", tag: "cd-library", icon: "disc" },
  { id: "tapes", name: "Tapes", formats: ["Cassette"], dir: "Music/Tapes", tag: "tape-library", icon: "cassette-tape" }] });

async function makePlugin(saved, entries) {
  const v = makeVault(entries);
  const p = new Plugin();
  p.app = v.app; p.saved = saved;
  await p.onload();
  p.refresh = () => {};
  return { p, ...v };
}

test("a new install starts with no username and no bases", async () => {
  const { p } = await makePlugin(undefined);
  assert.strictEqual(p.data.username, "");
  assert.deepStrictEqual(p.data.libraries, []);
});

test("settings without bases or a username get none: nothing is assumed about the user", async () => {
  const { p } = await makePlugin({ last: null, pdf: { size: "A4", orientation: "landscape" } });
  assert.deepStrictEqual(p.data.libraries, []);
  assert.strictEqual(p.data.username, "");
  assert.strictEqual(p.data.folder, "Music", "the default library folder");
  assert.strictEqual(p.data.pdf.orientation, "landscape");
});

test("the library folder decides where new bases, removed records and PDFs go", async () => {
  const { p, app } = await makePlugin({ username: "someone", libraries: [], folder: " /Collection//Records/ " });
  assert.strictEqual(p.data.folder, "Collection/Records", "tidied when loaded");
  const lib = await p.addLibrary({ name: "Vinyl", formats: ["Vinyl"] });
  assert.strictEqual(lib.dir, "Collection/Records/Vinyl");
  assert.ok(app.vault.getAbstractFileByPath("Collection/Records/Vinyl"));
  assert.strictEqual(app.vault.getAbstractFileByPath("Music"), null, "no Music folder is made");
  const vault = makeVault({ "Collection/Records/Vinyl/Sold.md": noteFor(9, "vinyl-library", "x") });
  const { eng } = makeEngine(vault, [{ ...VINYL, dir: "Collection/Records/Vinyl" }], []);
  eng.cfg.folder = "Collection/Records";
  await eng.syncAll();
  assert.ok(vault.text("Collection/Records/Removed from collection/Sold.md"), "removed records go under the library folder");
});

test("saved bases and username are kept as they are", async () => {
  const libs = [{ id: "lps", name: "LPs", formats: ["Vinyl"], dir: "Music/LPs", tag: "lps-library", icon: "disc-3", base: "Music/LPs.base" }];
  const { p } = await makePlugin({ username: "someone", libraries: libs });
  assert.strictEqual(p.data.username, "someone");
  assert.deepStrictEqual(p.data.libraries, libs);
});

test("bases from 0.8 and 0.9, which synced a Discogs folder, take the format of the same name", async () => {
  const old = [{ id: "cds", name: "CDs", discogsFolder: "CD", dir: "Music/CDs", tag: "cd-library", icon: "disc", base: "Music/CDs.base" }];
  const { p } = await makePlugin({ username: "someone", libraries: old });
  assert.deepStrictEqual(p.data.libraries, [{ id: "cds", name: "CDs", formats: ["CD"], dir: "Music/CDs", tag: "cd-library", icon: "disc" }]);
  assert.deepStrictEqual(p.data.legacyFiles, ["Music/CDs.base"], "its .base file is offered for removal");
});

test("a sync without a username or token explains what's missing and does nothing", async () => {
  const { p } = await makePlugin(undefined);
  notices.length = 0;
  await p.run("sync");
  assert.match(notices[0], /Enter your Discogs username/);
  p.data.username = "someone";
  await p.run("sync");
  assert.match(notices[1], /Save your Discogs token/);
  assert.strictEqual(p.state.running, false);
});

test("adding a base creates only its folder: no .base files or other files", async () => {
  const { p, files, app } = await makePlugin(undefined);
  const lib = await p.addLibrary({ name: " Mini  Discs ", formats: ["Minidisc"], icon: "disc-2" });
  assert.deepStrictEqual(lib, { id: "mini-discs", name: "Mini Discs", formats: ["Minidisc"], dir: "Music/Mini Discs", tag: "mini-discs-library", icon: "disc-2" });
  assert.ok(app.vault.getAbstractFileByPath("Music/Mini Discs"));
  assert.deepStrictEqual([...files.values()].filter((f) => f.text !== null), [], "nothing but folders");
});

test("checking a base adds the vault's own clashes to the naming rules", async () => {
  // The naming rules themselves are tested directly in bases.test.js.
  const { p } = await makePlugin(THREE(), { "Music/Exports": null });
  const check = (name, self = null) => p.checkLibrary({ name, formats: self ? self.formats : ["Minidisc"] }, self);
  assert.match(await check("vinyl"), /already a base called “Vinyl”/, "the naming rules apply");
  assert.match(await check("Exports"), /already has a folder called “Exports”/);
  assert.strictEqual(await check("Tapes", p.data.libraries[2]), "", "a base doesn't clash with itself");
  assert.strictEqual(await check("Minidiscs"), "");
});

test("renaming a base changes its name only; its notes stay where they are", async () => {
  const { p } = await makePlugin(THREE());
  const tapes = p.data.libraries[2];
  await p.updateLibrary(tapes, { name: "Cassettes", formats: ["Cassette", "Microcassette"] });
  assert.deepStrictEqual([tapes.name, tapes.formats, tapes.dir, tapes.tag], ["Cassettes", ["Cassette", "Microcassette"], "Music/Tapes", "tape-library"]);
});

test("the last base can be removed", async () => {
  const { p } = await makePlugin(undefined);
  const lib = await p.addLibrary({ name: "Vinyl", formats: ["Vinyl"] });
  await p.removeLibrary(lib);
  assert.deepStrictEqual(p.data.libraries, []);
});

test("setting up from Discogs adds a base per format, with a fitting icon, and skips clashes", async () => {
  const { p } = await makePlugin(undefined);
  const { added, skipped } = await p.addFromDiscogs(["Vinyl", "CD", "Cassette", "Box Set", "vinyl"]);
  assert.deepStrictEqual(added.map((l) => [l.name, l.formats, l.icon]), [["Vinyl", ["Vinyl"], "disc-3"], ["CD", ["CD"], "disc"], ["Cassette", ["Cassette"], "cassette-tape"], ["Box Set", ["Box Set"], "music"]]);
  assert.strictEqual(skipped.length, 1);
  assert.match(skipped[0], /^vinyl: /);
});

test("reading the collection's formats reports why it failed instead of returning nothing", async () => {
  const { p } = await makePlugin(undefined, {});
  await assert.rejects(p.collectionFormats(), /No Discogs token saved yet/);
  p.saveToken("discogs", "t0ken");
  await assert.rejects(p.collectionFormats(), /No Discogs username entered yet/);
  p.data.username = "someone";
  for (const [status, why] of [[401, /didn't accept the token/], [404, /no user called “someone”/], [502, /answered 502/]]) {
    network = async () => ({ status, json: {} });
    await assert.rejects(p.collectionFormats(), why);
  }
  network = async () => ({ status: 200, json: { releases: [{ id: 1 }], pagination: { page: 1, pages: 1 } } });
  await assert.rejects(p.collectionFormats(), /without its release or copy number/, "a malformed page is a reason, not an empty list");
  network = async (req) => {
    assert.match(req.url, /users\/someone\/collection\/folders\/0\/releases\?per_page=100&page=1$/);
    assert.strictEqual(req.headers.Authorization, "Discogs token=t0ken");
    return { status: 200, json: { releases: [item(1, ["Vinyl"]), item(2, ["Box Set", "Vinyl"]), item(3, ["CD"])], pagination: { page: 1, pages: 1 } } };
  };
  assert.deepStrictEqual(await p.collectionFormats(), [{ name: "Vinyl", count: 2 }, { name: "Box Set", count: 1 }, { name: "CD", count: 1 }]);
});

// ------------------------------------------------------------------ the sync

// A record note as the sync writes it, with the user's own text in it.
const noteFor = (instance, tag, own) => `---
artist: "A"
title: "T${instance}"
discogs_instance: ${instance}
cssclasses:
  - vinyl-record
tags:
  - ${tag}
---
# A – T${instance}

## Notes

${own}
`;

// The engine with a stand-in for Discogs: the collection given, and a minimal release for each record.
function makeEngine(vault, libraries, collection) {
  const log = [];
  const eng = new Engine(vault.app.vault.adapter, (l) => log.push(l), () => false, { username: "someone", lyrics: false, gallery: false, libraries });
  eng.discogs = async (url) => {
    if (url.includes("collection/folders/0/releases")) return { releases: collection, pagination: { page: 1, pages: 1 } };
    if (url.includes("collection/fields")) return { fields: [] };
    const release = url.match(/^releases\/(\d+)$/);
    if (release) return { id: +release[1], title: `Release ${release[1]}`, year: 1990, artists: [{ name: "Artist" }], labels: [{ name: "Label", catno: "C1" }],
      formats: [{ name: "Vinyl", qty: "1" }], genres: ["Rock"], styles: [], images: [], tracklist: [{ type_: "track", position: "A1", title: "One", duration: "3:00" }] };
    return {};                                                         // marketplace: no prices
  };
  return { eng, log };
}

const VINYL = { id: "vinyl", name: "Vinyl", formats: ["Vinyl"], dir: "Music/Vinyl", tag: "vinyl-library" };
const CDS = { id: "cds", name: "CDs", formats: ["CD"], dir: "Music/CDs", tag: "cd-library" };

test("a sync places every record by its format, wherever it is in the collection", async () => {
  const vault = makeVault({ "Music/Vinyl/Kept.md": noteFor(1, "vinyl-library", "My notes on record 1.") });
  const { eng, log } = makeEngine(vault, [VINYL, CDS], [item(1, ["Vinyl"]), item(2, ["CD"]), item(3, ["Box Set", "Vinyl"]), item(4, ["Cassette"])]);
  const made = await eng.syncAll();
  assert.strictEqual(made, 2, "records 2 and 3 are new; record 1 already has a note");
  const inDir = (dir) => [...vault.files.values()].filter((f) => f.text !== null && f.path.startsWith(`${dir}/`) && f.path.endsWith(".md")).map((f) => f.text);
  assert.strictEqual(inDir("Music/CDs").filter((t) => /discogs_instance: 2\b/.test(t)).length, 1, "the CD goes to CDs");
  assert.strictEqual(inDir("Music/Vinyl").filter((t) => /discogs_instance: 3\b/.test(t)).length, 1, "the box set goes to the base of its first format with one");
  assert.match(vault.text("Music/Vinyl/Kept.md"), /My notes on record 1\./, "an existing note is never rewritten");
  assert.strictEqual(inDir("Music/Vinyl").filter((t) => /discogs_instance: 1\b/.test(t)).length, 1, "no duplicate");
  assert.strictEqual(eng.unplaced, 1);
  assert.ok(log.some((l) => /1 record with the format Cassette has no base/.test(l)), "a format with no base is reported, not guessed");
});

test("a note in the wrong base is moved to the right one and retagged, keeping what the user wrote", async () => {
  const vault = makeVault({ "Music/Vinyl/Misfiled.md": noteFor(5, "vinyl-library", "Bought at a fair.") });
  const { eng, log } = makeEngine(vault, [VINYL, CDS], [item(5, ["CD"])]);
  assert.strictEqual(await eng.syncAll(), 0, "nothing new is created for it");
  assert.strictEqual(vault.text("Music/Vinyl/Misfiled.md"), undefined);
  const moved = vault.text("Music/CDs/Misfiled.md");
  assert.match(moved, /tags:\n  - cd-library\n/);
  assert.match(moved, /Bought at a fair\./);
  assert.strictEqual(eng.moved, 1);
  assert.ok(log.some((l) => /Misfiled is CD → moved from Vinyl to CDs/.test(l)));
});

test("a record gone from the collection is moved out, never deleted", async () => {
  const vault = makeVault({ "Music/CDs/Sold.md": noteFor(9, "cd-library", "Sold at a fair.") });
  const { eng } = makeEngine(vault, [VINYL, CDS], [item(1, ["Vinyl"])]);
  await eng.syncAll();
  const gone = vault.text("Music/Removed from collection/Sold.md");
  assert.match(gone, /tags:\n  - removed-from-collection\n/);
  assert.match(gone, /removed_from_collection: \d{4}-\d\d-\d\d\ncssclasses:/);
  assert.match(gone, /Sold at a fair\./);
  assert.strictEqual(eng.removed, 1);
});

test("a base whose format no record has is reported", async () => {
  const minidiscs = { id: "md", name: "Minidiscs", formats: ["Minidisc"], dir: "Music/Minidiscs", tag: "minidiscs-library" };
  const { eng, log } = makeEngine(makeVault(), [VINYL, minidiscs], [item(1, ["Vinyl"])]);
  await eng.syncAll();
  assert.ok(log.some((l) => /Minidiscs: no record in your collection has the format Minidisc/.test(l)));
});

test("the sync works through Obsidian's Vault API, so Obsidian's index sees every change at once", async () => {
  // Writing past Obsidian to the disk left Dataview, and so the dashboard, showing a moved record in its old base.
  const vault = makeVault({ "Music": null, "Music/Vinyl": null, "Music/CDs": null, "Music/Vinyl/covers": null, "Music/CDs/covers": null,
    "Music/Vinyl/Misfiled.md": noteFor(5, "vinyl-library", "Bought at a fair.") });
  const log = [];
  const eng = new Engine(vaultFiles(vault.app), (l) => log.push(l), () => false, { username: "someone", lyrics: false, gallery: false, libraries: [VINYL, CDS], discogsToken: "t" });
  eng.discogs = makeEngine(vault, [VINYL, CDS], [item(5, ["CD"]), item(6, ["Vinyl"])]).eng.discogs;
  await eng.syncAll();
  assert.ok(vault.calls.includes("renameFile Music/Vinyl/Misfiled.md → Music/CDs/Misfiled.md"), "moved with Obsidian's file manager, so links follow");
  assert.ok(vault.calls.some((c) => c.startsWith("modify Music/Vinyl/Misfiled.md")), "retagged through the vault");
  assert.ok(vault.calls.some((c) => /^create Music\/Vinyl\/.*\.md$/.test(c)), "new notes created through the vault");
  assert.match(vault.text("Music/CDs/Misfiled.md"), /  - cd-library\n[\s\S]*Bought at a fair\./);
});

// ------------------------------------------------------------------ nothing outside the plugin

test("tokens are kept in Obsidian's local storage, never in a file", async () => {
  const { p, files } = await makePlugin(undefined);
  p.saveToken("discogs", "  abc123 ");
  assert.strictEqual(p.token("discogs"), "abc123");
  assert.strictEqual(p.token("genius"), "");
  assert.deepStrictEqual([...files.values()].filter((f) => f.text !== null), [], "no file written");
  p.saveToken("discogs", "");
  assert.strictEqual(p.token("discogs"), "", "an empty token clears it");
});

test("tokens that earlier versions kept in files are read in once", async () => {
  const { p } = await makePlugin({ username: "someone", libraries: [] }, { "Music/.discogs-token": "old-token\n" });
  assert.strictEqual(p.token("discogs"), "old-token");
  assert.strictEqual(p.token("genius"), "", "a missing file is skipped");
});

test("files earlier versions made are listed, and moved to the trash only when asked", async () => {
  const old = [{ id: "vinyl", name: "Vinyl", formats: ["Vinyl"], dir: "Music/Vinyl", tag: "vinyl-library", icon: "disc-3", base: "Music/Vinyl.base" }];
  const { p, calls, text } = await makePlugin({ username: "someone", libraries: old }, {
    "Music/Vinyl.base": "view", "Music/All Media.base": "all", "Music/Music Dashboard.md": "dash", "Music/.discogs-token": "t",
    "Music/.vinyl-sync/collection-value.json": "{}", "Music/Vinyl/Record.md": "a record" });
  assert.strictEqual(p.data.libraries[0].base, undefined, "the base no longer points at a .base file");
  const legacy = await p.legacyFilesPresent();
  assert.deepStrictEqual(legacy.sort(), ["Music/.discogs-token", "Music/.vinyl-sync/collection-value.json", "Music/All Media.base", "Music/Music Dashboard.md", "Music/Vinyl.base"]);
  assert.strictEqual(calls.filter((c) => c.startsWith("trash")).length, 0, "nothing removed without asking");
  await p.trashLegacyFiles(legacy);
  assert.deepStrictEqual(await p.legacyFilesPresent(), []);
  assert.ok(calls.includes("trash Music/Vinyl.base") && calls.includes("trashSystem Music/.discogs-token"), "indexed files through Obsidian, dot-files directly");
  assert.strictEqual(text("Music/Vinyl/Record.md"), "a record", "record notes are never touched");
});

test("Discogs' collection value is decoded into the plugin's settings, not a file", async () => {
  const { eng } = makeEngine(makeVault(), [VINYL], []);
  eng.discogs = async () => ({ minimum: "SEK10,742.13", median: "SEK24,997.50", maximum: "SEK64,759.00" });
  const v = await eng.collectionValue();
  assert.deepStrictEqual([v.min, v.med, v.max], [10742, 24998, 64759]);
  eng.discogs = async () => ({});
  const none = await eng.collectionValue();
  assert.deepStrictEqual([none.min, none.med, none.max], [null, null, null]);
});
