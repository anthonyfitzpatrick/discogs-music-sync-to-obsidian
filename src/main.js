/* Discogs music sync and dashboard (plugin ID music-library-sync) — Wolf 359 Press.
   Pure JavaScript: talks to Discogs + Genius with Obsidian's requestUrl and writes notes
   through the vault adapter. No Python required.
   Safety: never overwrites an existing album note (except price fields on "Refresh prices")
   and never touches "Music/Vinyl Record Library.md". */
const obsidian = require("obsidian");
const { Plugin, PluginSettingTab, Notice, requestUrl, setIcon, moment, Modal, Setting } = obsidian;

const MUSIC = "Music";
const DASHBOARD = "Music/Music Dashboard.md";
const ALL_MEDIA_BASE = "Music/All Media.base";
const VERSION = "0.10.1";
const UA = `Wolf359DiscogsMusicSync/${VERSION}`;
// Bundled as text by esbuild (see esbuild.config.mjs), so the dashboard ships inside main.js.
const DASHBOARD_TEMPLATE = require("./dashboard-template.md");
// Pure logic, testable without Obsidian: names, tags, .base files, icons, naming rules.
const { tidy, slug, baseYaml, allMediaYaml, guessIcon, nameProblem, baseFor, formatCounts } = require("./bases.js");
// Decoders for Discogs responses, applied where the responses arrive.
const { decodeCollectionPage, decodeIdentity } = require("./discogs.js");
// The dashboard as a standalone page for PDF export, built without Dataview or Charts.
const { decodeRecord, decodeCollectionValue, cssColorToHex, buildReport } = require("./report.js");

const REPO = "https://github.com/anthonyfitzpatrick/discogs-music-sync-to-obsidian";

