/* Discogs music sync and dashboard (plugin ID music-library-sync) — Wolf 359 Press.
   Pure JavaScript: talks to Discogs + Genius with Obsidian's requestUrl and writes notes
   through the vault adapter. No Python required.
   Safety: never overwrites an existing album note (except price fields on "Refresh prices").
   Assumes nothing about the vault: every folder comes from the settings. */
const obsidian = require("obsidian");
const { Plugin, PluginSettingTab, Notice, requestUrl, setIcon, moment, Modal, Setting } = obsidian;

// The library folder a new install starts with; the user can choose another in settings.
const DEFAULT_FOLDER = "Music";
// A folder path as typed, cleaned: no leading/trailing slashes, single slashes, no empty parts.
const cleanFolder = (v) => String(v ?? "").split("/").map((x) => x.trim()).filter(Boolean).join("/");
const VERSION = "0.11.4";
const UA = `Wolf359DiscogsMusicSync/${VERSION}`;
// Pure logic, testable without Obsidian: names, tags, icons, naming rules, placement by format.
const { tidy, slug, guessIcon, nameProblem, baseFor, formatCounts } = require("./bases.js");
// Decoders for Discogs responses, applied where the responses arrive.
const { decodeCollectionPage, decodeIdentity } = require("./discogs.js");
// The dashboard as a standalone page for PDF export, built without Dataview or Charts.
const { decodeRecord, decodeCollectionValue, cssColorToHex, buildReport } = require("./report.js");
// The plugin's own view — the Dashboard and Library tabs — in place of a dashboard note and .base files.
const { MusicView, MUSIC_VIEW, OLD_VIEWS } = require("./views.js");

const REPO = "https://github.com/anthonyfitzpatrick/discogs-music-sync-to-obsidian";

// A "base" (library) takes the records of one or more Discogs formats into its own vault folder, with
// its own tag, and its own place in the Library and Dashboard views. A new install starts with none and
// sets them up from the formats in the user's collection.
const DEFAULTS = { last: null, username: "", folder: DEFAULT_FOLDER, lyrics: true, gallery: true, pdf: { size: "A4", orientation: "portrait" },
  value: null,                                   // Discogs' own value of the collection, fetched with each sync
  tab: "dashboard",                              // the Music tab shown last: dashboard or library
  library: { base: "", view: "gallery", sort: "", search: "" },   // the Library's last choices
  legacyFiles: [] };                             // files earlier versions made, offered for removal in settings
// Files versions before 0.11 kept in the vault, which the plugin no longer uses. Those versions always
// used a folder called Music, so only there. Offered for removal in settings, never removed without
// asking; in any other vault they simply aren't found. (Each base's .base file is added on loading.)
const LEGACY_FILES = ["Music/Music Dashboard.md", "Music/All Media.base", "Music/.discogs-token", "Music/.genius-token",
  "Music/.vinyl-sync/collection-value.json", "Music/.vinyl-sync/last-export.html"];
// Tokens live in Obsidian's local storage for this vault on this device: never in a file, so never in git.
const TOKEN_KEYS = { discogs: "music-library-sync-discogs-token", genius: "music-library-sync-genius-token" };
const ICONS = ["disc-3", "disc", "disc-2", "cassette-tape", "album", "music", "music-2", "radio", "headphones", "library", "guitar", "piano"];
const PRICE_KEYS = ["price_low_sek", "price_mid_sek", "price_high_sek", "price_max_sek", "price_my_copy_sek", "market_lowest_sek", "market_for_sale", "price_checked"];
const GRADE = { low: "Good Plus (G+)", mid: "Very Good Plus (VG+)", high: "Near Mint (NM or M-)" };

