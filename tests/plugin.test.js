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
    registerMarkdownCodeBlockProcessor() {} addRibbonIcon() {} addCommand() {} addSettingTab() {} registerInterval() {}
  },
  PluginSettingTab: class { constructor(app) { this.app = app; } },
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
const { Engine } = Plugin;

// An in-memory vault whose paths are case-insensitive, like the default macOS and Windows disks.
function makeVault(entries = {}) {
  const files = new Map();
  const put = (p, text = null) => files.set(p.toLowerCase(), { path: p, text });
  for (const [p, t] of Object.entries(entries)) put(p, t);
  const adapter = {
    exists: async (p) => files.has(p.toLowerCase()),
    read: async (p) => files.get(p.toLowerCase()).text,
    write: async (p, t) => put(p, t),
    mkdir: async (p) => put(p),
    writeBinary: async (p) => put(p, "<binary>"),
    rename: async (from, to) => { const f = files.get(from.toLowerCase()); files.delete(from.toLowerCase()); f.path = to; files.set(to.toLowerCase(), f); },
    list: async (dir) => ({ files: [...files.values()].filter((f) => f.text !== null && path.posix.dirname(f.path) === dir).map((f) => f.path), folders: [] }),
  };
  const app = {
    vault: {
      adapter,
      getAbstractFileByPath: (p) => { const f = files.get(p.toLowerCase()); return f && f.path === p ? f : null; },
      createFolder: async (p) => put(p),
      create: async (p, t) => { if (files.has(p.toLowerCase())) throw new Error("File already exists"); put(p, t); },
      process: async (f, fn) => { f.text = fn(f.text); },
    },
    fileManager: { renameFile: async (f, to) => { files.delete(f.path.toLowerCase()); f.path = to; files.set(to.toLowerCase(), f); } },
    plugins: { enabledPlugins: new Set(), plugins: {} },
    workspace: { getLeavesOfType: () => [] },
  };
  return { app, files, text: (p) => files.get(p.toLowerCase())?.text };
}

// A collection item as Discogs sends it.
const item = (instance, formats) => ({ id: instance * 10, instance_id: instance, date_added: "2026-09-01T12:00:00-07:00", notes: [],
  basic_information: { formats: formats.map((name) => ({ name, qty: "1" })) } });

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

