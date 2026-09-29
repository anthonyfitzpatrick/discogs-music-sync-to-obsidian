// The sync engine: talks to Discogs and Genius with Obsidian's requestUrl, and writes record notes
// through the vault. Safety: it never overwrites an existing album note, except the fields that come
// from Discogs on Refresh prices and Update this record. It assumes nothing about the vault: every folder
// comes from the settings.
import { requestUrl } from "obsidian";
import type { App, RequestUrlResponse } from "obsidian";
import { baseFor } from "./bases.ts";
import type { Base } from "./bases.ts";
import { DEFAULT_CURRENCY, currencyCode, formatMoney } from "./currency.ts";
import {
  decodeCollectionPage, decodeProfileCurrency, decodeRelease, decodeMaster, decodeMarketStats, decodePriceSuggestions,
  decodeCollectionFields, decodeCollectionValueText, decodeGeniusHits,
} from "./discogs.ts";
import type { CollectionItem, DiscogsArtist, DiscogsRelease, DiscogsTrack } from "./discogs.ts";
import type { JsonValue } from "./json.ts";
import { DEFAULT_FOLDER } from "./settings-data.ts";
import type { Rate, StoredValue } from "./settings-data.ts";

import { VERSION } from "./version.ts";

const UA = `Wolf359DiscogsMusicSync/${VERSION}`;

// A record note's price properties. price_currency says which currency the amounts are in.
const PRICE_KEYS = ["price_low", "price_mid", "price_high", "price_max", "price_my_copy", "market_lowest", "market_for_sale", "price_currency", "price_checked"] as const;
type PriceKey = (typeof PRICE_KEYS)[number];
type Prices = Record<PriceKey, string | number>;
// Their names before 0.16, when every price was in kronor. Refresh prices replaces them with the above.
const OLD_PRICE_KEYS = ["price_low_sek", "price_mid_sek", "price_high_sek", "price_max_sek", "price_my_copy_sek", "market_lowest_sek"];
const GRADE = { low: "Good Plus (G+)", mid: "Very Good Plus (VG+)", high: "Near Mint (NM or M-)" };

/* ------------------------------------------------------------------ helpers */
const pause = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));
const today = (): string => new Date().toISOString().slice(0, 10);
// The text of any error, for the log and notices.
const isMessage = (cause: unknown): cause is string => typeof cause === "string";
const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : isMessage(cause) ? cause : "unknown error");
const q = (v: string | null | undefined): string => JSON.stringify(v ?? "");
const cleanName = (n: string | null | undefined): string => (n || "").replace(/\s\(\d+\)$/, "").trim();
function artistsStr(arts: DiscogsArtist[]): string {
  let s = "";
  for (const a of arts) {
    s += cleanName(a.anv || a.name);
    const j = a.join.trim();
    s += j && j !== "," ? ` ${j} ` : j === "," ? ", " : "";
  }
  return s.replace(/\s+/g, " ").replace(/^[\s,]+|[\s,]+$/g, "");
}
const safe = (s: string): string => s.replace(/[\\/:*?"<>|#^[\]]/g, "").trim().replace(/\.+$/, "");
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const n2 = (s: string): string => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[\u0080-￿]/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const core = (title: string): string => {
  let t = title.split(" – ").pop() ?? "";
  t = t.replace(/\s*[([].*?[)\]]/g, "").replace(/\s+-\s+(live|remaster|mono|stereo|single|edit|version).*$/i, "");
  return n2(t);
};
const artistOk = (want: string, got: string): boolean => {
  const w = n2(want).replace(/^the/, ""), g = n2(got).replace(/^the/, "");
  if (!w || w === "various") return false;
  return w === g || (g.length >= 4 && (w.includes(g) || g.includes(w)));
};
const titleOk = (got: string, want: string): boolean => got === want || (Math.min(got.length, want.length) >= 6 && (got.startsWith(want) || want.startsWith(got)));
const splitArtists = (a: string): string[] => [a, ...a.split(/\s+(?:featuring|feat\.?|ft\.?|with|and|&)\s+|\s*[·,/]\s*/i)].map((x) => x.trim()).filter((x, i, arr) => x && x.toLowerCase() !== "various" && arr.indexOf(x) === i);
const imageExt = (uri: string): string => ((uri.split("?")[0] ?? "").match(/\.(jpe?g|png|gif|webp)$/i)?.[0] || ".jpg").toLowerCase();

// A note's frontmatter blocks: key → its lines (the "key: value" line, and any "  - item" lines under it).
type Blocks = Record<string, string[]>;

// Sets properties in a note's frontmatter text (from the opening --- up to, not including, the closing
// one). A key already there is replaced where it stands, list lines included; a new one goes in before
// discogs_id. Every other property, and the order, is kept.
function setProperties(fm: string, blocks: Blocks): string {
  const lines = fm.split("\n"), out: string[] = [], done = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const key = line.match(/^([A-Za-z_][\w-]*):/)?.[1];
    const block = key !== undefined && Object.hasOwn(blocks, key) ? blocks[key] : undefined;
    if (key !== undefined && block) {
      out.push(...block); done.add(key);
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? "")) i++;       // its list lines
      continue;
    }
    out.push(line);
  }
  const missing = Object.keys(blocks).filter((k) => !done.has(k)).flatMap((k) => blocks[k] ?? []);
  const at = out.findIndex((l) => l.startsWith("discogs_id:"));
  out.splice(at < 0 ? out.length : at, 0, ...missing);
  return out.join("\n");
}

