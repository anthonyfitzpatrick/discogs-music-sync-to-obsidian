/* Music Library Sync v0.8 — private Wolf 359 Press plugin.
   Pure JavaScript: talks to Discogs + Genius with Obsidian's requestUrl and writes notes
   through the vault adapter. No Python required.
   Safety: never overwrites an existing album note (except price fields on "Refresh prices")
   and never touches "Music/Vinyl Record Library.md". */
const obsidian = require("obsidian");
const { Plugin, PluginSettingTab, Notice, requestUrl, setIcon, moment, Modal, Setting } = obsidian;

const MUSIC = "Music";
const DASHBOARD = "Music/Music Dashboard.md";
const ALL_MEDIA_BASE = "Music/All Media.base";
const VERSION = "0.8.0";
const UA = "Wolf359MusicLibrarySync/0.8";

// A "base" (library) is one Discogs collection folder synced into its own vault folder, with its
// own tag, its own .base view and its own place on the dashboard. These are the original three.
const DEFAULT_LIBRARIES = [
  { id: "vinyl", name: "Vinyl", discogsFolder: "Vinyl",    dir: "Music/Vinyl", tag: "vinyl-library", icon: "disc-3",        base: "Music/Vinyl.base" },
  { id: "cds",   name: "CDs",   discogsFolder: "CD",       dir: "Music/CDs",   tag: "cd-library",    icon: "disc",          base: "Music/CDs.base" },
  { id: "tapes", name: "Tapes", discogsFolder: "Cassette", dir: "Music/Tapes", tag: "tape-library",  icon: "cassette-tape", base: "Music/Tapes.base" },
];
const DEFAULTS = { last: null, username: "discogs-user", lyrics: true, gallery: true, pdf: { size: "A4", orientation: "portrait" } };
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
const tidy = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
const slug = (s) => tidy(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const splitArtists = (a) => [a, ...String(a).split(/\s+(?:featuring|feat\.?|ft\.?|with|and|&)\s+|\s*[·,\/]\s*/i)].map((x) => x.trim()).filter((x, i, arr) => x && x.toLowerCase() !== "various" && arr.indexOf(x) === i);

function parseFrontmatter(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const out = {}; let key = null;
  for (const line of text.slice(3, end).split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) { key = m[1]; out[key] = m[2].trim() === "" ? null : val(m[2].trim()); }
    else if (key && /^\s+-\s+/.test(line)) { if (!Array.isArray(out[key])) out[key] = []; out[key].push(val(line.replace(/^\s+-\s+/, "").trim())); }
  }
  return out;
  function val(v) { if (v === "true" || v === "false") return v === "true"; try { return JSON.parse(v); } catch { return v.replace(/^'|'$/g, ""); } }
}

