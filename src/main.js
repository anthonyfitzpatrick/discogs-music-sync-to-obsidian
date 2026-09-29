/* Discogs music sync and dashboard (plugin ID discogs-music-sync) — Wolf 359 Press.
   Pure JavaScript: talks to Discogs + Genius with Obsidian's requestUrl and writes notes
   through the vault adapter. No Python required.
   Safety: never overwrites an existing album note (except price fields on "Refresh prices").
   Assumes nothing about the vault: every folder comes from the settings. */
import { Plugin, PluginSettingTab, Notice, requestUrl, setIcon, moment, Modal, Setting, normalizePath } from "obsidian";

// The library folder a new install starts with; the user can choose another in settings.
const DEFAULT_FOLDER = "Music";
// A folder path as typed, cleaned: no leading/trailing slashes, single slashes, no empty parts.
const cleanFolder = (v) => {
  const f = String(v ?? "").split("/").map((x) => x.trim()).filter(Boolean).join("/");
  return f ? normalizePath(f) : "";
};
// Why a folder name typed in settings can't be used, or "" when it can.
const folderProblem = (v) => {
  const f = cleanFolder(v);
  if (!f) return "Enter a folder name.";
  if (f.split("/").some((part) => part.startsWith(".") || /[\\:*?"<>|#^[\]]/.test(part))) return "Use a folder name without \\ : * ? \" < > | # ^ [ ], not starting with a dot.";
  return "";
};
const VERSION = "1.0.1";
const UA = `Wolf359DiscogsMusicSync/${VERSION}`;
// Pure logic, testable without Obsidian: names, tags, icons, naming rules, placement by format.
import { tidy, slug, guessIcon, nameProblem, baseFor, formatCounts, basesNeeded, sameFormat } from "./bases.js";
// Decoders for Discogs responses, applied where the responses arrive.
import { decodeCollectionPage, decodeIdentity, decodeProfileCurrency, decodeMoneyText } from "./discogs.js";
// Currencies: the choices, how money is written, and the default until the account's is known.
import { DEFAULT_CURRENCY, LEGACY_CURRENCY, currencyCode, currencyOptions, formatMoney } from "./currency.js";
// The dashboard as a standalone page for PDF export, built without Dataview or Charts.
import { decodeRecord, decodeCollectionValue, cssColorToHex, buildReport, SECTIONS, COLOUR_MODES, FULL_BASES, DEFAULT_ACCENT } from "./report.js";
// The plugin's own view — the Dashboard and Library tabs — in place of a dashboard note and .base files.
import { MusicView, MUSIC_VIEW, OLD_VIEWS, openNote } from "./views.js";

const REPO = "https://github.com/anthonyfitzpatrick/discogs-music-sync-to-obsidian";
// Where each service issues tokens, and the steps, shown under each token field in settings.
const TOKEN_HELP = {
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

// A "base" (library) takes the records of one or more Discogs formats into its own vault folder, with
// its own tag, and its own place in the Library and Dashboard views. A new install starts with none and
// sets them up from the formats in the user's collection.
const DEFAULTS = { last: null, username: "", folder: DEFAULT_FOLDER, lyrics: true, gallery: true, pdf: { size: "A4", orientation: "portrait" },
  value: null,                                   // Discogs' own value of the collection, fetched with each sync
  tab: "dashboard",                              // the Music tab shown last: dashboard or library
  library: { base: "", view: "gallery", size: "small", sort: "", search: "" },   // the Library's last choices
  legacyFiles: [],                               // files earlier versions made, offered for removal in settings
  valueHistory: [],                              // Discogs' value of the collection, one entry per day it was fetched
  sections: {},                                  // dashboard sections turned off: { key: false }
  autoBases: true,                               // a sync creates a base for each format that has none
  currency: "",                                   // prices' currency; "" = the Discogs account's, set at the first sync or Test
  rates: {},                                     // Discogs' exchange rates last measured: { "SEK>USD": { rate, date } }
  skippedFormats: [],                            // formats whose base the user stopped syncing: not created again
  colours: { mode: "theme", bases: {}, accent: DEFAULT_ACCENT } };   // bases: colour per base id, for Custom
// Files versions before 0.11 kept in the vault, which the plugin no longer uses. Those versions always
// used a folder called Music, so only there. Offered for removal in settings, never removed without
// asking; in any other vault they simply aren't found. (Each base's .base file is added on loading.)
const LEGACY_FILES = ["Music/Music Dashboard.md", "Music/All Media.base", "Music/.discogs-token", "Music/.genius-token",
  "Music/.vinyl-sync/collection-value.json", "Music/.vinyl-sync/last-export.html"];
// Tokens live in Obsidian's secret storage on this device, which the operating system encrypts: never in a
// file, so never in git. (Versions before 0.13 kept them in local storage, under the same names.)
const TOKEN_KEYS = { discogs: "discogs-music-sync-discogs-token", genius: "discogs-music-sync-genius-token" };
// Their names before 0.16, when the plugin's ID was music-library-sync: in the keychain from 0.13, and in
// local storage in 0.11–0.12. Moved to the names above on loading.
const OLD_TOKEN_KEYS = { discogs: "music-library-sync-discogs-token", genius: "music-library-sync-genius-token" };
const ICONS = ["disc-3", "disc", "disc-2", "cassette-tape", "album", "music", "music-2", "radio", "headphones", "library", "guitar", "piano"];
// A record note's price properties. price_currency says which currency the amounts are in.
const PRICE_KEYS = ["price_low", "price_mid", "price_high", "price_max", "price_my_copy", "market_lowest", "market_for_sale", "price_currency", "price_checked"];
// Their names before 0.16, when every price was in kronor. Refresh prices replaces them with the above.
const OLD_PRICE_KEYS = ["price_low_sek", "price_mid_sek", "price_high_sek", "price_max_sek", "price_my_copy_sek", "market_lowest_sek"];
const GRADE = { low: "Good Plus (G+)", mid: "Very Good Plus (VG+)", high: "Near Mint (NM or M-)" };

/* ------------------------------------------------------------------ helpers */
const pause = (ms) => new Promise((r) => window.setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const q = (v) => JSON.stringify(v ?? "");
const cleanName = (n) => (n || "").replace(/\s\(\d+\)$/, "").trim();
function artistsStr(arts) {
  let s = "";
  for (const a of arts || []) {
    s += cleanName(a.anv || a.name);
    const j = (a.join || "").trim();
    s += j && j !== "," ? ` ${j} ` : j === "," ? ", " : "";
  }
  return s.replace(/\s+/g, " ").replace(/^[\s,]+|[\s,]+$/g, "");
}
const safe = (s) => s.replace(/[\\/:*?"<>|#^[\]]/g, "").trim().replace(/\.+$/, "");
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const n2 = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[\u0080-\uffff]/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const core = (title) => {
  let t = String(title).split(" – ").pop();
  t = t.replace(/\s*[([].*?[)\]]/g, "").replace(/\s+-\s+(live|remaster|mono|stereo|single|edit|version).*$/i, "");
  return n2(t);
};
const artistOk = (want, got) => {
  const w = n2(want).replace(/^the/, ""), g = n2(got).replace(/^the/, "");
  if (!w || w === "various") return false;
  return w === g || (g.length >= 4 && (w.includes(g) || g.includes(w)));
};
const titleOk = (got, want) => got === want || (Math.min(got.length, want.length) >= 6 && (got.startsWith(want) || want.startsWith(got)));
const splitArtists = (a) => [a, ...String(a).split(/\s+(?:featuring|feat\.?|ft\.?|with|and|&)\s+|\s*[·,/]\s*/i)].map((x) => x.trim()).filter((x, i, arr) => x && x.toLowerCase() !== "various" && arr.indexOf(x) === i);

// Sets properties in a note's frontmatter text (from the opening --- up to, not including, the closing
// one). blocks: key → its lines (the "key: value" line, and any "  - item" lines under it). A key already
// there is replaced where it stands, list lines included; a new one goes in before discogs_id. Every other
// property, and the order, is kept.
function setProperties(fm, blocks) {
  const lines = fm.split("\n"), out = [], done = new Set();
  for (let i = 0; i < lines.length; i++) {
    const key = lines[i].match(/^([A-Za-z_][\w-]*):/)?.[1];
    if (key && Object.hasOwn(blocks, key)) {
      out.push(...blocks[key]); done.add(key);
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) i++;       // its list lines
      continue;
    }
    out.push(lines[i]);
  }
  const missing = Object.keys(blocks).filter((k) => !done.has(k)).flatMap((k) => blocks[k]);
  const at = out.findIndex((l) => /^discogs_id:/.test(l));
  out.splice(at < 0 ? out.length : at, 0, ...missing);
  return out.join("\n");
}

/* ------------------------------------------------------------------ files */
// The engine's file access, through Obsidian's Vault API rather than straight to disk, so Obsidian's
// index — and with it Dataview and the dashboard — sees every new, changed and moved note at once,
// and a moved note's links follow it. Dot-folders such as Music/.vinyl-sync aren't indexed by
// Obsidian, so files there are written directly.
function vaultFiles(app) {
  const vault = app.vault, adapter = vault.adapter;
  const hidden = (p) => p.split("/").some((part) => part.startsWith("."));
  const file = (p) => vault.getAbstractFileByPath(p);
  return {
    exists: (p) => adapter.exists(p),
    read: (p) => { const f = hidden(p) ? null : vault.getFileByPath(p); return f ? vault.read(f) : adapter.read(p); },
    // Changes a file's text in one step, so an edit made in between (by the user, or another device's
    // sync) is never overwritten with an older copy.
    process: (p, fn) => { const f = hidden(p) ? null : vault.getFileByPath(p); return f ? vault.process(f, fn) : adapter.process(p, fn); },
    list: (p) => adapter.list(p),
    async mkdir(p) { if (hidden(p)) await adapter.mkdir(p); else if (!file(p)) await vault.createFolder(p); },
    async write(p, text) {
      if (hidden(p)) return adapter.write(p, text);
      const f = file(p);
      if (f) await vault.modify(f, text); else await vault.create(p, text);
    },
    async writeBinary(p, data) {
      if (hidden(p)) return adapter.writeBinary(p, data);
      const f = file(p);
      if (f) await vault.modifyBinary(f, data); else await vault.createBinary(p, data);
    },
    async rename(from, to) {
      const f = file(from);
      if (f) await app.fileManager.renameFile(f, to); else await adapter.rename(from, to);
    },
  };
}

/* ------------------------------------------------------------------ engine */
class Engine {
  // cfg: { username, lyrics, gallery, libraries } — a snapshot of the settings for this run
  constructor(adapter, log, isCancelled, cfg) {
    this.fs = adapter; this.log = log; this.isCancelled = isCancelled || (() => false);
    // cfg: also discogsToken and geniusToken, handed over by the plugin
    this.cfg = Object.assign({ username: "", folder: DEFAULT_FOLDER, lyrics: true, gallery: true, libraries: [], discogsToken: "", geniusToken: "", currency: "", rates: {} }, cfg);
    this.last = { discogs: 0, genius: 0 };
    this.noSuggest = false;
  }
  async http(kind, url, headers, binary) {
    const gap = kind === "discogs" ? 1100 : kind === "img" ? 300 : 350;
    const host = kind === "genius" ? "Genius" : "Discogs";
    for (let attempt = 0; attempt < 6; attempt++) {
      if (this.isCancelled()) throw new Error("Cancelled");
      const wait = gap - (Date.now() - (this.last[kind] || 0));
      if (wait > 0) await pause(wait);
      this.last[kind] = Date.now();
      let r;
      try {
        r = await Promise.race([requestUrl({ url, headers, throw: false }),
          pause(30000).then(() => { throw new Error("timeout"); })]);
      } catch (e) { this.log(`  ${host} didn't answer (${e.message}) — retrying ${attempt + 1}/5…`); await pause(3000 * (attempt + 1)); continue; }
      if (r.status === 429 || r.status >= 500) {
        const w = kind === "discogs" ? 15000 : 3000 * (attempt + 1);
        this.log(`  ${host} is busy (${r.status}) — waiting ${Math.round(w / 1000)} s…`); await pause(w); continue; }
      if (r.status >= 400) { const err = new Error(`${r.status} ${url}`); err.status = r.status; err.body = r.text; throw err; }
      return binary ? r.arrayBuffer : r.json;
    }
    throw new Error(`Gave up on ${url}`);
  }
  discogs(path, binary) {
    const url = path.startsWith("http") ? path : `https://api.discogs.com/${path}`;
    return this.http(binary ? "img" : "discogs", url, { Authorization: `Discogs token=${this.dToken}`, "User-Agent": UA }, binary);
  }
  genius(qs) { return this.http("genius", `https://api.genius.com/search?q=${encodeURIComponent(qs)}`, { Authorization: `Bearer ${this.gToken}` }); }

  async init() {
    if (!this.cfg.discogsToken) throw new Error("No Discogs token saved yet");
    this.dToken = this.cfg.discogsToken;
    this.gToken = this.cfg.geniusToken || null;
  }
  async ensureDir(p) { if (!(await this.fs.exists(p))) await this.fs.mkdir(p); }
  async listNotes(dir) {
    if (!(await this.fs.exists(dir))) return [];
    return (await this.fs.list(dir)).files.filter((f) => f.endsWith(".md"));
  }

  /* ---- Genius direct link for one track ---- */
  async lyricsUrl(artist, title, albumTitle) {
    if (!this.gToken || !this.cfg.lyrics) return "";
    const short = String(title).split(" – ").pop(), want = core(title);
    const arts = splitArtists(artist);
    const queries = [...arts.map((a) => `${a} ${short}`), short];
    for (const qs of queries) {
      let d; try { d = await this.genius(qs); } catch (e) { this.log(`  genius: ${e.message}`); return ""; }
      for (const h of d?.response?.hits || []) {
        const r = h.result || {};
        if (h.type !== "song" || !titleOk(core(r.title || ""), want)) continue;
        const names = [r.primary_artist?.name || "", ...(r.featured_artists || []).map((a) => a.name)];
        if (arts.some((a) => names.some((nm) => artistOk(a, nm)))) return r.url;
        const pa = r.primary_artist?.name || "";
        if (/cast|soundtrack|original|broadway|london|company/i.test(pa) && n2(albumTitle).slice(0, 8) && n2(pa).includes(n2(albumTitle).slice(0, 8))) return r.url;
      }
    }
    return "";
  }

  /* ---- fill missing durations from master + main release ---- */
  async durationFill(rel) {
    const all = (rel.tracklist || []).flatMap((t) => [t, ...(t.sub_tracks || [])]);
    if (all.every((t) => t.type_ !== "track" || t.duration)) return {};
    const found = {};
    const absorb = (src) => (src?.tracklist || []).flatMap((t) => [t, ...(t.sub_tracks || [])])
      .forEach((x) => { if (x.duration && !(norm(x.title) in found)) found[norm(x.title)] = x.duration; });
    if (rel.master_id) {
      try {
        const m = await this.discogs(`masters/${rel.master_id}`); absorb(m);
        if (m.main_release && String(m.main_release) !== String(rel.id)) absorb(await this.discogs(`releases/${m.main_release}`));
      } catch (e) { this.log(`  lengths: ${e.message}`); }
    }
    return found;
  }

  async tracklist(rel) {
    const fill = await this.durationFill(rel);
    const albumArtist = artistsStr(rel.artists);
    const rows = ["| # | Title | Length | Lyrics |", "|---|---|---|---|"];
    const row = async (pos, title, dur, arts) => {
      const art = arts?.length ? artistsStr(arts) : albumArtist;
      const url = this.isCancelled() ? "" : await this.lyricsUrl(art, title, rel.title);
      return `| ${pos || ""} | ${String(title).replace(/\|/g, "/")} | ${dur || fill[norm(title)] || ""} | ${url ? `[Lyrics](${url})` : ""} |`;
    };
    for (const t of rel.tracklist || []) {
      if (t.type_ === "heading") rows.push(`| | **${t.title}** | | |`);
      else if (t.type_ === "index") {
        rows.push(`| ${t.position || ""} | **${t.title}** | ${t.duration || ""} | |`);
        for (const x of t.sub_tracks || []) rows.push(await row(x.position, `${t.title} – ${x.title}`, x.duration, x.artists || t.artists));
      } else rows.push(await row(t.position, t.title, t.duration, t.artists));
    }
    return rows.join("\n");
  }

  /* ---- currencies ---- */
  // The currency prices are kept in (the one chosen in settings, else the Discogs account's), and the
  // account's own: Discogs gives price suggestions and the collection's value only in the account's.
  async currencies() {
    if (this.cur) return this.cur;
    let account = "";
    try { account = decodeProfileCurrency(await this.discogs(`users/${encodeURIComponent(this.cfg.username)}`)); }
    catch (e) { this.log(`  (couldn't read your Discogs account's currency: ${e.message})`); }
    const target = currencyCode(this.cfg.currency) || account || DEFAULT_CURRENCY;
    this.cur = { target, account: account || target };
    if (!currencyCode(this.cfg.currency)) { this.cfg.currency = target; this.cfg.onCurrency?.(target); }
    if (target !== this.cur.account) this.log(`Prices in ${target}, converted from your Discogs account's ${this.cur.account} at Discogs' rates`);
    return this.cur;
  }
  // How much one unit of the account's currency is worth in the target currency, as Discogs converts it:
  // the same release's cheapest listing asked for in both. Measured once a run, from the first release
  // that has a listing, and kept between runs (cfg.rates) for when none does.
  async rate(releaseId, targetLowest) {
    const { target, account } = await this.currencies();
    if (target === account) return 1;
    const key = `${account}>${target}`;
    if (this.fresh?.[key]) return this.fresh[key];
    if (releaseId && targetLowest) {
      try {
        const st = await this.discogs(`marketplace/stats/${releaseId}?curr_abbr=${account}`);
        const there = st?.lowest_price?.value;
        if (there > 0) {
          const r = targetLowest / there;
          this.fresh = { ...this.fresh, [key]: r };
          this.cfg.rates[key] = { rate: r, date: today() };
          return r;
        }
      } catch (e) { this.log(`  exchange rate: ${e.message}`); }
    }
    return this.cfg.rates[key]?.rate ?? null;
  }
  // A rate when no release is at hand (a value refresh on its own): tried on the first few releases.
  async anyRate() {
    const { target, account } = await this.currencies();
    if (target === account) return 1;
    const key = `${account}>${target}`;
    if (this.fresh?.[key]) return this.fresh[key];
    const items = this.items || decodeCollectionPage(await this.discogs(`users/${this.cfg.username}/collection/folders/0/releases?per_page=10&page=1`)).items;
    for (const item of items.slice(0, 10)) {
      const st = await this.discogs(`marketplace/stats/${item.id}?curr_abbr=${target}`).catch(() => null);
      if (st?.lowest_price?.value > 0) { const r = await this.rate(item.id, st.lowest_price.value); if (this.fresh?.[key]) return r; }
    }
    return this.cfg.rates[key]?.rate ?? null;
  }

  async prices(releaseId, myCondition) {
    const out = Object.fromEntries(PRICE_KEYS.map((k) => [k, ""]));
    const { target } = await this.currencies();
    let lowest = null;
    try {
      const st = await this.discogs(`marketplace/stats/${releaseId}?curr_abbr=${target}`);
      if (st?.lowest_price?.value != null) { lowest = st.lowest_price.value; out.market_lowest = Math.round(lowest); }
      out.market_for_sale = st?.num_for_sale ?? "";
    } catch (e) { this.log(`  stats: ${e.message}`); }
    if (!this.noSuggest) {
      try {
        const s = await this.discogs(`marketplace/price_suggestions/${releaseId}`);
        const rate = await this.rate(releaseId, lowest);
        if (rate === null) this.log("  (no exchange rate yet, so no price suggestions for this record: Refresh prices adds them)");
        const v = (g) => (s[g] && rate !== null ? Math.round(s[g].value * rate) : "");
        out.price_low = v(GRADE.low); out.price_mid = v(GRADE.mid); out.price_high = v(GRADE.high); out.price_max = v("Mint (M)");
        if (myCondition) out.price_my_copy = v(myCondition);
      } catch { this.noSuggest = true; this.log("  (price suggestions need Discogs Seller Settings — skipping)"); }
    }
    out.price_currency = target;
    out.price_checked = today();
    return out;
  }

  /* ---- the whole Discogs collection, every folder, decoded page by page ---- */
  async collection() {
    if (this.items) return this.items;
    let items = [], page = 1;
    while (true) {
      const d = decodeCollectionPage(await this.discogs(`users/${this.cfg.username}/collection/folders/0/releases?per_page=100&page=${page}`));
      items = items.concat(d.items);
      if (page >= d.pages) break; page++;
    }
    return (this.items = items);
  }

  /* ---- place every record in the base for its format, and bring the notes in line ----
     onBase(lib, index, done, total) reports progress as each base's new records are added. */
  async syncAll(onBase) {
    const libs = this.cfg.libraries;
    this.log("Reading your Discogs collection…");
    const items = await this.collection();
    // 0. a base, named after the format, for each format no base takes yet (when the plugin creates them)
    if (this.cfg.createBases) {
      const { added, skipped } = await this.cfg.createBases(items);
      for (const lib of added) { libs.push(lib); this.log(`+ New base ${lib.name} for ${lib.formats.join(", ")} records → ${lib.dir}`); }
      for (const why of skipped) this.log(`⚠ No base created for ${why}`);
    }
    const fieldMap = await this.fieldMap();

    // 1. every record goes to the base that takes its format; the rest are reported, never guessed
    const placed = new Map(libs.map((l) => [l.id, []])), unplaced = new Map();
    for (const item of items) {
      const lib = baseFor(item.formats, libs);
      if (lib) placed.get(lib.id).push(item);
      else { const k = item.formats.join(" + ") || "no format"; unplaced.set(k, (unplaced.get(k) || 0) + 1); }
    }
    for (const l of libs) if (!placed.get(l.id).length) this.log(`⚠ ${l.name}: no record in your collection has the format ${l.formats.join(" or ")}`);
    for (const [k, n] of unplaced) this.log(`⚠ ${n} record${n === 1 ? "" : "s"} with the format ${k} ${n === 1 ? "has" : "have"} no base — add one in settings to sync ${n === 1 ? "it" : "them"}`);
    this.unplaced = [...unplaced.values()].reduce((a, n) => a + n, 0);

    // 2. where every existing record note is, across all bases
    const where = new Map();
    for (const l of libs) {
      await this.ensureDir(l.dir); await this.ensureDir(`${l.dir}/covers`);
      for (const p of await this.listNotes(l.dir)) {
        const inst = (await this.fs.read(p)).match(/^discogs_instance:[ \t]*(\d+)/m)?.[1];
        if (inst) where.set(inst, { path: p, lib: l });
      }
    }

    // 3. records no longer in the collection: moved out, never deleted
    const inCollection = new Set(items.map((i) => i.instance));
    for (const [inst, note] of where) {
      if (inCollection.has(inst)) continue;
      await this.moveNote(note.path, `${this.cfg.folder}/Removed from collection`, note.lib.tag, "removed-from-collection", `removed_from_collection: ${today()}`);
      this.removed = (this.removed || 0) + 1;
      this.log(`  − ${note.path.split("/").pop().replace(/\.md$/, "")} is no longer in your Discogs collection → moved to "Removed from collection"`);
      where.delete(inst);
    }

    // 4. notes in the wrong base (the format says otherwise): moved to the right one and retagged
    for (const l of libs) for (const item of placed.get(l.id)) {
      const note = where.get(item.instance);
      if (!note || note.lib.id === l.id) continue;
      await this.moveNote(note.path, l.dir, note.lib.tag, l.tag, "");
      this.moved = (this.moved || 0) + 1;
      this.log(`  → ${note.path.split("/").pop().replace(/\.md$/, "")} is ${item.formats.join(" + ")} → moved from ${note.lib.name} to ${l.name}`);
    }

    // 5. new records
    let made = 0;
    for (const [i, l] of libs.entries()) {
      const todo = placed.get(l.id).filter((item) => !where.has(item.instance));
      this.log(`${l.name}: ${placed.get(l.id).length} in your collection, ${todo.length} new`);
      for (const [idx, item] of todo.entries()) {
        if (this.isCancelled()) break;
        onBase?.(l, i, idx, todo.length);
        await this.createNote(l, item, fieldMap);
        made++;
      }
      onBase?.(l, i, todo.length, todo.length);
    }
    return made;
  }

  // Moves a note to another folder, swapping one tag for another, and optionally adding a property.
  // The note's own text is kept; nothing is deleted.
  async moveNote(path, destDir, fromTag, toTag, addLine) {
    await this.ensureDir(destDir);
    const name = path.split("/").pop();
    let dest = `${destDir}/${name}`, n = 2;
    while (await this.fs.exists(dest)) dest = `${destDir}/${name.replace(/\.md$/, "")} (${n++}).md`;
    const tagLine = new RegExp(`^(\\s*-\\s*)#?${fromTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
    await this.fs.process(path, (text) => {
      const end = text.indexOf("\n---", 3);
      let fm = text.slice(0, end); const rest = text.slice(end);
      if (tagLine.test(fm)) fm = fm.replace(tagLine, `$1${toTag}`);
      else this.log(`  (couldn't find the tag ${fromTag} in ${name}; set its tag to ${toTag} yourself)`);
      if (addLine) fm = fm.replace("\ncssclasses:", `\n${addLine}\ncssclasses:`);
      return fm + rest;
    });
    await this.fs.rename(path, dest);
  }

  // The release's original year, from its master release.
  async masterYear(rel) {
    if (!rel.master_id) return "";
    try { return (await this.discogs(`masters/${rel.master_id}`)).year || ""; } catch (e) { this.log(`  original year: ${e.message}`); return ""; }
  }
  // The front cover, saved in the base's covers folder unless it is there already: its file name, or "".
  async saveCover(T, rel) {
    const imgs = rel.images || [];
    const img = imgs.find((x) => x.type === "primary") || imgs[0];
    if (!img?.uri) return "";
    const ext = (img.uri.split("?")[0].match(/\.(jpe?g|png|gif|webp)$/i)?.[0] || ".jpg").toLowerCase();
    const cover = `${rel.id}${ext}`, dest = `${T.dir}/covers/${cover}`;
    if (await this.fs.exists(dest)) return cover;
    await this.ensureDir(`${T.dir}/covers`);
    try { await this.fs.writeBinary(dest, await this.discogs(img.uri, true)); return cover; }
    catch (e) { this.log(`  cover failed: ${e.message}`); return ""; }
  }
  // The properties that come from Discogs, as frontmatter blocks (see setProperties). A new note is made
  // of these; Update record replaces only these, so what the user fills in is never touched.
  discogsProperties(rel, masterYear, cond, added) {
    const artist = artistsStr(rel.artists);
    const lab = (rel.labels || [{}])[0];
    const fmts = rel.formats || [];
    const fmtS = fmts.map((x) => `${x.qty || "1"}x ${x.name}` + (x.descriptions?.length ? ", " + x.descriptions.join(", ") : "")).join("; ");
    return {
      artist: [`artist: ${q(artist)}`], title: [`title: ${q(rel.title)}`], year: [`year: ${rel.year || ""}`],
      original_year: [`original_year: ${masterYear || rel.year || ""}`],
      genres: ["genres:", ...(rel.genres || []).map((g) => `  - ${q(g)}`)],
      styles: ["styles:", ...(rel.styles || []).map((g) => `  - ${q(g)}`)],
      label: [`label: ${q(cleanName(lab.name))}`], catno: [`catno: ${q(lab.catno)}`], country: [`country: ${q(rel.country)}`],
      format: [`format: ${q(fmtS)}`], media: [`media: ${q(fmts[0]?.name || "")}`],
      media_condition: [`media_condition: ${q(cond["Media Condition"] || "")}`], sleeve_condition: [`sleeve_condition: ${q(cond["Sleeve Condition"] || "")}`],
      added_to_discogs: [`added_to_discogs: ${added}`], discogs_url: [`discogs_url: ${q(rel.uri || "")}`],
    };
  }
  // The user's own fields for a copy (conditions, notes), by name.
  fields(item, fieldMap) { return Object.fromEntries(item.notes.map((n) => [fieldMap[n.field_id] || n.field_id, n.value])); }
  async fieldMap() {
    this.fieldNames ??= Object.fromEntries(((await this.discogs(`users/${this.cfg.username}/collection/fields`)).fields || []).map((x) => [x.id, x.name]));
    return this.fieldNames;
  }

  /* ---- one new record note ---- */
  async createNote(T, item, fieldMap) {
    const rel = await this.discogs(`releases/${item.id}`);
    const masterYear = await this.masterYear(rel);
    const cover = await this.saveCover(T, rel);
    const imgs = rel.images || [];
    // every other image Discogs has (back, labels, inner sleeves…)
    const gallery = [];
    if (this.cfg.gallery) await this.ensureDir(`${T.dir}/images`);
    for (const [n, im] of this.cfg.gallery ? imgs.entries() : []) {
      if (!im.uri || this.isCancelled()) continue;
      const ext = (im.uri.split("?")[0].match(/\.(jpe?g|png|gif|webp)$/i)?.[0] || ".jpg").toLowerCase();
      const fn = `${rel.id}-${String(n + 1).padStart(2, "0")}${ext}`, dest = `${T.dir}/images/${fn}`;
      if (!(await this.fs.exists(dest))) {
        try { await this.fs.writeBinary(dest, await this.discogs(im.uri, true)); } catch (e) { this.log(`  image failed: ${e.message}`); continue; }
      }
      gallery.push(fn);
    }
    const cond = this.fields(item, fieldMap);
    const pr = await this.prices(rel.id, cond["Media Condition"] || "");
    const artist = artistsStr(rel.artists);
    const d = this.discogsProperties(rel, masterYear, cond, item.added);
    const fm = [
      "---",
      ...d.artist, ...d.title, ...d.year, ...d.original_year, ...d.genres, ...d.styles,
      ...d.label, ...d.catno, ...d.country, ...d.format, ...d.media,
      `cover: ${cover ? q(`[[${cover}]]`) : ""}`,
      ...d.media_condition, ...d.sleeve_condition,
      "purchased: ", `shop: ""`, "price_paid: ",
      ...PRICE_KEYS.map((k) => `${k}: ${pr[k]}`),
      ...d.added_to_discogs,
      `discogs_id: ${rel.id}`, `discogs_instance: ${item.instance}`, ...d.discogs_url,
      "cssclasses:", "  - vinyl-record",
      "tags:", `  - ${T.tag}`,
      "---",
    ];
    const body = [`# ${artist} – ${rel.title}`, ""];
    if (cover) body.push(`![[${cover}|300]]`, "");
    body.push("## Tracklist", "", "<!-- tracklist v2 --><!-- g2 -->", await this.tracklist(rel), "",
      "## Images", "", gallery.length ? gallery.map((g) => `![[${g}|180]]`).join(" ") : this.cfg.gallery ? "_No images on Discogs._" : "_Images not downloaded (turned off in settings)._", "", "## Notes");
    if ((cond.Notes || "").trim()) body.push("", cond.Notes);
    const base = safe(`${artist} - ${rel.title}`).slice(0, 150);
    let p = `${T.dir}/${base}.md`, n = 2;
    while (await this.fs.exists(p)) p = `${T.dir}/${base} (${n++}).md`;
    await this.fs.write(p, fm.join("\n") + "\n" + body.join("\n") + "\n");
    this.log(`  + ${artist} – ${rel.title}`);
  }

  /* ---- one record, brought up to date with Discogs ---- */
  // Replaces the note's Discogs properties (details, conditions, prices), its tracklist (adding lyrics
  // links if they are on) and a missing cover, from Discogs as it is now. Everything the user fills in
  // (purchased, shop, price paid, listened, tags) and writes (Notes, anywhere outside the tracklist) is
  // kept. Returns what changed, for the notice.
  async updateRecord(T, path) {
    const text = await this.fs.read(path);
    const end = text.indexOf("\n---", 3);
    if (!text.startsWith("---") || end < 0) throw new Error("This note has no properties, so it isn't a record note");
    const id = text.slice(0, end).match(/^discogs_id:[ \t]*(\d+)/m)?.[1], instance = text.slice(0, end).match(/^discogs_instance:[ \t]*(\d+)/m)?.[1];
    if (!id) throw new Error("This note has no discogs_id, so it can't be matched to Discogs");
    const rel = await this.discogs(`releases/${id}`);
    const masterYear = await this.masterYear(rel);
    // this copy in the collection, for its conditions and date added
    const copies = decodeCollectionPage(await this.discogs(`users/${this.cfg.username}/collection/releases/${id}`)).items;
    const item = copies.find((c) => c.instance === instance) || copies[0];
    if (!item) throw new Error("This record is no longer in your Discogs collection");
    const cond = this.fields(item, await this.fieldMap());
    const pr = await this.prices(rel.id, cond["Media Condition"] || "");
    const hadCover = /^cover:[ \t]*\S/m.test(text.slice(0, end));
    const cover = hadCover ? "" : await this.saveCover(T, rel);
    const table = await this.tracklist(rel);
    const blocks = { ...this.discogsProperties(rel, masterYear, cond, item.added), ...Object.fromEntries(PRICE_KEYS.map((k) => [k, [`${k}: ${pr[k]}`]])) };
    if (cover) blocks.cover = [`cover: ${q(`[[${cover}]]`)}`];
    let changed = false;
    await this.fs.process(path, (now) => {
      const e = now.indexOf("\n---", 3);
      if (!now.startsWith("---") || e < 0) return now;
      let fm = setProperties(now.slice(0, e), blocks);
      fm = fm.replace(/^price_paid_sek:/m, "price_paid:");
      for (const k of OLD_PRICE_KEYS) fm = fm.replace(new RegExp(`^${k}:.*\\n?`, "m"), "");
      let body = now.slice(e);
      // the tracklist section, up to the next heading, is the plugin's own: it is rebuilt
      body = body.replace(/(\n## Tracklist\n)[\s\S]*?(?=\n## |$)/, (_m, head) => `${head}\n<!-- tracklist v2 --><!-- g2 -->\n${table}\n`);   // a function, so a "$" in a title is kept as it is
      if (cover && !/!\[\[[^\]]+\|300\]\]/.test(body)) body = body.replace(/(\n# [^\n]*\n)/, (_m, head) => `${head}\n![[${cover}|300]]\n`);
      changed = fm + body !== now;
      return fm + body;
    });
    this.log(`  ↻ ${artistsStr(rel.artists)} – ${rel.title}${changed ? "" : " (already up to date)"}`);
    return changed;
  }

  /* ---- refresh price fields only ---- */
  async refreshPrices(T, onProgress) {
    const notes = await this.listNotes(T.dir);
    let n = 0;
    for (const [idx, p] of notes.entries()) {
      if (this.isCancelled()) break;
      onProgress?.(idx, notes.length);
      const text = await this.fs.read(p);
      const end = text.indexOf("\n---", 3);
      if (!text.startsWith("---") || end < 0) continue;
      const id = text.slice(0, end).match(/^discogs_id:[ \t]*(\d+)/m)?.[1]; if (!id) continue;
      const mc = text.slice(0, end).match(/^media_condition:[ \t]*"?([^"\n]*)"?/m)?.[1]?.trim() || "";
      const pr = await this.prices(id, mc);
      // The prices go into the note as it is now: it may have been edited while Discogs was answering.
      let changed = false;
      await this.fs.process(p, (now) => {
        const e = now.indexOf("\n---", 3);
        if (!now.startsWith("---") || e < 0) return now;
        let fm = now.slice(0, e);
        // price properties from before 0.16 (kronor) give way to the new ones; what the user paid keeps its value
        fm = fm.replace(/^price_paid_sek:/m, "price_paid:");
        for (const k of OLD_PRICE_KEYS) fm = fm.replace(new RegExp(`^${k}:.*\\n?`, "m"), "");
        for (const k of PRICE_KEYS) {
          const line = `${k}: ${pr[k]}`, re = new RegExp(`^${k}:.*$`, "m");
          fm = re.test(fm) ? fm.replace(re, line) : fm.replace(/^(discogs_id:)/m, `${line}\n$1`);
        }
        changed = fm + now.slice(e) !== now;
        return fm + now.slice(e);
      });
      if (changed) n++;
    }
    onProgress?.(notes.length, notes.length);
    this.log(`${T.name}: prices refreshed on ${n} notes`);
    return n;
  }

  /* ---- Discogs' own value of the whole collection, for the dashboard: { min, med, max, checked } ---- */
  // Discogs sends it in the account's currency; it is converted like the price suggestions.
  async collectionValue() {
    const r = await this.discogs(`users/${this.cfg.username}/collection/value`);
    const { target } = await this.currencies();
    const rate = await this.anyRate();
    const n = (x) => { const v = decodeMoneyText(x); return v === null || rate === null ? null : Math.round(v * rate); };
    const value = { min: n(r?.minimum), med: n(r?.median), max: n(r?.maximum), currency: target, checked: today() };
    this.log(`Collection value: ${value.med === null ? "not available" : `median ${formatMoney(value.med, target)}`}`);
    return value;
  }
}

/* ------------------------------------------------------------------ PDF export */
const PAPER = {                         // inches (portrait)
  A5: [5.83, 8.27], A4: [8.27, 11.69], A3: [11.69, 16.54],
  Letter: [8.5, 11], Legal: [8.5, 14], Tabloid: [11, 17],
};
const MARGIN = 0.45;                    // inches

class ExportModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() {
    const d = this.plugin.data.pdf || { size: "A4", orientation: "portrait" };
    const opts = { ...d };
    this.titleEl.setText("Export dashboard as PDF");
    new Setting(this.contentEl).setName("Paper size").addDropdown((dd) => {
      Object.keys(PAPER).forEach((k) => dd.addOption(k, `${k} (${PAPER[k][0]} × ${PAPER[k][1]} in)`));
      dd.setValue(opts.size).onChange((v) => (opts.size = v));
    });
    new Setting(this.contentEl).setName("Orientation").addDropdown((dd) => {
      dd.addOption("portrait", "Portrait").addOption("landscape", "Landscape");
      dd.setValue(opts.orientation).onChange((v) => (opts.orientation = v));
    });
    new Setting(this.contentEl).setName("Saved to").setDesc(`${this.plugin.data.folder}/Exports in your vault, then opened in your PDF viewer.`);
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Export PDF").setCta().onClick(async () => {
        b.setDisabled(true); b.setButtonText("Exporting…");
        this.plugin.data.pdf = opts; await this.plugin.saveData(this.plugin.data);
        try { await this.plugin.exportPdf(opts); this.close(); }
        catch (e) { console.error(e); new Notice(`PDF export failed: ${e.message}`, 10000); b.setDisabled(false); b.setButtonText("Export PDF"); }
      }));
  }
  onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------------------------ plugin */
class MusicLibrarySync extends Plugin {
  async onload() {
    const saved = await this.loadData();
    this.data = Object.assign(structuredClone(DEFAULTS), saved);
    if (!Array.isArray(this.data.libraries)) this.data.libraries = [];
    if (!Array.isArray(this.data.skippedFormats)) this.data.skippedFormats = [];
    // Before 0.16 every price was in kronor, so an install from then keeps kronor until the user chooses.
    if (saved && saved.currency === undefined && (this.data.libraries.length || this.data.value)) this.data.currency = LEGACY_CURRENCY;
    this.data.currency = currencyCode(this.data.currency);
    if (!this.data.rates || Array.isArray(this.data.rates)) this.data.rates = {};
    this.data.folder = cleanFolder(this.data.folder) || DEFAULT_FOLDER;
    // Before 0.10 a base synced a Discogs folder. The folders were named after their formats (Vinyl,
    // CD, Cassette), which are Discogs' own spellings, so each becomes the format its base takes.
    for (const lib of this.data.libraries) if (!Array.isArray(lib.formats)) { lib.formats = [lib.discogsFolder || lib.name]; delete lib.discogsFolder; }
    // Before 0.11 each base had a .base file. The views replace them; the files are offered for removal.
    for (const lib of this.data.libraries) if (lib.base) { if (!this.data.legacyFiles.includes(lib.base)) this.data.legacyFiles.push(lib.base); delete lib.base; }
    this.data.library = Object.assign(structuredClone(DEFAULTS.library), this.data.library);
    this.data.colours = Object.assign(structuredClone(DEFAULTS.colours), this.data.colours);
    if (!this.data.colours.bases || Array.isArray(this.data.colours.bases)) this.data.colours.bases = {};
    await this.importTokenFiles();
    this.state = { running: false, mode: null, steps: {}, now: "", log: "", progress: 0 };
    this.panels = new Set();
    this.registerMarkdownCodeBlockProcessor("music-sync", (_src, el) => this.renderPanel(el));
    this.registerView(MUSIC_VIEW, (leaf) => new MusicView(leaf, this));
    for (const type of Object.keys(OLD_VIEWS)) this.registerView(type, (leaf) => new MusicView(leaf, this, type));
    this.addRibbonIcon("disc-3", "Open music dashboard and library", () => this.openView());
    this.addCommand({ id: "open-dashboard", name: "Open dashboard", callback: () => this.openView("dashboard") });
    this.addCommand({ id: "open-library", name: "Open library", callback: () => this.openView("library") });
    this.addCommand({ id: "sync", name: "Sync from Discogs", callback: () => this.run("sync") });
    this.addCommand({ id: "prices", name: "Refresh prices", callback: () => this.run("prices") });
    this.addCommand({ id: "dashboard", name: "Refresh collection value", callback: () => this.run("dashboard") });
    this.addCommand({ id: "cancel", name: "Cancel running sync", callback: () => (this.cancelled = true) });
    this.addCommand({ id: "export-pdf", name: "Export dashboard as PDF…", callback: () => new ExportModal(this.app, this).open() });
    this.addCommand({ id: "add-base", name: "Add a base…", callback: () => new LibraryModal(this.app, this, null).open() });
    this.addCommand({ id: "update-record", name: "Update this record from Discogs", checkCallback: (checking) => {
      const file = this.app.workspace.getActiveFile();
      if (!this.baseOfNote(file)) return false;
      if (!checking) void this.updateRecord(file);
      return true;
    } });
    // the same, from a record note's menu (right-click, or the note's ⋯ menu)
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (this.baseOfNote(file)) menu.addItem((i) => i.setTitle("Update from Discogs").setIcon("refresh-cw").onClick(() => void this.updateRecord(file)));
    }));
    this.addSettingTab(new MusicSettingTab(this.app, this));
    this.registerInterval(window.setInterval(() => this.refresh(), 60 * 1000));
    // The views follow the notes: redraw shortly after record notes change, move or go, and on theme changes.
    const soon = () => { window.clearTimeout(this.redrawTimer); this.redrawTimer = window.setTimeout(() => this.redrawViews(), 600); };
    const inMusic = (path) => [this.data.folder, ...this.data.libraries.map((l) => l.dir)].some((d) => String(path ?? "").startsWith(`${d}/`));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => { if (inMusic(file?.path)) soon(); }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (inMusic(file?.path) || inMusic(oldPath)) soon(); }));
    this.registerEvent(this.app.vault.on("delete", (file) => { if (inMusic(file?.path)) soon(); }));
    this.registerEvent(this.app.workspace.on("css-change", soon));
  }

  /* ---- views ---- */
  // The Music tab, on the given tab ("dashboard" or "library") or the one used last. An open Music tab
  // is brought forward rather than opening another.
  musicLeaves() { return [MUSIC_VIEW, ...Object.keys(OLD_VIEWS)].flatMap((t) => this.app.workspace.getLeavesOfType(t)); }
  async openView(tab) {
    const open = this.musicLeaves()[0];
    if (open) { await this.app.workspace.revealLeaf(open); if (tab) await open.view?.show?.(tab); return; }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: MUSIC_VIEW, active: true, state: { tab: tab || this.data.tab } });
    await this.app.workspace.revealLeaf(leaf);
  }
  redrawViews() {
    for (const leaf of this.musicLeaves()) leaf.view?.render?.().catch?.((e) => console.error(e));
  }
  baseNames() { return this.data.libraries.map((l) => l.name); }
  // The currency prices are shown in: the one chosen, else (before the first sync has found the Discogs
  // account's) the default.
  currency() { return this.data.currency || DEFAULT_CURRENCY; }
  // What the dashboard and PDF need besides the records: sections on or off, colours, value history, currency.
  reportOptions() {
    const c = this.data.colours;
    return { sections: this.data.sections, history: this.data.valueHistory, currency: this.currency(),
      colours: { mode: c.mode, accent: c.accent, bases: this.data.libraries.map((l) => c.bases[l.id]) } };
  }
  collectionValue() {
    const v = this.data.value;
    return decodeCollectionValue(v && { discogs_value_min: v.min, discogs_value_median: v.med, discogs_value_max: v.max, currency: v.currency || LEGACY_CURRENCY });
  }
  // A record's cover image, found the way Obsidian resolves the note's link to it.
  coverFile(record) { return record.cover ? this.app.metadataCache.getFirstLinkpathDest(record.cover, record.path) : null; }
  // Ticking Listened on the dashboard records it in the note's properties.
  async markListened(path, box) {
    const f = this.app.vault.getAbstractFileByPath(path);
    try { await this.app.fileManager.processFrontMatter(f, (fm) => { fm.listened = true; fm.listened_on = today(); }); }
    catch (e) { box.checked = false; new Notice(`Couldn't mark it as listened to: ${e.message}`); console.error(e); }
  }

  /* ---- one record ---- */
  // The base a record note belongs to (by its tag), or null for any other file.
  baseOfNote(file) {
    const fm = file && this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm?.discogs_id) return null;
    const tags = [].concat(fm.tags ?? []).map((t) => String(t).replace(/^#/, "").toLowerCase());
    return this.data.libraries.find((l) => tags.includes(l.tag.toLowerCase())) ?? null;
  }
  // Brings one record note up to date with Discogs (Engine.updateRecord), leaving what the user wrote.
  async updateRecord(file) {
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
    } catch (e) { new Notice(`Couldn't update from Discogs: ${e.message}`, 10000); console.error(e); }
    finally { notice.hide(); this.updating = false; }
  }

  /* ---- libraries ("bases") ---- */
  steps() {
    return [...this.data.libraries.map((l) => ({ key: l.id, label: l.name, icon: l.icon })),
      { key: "dashboard", label: "Collection value", icon: "coins" }];
  }
  libraryNames() {
    const n = this.data.libraries.map((l) => l.name);
    return n.length < 2 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
  }
  async save() { await this.saveData(this.data); this.refresh(); }

  // Why a proposed name (and its formats) can't be used, or "" when it can. `self` is the library
  // being edited, so it doesn't clash with itself. No two bases may share a name, ignoring case and spacing.
  // `adopt` lets a base named after its Discogs format take over an existing folder of that name: after
  // Start again, or a reinstall, the notes are already there and the sync finds them.
  async checkLibrary(v, self = null, adopt = false) {
    const problem = nameProblem(v, this.data.libraries.filter((l) => l !== self), !!self);
    if (problem) return problem;
    const name = tidy(v.name);
    const fs = this.app.vault.adapter;
    if (!self && !adopt && (await fs.exists(`${this.data.folder}/${name}`))) return `${this.data.folder} already has a folder called “${name}”.`;
    return "";
  }

  // Creates the base's folder (or adopts it, see checkLibrary) and starts syncing it.
  async addLibrary(v, adopt = false) {
    const err = await this.checkLibrary(v, null, adopt); if (err) throw new Error(err);
    const name = tidy(v.name), s = slug(name);
    let id = s, n = 2; while (this.data.libraries.some((l) => l.id === id)) id = `${s}-${n++}`;
    const lib = { id, name, formats: [...v.formats], dir: `${this.data.folder}/${name}`, tag: `${s}-library`, icon: v.icon || "disc-3" };
    await this.ensureLibraryFiles(lib);
    this.data.libraries.push(lib);
    this.unskip(lib.formats);
    await this.save();
    return lib;
  }

  // Renames the base and updates its formats and icon. Notes aren't moved here; the next sync
  // moves any record whose format now belongs to another base.
  async updateLibrary(lib, v) {
    const err = await this.checkLibrary(v, lib); if (err) throw new Error(err);
    lib.name = tidy(v.name);
    lib.formats = [...v.formats];
    lib.icon = v.icon || lib.icon;
    this.unskip(lib.formats);
    await this.save();
  }

  // Creates the base's folder if it's missing.
  async ensureLibraryFiles(lib) {
    const vault = this.app.vault;
    if (!vault.getAbstractFileByPath(lib.dir)) await vault.createFolder(lib.dir);
  }

  // Adds a base for each chosen format, named after the format. Returns what was added and
  // what was skipped, with the reason.
  async addFromDiscogs(formats) {
    const added = [], skipped = [];
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
  async removeLibrary(lib) {
    this.data.libraries = this.data.libraries.filter((l) => l !== lib);
    for (const f of lib.formats) if (!this.data.skippedFormats.some((x) => sameFormat(x, f))) this.data.skippedFormats.push(f);
    await this.save();
  }
  // A format given a base again, by hand, is no longer left out.
  unskip(formats) { this.data.skippedFormats = this.data.skippedFormats.filter((x) => !formats.some((f) => sameFormat(f, x))); }

  // During a sync: a base, named after the format, for each format in the collection that no base
  // takes, so a new install needs no setting up. Formats the user stopped syncing are left out.
  async createBasesFor(items) {
    if (!this.data.autoBases) return { added: [], skipped: [] };
    const { added, skipped } = await this.addFromDiscogs(basesNeeded(items, this.data.libraries, this.data.skippedFormats));
    return { added: structuredClone(added), skipped };
  }

  /* ---- Discogs / Genius helpers for the settings page ---- */
  token(kind) { return String(this.app.secretStorage.getSecret(TOKEN_KEYS[kind]) ?? ""); }
  saveToken(kind, value) {
    if (!value.trim()) { this.forgetToken(kind); return; }
    this.app.secretStorage.setSecret(TOKEN_KEYS[kind], value.trim()); this.formatCache = null;
  }
  // Removes the token from this vault's keychain. Obsidian's published API can't delete a secret yet, but
  // its keychain can; where it can't, the secret is emptied, which the plugin reads as no token.
  forgetToken(kind) {
    const store = this.app.secretStorage;
    if ("deleteSecret" in store) store.deleteSecret(TOKEN_KEYS[kind]); else store.setSecret(TOKEN_KEYS[kind], "");
    this.formatCache = null;
  }
  // Back to how a new install starts: tokens removed, username, bases and every setting reset. Record notes,
  // covers and PDFs stay in the vault, and the next sync finds them again (bases adopt their old folders).
  async startAgain() {
    for (const kind of Object.keys(TOKEN_KEYS)) this.forgetToken(kind);
    const library = this.data.library;                          // the open Library view holds on to this one
    for (const k of Object.keys(this.data)) delete this.data[k];
    Object.assign(this.data, structuredClone(DEFAULTS), { libraries: [] });
    this.data.library = Object.assign(library, structuredClone(DEFAULTS.library));
    await this.save();
    this.redrawViews();
  }
  // Tokens kept in local storage by 0.11 and 0.12 move to secret storage, and leave local storage. Tokens
  // kept in files by earlier versions are read in once; the files are then offered for removal.
  async importTokenFiles() {
    const store = this.app.secretStorage;
    for (const [kind, key] of Object.entries(OLD_TOKEN_KEYS)) {
      const kept = String(store.getSecret(key) ?? "").trim();                      // 0.13–0.15
      if (kept) {
        if (!this.token(kind)) this.saveToken(kind, kept);
        if ("deleteSecret" in store) store.deleteSecret(key); else store.setSecret(key, "");
      }
      const local = String(this.app.loadLocalStorage(key) ?? "").trim();         // 0.11–0.12
      if (!local) continue;
      if (!this.token(kind)) this.saveToken(kind, local);
      this.app.saveLocalStorage(key, null);
    }
    for (const [kind, file] of [["discogs", "Music/.discogs-token"], ["genius", "Music/.genius-token"]]) {   // where versions before 0.11 kept them
      if (this.token(kind) || !(await this.app.vault.adapter.exists(file))) continue;
      const t = (await this.app.vault.adapter.read(file)).trim();
      if (t) this.saveToken(kind, t);
    }
  }
  // Files earlier versions made that are still in the vault.
  async legacyFilesPresent() {
    const out = [];
    for (const p of [...new Set([...LEGACY_FILES, ...this.data.legacyFiles])]) if (await this.app.vault.adapter.exists(p)) out.push(p);
    return out;
  }
  // Moves them to the trash (recoverable): through Obsidian, which follows the user's choice of system or
  // vault trash, except files in dot-folders or dot-files, which Obsidian doesn't index.
  async trashLegacyFiles(paths) {
    for (const p of paths) {
      const hidden = p.split("/").some((part) => part.startsWith("."));
      const f = hidden ? null : this.app.vault.getAbstractFileByPath(p);
      if (f) await this.app.fileManager.trashFile(f); else await this.app.vault.adapter.trashSystem(p);
    }
    this.data.legacyFiles = [];
    await this.save();
  }
  async discogsIdentity() {
    const t = this.token("discogs"); if (!t) throw new Error("No Discogs token saved yet");
    const r = await requestUrl({ url: "https://api.discogs.com/oauth/identity", headers: { Authorization: `Discogs token=${t}`, "User-Agent": UA }, throw: false });
    if (r.status >= 400) throw new Error(r.status === 401 ? "Discogs didn't accept the token" : `Discogs answered ${r.status}`);
    return decodeIdentity(r.json);
  }
  // The currency the Discogs account prices in, or "" when Discogs doesn't say.
  async discogsCurrency(username) {
    const r = await requestUrl({ url: `https://api.discogs.com/users/${encodeURIComponent(username)}`, headers: { Authorization: `Discogs token=${this.token("discogs")}`, "User-Agent": UA }, throw: false });
    return r.status < 400 ? decodeProfileCurrency(r.json) : "";
  }
  async geniusCheck() {
    const t = this.token("genius"); if (!t) throw new Error("No Genius token saved yet");
    const r = await requestUrl({ url: "https://api.genius.com/search?q=test", headers: { Authorization: `Bearer ${t}` }, throw: false });
    if (r.status >= 400) throw new Error(r.status === 401 ? "Genius didn't accept the token" : `Genius answered ${r.status}`);
  }
  // The formats in the user's Discogs collection, with how many records include each — read from
  // Discogs, so a base's formats are always chosen from real names and never typed.
  async collectionFormats() {
    if (this.formatCache) return this.formatCache;
    const t = this.token("discogs");
    if (!t) throw new Error("No Discogs token saved yet");
    if (!this.data.username) throw new Error("No Discogs username entered yet");
    let items = [], page = 1;
    while (true) {
      if (page > 1) await pause(1100);                                   // Discogs' rate limit
      const r = await requestUrl({ url: `https://api.discogs.com/users/${encodeURIComponent(this.data.username)}/collection/folders/0/releases?per_page=100&page=${page}`,
        headers: { Authorization: `Discogs token=${t}`, "User-Agent": UA }, throw: false });
      if (r.status === 401) throw new Error("Discogs didn't accept the token");
      if (r.status === 404) throw new Error(`Discogs has no user called “${this.data.username}”`);
      if (r.status >= 400) throw new Error(`Discogs answered ${r.status}`);
      const d = decodeCollectionPage(r.json);
      items = items.concat(d.items);
      if (page >= d.pages) break; page++;
    }
    return (this.formatCache = formatCounts(items));
  }

  // Every record note of every base, decoded for the views and the PDF report. Reads Obsidian's own metadata
  // cache and the notes themselves, so it needs no other plugin.
  async collectRecords() {
    const byTag = new Map(this.data.libraries.map((l) => [l.tag.toLowerCase(), l.name]));
    const records = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;
      const media = [].concat(fm.tags ?? []).map((t) => String(t).replace(/^#/, "").toLowerCase()).map((t) => byTag.get(t)).find(Boolean);
      if (!media) continue;
      records.push(decodeRecord(fm, media, await this.app.vault.cachedRead(file), file.basename, file.path));
    }
    return records;
  }

  // The active theme's colours and font, resolved to values a standalone page can use.
  themeForReport() {
    const probe = document.body.createDiv({ cls: "mls-theme-probe" });
    const color = (name, fallback) => { probe.setCssProps({ color: `var(${name}, ${fallback})` }); return cssColorToHex(getComputedStyle(probe).color, fallback); };
    const theme = { fg: color("--text-normal", "#222222"), bg: color("--background-primary", "#ffffff"), muted: color("--text-muted", "#666666"),
      border: color("--background-modifier-border", "#cccccc"), font: getComputedStyle(probe).fontFamily || "sans-serif" };
    probe.remove();
    return theme;
  }

  // Builds the Music Dashboard as its own page from the notes (report.js) and prints it to PDF with
  // Obsidian's desktop app. Dataview and Charts are not involved, and the dashboard needn't be open.
  async exportPdf({ size = "A4", orientation = "portrait" } = {}) {
    // Electron is reached through Obsidian's own require, when the export runs, so the plugin loads
    // even where PDF export can't run.
    const electron = window.require("electron");
    const remote = electron.remote || (() => { try { return window.require("@electron/remote"); } catch { return null; } })();
    if (!remote?.BrowserWindow) throw new Error("PDF export isn't available in this version of Obsidian. Please report it with “Report a bug” in the plugin's settings.");
    if (!this.data.libraries.length) throw new Error("Add a base first — there's nothing to export yet");
    const notice = new Notice("Preparing PDF…", 0);
    try {
      const value = this.collectionValue();
      const theme = this.themeForReport();
      const stamp = moment().format("D MMMM YYYY, HH:mm");
      // the report's rules are in the plugin's styles.css, which the page embeds
      const css = await this.app.vault.adapter.read(`${this.manifest.dir}/styles.css`).catch(() => "");
      const html = buildReport(await this.collectRecords(), this.data.libraries.map((l) => l.name), value, theme, stamp, { ...this.reportOptions(), css });
      // The page is written to the plugin's own folder through the vault adapter, so the plugin never
      // touches the file system outside the vault; the print window loads it from there.
      const adapter = this.app.vault.adapter;
      if (typeof adapter.getFullPath !== "function") throw new Error("PDF export needs Obsidian's desktop app");
      const tmp = `${this.manifest.dir}/.export-${Date.now()}.html`;
      await adapter.write(tmp, html);
      const [w, h] = PAPER[size] || PAPER.A4;
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
        await files.writeBinary(out, pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
        notice.hide();
        new Notice(`PDF saved: ${out}`, 8000);
        try { this.app.openWithDefaultApp(out); }   // the notice above already gives the path
        catch (e) { console.warn("Discogs music sync: couldn't open the PDF viewer", e); }
      } finally { win.destroy(); await adapter.remove(tmp).catch(() => { /* a leftover page in the plugin folder is harmless */ }); }
    } finally { notice.hide(); }
  }

  renderPanel(el) {
    const p = { root: el.createDiv({ cls: "mls-panel" }) };
    const top = p.root.createDiv({ cls: "mls-top" });
    const badge = top.createDiv({ cls: "mls-badge" }); setIcon(badge, "disc-3");
    const txt = top.createDiv({ cls: "mls-text" });
    const tt = txt.createDiv({ cls: "mls-title", text: "Discogs music sync and dashboard " }); tt.createSpan({ cls: "mls-ver", text: `v${VERSION}` });
    p.meta = txt.createDiv({ cls: "mls-meta" });
    const act = p.root.createDiv({ cls: "mls-actions" });
    const btn = (label, ic, cls, fn, tip) => {
      const b = act.createEl("button", { cls: `mls-btn ${cls}` });
      const s = b.createSpan({ cls: "mls-ic" }); setIcon(s, ic); b.createSpan({ text: label });
      b.setAttr("aria-label", tip); b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
      return b;
    };
    p.sync = btn("Sync from Discogs", "refresh-cw", "mls-primary", () => this.run("sync"), `Add new ${this.libraryNames()} records from Discogs`);
    p.prices = btn("Refresh prices", "coins", "mls-secondary", () => this.run("prices"), "Update the price fields on every record");
    p.dash = btn("Library", "library", "mls-secondary", () => this.openView("library"), "Browse your records by base, as a gallery or tables");
    p.pdf = btn("Export PDF", "file-down", "mls-secondary", () => new ExportModal(this.app, this).open(), "Save the dashboard as a PDF in the paper size you choose");
    p.cancel = btn("Cancel", "x-circle", "mls-cancel", () => (this.cancelled = true), "Stop after the current record");
    p.steps = p.root.createDiv({ cls: "mls-steps" });
    const barWrap = p.root.createDiv({ cls: "mls-bar" }); p.bar = barWrap.createDiv();
    p.now = p.root.createDiv({ cls: "mls-now" });
    const det = p.root.createEl("details", { cls: "mls-log" });
    det.createEl("summary", { text: "Sync log" }); p.log = det.createEl("pre");
    this.panels.add(p); this.paint(p);
  }

  paint(p) {
    const s = this.state, last = this.data.last;
    p.root.toggleClass("is-running", s.running);
    p.root.toggleClass("is-done", !!s.justDone && !s.running);
    [p.sync, p.prices, p.dash, p.pdf].forEach((b) => (b.disabled = s.running));
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
    p.bar.parentElement.toggle(s.running || !!s.justDone);
    p.bar.setCssProps({ width: `${Math.round(s.progress * 100)}%` });
    p.now.setText(s.running ? s.now : "");
    p.log.setText(s.log || "No run yet in this session.");
  }
  refresh() { for (const p of this.panels) { if (!p.root.isConnected) { this.panels.delete(p); continue; } this.paint(p); } }

  async run(mode) {
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
    const lines = [];
    const log = (l) => { lines.push(l); s.log = lines.slice(-400).join("\n"); s.now = l.trim(); this.refresh(); };
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
        } catch (e) { failed = true; for (const l of libs) if (s.steps[l.id] !== "done") s.steps[l.id] = "error"; log(`ERROR: ${e.message}`); console.error(e); }
      }
      for (let i = 0; mode === "prices" && i < steps.length && !this.cancelled; i++) {
        const st = steps[i];
        s.steps[st.id] = "active"; s.progress = i / work(); this.refresh();
        const prog = (done, total) => { s.progress = (i + (total ? done / total : 1)) / work(); this.refresh(); };
        try {
          priced += await eng.refreshPrices(st, prog);
          s.steps[st.id] = "done";
        } catch (e) { failed = true; s.steps[st.id] = "error"; log(`ERROR (${st.name}): ${e.message}`); console.error(e); }
      }
      s.steps.dashboard = "active"; s.progress = steps.length / work(); this.refresh();
      try {
        this.data.value = await eng.collectionValue();
        // one entry per day, for the value-over-time chart; a later fetch the same day replaces it
        if (this.data.value.med !== null) {
          const h = this.data.valueHistory.filter((e) => e.date !== this.data.value.checked);
          h.push({ date: this.data.value.checked, min: this.data.value.min, med: this.data.value.med, max: this.data.value.max, currency: this.data.value.currency });
          this.data.valueHistory = h.sort((a, b) => a.date.localeCompare(b.date)).slice(-1000);
        }
        s.steps.dashboard = "done";
      }
      catch (e) { failed = true; s.steps.dashboard = "error"; log(`ERROR (collection value): ${e.message}`); console.error(e); }
      this.redrawViews();
    } catch (e) { failed = true; log(`ERROR: ${e.message}`); console.error(e); }
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