// A "base" (library) takes the records of one or more Discogs formats into its own vault folder, with
// its own tag, its own .base view and its own place on the dashboard. A new install starts with none and
// sets them up from the formats in the user's collection; these three are for installs from before 0.8,
// whose settings predate the list of bases.
const LEGACY_LIBRARIES = [
  { id: "vinyl", name: "Vinyl", formats: ["Vinyl"],    dir: "Music/Vinyl", tag: "vinyl-library", icon: "disc-3",        base: "Music/Vinyl.base" },
  { id: "cds",   name: "CDs",   formats: ["CD"],       dir: "Music/CDs",   tag: "cd-library",    icon: "disc",          base: "Music/CDs.base" },
  { id: "tapes", name: "Tapes", formats: ["Cassette"], dir: "Music/Tapes", tag: "tape-library",  icon: "cassette-tape", base: "Music/Tapes.base" },
];
const DEFAULTS = { last: null, username: "", lyrics: true, gallery: true, pdf: { size: "A4", orientation: "portrait" } };
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
    this.cfg = Object.assign({ username: "", lyrics: true, gallery: true, libraries: [], template: DASHBOARD_TEMPLATE }, cfg);
    this.last = { discogs: 0, genius: 0 };
    this.noSuggest = false;
  }
  async token(name) {
    const p = `${MUSIC}/${name}`;
    if (!(await this.fs.exists(p))) throw new Error(`Missing ${p}`);
    return (await this.fs.read(p)).trim();
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
    this.dToken = await this.token(".discogs-token");
    this.gToken = (await this.fs.exists(`${MUSIC}/.genius-token`)) ? await this.token(".genius-token") : null;
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
      await this.moveNote(note.path, `${MUSIC}/Removed from collection`, note.lib.tag, "removed-from-collection", `removed_from_collection: ${today()}`);
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
      "purchased: ", `shop: ""`, "price_paid_sek: ", "ripped: false",
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

  /* ---- dashboard: live Dataview + Charts note built from the template shipped with the plugin ---- */
  async dashboard(outPath = DASHBOARD) {
    await this.ensureDir(`${MUSIC}/.vinyl-sync`);
    let v = {};
    try {
      const r = await this.discogs(`users/${this.cfg.username}/collection/value`);
      const n = (s) => Math.round(parseFloat(String(s).replace(/[^0-9.]/g, "")));
      v = { MIN: n(r.minimum), MED: n(r.median), MAX: n(r.maximum), CHECKED: today() };
    } catch (e) { this.log(`  collection value: ${e.message}`); }
    if (v.MED) await this.fs.write(`${MUSIC}/.vinyl-sync/collection-value.json`, JSON.stringify(
      { discogs_value_min: v.MIN, discogs_value_median: v.MED, discogs_value_max: v.MAX, checked: v.CHECKED }));
    const text = this.cfg.template;
    if (!(await this.fs.exists(outPath)) || (await this.fs.read(outPath)) !== text) await this.fs.write(outPath, text);
    this.log(`Dashboard rebuilt${v.MED ? ` (Discogs median ${v.MED} kr)` : ""}`);
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
    new Setting(this.contentEl).setName("Saved to").setDesc("Music/Exports in your vault, then opened in your PDF viewer.");
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
    if (!Array.isArray(this.data.libraries)) this.data.libraries = saved ? structuredClone(LEGACY_LIBRARIES) : [];
    if (saved && saved.username === undefined) this.data.username = "discogs-user";   // pre-0.8 settings were the author's own
    // Before 0.10 a base synced a Discogs folder. The folders were named after their formats (Vinyl,
    // CD, Cassette), which are Discogs' own spellings, so each becomes the format its base takes.
    for (const lib of this.data.libraries) if (!Array.isArray(lib.formats)) { lib.formats = [lib.discogsFolder || lib.name]; delete lib.discogsFolder; }
    this.state = { running: false, mode: null, steps: {}, now: "", log: "", progress: 0 };
    this.panels = new Set();
    this.registerMarkdownCodeBlockProcessor("music-sync", (_src, el) => this.renderPanel(el));
    this.addRibbonIcon("disc-3", "Open Music Dashboard", () => this.openDashboard());
    this.addCommand({ id: "open-dashboard", name: "Open dashboard", callback: () => this.openDashboard() });
    this.addCommand({ id: "sync", name: "Sync from Discogs", callback: () => this.run("sync") });
    this.addCommand({ id: "prices", name: "Refresh prices", callback: () => this.run("prices") });
    this.addCommand({ id: "dashboard", name: "Rebuild dashboard", callback: () => this.run("dashboard") });
    this.addCommand({ id: "cancel", name: "Cancel running sync", callback: () => (this.cancelled = true) });
    this.addCommand({ id: "export-pdf", name: "Export dashboard as PDF…", callback: () => new ExportModal(this.app, this).open() });
    this.addCommand({ id: "add-base", name: "Add a base…", callback: () => new LibraryModal(this.app, this, null).open() });
    this.addSettingTab(new MusicSettingTab(this.app, this));
    this.registerInterval(window.setInterval(() => this.refresh(), 60 * 1000));
  }

  /* ---- libraries ("bases") ---- */
  libraries() { return this.data.libraries.map((l) => ({ ...l })); }        // read by the dashboard note
  steps() {
    return [...this.data.libraries.map((l) => ({ key: l.id, label: l.name, icon: l.icon })),
      { key: "dashboard", label: "Dashboard", icon: "layout-dashboard" }];
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
    const fs = this.app.vault.adapter, basePath = `${MUSIC}/${name}.base`;
    if ((!self || basePath.toLowerCase() !== self.base.toLowerCase()) && (await fs.exists(basePath))) return `Music already has a file called “${name}.base”.`;
    if (!self && (await fs.exists(`${MUSIC}/${name}`))) return `Music already has a folder called “${name}”.`;
    return "";
  }

  // Creates the folder, the .base file and the All Media entry, then starts syncing it.
  async addLibrary(v) {
    const err = await this.checkLibrary(v); if (err) throw new Error(err);
    const name = tidy(v.name), s = slug(name);
    let id = s, n = 2; while (this.data.libraries.some((l) => l.id === id)) id = `${s}-${n++}`;
    const lib = { id, name, formats: [...v.formats], dir: `${MUSIC}/${name}`, tag: `${s}-library`, icon: v.icon || "disc-3", base: `${MUSIC}/${name}.base` };
    await this.ensureLibraryFiles(lib);
    this.data.libraries.push(lib);
    await this.save();
    return lib;
  }

  // Renames the base (and its .base file) and updates its formats and icon. Notes aren't moved here;
  // the next sync moves any record whose format now belongs to another base.
  async updateLibrary(lib, v) {
    const err = await this.checkLibrary(v, lib); if (err) throw new Error(err);
    const name = tidy(v.name);
    if (name !== lib.name) {
      const f = this.app.vault.getAbstractFileByPath(lib.base), to = `${MUSIC}/${name}.base`;
      if (f) {
        // a case-only rename needs a stop in between on a case-insensitive disk
        if (f.path.toLowerCase() === to.toLowerCase()) await this.app.fileManager.renameFile(f, `${MUSIC}/${name} (renaming).base`);
        await this.app.fileManager.renameFile(f, to);
      }
      lib.base = to; lib.name = name;
    }
    lib.formats = [...v.formats];
    lib.icon = v.icon || lib.icon;
    await this.save();
  }

  // Creates whatever a base needs and is missing: its folder, its .base file, All Media.base and
  // its entry there. Never changes a file that exists, apart from adding the entry.
  async ensureLibraryFiles(lib) {
    const vault = this.app.vault;
    if (!vault.getAbstractFileByPath(MUSIC)) await vault.createFolder(MUSIC);
    if (!vault.getAbstractFileByPath(lib.dir)) await vault.createFolder(lib.dir);
    if (!(await vault.adapter.exists(lib.base))) await vault.create(lib.base, baseYaml(lib.dir, lib.tag));
    const all = vault.getAbstractFileByPath(ALL_MEDIA_BASE);
    if (!all) { if (!(await vault.adapter.exists(ALL_MEDIA_BASE))) await vault.create(ALL_MEDIA_BASE, allMediaYaml([lib.tag])); return; }
    await vault.process(all, (t) => {
      if (t.includes(`file.hasTag("${lib.tag}")`)) return t;
      const m = [...t.matchAll(/^(\s*)- file\.hasTag\("[^"]*"\)$/gm)].pop();
      return m ? t.slice(0, m.index + m[0].length) + `\n${m[1]}- file.hasTag("${lib.tag}")` + t.slice(m.index + m[0].length) : t;
    });
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

  // What the Music Dashboard needs from other plugins and doesn't have, in plain words.
  dashboardProblems() {
    const pl = this.app.plugins, on = (id) => pl?.enabledPlugins?.has(id), out = [];
    if (!on("dataview")) out.push("Install and enable the Dataview plugin.");
    else if (pl.plugins?.dataview?.settings?.enableDataviewJs === false) out.push("Turn on “Enable JavaScript Queries” in Dataview's settings.");
    if (!on("obsidian-charts")) out.push("Install and enable the Charts plugin.");
    return out;
  }

  // Stops syncing a base. Its folder, notes and .base file are left in the vault.
  async removeLibrary(lib) {
    this.data.libraries = this.data.libraries.filter((l) => l !== lib);
    await this.save();
  }

  /* ---- Discogs / Genius helpers for the settings page ---- */
  async readToken(file) {
    const p = `${MUSIC}/${file}`, fs = this.app.vault.adapter;
    return (await fs.exists(p)) ? (await fs.read(p)).trim() : "";
  }
  async writeToken(file, value) { await this.app.vault.adapter.write(`${MUSIC}/${file}`, value.trim() + "\n"); this.formatCache = null; }
  async discogsIdentity() {
    const t = await this.readToken(".discogs-token"); if (!t) throw new Error("No Discogs token saved yet");
    const r = await requestUrl({ url: "https://api.discogs.com/oauth/identity", headers: { Authorization: `Discogs token=${t}`, "User-Agent": UA }, throw: false });
    if (r.status >= 400) throw new Error(r.status === 401 ? "Discogs didn't accept the token" : `Discogs answered ${r.status}`);
    return decodeIdentity(r.json);
  }
  async geniusCheck() {
    const t = await this.readToken(".genius-token"); if (!t) throw new Error("No Genius token saved yet");
    const r = await requestUrl({ url: "https://api.genius.com/search?q=test", headers: { Authorization: `Bearer ${t}` }, throw: false });
    if (r.status >= 400) throw new Error(r.status === 401 ? "Genius didn't accept the token" : `Genius answered ${r.status}`);
  }
  // The formats in the user's Discogs collection, with how many records include each — read from
  // Discogs, so a base's formats are always chosen from real names and never typed.
  async collectionFormats() {
    if (this.formatCache) return this.formatCache;
    const t = await this.readToken(".discogs-token");
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

  // Shows the Music Dashboard: switches to its tab if it's open, builds the note first if it doesn't exist yet.
  async openDashboard() {
    const open = this.app.workspace.getLeavesOfType("markdown").find((l) => l.view?.file?.path === DASHBOARD);
    if (open) { this.app.workspace.revealLeaf(open); return; }
    if (!this.app.vault.getAbstractFileByPath(DASHBOARD)) await this.run("dashboard");
    if (!this.app.vault.getAbstractFileByPath(DASHBOARD)) { new Notice("The Music Dashboard couldn't be created — see Sync log"); return; }
    await this.app.workspace.openLinkText(DASHBOARD, "", false);
  }

  // Every record note of every base, decoded for the PDF report. Reads Obsidian's own metadata
  // cache and the notes themselves, so it needs no other plugin.
  async collectRecords() {
    const byTag = new Map(this.data.libraries.map((l) => [l.tag.toLowerCase(), l.name]));
    const records = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;
      const media = [].concat(fm.tags ?? []).map((t) => String(t).replace(/^#/, "").toLowerCase()).map((t) => byTag.get(t)).find(Boolean);
      if (!media) continue;
      records.push(decodeRecord(fm, media, await this.app.vault.cachedRead(file), file.basename));
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
      let value = decodeCollectionValue(null);
      try { value = decodeCollectionValue(JSON.parse(await this.app.vault.adapter.read(`${MUSIC}/.vinyl-sync/collection-value.json`))); }
      catch { /* not fetched yet: the Discogs value columns show "—", as on the dashboard */ }
      const theme = this.themeForReport();
      const stamp = moment().format("D MMMM YYYY, HH:mm");
      const html = buildReport(await this.collectRecords(), this.data.libraries.map((l) => l.name), value, theme, stamp);
      const tmp = path.join(os.tmpdir(), `music-dashboard-export-${Date.now()}.html`);
      fs.writeFileSync(tmp, html, "utf8");
      try { await this.app.vault.adapter.write(`${MUSIC}/.vinyl-sync/last-export.html`, html); }   // for troubleshooting
      catch (e) { console.warn("Discogs music sync: couldn't keep a copy of the export page", e); }
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
        const dir = `${MUSIC}/Exports`;
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
    p.dash = btn("Rebuild dashboard", "layout-dashboard", "mls-secondary", () => this.run("dashboard"), "Redraw this dashboard");
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
    if (s.running) p.meta.setText(s.mode === "sync" ? "Syncing with Discogs…" : s.mode === "prices" ? "Refreshing prices…" : "Rebuilding dashboard…");
    else if (last) p.meta.setText(`${last.ok ? "✓" : "⚠"} Last ${last.mode === "sync" ? "sync" : last.mode === "prices" ? "price refresh" : "rebuild"} ${moment(last.at).fromNow()} · ${last.summary}`);
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
    const need = !this.data.username ? "Enter your Discogs username" : !(await this.readToken(".discogs-token")) ? "Save your Discogs token" :
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
    const eng = new Engine(vaultFiles(this.app), log, () => this.cancelled, { username: d.username, lyrics: d.lyrics, gallery: d.gallery, libraries: libs });
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
      try { await eng.dashboard(); s.steps.dashboard = "done"; }
      catch (e) { failed = true; s.steps.dashboard = "error"; log(`ERROR (dashboard): ${e.message}`); console.error(e); }
    } catch (e) { failed = true; log(`ERROR: ${e.message}`); console.error(e); }
    finally {
      const shown = Date.now() - started; if (shown < 1500) await new Promise((r) => setTimeout(r, 1500 - shown));
      const summary = this.cancelled ? `cancelled after ${created} new` : failed ? "finished with errors — open Sync log" :
        mode === "sync" ? ([created ? `${created} new record${created === 1 ? "" : "s"} added` : "", eng.moved ? `${eng.moved} moved to the right base` : "",
          eng.removed ? `${eng.removed} removed` : "", eng.unplaced ? `${eng.unplaced} with no base for their format — see Sync log` : ""].filter(Boolean).join(", ") || "already up to date") :
        mode === "prices" ? `prices updated on ${priced} records` : "dashboard rebuilt";
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
      text: "A base takes every record of the formats you choose, from anywhere in your Discogs collection, into its own folder in Music with its own .base view, its own tag and its own place on the dashboard." });
    new Setting(c).setName("Name")
      .setDesc(lib ? `Also renames ${lib.base.split("/").pop()}. The notes stay in ${lib.dir}.` : "Used for the folder and the .base file. No two bases can have the same name.")
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
      if (preview) { const name = tidy(v.name); preview.setText(name && !e ? `Creates ${MUSIC}/${name}/, ${MUSIC}/${name}.base and the tag #${slug(name)}-library.` : ""); }
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
      .setDesc(`${f.count} record${f.count === 1 ? "" : "s"}. Creates ${MUSIC}/${f.name}/ and ${MUSIC}/${f.name}.base`)
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
    const saved = { discogs: !!(await P.readToken(".discogs-token")), genius: !!(await P.readToken(".genius-token")) };
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
    new Setting(el).setName("Username").setDesc("The Discogs account whose collection is synced.")
      .addText((t) => t.setPlaceholder("your-discogs-name").setValue(d.username || "").onChange(async (x) => { d.username = x.trim(); P.formatCache = null; await P.save(); }));
    this.token(el, saved.discogs, "Personal access token", ".discogs-token",
      "Required. Create one at discogs.com → Settings → Developers.", "Discogs", async () => {
        const who = await P.discogsIdentity();
        if (!d.username) { d.username = who; await P.save(); redraw(); }
        return who.toLowerCase() === (d.username || "").toLowerCase() ? `Connected as ${who}` : `The token belongs to ${who}, but the username above is ${d.username}`;
      });

    new Setting(el).setName("Lyrics").setHeading();
    new Setting(el).setName("Add Genius lyrics links").setDesc("Look up each track on Genius when a record is added. Needs a Genius token.")
      .addToggle((t) => t.setValue(d.lyrics).onChange(async (x) => { d.lyrics = x; await P.save(); }));
    this.token(el, saved.genius, "Genius access token", ".genius-token",
      "Optional. Create a client at genius.com/api-clients and generate an access token.", "Genius", async () => { await P.geniusCheck(); return "Genius accepted the token"; });

    new Setting(el).setName("Bases").setHeading();
    el.createEl("p", { cls: "setting-item-description",
      text: "Each base takes the records of the formats you choose, from anywhere in your Discogs collection, into its own folder in Music, with its own .base view and a place on the dashboard. Names must be unique." });
    if (!d.libraries.length) el.createEl("p", { cls: "setting-item-description", text: "No bases yet." });
    for (const lib of d.libraries) {
      const row = new Setting(el).setName(lib.name)
        .setDesc(`Takes ${lib.formats.join(", ")} records → ${lib.dir} · #${lib.tag}`)
        .addExtraButton((b) => b.setIcon("pencil").setTooltip("Rename or edit").onClick(() => new LibraryModal(this.app, P, lib, redraw).open()))
        .addExtraButton((b) => b.setIcon("trash-2").setTooltip("Stop syncing this base")
          .onClick(() => new ConfirmModal(this.app, `Stop syncing “${lib.name}”?`,
            `It disappears from the sync and the dashboard. ${lib.dir}, its notes and ${lib.base.split("/").pop()} stay in your vault — delete them yourself if you no longer want them.`,
            "Stop syncing", async () => { await P.removeLibrary(lib); redraw(); }).open()));
      setIcon(row.nameEl.createSpan({ cls: "mls-lib-icon", prepend: true }), lib.icon);
    }
    new Setting(el)
      .addButton((b) => b.setButtonText("Set up from Discogs").setDisabled(!d.username || !saved.discogs)
        .setTooltip(d.username && saved.discogs ? "Choose formats from your collection to add as bases" : "Enter your username and token first")
        .onClick(() => new SetupModal(this.app, P, redraw).open()))
      .addButton((b) => b.setButtonText("Add base").setCta().onClick(() => new LibraryModal(this.app, P, null, redraw).open()));

    new Setting(el).setName("Dashboard").setHeading();
    const problems = P.dashboardProblems();
    new Setting(el).setName(problems.length ? "The Music Dashboard needs other plugins" : "Dashboard plugins are ready")
      .setDesc(problems.length ? `${problems.join(" ")} Syncing and PDF export work without them.` : "Dataview (with JavaScript queries) and Charts are enabled.")
      .addButton((b) => b.setButtonText("Open dashboard").onClick(() => P.openDashboard()));

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

  // A token is kept in its own file in Music (ignored by git), never in the plugin's settings.
  token(el, saved, name, file, desc, service, test) {
    const P = this.plugin;
    const s = new Setting(el).setName(name).setDesc(`${desc} ${saved ? "A token is saved." : "No token saved yet."}`);
    s.addText((t) => {
      t.inputEl.type = "password";
      t.setPlaceholder(saved ? "Paste a new token to replace it" : "Paste the token here");
      t.inputEl.addEventListener("change", async () => {
        const x = t.getValue().trim(); if (!x) return;
        await P.writeToken(file, x); new Notice(`${service} token saved`); this.display();
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