/* ------------------------------------------------------------------ helpers */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const safe = (s) => s.replace(/[\\/:*?"<>|#^\[\]]/g, "").trim().replace(/\.+$/, "");
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const n2 = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const core = (title) => {
  let t = String(title).split(" – ").pop();
  t = t.replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/\s+-\s+(live|remaster|mono|stereo|single|edit|version).*$/i, "");
  return n2(t);
};
const artistOk = (want, got) => {
  const w = n2(want).replace(/^the/, ""), g = n2(got).replace(/^the/, "");
  if (!w || w === "various") return false;
  return w === g || (g.length >= 4 && (w.includes(g) || g.includes(w)));
};
const titleOk = (got, want) => got === want || (Math.min(got.length, want.length) >= 6 && (got.startsWith(want) || want.startsWith(got)));
const splitArtists = (a) => [a, ...String(a).split(/\s+(?:featuring|feat\.?|ft\.?|with|and|&)\s+|\s*[·,\/]\s*/i)].map((x) => x.trim()).filter((x, i, arr) => x && x.toLowerCase() !== "various" && arr.indexOf(x) === i);

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
    read: (p) => adapter.read(p),
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
    this.cfg = Object.assign({ username: "", folder: DEFAULT_FOLDER, lyrics: true, gallery: true, libraries: [], discogsToken: "", geniusToken: "" }, cfg);
    this.last = { discogs: 0, genius: 0 };
    this.noSuggest = false;
  }
  async http(kind, url, headers, binary) {
    const gap = kind === "discogs" ? 1100 : kind === "img" ? 300 : 350;
    const host = kind === "genius" ? "Genius" : "Discogs";
    for (let attempt = 0; attempt < 6; attempt++) {
      if (this.isCancelled()) throw new Error("Cancelled");
      const wait = gap - (Date.now() - (this.last[kind] || 0));
      if (wait > 0) await sleep(wait);
      this.last[kind] = Date.now();
      let r;
      try {
        r = await Promise.race([requestUrl({ url, headers, throw: false }),
          sleep(30000).then(() => { throw new Error("timeout"); })]);
      } catch (e) { this.log(`  ${host} didn't answer (${e.message}) — retrying ${attempt + 1}/5…`); await sleep(3000 * (attempt + 1)); continue; }
      if (r.status === 429 || r.status >= 500) {
        const w = kind === "discogs" ? 15000 : 3000 * (attempt + 1);
        this.log(`  ${host} is busy (${r.status}) — waiting ${Math.round(w / 1000)} s…`); await sleep(w); continue; }
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

  async prices(releaseId, myCondition) {
    const out = Object.fromEntries(PRICE_KEYS.map((k) => [k, ""]));
    try {
      const st = await this.discogs(`marketplace/stats/${releaseId}?curr_abbr=SEK`);
      if (st?.lowest_price?.value != null) out.market_lowest_sek = Math.round(st.lowest_price.value);
      out.market_for_sale = st?.num_for_sale ?? "";
    } catch (e) { this.log(`  stats: ${e.message}`); }
    if (!this.noSuggest) {
      try {
        const s = await this.discogs(`marketplace/price_suggestions/${releaseId}`);
        const v = (g) => (s[g] ? Math.round(s[g].value) : "");
        out.price_low_sek = v(GRADE.low); out.price_mid_sek = v(GRADE.mid); out.price_high_sek = v(GRADE.high); out.price_max_sek = v("Mint (M)");
        if (myCondition) out.price_my_copy_sek = v(myCondition);
      } catch (e) { this.noSuggest = true; this.log("  (price suggestions need Discogs Seller Settings — skipping)"); }
    }
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
    const fieldMap = Object.fromEntries(((await this.discogs(`users/${this.cfg.username}/collection/fields`)).fields || []).map((x) => [x.id, x.name]));

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
        const inst = (await this.fs.read(p)).match(/^discogs_instance:\s*(\d+)/m)?.[1];
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
    let text = await this.fs.read(path);
    const end = text.indexOf("\n---", 3);
    let fm = text.slice(0, end); const rest = text.slice(end);
    const tagLine = new RegExp(`^(\\s*-\\s*)#?${fromTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
    if (tagLine.test(fm)) fm = fm.replace(tagLine, `$1${toTag}`);
    else this.log(`  (couldn't find the tag ${fromTag} in ${name}; set its tag to ${toTag} yourself)`);
    if (addLine) fm = fm.replace("\ncssclasses:", `\n${addLine}\ncssclasses:`);
    text = fm + rest;
    await this.fs.write(path, text);
    await this.fs.rename(path, dest);
  }

  /* ---- one new record note ---- */
  async createNote(T, item, fieldMap) {
    const rel = await this.discogs(`releases/${item.id}`);
    let masterYear = "";
    if (rel.master_id) { try { masterYear = (await this.discogs(`masters/${rel.master_id}`)).year || ""; } catch (e) { this.log(`  original year: ${e.message}`); } }
    // cover
    let cover = "";
    const imgs = rel.images || [];
    const img = imgs.find((x) => x.type === "primary") || imgs[0];
    if (img?.uri) {
      const ext = (img.uri.split("?")[0].match(/\.(jpe?g|png|gif|webp)$/i)?.[0] || ".jpg").toLowerCase();
      cover = `${rel.id}${ext}`;
      const dest = `${T.dir}/covers/${cover}`;
      if (!(await this.fs.exists(dest))) {
        try { await this.fs.writeBinary(dest, await this.discogs(img.uri, true)); }
        catch (e) { this.log(`  cover failed: ${e.message}`); cover = ""; }
      }
    }
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
    const cond = Object.fromEntries(item.notes.map((n) => [fieldMap[n.field_id] || n.field_id, n.value]));
    const pr = await this.prices(rel.id, cond["Media Condition"] || "");
    const artist = artistsStr(rel.artists);
    const lab = (rel.labels || [{}])[0];
    const fmts = rel.formats || [];
    const fmtS = fmts.map((x) => `${x.qty || "1"}x ${x.name}` + (x.descriptions?.length ? ", " + x.descriptions.join(", ") : "")).join("; ");
    const fm = [
      "---",
      `artist: ${q(artist)}`, `title: ${q(rel.title)}`, `year: ${rel.year || ""}`, `original_year: ${masterYear || rel.year || ""}`,
      "genres:", ...(rel.genres || []).map((g) => `  - ${q(g)}`),
      "styles:", ...(rel.styles || []).map((g) => `  - ${q(g)}`),
      `label: ${q(cleanName(lab.name))}`, `catno: ${q(lab.catno)}`, `country: ${q(rel.country)}`,
      `format: ${q(fmtS)}`, `media: ${q(fmts[0]?.name || "")}`,
      `cover: ${cover ? q(`[[${cover}]]`) : ""}`,
      `media_condition: ${q(cond["Media Condition"] || "")}`, `sleeve_condition: ${q(cond["Sleeve Condition"] || "")}`,
      "purchased: ", `shop: ""`, "price_paid_sek: ",
      ...PRICE_KEYS.map((k) => `${k}: ${pr[k]}`),
      `added_to_discogs: ${item.added}`,
      `discogs_id: ${rel.id}`, `discogs_instance: ${item.instance}`, `discogs_url: ${q(rel.uri || "")}`,
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
      let fm = text.slice(0, end); const rest = text.slice(end);
      const id = fm.match(/^discogs_id:\s*(\d+)/m)?.[1]; if (!id) continue;
      const mc = fm.match(/^media_condition:\s*"?([^"\n]*)"?/m)?.[1]?.trim() || "";
      const pr = await this.prices(id, mc);
      for (const k of PRICE_KEYS) {
        const line = `${k}: ${pr[k]}`, re = new RegExp(`^${k}:.*$`, "m");
        fm = re.test(fm) ? fm.replace(re, line) : fm.replace(/^(discogs_id:)/m, `${line}\n$1`);
      }
      if (fm + rest !== text) { await this.fs.write(p, fm + rest); n++; }
    }
    onProgress?.(notes.length, notes.length);
    this.log(`${T.name}: prices refreshed on ${n} notes`);
    return n;
  }

  /* ---- Discogs' own value of the whole collection, for the dashboard: { min, med, max, checked } ---- */
  async collectionValue() {
    const r = await this.discogs(`users/${this.cfg.username}/collection/value`);
    const n = (x) => { const v = Math.round(parseFloat(String(x ?? "").replace(/[^0-9.]/g, ""))); return Number.isFinite(v) ? v : null; };
    const value = { min: n(r?.minimum), med: n(r?.median), max: n(r?.maximum), checked: today() };
    this.log(`Collection value: ${value.med === null ? "not available" : `median ${value.med} kr`}`);
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
    this.titleEl.setText("Export Music Dashboard as PDF");
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
    this.data.folder = cleanFolder(this.data.folder) || DEFAULT_FOLDER;
    // Before 0.10 a base synced a Discogs folder. The folders were named after their formats (Vinyl,
    // CD, Cassette), which are Discogs' own spellings, so each becomes the format its base takes.
    for (const lib of this.data.libraries) if (!Array.isArray(lib.formats)) { lib.formats = [lib.discogsFolder || lib.name]; delete lib.discogsFolder; }
    // Before 0.11 each base had a .base file. The views replace them; the files are offered for removal.
    for (const lib of this.data.libraries) if (lib.base) { if (!this.data.legacyFiles.includes(lib.base)) this.data.legacyFiles.push(lib.base); delete lib.base; }
    this.data.library = Object.assign(structuredClone(DEFAULTS.library), this.data.library);
    await this.importTokenFiles();
    this.state = { running: false, mode: null, steps: {}, now: "", log: "", progress: 0 };
    this.panels = new Set();
    this.registerMarkdownCodeBlockProcessor("music-sync", (_src, el) => this.renderPanel(el));
    this.registerView(MUSIC_VIEW, (leaf) => new MusicView(leaf, this));
    for (const type of Object.keys(OLD_VIEWS)) this.registerView(type, (leaf) => new MusicView(leaf, this, type));
    this.addRibbonIcon("disc-3", "Open Music: Dashboard and Library", () => this.openView());
    this.addCommand({ id: "open-dashboard", name: "Open dashboard", callback: () => this.openView("dashboard") });
    this.addCommand({ id: "open-library", name: "Open library", callback: () => this.openView("library") });
    this.addCommand({ id: "sync", name: "Sync from Discogs", callback: () => this.run("sync") });
    this.addCommand({ id: "prices", name: "Refresh prices", callback: () => this.run("prices") });
    this.addCommand({ id: "dashboard", name: "Refresh collection value", callback: () => this.run("dashboard") });
    this.addCommand({ id: "cancel", name: "Cancel running sync", callback: () => (this.cancelled = true) });
    this.addCommand({ id: "export-pdf", name: "Export dashboard as PDF…", callback: () => new ExportModal(this.app, this).open() });
    this.addCommand({ id: "add-base", name: "Add a base…", callback: () => new LibraryModal(this.app, this, null).open() });
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
    if (open) { this.app.workspace.revealLeaf(open); if (tab) await open.view?.show?.(tab); return; }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: MUSIC_VIEW, active: true, state: { tab: tab || this.data.tab } });
    this.app.workspace.revealLeaf(leaf);
  }
  redrawViews() {
    for (const leaf of this.musicLeaves()) leaf.view?.render?.().catch?.((e) => console.error(e));
  }
  baseNames() { return this.data.libraries.map((l) => l.name); }
  collectionValue() { return decodeCollectionValue(this.data.value && { discogs_value_min: this.data.value.min, discogs_value_median: this.data.value.med, discogs_value_max: this.data.value.max }); }
  // A record's cover image, found the way Obsidian resolves the note's link to it.
  coverFile(record) { return record.cover ? this.app.metadataCache.getFirstLinkpathDest(record.cover, record.path) : null; }
  // Ticking Listened on the dashboard records it in the note's properties.
  async markListened(path, box) {
    const f = this.app.vault.getAbstractFileByPath(path);
    try { await this.app.fileManager.processFrontMatter(f, (fm) => { fm.listened = true; fm.listened_on = today(); }); }
    catch (e) { box.checked = false; new Notice(`Couldn't mark it as listened to: ${e.message}`); console.error(e); }
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
  async checkLibrary(v, self = null) {
    const problem = nameProblem(v, this.data.libraries.filter((l) => l !== self), !!self);
    if (problem) return problem;
    const name = tidy(v.name);
    const fs = this.app.vault.adapter;
    if (!self && (await fs.exists(`${this.data.folder}/${name}`))) return `${this.data.folder} already has a folder called “${name}”.`;
    return "";
  }

  // Creates the base's folder and starts syncing it.
  async addLibrary(v) {
    const err = await this.checkLibrary(v); if (err) throw new Error(err);
    const name = tidy(v.name), s = slug(name);
    let id = s, n = 2; while (this.data.libraries.some((l) => l.id === id)) id = `${s}-${n++}`;
    const lib = { id, name, formats: [...v.formats], dir: `${this.data.folder}/${name}`, tag: `${s}-library`, icon: v.icon || "disc-3" };
    await this.ensureLibraryFiles(lib);
    this.data.libraries.push(lib);
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
      const err = await this.checkLibrary(v);
      if (err) { skipped.push(`${f}: ${err}`); continue; }
      added.push(await this.addLibrary(v));
    }
    return { added, skipped };
  }

  // Stops syncing a base. Its folder and notes are left in the vault.
  async removeLibrary(lib) {
    this.data.libraries = this.data.libraries.filter((l) => l !== lib);
    await this.save();
  }

  /* ---- Discogs / Genius helpers for the settings page ---- */
  token(kind) { return String(this.app.loadLocalStorage(TOKEN_KEYS[kind]) ?? ""); }
  saveToken(kind, value) { this.app.saveLocalStorage(TOKEN_KEYS[kind], value.trim() || null); this.formatCache = null; }
  // Tokens kept in files by earlier versions are read in once; the files are then offered for removal.
  async importTokenFiles() {
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
  // Moves them to the system trash (recoverable): through Obsidian, except files in dot-folders or
  // dot-files, which Obsidian doesn't index.
  async trashLegacyFiles(paths) {
    for (const p of paths) {
      const hidden = p.split("/").some((part) => part.startsWith("."));
      const f = hidden ? null : this.app.vault.getAbstractFileByPath(p);
      if (f) await this.app.vault.trash(f, true); else await this.app.vault.adapter.trashSystem(p);
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
      if (page > 1) await sleep(1100);                                   // Discogs' rate limit
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
    const probe = document.body.createDiv();
    probe.style.display = "none";
    const color = (name, fallback) => { probe.style.color = ""; probe.style.color = `var(${name}, ${fallback})`; return cssColorToHex(getComputedStyle(probe).color, fallback); };
    probe.style.fontFamily = "var(--font-text, sans-serif)";
    const theme = { fg: color("--text-normal", "#222222"), bg: color("--background-primary", "#ffffff"), muted: color("--text-muted", "#666666"),
      border: color("--background-modifier-border", "#cccccc"), font: getComputedStyle(probe).fontFamily || "sans-serif" };
    probe.remove();
    return theme;
  }

  // Builds the Music Dashboard as its own page from the notes (report.js) and prints it to PDF with
  // Obsidian's desktop app. Dataview and Charts are not involved, and the dashboard needn't be open.
  async exportPdf({ size = "A4", orientation = "portrait" } = {}) {
    const electron = require("electron");
    const remote = electron.remote || (() => { try { return require("@electron/remote"); } catch { return null; } })();
    if (!remote?.BrowserWindow) throw new Error("PDF export isn't available in this version of Obsidian. Please report it with “Report a bug” in the plugin's settings.");
    if (!this.data.libraries.length) throw new Error("Add a base first — there's nothing to export yet");
    const fs = require("fs"), os = require("os"), path = require("path");
    const notice = new Notice("Preparing PDF…", 0);
    try {
      const value = this.collectionValue();
      const theme = this.themeForReport();
      const stamp = moment().format("D MMMM YYYY, HH:mm");
      const html = buildReport(await this.collectRecords(), this.data.libraries.map((l) => l.name), value, theme, stamp);
      const tmp = path.join(os.tmpdir(), `music-dashboard-export-${Date.now()}.html`);
      fs.writeFileSync(tmp, html, "utf8");
      const [w, h] = PAPER[size] || PAPER.A4;
      const printableW = Math.round(((orientation === "landscape" ? h : w) - 2 * MARGIN) * 96);
      const win = new remote.BrowserWindow({ show: false, width: printableW, height: 1200, webPreferences: { offscreen: false } });
      try {
        await win.loadFile(tmp);
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
      } finally { win.destroy(); try { fs.unlinkSync(tmp); } catch { /* a leftover file in the system temp folder is harmless */ } }
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
    else p.meta.setText("Press Sync to pull new records from Discogs");
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
    p.bar.style.width = `${Math.round(s.progress * 100)}%`;
    p.now.setText(s.running ? s.now : "");
    p.log.setText(s.log || "No run yet in this session.");
  }
  refresh() { for (const p of this.panels) { if (!p.root.isConnected) { this.panels.delete(p); continue; } this.paint(p); } }

  async run(mode) {
    const s = this.state;
    if (s.running) { new Notice("Music sync is already running"); return; }
    const need = !this.data.username ? "Enter your Discogs username" : !this.token("discogs") ? "Save your Discogs token" :
      mode !== "dashboard" && !this.data.libraries.length ? "Add a base" : "";
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
      discogsToken: this.token("discogs"), geniusToken: this.token("genius"), folder: d.folder });
    const steps = mode === "dashboard" ? [] : libs;
    const work = steps.length + 1;
    let failed = false, created = 0, priced = 0;
    this.refresh();
    try {
      await eng.init();
      if (mode === "sync") {
        try {
          created = await eng.syncAll((lib, i, done, total) => {
            libs.slice(0, i).forEach((l) => { s.steps[l.id] = "done"; });
            s.steps[lib.id] = done >= total ? "done" : "active";
            s.progress = (i + (total ? done / total : 1)) / work; this.refresh();
          });
        } catch (e) { failed = true; for (const l of libs) if (s.steps[l.id] !== "done") s.steps[l.id] = "error"; log(`ERROR: ${e.message}`); console.error(e); }
      }
      for (let i = 0; mode === "prices" && i < steps.length && !this.cancelled; i++) {
        const st = steps[i];
        s.steps[st.id] = "active"; s.progress = i / work; this.refresh();
        const prog = (done, total) => { s.progress = (i + (total ? done / total : 1)) / work; this.refresh(); };
        try {
          priced += await eng.refreshPrices(st, prog);
          s.steps[st.id] = "done";
        } catch (e) { failed = true; s.steps[st.id] = "error"; log(`ERROR (${st.name}): ${e.message}`); console.error(e); }
      }
      s.steps.dashboard = "active"; s.progress = steps.length / work; this.refresh();
      try { this.data.value = await eng.collectionValue(); s.steps.dashboard = "done"; }
      catch (e) { failed = true; s.steps.dashboard = "error"; log(`ERROR (collection value): ${e.message}`); console.error(e); }
      this.redrawViews();
    } catch (e) { failed = true; log(`ERROR: ${e.message}`); console.error(e); }
    finally {
      const shown = Date.now() - started; if (shown < 1500) await new Promise((r) => setTimeout(r, 1500 - shown));
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
      text: "A base takes every record of the formats you choose, from anywhere in your Discogs collection, into its own folder in Music, with its own tag and its own place in the Library and on the Dashboard." });
    new Setting(c).setName("Name")
      .setDesc(lib ? `The notes stay in ${lib.dir}.` : "Used for the base's folder in Music. No two bases can have the same name.")
      .addText((t) => { t.setPlaceholder("e.g. Minidiscs").setValue(v.name).onChange((x) => { v.name = x; touched = true; check(); }); window.setTimeout(() => t.inputEl.focus(), 0); });

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
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  async display() {
    const P = this.plugin, d = P.data, el = this.containerEl;
    const gen = (this.gen = (this.gen || 0) + 1);
    const saved = { discogs: !!P.token("discogs"), genius: !!P.token("genius") };
    const legacy = await P.legacyFilesPresent();
    if (gen !== this.gen) return;                               // a newer redraw has started
    el.empty();
    const redraw = () => this.display();

    if (!d.username || !saved.discogs || !d.libraries.length) {
      const g = el.createDiv({ cls: "mls-getting-started" });
      g.createEl("strong", { text: "Getting started" });
      const ol = g.createEl("ol");
      [["Enter your Discogs username and paste a personal access token below, then press Test.", d.username && saved.discogs],
       ["Under Bases, press “Set up from Discogs” and tick the formats to sync, such as Vinyl and CD.", d.libraries.length > 0],
       ["Run “Sync from Discogs” from the command palette, then press the disc icon in the ribbon to open the Music Dashboard.", false]]
        .forEach(([t, done]) => ol.createEl("li", { text: t, cls: done ? "is-done" : "" }));
    }

    new Setting(el).setName("Discogs").setHeading();
    new Setting(el).setName("Library folder")
      .setDesc("Where new bases get their folders, and where removed records and PDF exports go. Existing bases keep their folders.")
      .addText((t) => {
        t.setPlaceholder(DEFAULT_FOLDER).setValue(d.folder);
        t.inputEl.addEventListener("change", async () => {
          const f = cleanFolder(t.getValue());
          if (!f || f.split("/").some((part) => part.startsWith(".") || /[\\:*?"<>|#^[\]]/.test(part))) {
            new Notice("Choose a folder name without \\ : * ? \" < > | # ^ [ ] and not starting with a dot"); t.setValue(d.folder); return;
          }
          d.folder = f; t.setValue(f); await P.save();
        });
      });
    new Setting(el).setName("Username").setDesc("The Discogs account whose collection is synced.")
      .addText((t) => t.setPlaceholder("your-discogs-name").setValue(d.username || "").onChange(async (x) => { d.username = x.trim(); P.formatCache = null; await P.save(); }));
    this.token(el, saved.discogs, "Personal access token", "discogs",
      "Required. Create one at discogs.com → Settings → Developers.", "Discogs", async () => {
        const who = await P.discogsIdentity();
        if (!d.username) { d.username = who; await P.save(); redraw(); }
        return who.toLowerCase() === (d.username || "").toLowerCase() ? `Connected as ${who}` : `The token belongs to ${who}, but the username above is ${d.username}`;
      });

    new Setting(el).setName("Lyrics").setHeading();
    new Setting(el).setName("Add Genius lyrics links").setDesc("Look up each track on Genius when a record is added. Needs a Genius token.")
      .addToggle((t) => t.setValue(d.lyrics).onChange(async (x) => { d.lyrics = x; await P.save(); }));
    this.token(el, saved.genius, "Genius access token", "genius",
      "Optional. Create a client at genius.com/api-clients and generate an access token.", "Genius", async () => { await P.geniusCheck(); return "Genius accepted the token"; });

    new Setting(el).setName("Bases").setHeading();
    el.createEl("p", { cls: "setting-item-description",
      text: "Each base takes the records of the formats you choose, from anywhere in your Discogs collection, into its own folder in Music, with its own place in the Library and on the Dashboard. Names must be unique." });
    if (!d.libraries.length) el.createEl("p", { cls: "setting-item-description", text: "No bases yet." });
    for (const lib of d.libraries) {
      const row = new Setting(el).setName(lib.name)
        .setDesc(`Takes ${lib.formats.join(", ")} records → ${lib.dir} · #${lib.tag}`)
        .addExtraButton((b) => b.setIcon("pencil").setTooltip("Rename or edit").onClick(() => new LibraryModal(this.app, P, lib, redraw).open()))
        .addExtraButton((b) => b.setIcon("trash-2").setTooltip("Stop syncing this base")
          .onClick(() => new ConfirmModal(this.app, `Stop syncing “${lib.name}”?`,
            `It disappears from the sync, the Library and the Dashboard. ${lib.dir} and its notes stay in your vault — delete them yourself if you no longer want them.`,
            "Stop syncing", async () => { await P.removeLibrary(lib); redraw(); }).open()));
      setIcon(row.nameEl.createSpan({ cls: "mls-lib-icon", prepend: true }), lib.icon);
    }
    new Setting(el)
      .addButton((b) => b.setButtonText("Set up from Discogs").setDisabled(!d.username || !saved.discogs)
        .setTooltip(d.username && saved.discogs ? "Choose formats from your collection to add as bases" : "Enter your username and token first")
        .onClick(() => new SetupModal(this.app, P, redraw).open()))
      .addButton((b) => b.setButtonText("Add base").setCta().onClick(() => new LibraryModal(this.app, P, null, redraw).open()));

    if (legacy.length) {
      new Setting(el).setName("Files from earlier versions").setHeading();
      el.createEl("p", { cls: "setting-item-description",
        text: "Earlier versions kept these in your vault. The plugin no longer uses them: the Dashboard and Library views, and tokens kept on this device, have replaced them." });
      const ul = el.createEl("ul", { cls: "mls-legacy-list" });
      for (const f of legacy) ul.createEl("li", { text: f });
      new Setting(el).addButton((b) => b.setButtonText("Move to trash").setWarning().onClick(() => new ConfirmModal(this.app, "Move these files to the trash?",
        `${legacy.join(", ")}. They go to your system trash, so you can get them back.`, "Move to trash",
        async () => { await P.trashLegacyFiles(legacy); new Notice("Moved to the trash"); redraw(); }).open()));
    }

    new Setting(el).setName("Sync").setHeading();
    new Setting(el).setName("Download all images").setDesc("Save every Discogs photo (back cover, labels, inserts) with a new record, not just the front cover.")
      .addToggle((t) => t.setValue(d.gallery).onChange(async (x) => { d.gallery = x; await P.save(); }));

    new Setting(el).setName("PDF export").setHeading();
    new Setting(el).setName("Paper size").addDropdown((dd) => {
      Object.keys(PAPER).forEach((k) => dd.addOption(k, `${k} (${PAPER[k][0]} × ${PAPER[k][1]} in)`));
      dd.setValue(d.pdf.size).onChange(async (x) => { d.pdf.size = x; await P.save(); });
    });
    new Setting(el).setName("Orientation").addDropdown((dd) => {
      dd.addOption("portrait", "Portrait").addOption("landscape", "Landscape");
      dd.setValue(d.pdf.orientation).onChange(async (x) => { d.pdf.orientation = x; await P.save(); });
    });

    const about = new Setting(el).settingEl;
    about.empty(); about.addClass("mls-about-row");
    this.aboutFooter(about);
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

  // A token is kept in Obsidian's local storage on this device: never in a file, the vault or the plugin's settings.
  token(el, saved, name, kind, desc, service, test) {
    const P = this.plugin;
    const s = new Setting(el).setName(name).setDesc(`${desc} ${saved ? "A token is saved on this device." : "No token saved yet."}`);
    s.addText((t) => {
      t.inputEl.type = "password";
      t.setPlaceholder(saved ? "Paste a new token to replace it" : "Paste the token here");
      t.inputEl.addEventListener("change", async () => {
        const x = t.getValue().trim(); if (!x) return;
        P.saveToken(kind, x); new Notice(`${service} token saved on this device`); this.display();
      });
    });
    s.addButton((b) => b.setButtonText("Test").setDisabled(!saved).onClick(async () => {
      b.setDisabled(true); b.setButtonText("Testing…");
      try { new Notice(await test(), 6000); } catch (e) { new Notice(e.message, 8000); }
      b.setDisabled(false); b.setButtonText("Test");
    }));
  }
}

module.exports = MusicLibrarySync;
module.exports.Engine = Engine;          // exported for testing
module.exports.vaultFiles = vaultFiles;