/* ------------------------------------------------------------------ settings */
class LibraryModal extends Modal {
  // lib = null adds a new base; otherwise edits that one
  constructor(app, plugin, lib, done) { super(app); this.plugin = plugin; this.lib = lib; this.done = done; }
  onOpen() {
    const { plugin, lib } = this, c = this.contentEl;
    const v = { name: lib?.name || "", formats: [...(lib?.formats || [])], icon: lib?.icon || "disc-3" };
    this.titleEl.setText(lib ? `Edit “${lib.name}”` : "Add a base");
    if (!lib) c.createEl("p", { cls: "setting-item-description",
      text: `A base takes every record of the formats you choose, from anywhere in your Discogs collection, into its own folder in ${plugin.data.folder}, with its own tag and its own place in the library and on the dashboard.` });
    new Setting(c).setName("Name")
      .setDesc(lib ? `The notes stay in ${lib.dir}.` : `Used for the base's folder in ${plugin.data.folder}. No two bases can have the same name.`)
      .addText((t) => { t.setPlaceholder("MiniDiscs").setValue(v.name).onChange((x) => { v.name = x; touched = true; check(); }); window.setTimeout(() => t.inputEl.focus(), 0); });

    // Formats are picked from what Discogs reports for the collection, never typed, so a
    // misspelling can't quietly send records nowhere.
    new Setting(c).setName("Formats").setHeading();
    const formatsEl = c.createDiv();
    const status = formatsEl.createEl("p", { cls: "setting-item-description", text: "Reading the formats in your Discogs collection…" });
    const others = plugin.data.libraries.filter((l) => l !== lib);
    const toggleFor = (name, detail) => {
      const taken = others.find((l) => l.formats.some((g) => g.toLowerCase() === name.toLowerCase()));
      new Setting(formatsEl).setName(name).setDesc(taken ? `${detail} Taken by “${taken.name}”.` : detail)
        .addToggle((t) => t.setValue(v.formats.includes(name)).setDisabled(!!taken).onChange((on) => {
          v.formats = on ? [...v.formats, name] : v.formats.filter((f) => f !== name); touched = true; check();
        }));
    };
    plugin.collectionFormats().then((found) => {
      status.setText("Turn on the formats this base takes. A record goes to the base of its first format that has one.");
      const names = new Set(found.map((f) => f.name));
      for (const f of found) toggleFor(f.name, `${f.count} record${f.count === 1 ? "" : "s"} in your collection.`);
      for (const f of v.formats) if (!names.has(f)) toggleFor(f, "No record in your collection has this format now.");
    }).catch((e) => {
      status.setText(`Couldn't read your Discogs collection: ${e.message}. Formats can only be chosen from your collection; check your username and token with Test, then open this again.`);
      for (const f of v.formats) toggleFor(f, "");
    });

    const iconSet = new Setting(c).setName("Icon").addDropdown((dd) => {
      ICONS.forEach((i) => dd.addOption(i, i));
      dd.setValue(v.icon).onChange((x) => { v.icon = x; showIcon(); });
    });
    const iconEl = iconSet.controlEl.createSpan({ cls: "mls-lib-icon" });
    const showIcon = () => { iconEl.empty(); setIcon(iconEl, v.icon); };
    showIcon();
    const preview = lib ? null : c.createDiv({ cls: "setting-item-description mls-form-preview" });
    const err = c.createDiv({ cls: "mls-form-error" });
    let save, touched = !!lib, seq = 0;
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => { save = b; b.setButtonText(lib ? "Save" : "Add base").setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          if (lib) { await plugin.updateLibrary(lib, v); new Notice(`Saved “${lib.name}”. The next sync moves records to match.`, 8000); }
          else { const n = await plugin.addLibrary(v); new Notice(`Added the base “${n.name}” — the next sync fills it from Discogs`, 8000); }
          this.close(); this.done?.();
        } catch (e) { err.setText(e.message); b.setDisabled(false); }
      }); });
    const check = async () => {
      const n = ++seq, e = await plugin.checkLibrary(v, lib);
      if (n !== seq) return;                                    // a newer change is already being checked
      err.setText(touched ? e : ""); save.setDisabled(!!e);
      if (preview) { const name = tidy(v.name); preview.setText(name && !e ? `Creates ${plugin.data.folder}/${name}/ and the tag #${slug(name)}-library.` : ""); }
    };
    check();
  }
  onClose() { this.contentEl.empty(); }
}