/* ------------------------------------------------------------------ files */
// What the engine needs to read and write notes and images.
interface FileAccess {
  exists(p: string): Promise<boolean>;
  read(p: string): Promise<string>;
  process(p: string, fn: (text: string) => string): Promise<string>;
  list(p: string): Promise<{ files: string[] }>;
  mkdir(p: string): Promise<void>;
  write(p: string, text: string): Promise<void>;
  writeBinary(p: string, data: ArrayBuffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

// The engine's file access, through Obsidian's Vault API rather than straight to disk, so Obsidian's
// index — and with it the dashboard — sees every new, changed and moved note at once, and a moved
// note's links follow it. Dot-folders such as Music/.vinyl-sync aren't indexed by Obsidian, so files
// there are written directly.
function vaultFiles(app: App): FileAccess {
  const vault = app.vault, adapter = vault.adapter;
  const hidden = (p: string) => p.split("/").some((part) => part.startsWith("."));
  const note = (p: string) => (hidden(p) ? null : vault.getFileByPath(p));
  return {
    exists: (p) => adapter.exists(p),
    read: (p) => { const f = note(p); return f ? vault.read(f) : adapter.read(p); },
    // Changes a file's text in one step, so an edit made in between (by the user, or another device's
    // sync) is never overwritten with an older copy.
    process: (p, fn) => { const f = note(p); return f ? vault.process(f, fn) : adapter.process(p, fn); },
    list: (p) => adapter.list(p),
    async mkdir(p) { if (hidden(p)) await adapter.mkdir(p); else if (!vault.getAbstractFileByPath(p)) await vault.createFolder(p); },
    async write(p, text) {
      if (hidden(p)) return adapter.write(p, text);
      const f = vault.getFileByPath(p);
      if (f) await vault.modify(f, text); else await vault.create(p, text);
    },
    async writeBinary(p, data) {
      if (hidden(p)) return adapter.writeBinary(p, data);
      const f = vault.getFileByPath(p);
      if (f) await vault.modifyBinary(f, data); else await vault.createBinary(p, data);
    },
    async rename(from, to) {
      const f = vault.getAbstractFileByPath(from);
      if (f) await app.fileManager.renameFile(f, to); else await adapter.rename(from, to);
    },
  };
}

/* ------------------------------------------------------------------ engine */
// What a sync makes of bases missing for some formats: the ones added, and why others weren't.
interface BasesAdded { added: Base[]; skipped: string[] }

// A snapshot of the settings for one run, and the tokens, handed over by the plugin.
interface EngineConfig {
  username: string;
  folder: string;
  lyrics: boolean;
  gallery: boolean;
  libraries: Base[];
  discogsToken: string;
  geniusToken: string;
  currency: string;
  rates: Record<string, Rate>;
  onCurrency?: (currency: string) => void;
  createBases?: (items: CollectionItem[]) => Promise<BasesAdded>;
}

// An HTTP error from Discogs or Genius, with the status and what they answered.
class HttpError extends Error {
  status: number; body: string;
  constructor(status: number, url: string, body: string) { super(`${status} ${url}`); this.status = status; this.body = body; }
}

// A reply's body as JSON.
// SAFETY: requestUrl reads the body with JSON.parse, which only ever produces JSON values.
const replyJson = (r: RequestUrlResponse): JsonValue => r.json as JsonValue;

type HttpKind = "discogs" | "img" | "genius";
// A note that already exists, and the base it is in.
interface NoteAt { path: string; lib: Base }

class Engine {
  fs: FileAccess;
  log: (line: string) => void;
  isCancelled: () => boolean;
  cfg: EngineConfig;
  last: Record<HttpKind, number> = { discogs: 0, img: 0, genius: 0 };
  noSuggest = false;
  dToken = "";
  gToken: string | null = null;
  cur: { target: string; account: string } | null = null;
  fresh: Record<string, number> = {};
  items: CollectionItem[] | null = null;
  fieldNames: Map<number, string> | null = null;
  unplaced = 0;
  moved = 0;
  removed = 0;

  constructor(files: FileAccess, log: (line: string) => void, isCancelled: (() => boolean) | null, cfg: Partial<EngineConfig>) {
    this.fs = files; this.log = log; this.isCancelled = isCancelled || (() => false);
    this.cfg = { username: "", folder: DEFAULT_FOLDER, lyrics: true, gallery: true, libraries: [], discogsToken: "", geniusToken: "", currency: "", rates: {}, ...cfg };
  }

  async http(kind: HttpKind, url: string, headers: Record<string, string>): Promise<RequestUrlResponse> {
    const gap = kind === "discogs" ? 1100 : kind === "img" ? 300 : 350;
    const host = kind === "genius" ? "Genius" : "Discogs";
    for (let attempt = 0; attempt < 6; attempt++) {
      if (this.isCancelled()) throw new Error("Cancelled");
      const wait = gap - (Date.now() - (this.last[kind] || 0));
      if (wait > 0) await pause(wait);
      this.last[kind] = Date.now();
      let r: RequestUrlResponse;
      try {
        r = await Promise.race([requestUrl({ url, headers, throw: false }),
          pause(30000).then((): never => { throw new Error("timeout"); })]);
      } catch (e) { this.log(`  ${host} didn't answer (${errorText(e)}) — retrying ${attempt + 1}/5…`); await pause(3000 * (attempt + 1)); continue; }
      if (r.status === 429 || r.status >= 500) {
        const w = kind === "discogs" ? 15000 : 3000 * (attempt + 1);
        this.log(`  ${host} is busy (${r.status}) — waiting ${Math.round(w / 1000)} s…`); await pause(w); continue; }
      if (r.status >= 400) throw new HttpError(r.status, url, r.text);
      return r;
    }
    throw new Error(`Gave up on ${url}`);
  }
  // A Discogs API reply (a path under api.discogs.com, or a full URL), or with binary an image.
  discogs(path: string): Promise<JsonValue>;
  discogs(path: string, binary: true): Promise<ArrayBuffer>;
  async discogs(path: string, binary = false): Promise<JsonValue | ArrayBuffer> {
    const url = path.startsWith("http") ? path : `https://api.discogs.com/${path}`;
    const r = await this.http(binary ? "img" : "discogs", url, { Authorization: `Discogs token=${this.dToken}`, "User-Agent": UA });
    return binary ? r.arrayBuffer : replyJson(r);
  }
  async genius(qs: string): Promise<JsonValue> {
    return replyJson(await this.http("genius", `https://api.genius.com/search?q=${encodeURIComponent(qs)}`, { Authorization: `Bearer ${this.gToken ?? ""}` }));
  }

  init(): Promise<void> {
    if (!this.cfg.discogsToken) return Promise.reject(new Error("No Discogs token saved yet"));
    this.dToken = this.cfg.discogsToken;
    this.gToken = this.cfg.geniusToken || null;
    return Promise.resolve();
  }
  async ensureDir(p: string): Promise<void> { if (!(await this.fs.exists(p))) await this.fs.mkdir(p); }
  async listNotes(dir: string): Promise<string[]> {
    if (!(await this.fs.exists(dir))) return [];
    return (await this.fs.list(dir)).files.filter((f) => f.endsWith(".md"));
  }

  /* ---- Genius direct link for one track ---- */
  async lyricsUrl(artist: string, title: string, albumTitle: string): Promise<string> {
    if (!this.gToken || !this.cfg.lyrics) return "";
    const short = title.split(" – ").pop() ?? title, want = core(title);
    const arts = splitArtists(artist);
    const queries = [...arts.map((a) => `${a} ${short}`), short];
    for (const qs of queries) {
      let hits;
      try { hits = decodeGeniusHits(await this.genius(qs)); } catch (e) { this.log(`  genius: ${errorText(e)}`); return ""; }
      for (const h of hits) {
        if (h.type !== "song" || !titleOk(core(h.title), want)) continue;
        const names = [h.primaryArtist, ...h.featuredArtists];
        if (arts.some((a) => names.some((nm) => artistOk(a, nm)))) return h.url;
        const pa = h.primaryArtist;
        if (/cast|soundtrack|original|broadway|london|company/i.test(pa) && n2(albumTitle).slice(0, 8) && n2(pa).includes(n2(albumTitle).slice(0, 8))) return h.url;
      }
    }
    return "";
  }

  /* ---- fill missing durations from master + main release ---- */
  async durationFill(rel: DiscogsRelease): Promise<Map<string, string>> {
    const all = rel.tracklist.flatMap((t) => [t, ...t.sub_tracks]);
    const found = new Map<string, string>();
    if (all.every((t) => t.type_ !== "track" || t.duration)) return found;
    const absorb = (tracks: DiscogsTrack[]) => tracks.flatMap((t) => [t, ...t.sub_tracks])
      .forEach((x) => { if (x.duration && !found.has(norm(x.title))) found.set(norm(x.title), x.duration); });
    if (rel.master_id) {
      try {
        const m = decodeMaster(await this.discogs(`masters/${rel.master_id}`)); absorb(m.tracklist);
        if (m.main_release && String(m.main_release) !== String(rel.id)) absorb(decodeRelease(await this.discogs(`releases/${m.main_release}`)).tracklist);
      } catch (e) { this.log(`  lengths: ${errorText(e)}`); }
    }
    return found;
  }

  async tracklist(rel: DiscogsRelease): Promise<string> {
    const fill = await this.durationFill(rel);
    const albumArtist = artistsStr(rel.artists);
    const rows = ["| # | Title | Length | Lyrics |", "|---|---|---|---|"];
    const row = async (pos: string, title: string, dur: string, arts: DiscogsArtist[]) => {
      const art = arts.length ? artistsStr(arts) : albumArtist;
      const url = this.isCancelled() ? "" : await this.lyricsUrl(art, title, rel.title);
      return `| ${pos || ""} | ${title.replace(/\|/g, "/")} | ${dur || fill.get(norm(title)) || ""} | ${url ? `[Lyrics](${url})` : ""} |`;
    };
    for (const t of rel.tracklist) {
      if (t.type_ === "heading") rows.push(`| | **${t.title}** | | |`);
      else if (t.type_ === "index") {
        rows.push(`| ${t.position || ""} | **${t.title}** | ${t.duration || ""} | |`);
        for (const x of t.sub_tracks) rows.push(await row(x.position, `${t.title} – ${x.title}`, x.duration, x.artists.length ? x.artists : t.artists));
      } else rows.push(await row(t.position, t.title, t.duration, t.artists));
    }
    return rows.join("\n");
  }

  /* ---- currencies ---- */
  // The currency prices are kept in (the one chosen in settings, else the Discogs account's), and the
  // account's own: Discogs gives price suggestions and the collection's value only in the account's.
  async currencies(): Promise<{ target: string; account: string }> {
    if (this.cur) return this.cur;
    let account = "";
    try { account = decodeProfileCurrency(await this.discogs(`users/${encodeURIComponent(this.cfg.username)}`)); }
    catch (e) { this.log(`  (couldn't read your Discogs account's currency: ${errorText(e)})`); }
    const target = currencyCode(this.cfg.currency) || account || DEFAULT_CURRENCY;
    this.cur = { target, account: account || target };
    if (!currencyCode(this.cfg.currency)) { this.cfg.currency = target; this.cfg.onCurrency?.(target); }
    if (target !== this.cur.account) this.log(`Prices in ${target}, converted from your Discogs account's ${this.cur.account} at Discogs' rates`);
    return this.cur;
  }
  // How much one unit of the account's currency is worth in the target currency, as Discogs converts it:
  // the same release's cheapest listing asked for in both. Measured once a run, from the first release
  // that has a listing, and kept between runs (cfg.rates) for when none does.
  async rate(releaseId: number | string, targetLowest: number | null): Promise<number | null> {
    const { target, account } = await this.currencies();
    if (target === account) return 1;
    const key = `${account}>${target}`;
    const known = this.fresh[key];
    if (known) return known;
    if (releaseId && targetLowest) {
      try {
        const there = decodeMarketStats(await this.discogs(`marketplace/stats/${releaseId}?curr_abbr=${account}`)).lowest;
        if (there !== null && there > 0) {
          const r = targetLowest / there;
          this.fresh = { ...this.fresh, [key]: r };
          this.cfg.rates[key] = { rate: r, date: today() };
          return r;
        }
      } catch (e) { this.log(`  exchange rate: ${errorText(e)}`); }
    }
    return this.cfg.rates[key]?.rate ?? null;
  }
  // A rate when no release is at hand (a value refresh on its own): tried on the first few releases.
  async anyRate(): Promise<number | null> {
    const { target, account } = await this.currencies();
    if (target === account) return 1;
    const key = `${account}>${target}`;
    const known = this.fresh[key];
    if (known) return known;
    const items = this.items || decodeCollectionPage(await this.discogs(`users/${this.cfg.username}/collection/folders/0/releases?per_page=10&page=1`)).items;
    for (const item of items.slice(0, 10)) {
      const lowest = await this.discogs(`marketplace/stats/${item.id}?curr_abbr=${target}`).then((j) => decodeMarketStats(j).lowest, () => null);
      if (lowest !== null && lowest > 0) { const r = await this.rate(item.id, lowest); if (this.fresh[key]) return r; }
    }
    return this.cfg.rates[key]?.rate ?? null;
  }

  async prices(releaseId: number | string, myCondition: string): Promise<Prices> {
    // SAFETY: the entries are made from PRICE_KEYS itself, so every key of Prices is there.
    const out = Object.fromEntries(PRICE_KEYS.map((k) => [k, ""])) as Prices;
    const { target } = await this.currencies();
    let lowest: number | null = null;
    try {
      const st = decodeMarketStats(await this.discogs(`marketplace/stats/${releaseId}?curr_abbr=${target}`));
      if (st.lowest !== null) { lowest = st.lowest; out.market_lowest = Math.round(lowest); }
      out.market_for_sale = st.forSale ?? "";
    } catch (e) { this.log(`  stats: ${errorText(e)}`); }
    if (!this.noSuggest) {
      try {
        const s = decodePriceSuggestions(await this.discogs(`marketplace/price_suggestions/${releaseId}`));
        const rate = await this.rate(releaseId, lowest);
        if (rate === null) this.log("  (no exchange rate yet, so no price suggestions for this record: Refresh prices adds them)");
        const v = (g: string) => { const p = s.get(g); return p !== undefined && rate !== null ? Math.round(p * rate) : ""; };
        out.price_low = v(GRADE.low); out.price_mid = v(GRADE.mid); out.price_high = v(GRADE.high); out.price_max = v("Mint (M)");
        if (myCondition) out.price_my_copy = v(myCondition);
      } catch { this.noSuggest = true; this.log("  (price suggestions need Discogs Seller Settings — skipping)"); }
    }
    out.price_currency = target;
    out.price_checked = today();
    return out;
  }

  /* ---- the whole Discogs collection, every folder, decoded page by page ---- */
  async collection(): Promise<CollectionItem[]> {
    if (this.items) return this.items;
    let items: CollectionItem[] = [], page = 1;
    for (;;) {
      const d = decodeCollectionPage(await this.discogs(`users/${this.cfg.username}/collection/folders/0/releases?per_page=100&page=${page}`));
      items = items.concat(d.items);
      if (page >= d.pages) break; page++;
    }
    return (this.items = items);
  }

  /* ---- place every record in the base for its format, and bring the notes in line ----
     onBase(lib, index, done, total) reports progress as each base's new records are added. */
  async syncAll(onBase?: (lib: Base, index: number, done: number, total: number) => void): Promise<number> {
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
    const placed = new Map<string, CollectionItem[]>(libs.map((l) => [l.id, []])), unplaced = new Map<string, number>();
    const placedIn = (l: Base) => placed.get(l.id) ?? [];
    for (const item of items) {
      const lib = baseFor(item.formats, libs);
      if (lib) placedIn(lib).push(item);
      else { const k = item.formats.join(" + ") || "no format"; unplaced.set(k, (unplaced.get(k) || 0) + 1); }
    }
    for (const l of libs) if (!placedIn(l).length) this.log(`⚠ ${l.name}: no record in your collection has the format ${l.formats.join(" or ")}`);
    for (const [k, n] of unplaced) this.log(`⚠ ${n} record${n === 1 ? "" : "s"} with the format ${k} ${n === 1 ? "has" : "have"} no base — add one in settings to sync ${n === 1 ? "it" : "them"}`);
    this.unplaced = [...unplaced.values()].reduce((a, n) => a + n, 0);

    // 2. where every existing record note is, across all bases
    const where = new Map<string, NoteAt>();
    for (const l of libs) {
      await this.ensureDir(l.dir); await this.ensureDir(`${l.dir}/covers`);
      for (const p of await this.listNotes(l.dir)) {
        const inst = (await this.fs.read(p)).match(/^discogs_instance:[ \t]*(\d+)/m)?.[1];
        if (inst) where.set(inst, { path: p, lib: l });
      }
    }
    const noteName = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/, "");

    // 3. records no longer in the collection: moved out, never deleted
    const inCollection = new Set(items.map((i) => i.instance));
    for (const [inst, note] of where) {
      if (inCollection.has(inst)) continue;
      await this.moveNote(note.path, `${this.cfg.folder}/Removed from collection`, note.lib.tag, "removed-from-collection", `removed_from_collection: ${today()}`);
      this.removed++;
      this.log(`  − ${noteName(note.path)} is no longer in your Discogs collection → moved to "Removed from collection"`);
      where.delete(inst);
    }

    // 4. notes in the wrong base (the format says otherwise): moved to the right one and retagged
    for (const l of libs) for (const item of placedIn(l)) {
      const note = where.get(item.instance);
      if (!note || note.lib.id === l.id) continue;
      await this.moveNote(note.path, l.dir, note.lib.tag, l.tag, "");
      this.moved++;
      this.log(`  → ${noteName(note.path)} is ${item.formats.join(" + ")} → moved from ${note.lib.name} to ${l.name}`);
    }

    // 5. new records
    let made = 0;
    for (const [i, l] of libs.entries()) {
      const todo = placedIn(l).filter((item) => !where.has(item.instance));
      this.log(`${l.name}: ${placedIn(l).length} in your collection, ${todo.length} new`);
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
  async moveNote(path: string, destDir: string, fromTag: string, toTag: string, addLine: string): Promise<void> {
    await this.ensureDir(destDir);
    const name = path.split("/").pop() ?? path;
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
  async masterYear(rel: DiscogsRelease): Promise<number | ""> {
    if (!rel.master_id) return "";
    try { return decodeMaster(await this.discogs(`masters/${rel.master_id}`)).year || ""; } catch (e) { this.log(`  original year: ${errorText(e)}`); return ""; }
  }
  // The front cover, saved in the base's covers folder unless it is there already: its file name, or "".
  async saveCover(T: Base, rel: DiscogsRelease): Promise<string> {
    const img = rel.images.find((x) => x.type === "primary") || rel.images[0];
    if (!img?.uri) return "";
    const cover = `${rel.id}${imageExt(img.uri)}`, dest = `${T.dir}/covers/${cover}`;
    if (await this.fs.exists(dest)) return cover;
    await this.ensureDir(`${T.dir}/covers`);
    try { await this.fs.writeBinary(dest, await this.discogs(img.uri, true)); return cover; }
    catch (e) { this.log(`  cover failed: ${errorText(e)}`); return ""; }
  }
  // The properties that come from Discogs, as frontmatter blocks (see setProperties). A new note is made
  // of these; Update record replaces only these, so what the user fills in is never touched.
  discogsProperties(rel: DiscogsRelease, masterYear: number | "", cond: Map<string, string>, added: string) {
    const artist = artistsStr(rel.artists);
    const lab = rel.labels[0] ?? { name: "", catno: "" };
    const fmtS = rel.formats.map((x) => `${x.qty || "1"}x ${x.name}` + (x.descriptions.length ? ", " + x.descriptions.join(", ") : "")).join("; ");
    return {
      artist: [`artist: ${q(artist)}`], title: [`title: ${q(rel.title)}`], year: [`year: ${rel.year || ""}`],
      original_year: [`original_year: ${masterYear || rel.year || ""}`],
      genres: ["genres:", ...rel.genres.map((g) => `  - ${q(g)}`)],
      styles: ["styles:", ...rel.styles.map((g) => `  - ${q(g)}`)],
      label: [`label: ${q(cleanName(lab.name))}`], catno: [`catno: ${q(lab.catno)}`], country: [`country: ${q(rel.country)}`],
      format: [`format: ${q(fmtS)}`], media: [`media: ${q(rel.formats[0]?.name || "")}`],
      media_condition: [`media_condition: ${q(cond.get("Media Condition") || "")}`], sleeve_condition: [`sleeve_condition: ${q(cond.get("Sleeve Condition") || "")}`],
      added_to_discogs: [`added_to_discogs: ${added}`], discogs_url: [`discogs_url: ${q(rel.uri || "")}`],
    } satisfies Blocks;
  }
  // The user's own fields for a copy (conditions, notes), by name.
  fields(item: CollectionItem, fieldMap: Map<number, string>): Map<string, string> {
    return new Map(item.notes.map((n) => [fieldMap.get(n.field_id) || String(n.field_id), n.value]));
  }
  async fieldMap(): Promise<Map<number, string>> {
    this.fieldNames ??= decodeCollectionFields(await this.discogs(`users/${this.cfg.username}/collection/fields`));
    return this.fieldNames;
  }

  /* ---- one new record note ---- */
  async createNote(T: Base, item: CollectionItem, fieldMap: Map<number, string>): Promise<void> {
    const rel = decodeRelease(await this.discogs(`releases/${item.id}`));
    const masterYear = await this.masterYear(rel);
    const cover = await this.saveCover(T, rel);
    // every other image Discogs has (back, labels, inner sleeves…)
    const gallery: string[] = [];
    if (this.cfg.gallery) await this.ensureDir(`${T.dir}/images`);
    for (const [n, im] of this.cfg.gallery ? rel.images.entries() : []) {
      if (!im.uri || this.isCancelled()) continue;
      const fn = `${rel.id}-${String(n + 1).padStart(2, "0")}${imageExt(im.uri)}`, dest = `${T.dir}/images/${fn}`;
      if (!(await this.fs.exists(dest))) {
        try { await this.fs.writeBinary(dest, await this.discogs(im.uri, true)); } catch (e) { this.log(`  image failed: ${errorText(e)}`); continue; }
      }
      gallery.push(fn);
    }
    const cond = this.fields(item, fieldMap);
    const pr = await this.prices(rel.id, cond.get("Media Condition") || "");
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
    const notes = cond.get("Notes") || "";
    if (notes.trim()) body.push("", notes);
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
  // kept. Returns whether anything changed, for the notice.
  async updateRecord(T: Base, path: string): Promise<boolean> {
    const text = await this.fs.read(path);
    const end = text.indexOf("\n---", 3);
    if (!text.startsWith("---") || end < 0) throw new Error("This note has no properties, so it isn't a record note");
    const id = text.slice(0, end).match(/^discogs_id:[ \t]*(\d+)/m)?.[1], instance = text.slice(0, end).match(/^discogs_instance:[ \t]*(\d+)/m)?.[1];
    if (!id) throw new Error("This note has no discogs_id, so it can't be matched to Discogs");
    const rel = decodeRelease(await this.discogs(`releases/${id}`));
    const masterYear = await this.masterYear(rel);
    // this copy in the collection, for its conditions and date added
    const copies = decodeCollectionPage(await this.discogs(`users/${this.cfg.username}/collection/releases/${id}`)).items;
    const item = copies.find((c) => c.instance === instance) || copies[0];
    if (!item) throw new Error("This record is no longer in your Discogs collection");
    const cond = this.fields(item, await this.fieldMap());
    const pr = await this.prices(rel.id, cond.get("Media Condition") || "");
    const hadCover = /^cover:[ \t]*\S/m.test(text.slice(0, end));
    const cover = hadCover ? "" : await this.saveCover(T, rel);
    const table = await this.tracklist(rel);
    const priceBlocks = new Map(PRICE_KEYS.map((k) => [k, [`${k}: ${pr[k]}`]]));
    const blocks = { ...this.discogsProperties(rel, masterYear, cond, item.added), ...Object.fromEntries(priceBlocks),
      ...(cover ? { cover: [`cover: ${q(`[[${cover}]]`)}`] } : undefined) } satisfies Blocks;
    let changed = false;
    await this.fs.process(path, (now) => {
      const e = now.indexOf("\n---", 3);
      if (!now.startsWith("---") || e < 0) return now;
      let fm = setProperties(now.slice(0, e), blocks);
      fm = fm.replace(/^price_paid_sek:/m, "price_paid:");
      for (const k of OLD_PRICE_KEYS) fm = fm.replace(new RegExp(`^${k}:.*\\n?`, "m"), "");
      let body = now.slice(e);
      // the tracklist section, up to the next heading, is the plugin's own: it is rebuilt
      body = body.replace(/(\n## Tracklist\n)[\s\S]*?(?=\n## |$)/, (_m, head: string) => `${head}\n<!-- tracklist v2 --><!-- g2 -->\n${table}\n`);   // a function, so a "$" in a title is kept as it is
      if (cover && !/!\[\[[^\]]+\|300\]\]/.test(body)) body = body.replace(/(\n# [^\n]*\n)/, (_m, head: string) => `${head}\n![[${cover}|300]]\n`);
      changed = fm + body !== now;
      return fm + body;
    });
    this.log(`  ↻ ${artistsStr(rel.artists)} – ${rel.title}${changed ? "" : " (already up to date)"}`);
    return changed;
  }

  /* ---- refresh price fields only ---- */
  async refreshPrices(T: Base, onProgress?: (done: number, total: number) => void): Promise<number> {
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
  async collectionValue(): Promise<StoredValue> {
    const r = decodeCollectionValueText(await this.discogs(`users/${this.cfg.username}/collection/value`));
    const { target } = await this.currencies();
    const rate = await this.anyRate();
    const n = (v: number | null) => (v === null || rate === null ? null : Math.round(v * rate));
    const value: StoredValue = { min: n(r.min), med: n(r.med), max: n(r.max), currency: target, checked: today() };
    this.log(`Collection value: ${value.med === null ? "not available" : `median ${formatMoney(value.med, target)}`}`);
    return value;
  }
}

export type { FileAccess, EngineConfig, BasesAdded, Prices };
export { Engine, HttpError, vaultFiles, setProperties, errorText, pause, replyJson, today, UA };
