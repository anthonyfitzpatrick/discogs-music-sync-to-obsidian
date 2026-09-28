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
  assert.deepStrictEqual(p.data.libraries.map((l) => l.name), ["Vinyl", "CDs", "Tapes"]);
  assert.strictEqual(p.data.username, "discogs-user");
  assert.strictEqual(p.data.pdf.orientation, "landscape");
});

test("saved bases and username are kept as they are", async () => {
  const libs = [{ id: "lps", name: "LPs", discogsFolder: "LP", dir: "Music/LPs", tag: "lps-library", icon: "disc-3", base: "Music/LPs.base" }];
  const { p } = await makePlugin({ username: "someone", libraries: libs });
  assert.strictEqual(p.data.username, "someone");
  assert.deepStrictEqual(p.data.libraries, libs);
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
  const lib = await p.addLibrary({ name: " Mini  Discs ", discogsFolder: "", icon: "disc-2" });
  assert.deepStrictEqual(lib, { id: "mini-discs", name: "Mini Discs", discogsFolder: "Mini Discs", dir: "Music/Mini Discs",
    tag: "mini-discs-library", icon: "disc-2", base: "Music/Mini Discs.base" });
  assert.match(text("Music/Mini Discs.base"), /file\.inFolder\("Music\/Mini Discs"\)/);
  assert.match(text("Music/All Media.base"), /- file\.hasTag\("mini-discs-library"\)/);
  await p.addLibrary({ name: "Box Sets", discogsFolder: "Box" });
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
  const check = (name, self = null) => p.checkLibrary({ name, discogsFolder: "" }, self);
  assert.match(await check("vinyl"), /already a base called “Vinyl”/, "the naming rules apply");
  assert.match(await check("Exports"), /already has a folder called “Exports”/);
  assert.match(await check("old"), /already has a file called “old\.base”/);
  assert.strictEqual(await check("Tapes", p.data.libraries[2]), "", "a base doesn't clash with itself or its own files");
  assert.strictEqual(await check("Minidiscs"), "");
});

test("renaming a base renames its .base file, including a change of case only", async () => {
  const { p, app } = await makePlugin({ last: null }, { "Music/Tapes.base": "x" });
  const tapes = p.data.libraries[2];
  await p.updateLibrary(tapes, { name: "Cassettes", discogsFolder: "Cassette" });
  assert.ok(app.vault.getAbstractFileByPath("Music/Cassettes.base"));
  assert.strictEqual(tapes.dir, "Music/Tapes", "notes stay where they are");
  await p.updateLibrary(tapes, { name: "cassettes", discogsFolder: "Cassette" });
  assert.ok(app.vault.getAbstractFileByPath("Music/cassettes.base"));
});

test("the last base can be removed", async () => {
  const { p } = await makePlugin(undefined);
  const lib = await p.addLibrary({ name: "Vinyl" });
  await p.removeLibrary(lib);
  assert.deepStrictEqual(p.data.libraries, []);
});

test("setting up from Discogs adds a base per folder, with a fitting icon, and skips clashes", async () => {
  const { p } = await makePlugin(undefined);
  const { added, skipped } = await p.addFromDiscogs(["Vinyl", "CD", "Cassette", "Box Sets", "vinyl"]);
  assert.deepStrictEqual(added.map((l) => [l.name, l.icon]), [["Vinyl", "disc-3"], ["CD", "disc"], ["Cassette", "cassette-tape"], ["Box Sets", "music"]]);
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

test("reading Discogs folders reports why it failed instead of returning nothing", async () => {
  const { p } = await makePlugin(undefined, {});
  await assert.rejects(p.discogsFolders(), /No Discogs token saved yet/);
  await p.app.vault.adapter.write("Music/.discogs-token", "t0ken\n");
  await assert.rejects(p.discogsFolders(), /No Discogs username entered yet/);
  p.data.username = "someone";
  for (const [status, why] of [[401, /didn't accept the token/], [404, /no user called “someone”/], [502, /answered 502/]]) {
    network = async () => ({ status, json: {} });
    await assert.rejects(p.discogsFolders(), why);
  }
  network = async (req) => {
    assert.match(req.url, /users\/someone\/collection\/folders$/);
    assert.strictEqual(req.headers.Authorization, "Discogs token=t0ken");
    return { status: 200, json: { folders: [{ name: "All" }, { name: "Vinyl" }, { name: "Uncategorized" }] } };
  };
  assert.deepStrictEqual(await p.discogsFolders(), ["Vinyl", "Uncategorized"]);
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