test("settings from before 0.8 get the original three bases and username", async () => {
  const { p } = await makePlugin({ last: null, pdf: { size: "A4", orientation: "landscape" } });
  assert.deepStrictEqual(p.data.libraries.map((l) => [l.name, l.formats]), [["Vinyl", ["Vinyl"]], ["CDs", ["CD"]], ["Tapes", ["Cassette"]]]);
  assert.strictEqual(p.data.username, "discogs-user");
  assert.strictEqual(p.data.pdf.orientation, "landscape");
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
  assert.deepStrictEqual(p.data.libraries, [{ id: "cds", name: "CDs", formats: ["CD"], dir: "Music/CDs", tag: "cd-library", icon: "disc", base: "Music/CDs.base" }]);
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

test("adding a base in an empty vault creates its folder, its .base file and All Media.base", async () => {
  const { p, text } = await makePlugin(undefined);
  const lib = await p.addLibrary({ name: " Mini  Discs ", formats: ["Minidisc"], icon: "disc-2" });
  assert.deepStrictEqual(lib, { id: "mini-discs", name: "Mini Discs", formats: ["Minidisc"], dir: "Music/Mini Discs",
    tag: "mini-discs-library", icon: "disc-2", base: "Music/Mini Discs.base" });
  assert.match(text("Music/Mini Discs.base"), /file\.inFolder\("Music\/Mini Discs"\)/);
  assert.match(text("Music/All Media.base"), /- file\.hasTag\("mini-discs-library"\)/);
  await p.addLibrary({ name: "Box Sets", formats: ["Box Set"] });
  const all = text("Music/All Media.base");
  assert.match(all, /hasTag\("mini-discs-library"\)\n\s+- file\.hasTag\("box-sets-library"\)/);
});

test("missing files of existing bases are created, and existing files are left alone", async () => {
  const { p, text } = await makePlugin({ last: null }, { "Music/Vinyl.base": "custom view" });
  for (const lib of p.data.libraries) await p.ensureLibraryFiles(lib);
  assert.strictEqual(text("Music/Vinyl.base"), "custom view");
  assert.match(text("Music/CDs.base"), /hasTag\("cd-library"\)/);
  const all = text("Music/All Media.base");
  for (const t of ["vinyl-library", "cd-library", "tape-library"]) assert.ok(all.includes(`file.hasTag("${t}")`), t);
});

test("checking a base adds the vault's own clashes to the naming rules", async () => {
  // The naming rules themselves are tested directly in bases.test.js.
  const { p } = await makePlugin({ last: null }, { "Music/Exports": null, "Music/Old.base": "x" });
  const check = (name, self = null) => p.checkLibrary({ name, formats: self ? self.formats : ["Minidisc"] }, self);
  assert.match(await check("vinyl"), /already a base called “Vinyl”/, "the naming rules apply");
  assert.match(await check("Exports"), /already has a folder called “Exports”/);
  assert.match(await check("old"), /already has a file called “old\.base”/);
  assert.strictEqual(await check("Tapes", p.data.libraries[2]), "", "a base doesn't clash with itself or its own files");
  assert.strictEqual(await check("Minidiscs"), "");
});

test("renaming a base renames its .base file, including a change of case only", async () => {
  const { p, app } = await makePlugin({ last: null }, { "Music/Tapes.base": "x" });
  const tapes = p.data.libraries[2];
  await p.updateLibrary(tapes, { name: "Cassettes", formats: ["Cassette"] });
  assert.ok(app.vault.getAbstractFileByPath("Music/Cassettes.base"));
  assert.strictEqual(tapes.dir, "Music/Tapes", "notes stay where they are");
  await p.updateLibrary(tapes, { name: "cassettes", formats: ["Cassette"] });
  assert.ok(app.vault.getAbstractFileByPath("Music/cassettes.base"));
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

test("the dashboard is built from the template bundled in main.js", async () => {
  const { app, text } = makeVault();
  const eng = new Engine(app.vault.adapter, () => {}, () => false, { username: "someone" });
  eng.discogs = async () => { throw new Error("offline"); };
  await eng.dashboard();
  const note = text("Music/Music Dashboard.md");
  assert.match(note, /^# Music Dashboard/);
  assert.match(note, /```dataviewjs/);
  assert.match(note, /No bases to show yet/);
});

test("the dashboard reports the plugins it needs", async () => {
  const { p, app } = await makePlugin(undefined);
  assert.strictEqual(p.dashboardProblems().length, 2);
  app.plugins.enabledPlugins = new Set(["dataview", "obsidian-charts"]);
  app.plugins.plugins.dataview = { settings: { enableDataviewJs: false } };
  assert.deepStrictEqual(p.dashboardProblems(), ["Turn on “Enable JavaScript Queries” in Dataview's settings."]);
  app.plugins.plugins.dataview.settings.enableDataviewJs = true;
  assert.deepStrictEqual(p.dashboardProblems(), []);
});

test("reading the collection's formats reports why it failed instead of returning nothing", async () => {
  const { p } = await makePlugin(undefined, {});
  await assert.rejects(p.collectionFormats(), /No Discogs token saved yet/);
  await p.app.vault.adapter.write("Music/.discogs-token", "t0ken\n");
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

test("the dashboard's CSS has no declarations outside a rule", () => {
  // Leftover declarations with no selector turn into a bogus selector and swallow the next
  // rule as their body. It happened: the dashboard's table rule was lost that way.
  const template = require("node:fs").readFileSync(path.join(__dirname, "..", "src", "dashboard-template.md"), "utf8");
  const sheets = [...template.matchAll(/root\.createEl\("style", \{ text: (?:`([\s\S]*?)`|"((?:[^"\\]|\\.)*)") \}\)/g)]
    .map((m) => m[1] ?? JSON.parse(`"${m[2]}"`));
  assert.ok(sheets.length >= 2, "found the dashboard's style sheets");
  for (const css of sheets) {
    let depth = 0, selector = "";
    for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
      if (ch === "{") { if (depth++ === 0) { assert.doesNotMatch(selector, /[;]/, `declarations outside a rule: ${selector.trim().slice(0, 80)}`); selector = ""; } }
      else if (ch === "}") { assert.ok(depth > 0, "a closing brace with no rule open"); depth--; }
      else if (depth === 0) selector += ch;
    }
    assert.strictEqual(depth, 0, "every rule is closed");
  }
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