// First-run setup: lists the formats in the user's Discogs collection, with how many records have
// each, and adds a base for each one they tick, named after the format.
class SetupModal extends Modal {
  constructor(app, plugin, done) { super(app); this.plugin = plugin; this.done = done; }
  async onOpen() {
    const { plugin } = this, c = this.contentEl;
    this.titleEl.setText("Set up bases from Discogs");
    const status = c.createEl("p", { cls: "setting-item-description", text: "Reading the formats in your Discogs collection…" });
    let found;
    try { plugin.formatCache = null; found = await plugin.collectionFormats(); }
    catch (e) { status.setText(`Couldn't read your Discogs collection: ${e.message}. Check your username and token with Test, then try again.`); return; }
    const taken = (name) => plugin.data.libraries.some((l) => l.formats.some((g) => g.toLowerCase() === name.toLowerCase()));
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
  onClose() { this.contentEl.empty(); }
}

class ConfirmModal extends Modal {
  constructor(app, title, text, action, onYes) { super(app); Object.assign(this, { title, text, action, onYes }); }
  onOpen() {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.text });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.action).setWarning().onClick(async () => { this.close(); await this.onYes(); }));
  }
  onClose() { this.contentEl.empty(); }
}

class MusicSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; this.legacy = []; this.tokenStatus = {}; }
  // A token check's answer is kept while the tab is open, and forgotten when it closes.
  hide() { this.tokenStatus = {}; super.hide(); }

  // Obsidian draws the tab from these definitions and indexes them for its settings search. Plain values
  // are controls, read and saved through getControlValue and setControlValue; rows with buttons, tokens
  // and the list of bases draw themselves. update() redraws after a change that adds or removes rows.
  getSettingDefinitions() {
    const P = this.plugin, d = P.data;
    const ready = () => !!d.username && !!P.token("discogs");
    const custom = () => d.colours.mode === "custom";
    const redraw = () => this.update();
    this.checkLegacy().catch((e) => console.error(e));
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
          render: (s) => {
            setIcon(s.nameEl.createSpan({ cls: "mls-lib-icon", prepend: true }), lib.icon);
            s.addExtraButton((b) => b.setIcon("pencil").setTooltip("Rename or edit").onClick(() => new LibraryModal(this.app, P, lib, redraw).open()));
          } })) },
      { type: "group", heading: "Files from earlier versions", visible: () => this.legacy.length > 0, items: [
        { name: "Move to trash", searchable: false,
          desc: "Earlier versions kept these in your vault. The plugin no longer uses them: the dashboard and library views, and tokens kept on this device, have replaced them.",
          render: (s) => {
            const ul = s.descEl.createEl("ul", { cls: "mls-legacy-list" });
            for (const f of this.legacy) ul.createEl("li", { text: f });
            s.addButton((b) => b.setButtonText("Move to trash").setWarning().onClick(() => new ConfirmModal(this.app, "Move these files to the trash?",
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
          control: { type: "color", key: `colour:${lib.id}`, defaultValue: FULL_BASES[i % FULL_BASES.length] } })),
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
        { name: "Paper size", control: { type: "dropdown", key: "pdfSize", options: Object.fromEntries(Object.keys(PAPER).map((k) => [k, `${k} (${PAPER[k][0]} × ${PAPER[k][1]} in)`])) } },
        { name: "Orientation", control: { type: "dropdown", key: "pdfOrientation", options: { portrait: "Portrait", landscape: "Landscape" } } },
      ] },
      { type: "group", heading: "Reset", items: [
        { name: "Start again", aliases: ["Reset", "Remove tokens", "Uninstall"],
          desc: "Removes your Discogs and Genius tokens from this vault, and sets the username, bases and every setting back to how a new install starts. Your record notes, covers and PDFs stay in the vault; the next sync finds them again. Do this before uninstalling to leave no tokens behind.",
          render: (s) => s.addButton((b) => b.setButtonText("Start again").setWarning().onClick(() => new ConfirmModal(this.app, "Start again?",
            "Your tokens are removed from this vault, and the username, bases, dashboard sections, colours and PDF settings go back to how a new install starts. Your record notes, covers and PDFs stay in the vault.",
            "Start again", async () => { await P.startAgain(); this.tokenStatus = {}; redraw(); new Notice("Started again: tokens removed and settings reset"); }).open())) },
      ] },
      // The About block is not a setting: kept out of search, it takes over its row.
      { name: "About Discogs music sync and dashboard", searchable: false, render: (s) => {
        s.settingEl.empty(); s.settingEl.addClass("mls-about-row");
        this.aboutFooter(s.settingEl);
      } },
    ];
  }

  getControlValue(key) {
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

  async setControlValue(key, value) {
    const P = this.plugin, d = P.data;
    if (key.startsWith("section:")) { if (value) delete d.sections[key.slice(8)]; else d.sections[key.slice(8)] = false; }
    else if (key.startsWith("colour:")) d.colours.bases[key.slice(7)] = String(value);
    else switch (key) {
      case "folder": if (folderProblem(value)) return; d.folder = cleanFolder(value); break;   // validate has already said why
      case "username": d.username = String(value).trim(); P.formatCache = null; break;
      case "lyrics": d.lyrics = value === true; break;
      case "gallery": d.gallery = value === true; break;
      case "autoBases": d.autoBases = value === true; break;
      case "currency": {
        const was = d.currency;
        d.currency = currencyCode(value);
        if (d.currency && was && d.currency !== was) new Notice(`Prices are now shown in ${d.currency}. Run Refresh prices to fetch your records' prices in ${d.currency}; until then, prices in ${was} are left out of the dashboard's figures.`, 12000);
        break;
      }
      case "colourMode": d.colours.mode = COLOUR_MODES[value] ? value : "theme"; break;
      case "accent": d.colours.accent = String(value); break;
      case "pdfSize": d.pdf.size = PAPER[value] ? value : "A4"; break;
      case "pdfOrientation": d.pdf.orientation = value === "landscape" ? "landscape" : "portrait"; break;
      default: return;
    }
    await P.save();
    if (key.startsWith("section:") || key.startsWith("colour") || key === "accent" || key === "currency") P.redrawViews();
    this.refreshStarted();                          // getting started, the setup button and the custom colours follow these values
  }

  // Files from earlier versions are found on disk, so after the tab is drawn; it is redrawn if there are any.
  async checkLegacy() {
    const found = await this.plugin.legacyFilesPresent();
    if (found.join("\n") === this.legacy.join("\n")) return;
    this.legacy = found;
    if (this.containerEl.isConnected) this.update();          // otherwise the next showing draws them
  }

  // The first steps, ticked off as they are done; shown until there is a token, a username and a base.
  // Each step is crossed out as it is done, as it happens: refreshStarted() is called whenever a
  // username or token is saved.
  gettingStarted(s) {
    const P = this.plugin, d = P.data;
    s.settingEl.empty();
    const g = s.settingEl.createDiv({ cls: "mls-getting-started" });
    g.createEl("strong", { text: "Getting started" });
    const ol = g.createEl("ol");
    this.startedSteps = [
      ["Enter your Discogs username below.", () => !!d.username],
      ["Add your Discogs token: open the link under “Personal access token”, generate a token, paste it into the field and press Test.", () => !!P.token("discogs")],
      ["Optional, for lyrics links: add your Genius token the same way, under “Genius access token”.", () => !!P.token("genius")],
      ["Run “Sync from Discogs” from the command palette. It creates a base for each format in your collection, such as Vinyl and CD, and fills them.", () => d.libraries.length > 0],
      ["Press the disc icon in the ribbon to open the dashboard and library.", () => false],
    ].map(([t, done]) => [ol.createEl("li", { text: t }), done]);
    this.refreshStarted();
  }
  refreshStarted() {
    for (const [li, done] of this.startedSteps ?? []) if (li.isConnected) li.toggleClass("is-done", done());
    this.refreshDomState();                                   // the list shows until the required steps are done
  }

  // A token is kept in Obsidian's secret storage on this device: never in a file, the vault or the plugin's settings.
  // Pasting a token saves it (as do Enter and leaving the field); Test checks it with the service, saving
  // first whatever is in the field, so one press is enough. Saving doesn't redraw the tab, so a click on
  // Test is never lost. The answer shows under the field, and is kept when the tab redraws.
  tokenRow(s, kind, service, test) {
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
    const show = (text, state = "") => {
      this.tokenStatus[kind] = { text, state };
      status.setText(text);
      status.toggleClass("is-ok", state === "ok"); status.toggleClass("is-error", state === "error");
    };
    const kept = this.tokenStatus[kind];
    if (kept) show(kept.text, kept.state); else show(P.token(kind) ? "A token is saved on this device." : "No token saved yet.");
    let input, button, remove, run = 0;
    const save = () => {
      const typed = input.getValue().trim();
      if (!typed) return false;
      P.saveToken(kind, typed); input.setValue(""); input.setPlaceholder("Paste to replace");
      run++;                                                   // any check still running was for the old token
      button.setDisabled(false).setButtonText("Test");
      remove.setDisabled(false);
      show("Saved on this device. Press Test to check it.");
      this.refreshStarted();
      return true;
    };
    const check = async () => {
      const typed = save();
      if (!P.token(kind)) { show("No token saved yet. Paste one into the field.", "error"); return; }
      const mine = ++run;                                      // a newer check replaces this one's answer
      button.setDisabled(true).setButtonText("Checking…");
      show(`${typed ? "Saved on this device. " : ""}Checking with ${service}…`);
      let answer, ok = false;
      try { answer = await test(); ok = true; } catch (e) { answer = e.message; }
      if (mine !== run) return;
      show(ok ? `✓ ${answer}. The token is saved on this device.` : `✗ ${answer}. Paste a new token to replace it.`, ok ? "ok" : "error");
      button.setDisabled(false).setButtonText("Test");
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
        b.setDisabled(true); button.setDisabled(false).setButtonText("Test"); input.setPlaceholder("Paste token here");
        show("Removed from this vault. No token saved.");
        this.refreshStarted();
      });
    });
  }

  // The About / Support footer shared with the other Wolf 359 Press plugins.
  aboutFooter(el) {
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
    for (const link of [
      { icon: "bug", label: "Report a bug", primary: true, url: `${REPO}/issues/new?template=bug_report.yml&labels=bug` },
      { icon: "lightbulb", label: "Request a feature", primary: true, url: `${REPO}/issues/new?template=feature_request.yml&labels=enhancement` },
      { icon: "user-round", label: "Anthony Fitzpatrick", primary: true, url: "https://anthonyfitzpatrick.me/" },
      { icon: "globe", label: "wolf359.app", url: "https://wolf359.app/" },
      { icon: "book-open", label: "wolf359.press", url: "https://wolf359.press/" },
      { cls: "mls-about-link-coffee", label: "Buy me a coffee", url: "https://buymeacoffee.com/wolf359pressab" },
    ]) {
      const b = (link.primary ? primary : secondary).createEl("button", { cls: "mls-about-link", type: "button" });
      if (link.cls) b.addClass(link.cls);
      const ic = b.createSpan({ cls: "mls-about-link-icon", attr: { "aria-hidden": "true" } });
      if (link.icon) setIcon(ic, link.icon); else ic.addClass("mls-about-link-image-icon");
      b.createSpan({ cls: "mls-about-link-text", text: link.label });
      b.addEventListener("click", () => window.open(link.url, "_blank", "noopener"));
    }
  }
}

export default MusicLibrarySync;
export { Engine, vaultFiles, openNote, MusicView };          // exported for testing