/* ------------------------------------------------------------------ engine */
class Engine {
  // cfg: { username, lyrics, gallery, libraries } — a snapshot of the settings for this run
  constructor(adapter, log, isCancelled, cfg) {
    this.fs = adapter; this.log = log; this.isCancelled = isCancelled || (() => false);
    this.cfg = Object.assign({ username: DEFAULTS.username, lyrics: true, gallery: true, libraries: DEFAULT_LIBRARIES }, cfg);
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

  /* ---- create notes for new collection items in one library's Discogs folder ---- */
  async sync(T, onProgress) {
    const folderName = T.discogsFolder, USER = this.cfg.username;
    this.log(`${T.name}: contacting Discogs…`);
    const folders = (await this.discogs(`users/${USER}/collection/folders`)).folders;
    const f = folders.find((x) => x.name === folderName);
    if (!f) { this.log(`No Discogs folder called "${folderName}" — skipped`); return 0; }
    const fieldMap = Object.fromEntries(((await this.discogs(`users/${USER}/collection/fields`)).fields || []).map((x) => [x.id, x.name]));
    let items = [], page = 1;
    while (true) {
      const d = await this.discogs(`users/${USER}/collection/folders/${f.id}/releases?per_page=100&page=${page}`);
      items = items.concat(d.releases);
      if (page >= d.pagination.pages) break; page++;
    }
    await this.ensureDir(T.dir); await this.ensureDir(`${T.dir}/covers`);
    const have = new Set();
    for (const p of await this.listNotes(T.dir)) {
      const m = (await this.fs.read(p)).match(/^discogs_instance:\s*(\d+)/m); if (m) have.add(m[1]);
    }
    // records removed from this Discogs folder: move their notes out (never deleted)
    if (!this.allInstances) {
      let all = [], pg = 1;
      while (true) {
        const d = await this.discogs(`users/${USER}/collection/folders/0/releases?per_page=100&page=${pg}`);
        all = all.concat(d.releases); if (pg >= d.pagination.pages) break; pg++;
      }
      this.allInstances = new Map(all.map((i) => [String(i.instance_id), i.folder_id]));
    }
    const inFolder = new Set(items.map((i) => String(i.instance_id)));
    for (const p of await this.listNotes(T.dir)) {
      const text = await this.fs.read(p);
      const inst = text.match(/^discogs_instance:\s*(\d+)/m)?.[1];
      if (!inst || inFolder.has(inst)) continue;
      const movedTo = this.cfg.libraries.find((l) => folders.find((x) => x.name === l.discogsFolder)?.id === this.allInstances.get(inst));
      if (movedTo && movedTo.id !== T.id) { this.log(`  ${p.split("/").pop()} is now in your Discogs ${movedTo.name} folder — left as is`); continue; }
      const destDir = `${MUSIC}/Removed from collection`; await this.ensureDir(destDir);
      let dest = `${destDir}/${p.split("/").pop()}`, n = 2;
      while (await this.fs.exists(dest)) dest = `${destDir}/${p.split("/").pop().replace(/\.md$/, "")} (${n++}).md`;
      const retag = text.replace(`tags:\n  - ${T.tag}`, "tags:\n  - removed-from-collection")
        .replace("\ncssclasses:", `\nremoved_from_collection: ${today()}\ncssclasses:`);
      await this.fs.write(p, retag); await this.fs.rename(p, dest);
      this.removed = (this.removed || 0) + 1;
      this.log(`  − ${p.split("/").pop().replace(/\.md$/, "")} is no longer in your Discogs collection → moved to "Removed from collection"`);
    }
    const todo = items.filter((i) => !have.has(String(i.instance_id)));
    this.log(`${T.name}: ${items.length} on Discogs, ${todo.length} new`);
    let made = 0;
    for (const [idx, item] of todo.entries()) {
      if (this.isCancelled()) break;
      onProgress?.(idx, todo.length);
      const rel = await this.discogs(`releases/${item.id}`);
      let masterYear = "";
      if (rel.master_id) { try { masterYear = (await this.discogs(`masters/${rel.master_id}`)).year || ""; } catch {} }
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
      const cond = Object.fromEntries((item.notes || []).map((n) => [fieldMap[n.field_id] || n.field_id, n.value]));
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
        `added_to_discogs: ${(item.date_added || "").slice(0, 10)}`,
        `discogs_id: ${rel.id}`, `discogs_instance: ${item.instance_id}`, `discogs_url: ${q(rel.uri || "")}`,
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
      made++; this.log(`  + ${artist} – ${rel.title}`);
    }
    onProgress?.(todo.length, todo.length);
    return made;
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

  /* ---- dashboard: live Dataview + Charts note built from the template ---- */
  async dashboard(outPath = DASHBOARD) {
    const tplPath = `${MUSIC}/.vinyl-sync/dashboard-template.md`;
    if (!(await this.fs.exists(tplPath))) throw new Error(`Missing ${tplPath}`);
    let v = {};
    try {
      const r = await this.discogs(`users/${this.cfg.username}/collection/value`);
      const n = (s) => Math.round(parseFloat(String(s).replace(/[^0-9.]/g, "")));
      v = { MIN: n(r.minimum), MED: n(r.median), MAX: n(r.maximum), CHECKED: today() };
    } catch (e) { this.log(`  collection value: ${e.message}`); }
    if (v.MED) await this.fs.write(`${MUSIC}/.vinyl-sync/collection-value.json`, JSON.stringify(
      { discogs_value_min: v.MIN, discogs_value_median: v.MED, discogs_value_max: v.MAX, checked: v.CHECKED }));
    const text = await this.fs.read(tplPath);
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
const LAYOUT_WIDTH = 1000;              // px the dashboard is laid out at, then scaled to the page

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

/* ------------------------------------------------------------------ bases */
// The .base file written for a new library: the same views as Vinyl.base, CDs.base and Tapes.base.
const baseYaml = (dir, tag) => `filters:
  and:
    - file.inFolder(${JSON.stringify(dir)})
    - file.hasTag(${JSON.stringify(tag)})
formulas:
  decade: if(note.original_year, (number(note.original_year) / 10).floor() * 10 + "s", "")
properties:
  note.artist:
    displayName: Artist
  note.title:
    displayName: Album
  note.original_year:
    displayName: Year
  note.market_lowest_sek:
    displayName: Lowest listing (kr)
  note.price_low_sek:
    displayName: Low G+ (kr)
  note.price_mid_sek:
    displayName: Mid VG+ (kr)
  note.price_high_sek:
    displayName: High NM (kr)
  note.price_my_copy_sek:
    displayName: My copy (kr)
  note.media_condition:
    displayName: Media
  note.sleeve_condition:
    displayName: Sleeve
  formula.decade:
    displayName: Decade
views:
  - type: cards
    name: Gallery
    order:
      - title
      - artist
      - original_year
      - format
      - genres
    sort:
      - property: artist
        direction: ASC
      - property: original_year
        direction: ASC
    image: note.cover
    imageFit: cover
    imageAspectRatio: 1
  - type: cards
    name: By genre
    groupBy:
      property: genres
      direction: ASC
    order:
      - title
      - artist
    image: note.cover
    imageFit: cover
    imageAspectRatio: 1
  - type: table
    name: Catalogue
    order:
      - artist
      - title
      - original_year
      - label
      - catno
      - country
      - genres
      - purchased
      - shop
      - media_condition
      - sleeve_condition
      - ripped
      - market_lowest_sek
    sort:
      - property: artist
        direction: ASC
  - type: table
    name: Value
    order:
      - artist
      - title
      - catno
      - media_condition
      - price_low_sek
      - price_mid_sek
      - price_high_sek
      - price_my_copy_sek
      - market_lowest_sek
      - market_for_sale
      - price_checked
    sort:
      - property: price_mid_sek
        direction: DESC
      - property: market_lowest_sek
        direction: DESC
  - type: cards
    name: Not ripped yet
    filters:
      and:
        - note.ripped != true
    order:
      - title
      - artist
    image: note.cover
    imageFit: cover
    imageAspectRatio: 1
`;

/* ------------------------------------------------------------------ plugin */
class MusicLibrarySync extends Plugin {
  async onload() {
    this.data = Object.assign(structuredClone(DEFAULTS), await this.loadData());
    if (!Array.isArray(this.data.libraries) || !this.data.libraries.length) this.data.libraries = structuredClone(DEFAULT_LIBRARIES);
    this.state = { running: false, mode: null, steps: {}, now: "", log: "", progress: 0 };
    this.panels = new Set();
    this.registerMarkdownCodeBlockProcessor("music-sync", (_src, el) => this.renderPanel(el));
    this.addRibbonIcon("disc-3", "Music library: sync from Discogs", () => this.run("sync"));
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

  // Why a proposed name (and Discogs folder) can't be used, or "" when it can. `self` is the library
  // being edited, so it doesn't clash with itself. No two bases may share a name, ignoring case and spacing.
  async checkLibrary(v, self = null) {
    const name = tidy(v.name), s = slug(name);
    if (!name) return "Give the base a name.";
    if (/[\\/:*?"<>|#^\[\]]/.test(name) || name.startsWith(".")) return "A name can't start with a dot or contain \\ / : * ? \" < > | # ^ [ ]";
    if (name.length > 60) return "Keep the name to 60 characters or fewer.";
    if (!s) return "The name needs at least one letter or number.";
    const others = this.data.libraries.filter((l) => l !== self);
    const same = others.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (same) return `There's already a base called “${same.name}”. Pick a different name.`;
    const close = others.find((l) => slug(l.name) === s || (!self && l.tag === `${s}-library`));
    if (close) return `“${name}” is too close to the existing base “${close.name}”. Pick a different name.`;
    const folder = tidy(v.discogsFolder) || name;
    const dup = others.find((l) => l.discogsFolder.toLowerCase() === folder.toLowerCase());
    if (dup) return `The base “${dup.name}” already syncs the Discogs folder “${dup.discogsFolder}”.`;
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
    const lib = { id, name, discogsFolder: tidy(v.discogsFolder) || name, dir: `${MUSIC}/${name}`, tag: `${s}-library`, icon: v.icon || "disc-3", base: `${MUSIC}/${name}.base` };
    const vault = this.app.vault;
    if (!vault.getAbstractFileByPath(lib.dir)) await vault.createFolder(lib.dir);
    await vault.create(lib.base, baseYaml(lib.dir, lib.tag));
    const all = vault.getAbstractFileByPath(ALL_MEDIA_BASE);
    if (all) await vault.process(all, (t) => {
      if (t.includes(`file.hasTag("${lib.tag}")`)) return t;
      const m = [...t.matchAll(/^(\s*)- file\.hasTag\("[^"]*"\)$/gm)].pop();
      return m ? t.slice(0, m.index + m[0].length) + `\n${m[1]}- file.hasTag("${lib.tag}")` + t.slice(m.index + m[0].length) : t;
    });
    this.data.libraries.push(lib);
    await this.save();
    return lib;
  }

  // Renames the base (and its .base file) and updates its Discogs folder and icon. Notes don't move.
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
    lib.discogsFolder = tidy(v.discogsFolder) || name;
    lib.icon = v.icon || lib.icon;
    await this.save();
  }

  // Stops syncing a base. Its folder, notes and .base file are left in the vault.
  async removeLibrary(lib) {
    if (this.data.libraries.length < 2) throw new Error("Keep at least one base.");
    this.data.libraries = this.data.libraries.filter((l) => l !== lib);
    await this.save();
  }

  /* ---- Discogs / Genius helpers for the settings page ---- */
  async readToken(file) {
    const p = `${MUSIC}/${file}`, fs = this.app.vault.adapter;
    return (await fs.exists(p)) ? (await fs.read(p)).trim() : "";
  }
  async writeToken(file, value) { await this.app.vault.adapter.write(`${MUSIC}/${file}`, value.trim() + "\n"); this.folderCache = null; }
  async discogsIdentity() {
    const t = await this.readToken(".discogs-token"); if (!t) throw new Error("No Discogs token saved yet");
    const r = await requestUrl({ url: "https://api.discogs.com/oauth/identity", headers: { Authorization: `Discogs token=${t}`, "User-Agent": UA }, throw: false });
    if (r.status >= 400) throw new Error(r.status === 401 ? "Discogs didn't accept the token" : `Discogs answered ${r.status}`);
    return r.json.username;
  }
  async geniusCheck() {
    const t = await this.readToken(".genius-token"); if (!t) throw new Error("No Genius token saved yet");
    const r = await requestUrl({ url: "https://api.genius.com/search?q=test", headers: { Authorization: `Bearer ${t}` }, throw: false });
    if (r.status >= 400) throw new Error(r.status === 401 ? "Genius didn't accept the token" : `Genius answered ${r.status}`);
  }
  async discogsFolders() {
    if (this.folderCache) return this.folderCache;
    const t = await this.readToken(".discogs-token"); if (!t || !this.data.username) return [];
    const r = await requestUrl({ url: `https://api.discogs.com/users/${encodeURIComponent(this.data.username)}/collection/folders`,
      headers: { Authorization: `Discogs token=${t}`, "User-Agent": UA }, throw: false });
    if (r.status >= 400) return [];
    return (this.folderCache = (r.json.folders || []).map((f) => f.name).filter((n) => n !== "All"));
  }

  async findDashboardRoot() {
    const find = () => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        if (leaf.view?.file?.path !== DASHBOARD) continue;
        const r = leaf.view.containerEl.querySelector(".md-root");
        if (r && r.querySelector("canvas")) return r;
      }
      return null;
    };
    let root = find();
    if (!root) {
      await this.app.workspace.openLinkText(DASHBOARD, "", false);
      for (let i = 0; i < 60 && !(root = find()); i++) await sleep(500);   // wait for Dataview + charts
      await sleep(1200);                                                     // let chart animations finish
    }
    if (!root) throw new Error("Couldn't find the rendered dashboard — open Music Dashboard and try again");
    return root;
  }

  async exportPdf({ size = "A4", orientation = "portrait" } = {}) {
    const electron = require("electron");
    const remote = electron.remote || (() => { try { return require("@electron/remote"); } catch { return null; } })();
    if (!remote?.BrowserWindow) throw new Error("PDF export needs the Obsidian desktop app");
    const fs = require("fs"), os = require("os"), path = require("path");
    const notice = new Notice("Preparing PDF…", 0);
    try {
      const root = await this.findDashboardRoot();
      // 1. clone the dashboard and turn every chart canvas into a crisp image
      const clone = root.cloneNode(true);
      const src = root.querySelectorAll("canvas"), dst = clone.querySelectorAll("canvas");
      src.forEach((c, i) => {
        const img = document.createElement("img");
        img.src = c.toDataURL("image/png");
        img.style.width = "100%"; img.style.height = "auto"; img.style.display = "block";   // keep the chart's proportions
        dst[i].replaceWith(img);
      });
      clone.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.setAttribute("disabled", ""));
      // 2. carry over Obsidian's own CSS (theme, snippets, plugins) so it looks identical
      // Obsidian's own @media print rules hide everything except its export container, so drop them
      const isPrintRule = (r) => r.media && /print/i.test(r.media.mediaText || "");
      const css = [...document.styleSheets].map((ss) => {
        try { if (ss.media && /print/i.test(ss.media.mediaText || "")) return "";
              return [...ss.cssRules].filter((r) => !isPrintRule(r)).map((r) => r.cssText).join("\n"); } catch { return ""; }
      }).join("\n");
      const [w, h] = PAPER[size] || PAPER.A4;
      const pageW = orientation === "landscape" ? h : w;
      const printable = (pageW - 2 * MARGIN) * 96;
      const layoutW = Math.round(Math.max(760, Math.min(1400, root.getBoundingClientRect().width || LAYOUT_WIDTH)));  // same width as on screen
      const scale = Math.max(0.3, Math.min(1, printable / layoutW));
      // keep a whole section on one page when it fits, so headings never end up alone at the bottom
      const pageH = orientation === "landscape" ? w : h;
      const usableLayoutPx = ((pageH - 2 * MARGIN - 0.1) * 96) / scale - 10;
      const origSections = root.querySelectorAll(".md-section"), cloneSections = clone.querySelectorAll(".md-section");
      origSections.forEach((sec, i) => { if (sec.getBoundingClientRect().height <= usableLayoutPx) cloneSections[i]?.classList.add("mls-keep"); });
      const stamp = moment().format("D MMMM YYYY, HH:mm");
      const html = `<!doctype html><html class="${document.documentElement.className}" style="${document.documentElement.getAttribute("style") || ""}">
<head><meta charset="utf-8"><title>Music Dashboard</title><style>${css}</style><style>
  html, body { height: auto !important; min-height: 0 !important; overflow: visible !important; position: static !important; contain: none !important; }
  .mls-export table.md-table { width: 100% !important; table-layout: auto; }
  .mls-export table.md-table td:nth-child(2), .mls-export table.md-table td:nth-child(3) { white-space: normal !important; }
  .mls-export .md-card { overflow: visible !important; }
  @media print { html, body, body > *, .mls-export, .mls-export * { visibility: visible !important; } body > .mls-export { display: block !important; } }
  body { margin: 0 !important; background: var(--background-primary) !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .mls-export { width: ${layoutW}px; margin: 0; padding: 0; background: var(--background-primary); color: var(--text-normal); font-family: var(--font-text); }
  .mls-export-head { display: flex; align-items: baseline; justify-content: space-between; margin: 0 0 18px; padding-bottom: 10px; border-bottom: 3px solid; border-image: linear-gradient(90deg, var(--text-normal), var(--text-muted), var(--background-modifier-border)) 1; }
  .mls-export-head h1 { margin: 0; font-size: 30px; font-weight: 800; color: var(--text-normal); }
  .mls-export-head span { color: var(--text-muted); font-size: 13px; }
  .md-root { gap: 18px !important; }
  .md-section { break-inside: auto; }
  .md-section.mls-keep { break-inside: avoid; page-break-inside: avoid; }
  .md-card, .md-grid, table.md-table tr, .md-chart, img { break-inside: avoid; page-break-inside: avoid; }
  .md-section h2, .md-card-title { break-after: avoid; page-break-after: avoid; }
  table.md-table thead, table.md-table tr:first-child { break-after: avoid; }
  a { color: inherit !important; text-decoration: none !important; }
  input[type=checkbox] { accent-color: var(--text-normal); }
</style></head>
<body class="${document.body.className}" style="${document.body.getAttribute("style") || ""}">
<div class="mls-export markdown-rendered markdown-preview-view">
  <div class="mls-export-head"><h1>Music Dashboard</h1><span>Exported ${stamp}</span></div>
  ${clone.outerHTML}
</div></body></html>`;
      const tmp = path.join(os.tmpdir(), `music-dashboard-export-${Date.now()}.html`);
      fs.writeFileSync(tmp, html, "utf8");
      try { await this.app.vault.adapter.write(`${MUSIC}/.vinyl-sync/last-export.html`, html); } catch {}   // for troubleshooting
      // 3. render off-screen and print
      const win = new remote.BrowserWindow({ show: false, width: layoutW + 40, height: 1400, webPreferences: { offscreen: false } });
      try {
        await win.loadFile(tmp);
        await sleep(800);                                  // fonts & images
        // the footer is rendered in isolation, without the page's CSS, so the theme colour is resolved here
        const footColor = getComputedStyle(document.body).getPropertyValue("--text-muted").trim() || "#888";
        const footer = `<div style="font-size:8px;width:100%;padding:0 ${MARGIN}in;color:${footColor};display:flex;justify-content:space-between;font-family:sans-serif">
          <span>Music Dashboard · ${stamp}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
        const pdf = await win.webContents.printToPDF({
          pageSize: size, landscape: orientation === "landscape", printBackground: true, scale,
          margins: { top: MARGIN, bottom: MARGIN + 0.1, left: MARGIN, right: MARGIN },
          displayHeaderFooter: true, headerTemplate: "<div></div>", footerTemplate: footer,
        });
        const dir = `${MUSIC}/Exports`;
        if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
        const out = `${dir}/Music Dashboard ${moment().format("YYYY-MM-DD HHmm")} ${size} ${orientation}.pdf`;
        await this.app.vault.adapter.writeBinary(out, pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
        notice.hide();
        new Notice(`PDF saved: ${out}`, 8000);
        try { this.app.openWithDefaultApp(out); } catch {}
      } finally { win.destroy(); try { fs.unlinkSync(tmp); } catch {} }
    } finally { notice.hide(); }
  }

  renderPanel(el) {
    const p = { root: el.createDiv({ cls: "mls-panel" }) };
    const top = p.root.createDiv({ cls: "mls-top" });
    const badge = top.createDiv({ cls: "mls-badge" }); setIcon(badge, "disc-3");
    const txt = top.createDiv({ cls: "mls-text" });
    const tt = txt.createDiv({ cls: "mls-title", text: "Music Library " }); tt.createSpan({ cls: "mls-ver", text: `v${VERSION}` });
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
    const libs = structuredClone(this.data.libraries);
    Object.assign(s, { running: true, mode, steps: {}, now: "Starting…", log: "", progress: 0, stepList: this.steps() });
    window.musicLibrarySyncRunning = true;
    this.cancelled = false;
    const started = Date.now();
    const lines = [];
    const log = (l) => { lines.push(l); s.log = lines.slice(-400).join("\n"); s.now = l.trim(); this.refresh(); };
    const d = this.data;
    const eng = new Engine(this.app.vault.adapter, log, () => this.cancelled, { username: d.username, lyrics: d.lyrics, gallery: d.gallery, libraries: libs });
    const steps = mode === "dashboard" ? [] : libs;
    const work = steps.length + 1;
    let failed = false, created = 0, priced = 0;
    this.refresh();
    try {
      await eng.init();
      for (let i = 0; i < steps.length && !this.cancelled; i++) {
        const st = steps[i];
        s.steps[st.id] = "active"; s.progress = i / work; this.refresh();
        const prog = (done, total) => { s.progress = (i + (total ? done / total : 1)) / work; this.refresh(); };
        try {
          if (mode === "sync") created += await eng.sync(st, prog);
          else priced += await eng.refreshPrices(st, prog);
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
        mode === "sync" ? ([created ? `${created} new record${created === 1 ? "" : "s"} added` : "", eng.removed ? `${eng.removed} removed` : ""].filter(Boolean).join(", ") || "already up to date") :
        mode === "prices" ? `prices updated on ${priced} records` : "dashboard rebuilt";
      this.data.last = { at: Date.now(), mode, ok: !failed && !this.cancelled, summary };
      await this.saveData(this.data);
      Object.assign(s, { running: false, progress: 1, now: "", justDone: true });
      window.musicLibrarySyncRunning = false;
      this.refresh();
      window.setTimeout(() => { s.justDone = false; this.refresh(); }, 5000);
      new Notice(`Music Library: ${summary}`, 7000);
    }
  }
}

/* ------------------------------------------------------------------ settings */
class LibraryModal extends Modal {
  // lib = null adds a new base; otherwise edits that one
  constructor(app, plugin, lib, done) { super(app); this.plugin = plugin; this.lib = lib; this.done = done; }
  onOpen() {
    const { plugin, lib } = this, c = this.contentEl;
    const v = { name: lib?.name || "", discogsFolder: lib?.discogsFolder || "", icon: lib?.icon || "disc-3" };
    this.titleEl.setText(lib ? `Edit “${lib.name}”` : "Add a base");
    if (!lib) c.createEl("p", { cls: "setting-item-description",
      text: "A base is one folder in your Discogs collection, synced into its own folder in Music with its own .base view, its own tag and its own place on the dashboard." });
    new Setting(c).setName("Name")
      .setDesc(lib ? `Also renames ${lib.base.split("/").pop()}. The notes stay in ${lib.dir}.` : "Used for the folder and the .base file. No two bases can have the same name.")
      .addText((t) => { t.setPlaceholder("e.g. Minidiscs").setValue(v.name).onChange((x) => { v.name = x; touched = true; check(); }); window.setTimeout(() => t.inputEl.focus(), 0); });
    const folder = new Setting(c).setName("Discogs folder").setDesc("The folder in your Discogs collection to sync. Leave empty to use the name.")
      .addText((t) => t.setPlaceholder("Same as the name").setValue(v.discogsFolder).onChange((x) => { v.discogsFolder = x; check(); }));
    plugin.discogsFolders().then((list) => { if (list.length) folder.setDesc(`The folder in your Discogs collection to sync. Leave empty to use the name. Yours: ${list.join(", ")}.`); }).catch(() => {});
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
          if (lib) { await plugin.updateLibrary(lib, v); new Notice(`Saved “${lib.name}”`); }
          else { const n = await plugin.addLibrary(v); new Notice(`Added the base “${n.name}” — the next sync fills it from Discogs`, 8000); }
          this.close(); this.done?.();
        } catch (e) { err.setText(e.message); b.setDisabled(false); }
      }); });
    const check = async () => {
      const n = ++seq, e = await plugin.checkLibrary(v, lib);
      if (n !== seq) return;                                    // a newer keystroke is already being checked
      err.setText(touched ? e : ""); save.setDisabled(!!e);
      if (preview) { const name = tidy(v.name); preview.setText(name && !e ? `Creates ${MUSIC}/${name}/, ${MUSIC}/${name}.base and the tag #${slug(name)}-library.` : ""); }
    };
    check();
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

    new Setting(el).setName("Discogs").setHeading();
    new Setting(el).setName("Username").setDesc("The Discogs account whose collection is synced.")
      .addText((t) => t.setPlaceholder("your-discogs-name").setValue(d.username || "").onChange(async (x) => { d.username = x.trim(); P.folderCache = null; await P.save(); }));
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
      text: "Each base syncs one Discogs folder into its own folder in Music, with its own .base view and a place on the dashboard. Names must be unique." });
    for (const lib of d.libraries) {
      const row = new Setting(el).setName(lib.name)
        .setDesc(`Discogs folder “${lib.discogsFolder}” → ${lib.dir} · #${lib.tag}`)
        .addExtraButton((b) => b.setIcon("pencil").setTooltip("Rename or edit").onClick(() => new LibraryModal(this.app, P, lib, redraw).open()))
        .addExtraButton((b) => b.setIcon("trash-2").setTooltip(d.libraries.length < 2 ? "Keep at least one base" : "Stop syncing this base")
          .setDisabled(d.libraries.length < 2)
          .onClick(() => new ConfirmModal(this.app, `Stop syncing “${lib.name}”?`,
            `It disappears from the sync and the dashboard. ${lib.dir}, its notes and ${lib.base.split("/").pop()} stay in your vault — delete them yourself if you no longer want them.`,
            "Stop syncing", async () => { await P.removeLibrary(lib); redraw(); }).open()));
      setIcon(row.nameEl.createSpan({ cls: "mls-lib-icon", prepend: true }), lib.icon);
    }
    new Setting(el).addButton((b) => b.setButtonText("Add base").setCta().onClick(() => new LibraryModal(this.app, P, null, redraw).open()));

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
    setIcon(identity.createDiv({ cls: "mls-about-logo", attr: { "aria-label": "Music Library Sync logo", role: "img" } }), "disc-3");
    const text = identity.createDiv("mls-about-identity-text");
    text.createDiv({ cls: "mls-about-title", text: "Music Library Sync" });
    text.createDiv({ cls: "mls-about-version", text: `Version ${this.plugin.manifest.version}` });
    text.createDiv({ cls: "mls-about-credit", text: "Created by Anthony Fitzpatrick" });
    text.createDiv({ cls: "mls-about-credit", text: "Wolf 359 Press AB" });
    const links = footer.createDiv("mls-about-links");
    const primary = links.createDiv("mls-about-links-row"), secondary = links.createDiv("mls-about-links-row");
    // no url yet: shown, but disabled until there's somewhere for reports to go
    for (const link of [
      { icon: "bug", label: "Report a bug", primary: true },
      { icon: "lightbulb", label: "Request a feature", primary: true },
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
      if (link.url) b.addEventListener("click", () => window.open(link.url, "_blank", "noopener"));
      else { b.disabled = true; b.setAttr("aria-label", "Coming soon"); }
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
module.exports.parseFrontmatter = parseFrontmatter;
