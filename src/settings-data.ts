// The plugin's settings: their shape, what a new install starts with, and how saved settings from any
// earlier version are read. Nothing here touches Obsidian except normalizePath, so it is easy to follow.
import { normalizePath } from "obsidian";
import type { Base } from "./bases.ts";
import { LEGACY_CURRENCY, currencyCode } from "./currency.ts";
import { entries, field, isBoolean, isJsonObject, isNumber, isText, items, texts } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { DEFAULT_ACCENT, isColourMode } from "./report.ts";
import type { ColourMode, HistoryPoint } from "./report.ts";
import type { LibraryState } from "./views.ts";

// The library folder a new install starts with; the user can choose another in settings.
const DEFAULT_FOLDER = "Music";
// A folder path as typed, cleaned: no leading/trailing slashes, single slashes, no empty parts.
const cleanFolder = (v: JsonValue | undefined): string => {
  const f = (isText(v) ? v : "").split("/").map((x) => x.trim()).filter(Boolean).join("/");
  return f ? normalizePath(f) : "";
};
// Why a folder name typed in settings can't be used, or "" when it can.
const folderProblem = (v: JsonValue | undefined): string => {
  const f = cleanFolder(v);
  if (!f) return "Enter a folder name.";
  if (f.split("/").some((part) => part.startsWith(".") || /[\\:*?"<>|#^[\]]/.test(part))) return "Use a folder name without \\ : * ? \" < > | # ^ [ ], not starting with a dot.";
  return "";
};

// PDF paper sizes, in inches (portrait), and the margin round each page.
const PAPER = {
  A5: [5.83, 8.27], A4: [8.27, 11.69], A3: [11.69, 16.54],
  Letter: [8.5, 11], Legal: [8.5, 14], Tabloid: [11, 17],
} satisfies Record<string, [number, number]>;
const PAPER_TABLE = new Map<string, [number, number]>(Object.entries(PAPER));
// A paper size's width and height by its name, or undefined for one not in the list.
const paperSize = (name: string): [number, number] | undefined => PAPER_TABLE.get(name);
const MARGIN = 0.45;
type Orientation = "portrait" | "landscape";
interface PdfSettings { size: string; orientation: Orientation }

type RunMode = "sync" | "prices" | "dashboard";
interface LastRun { at: number; mode: RunMode; ok: boolean; summary: string }
// Discogs' own value of the collection as last fetched, in the prices' currency.
interface StoredValue { min: number | null; med: number | null; max: number | null; currency: string; checked: string }
// An exchange rate Discogs was seen to use, and when.
interface Rate { rate: number; date: string }
// The rates last measured, by currency pair ("SEK>USD").
type Rates = Record<string, Rate>;
interface ColourSettings { mode: ColourMode; bases: Record<string, string>; accent: string }

interface Settings {
  last: LastRun | null;
  username: string;
  folder: string;
  lyrics: boolean;
  gallery: boolean;
  pdf: PdfSettings;
  value: StoredValue | null;        // Discogs' own value of the collection, fetched with each sync
  tab: string;                      // the Music tab shown last: dashboard or library
  library: LibraryState;            // the Library's last choices
  legacyFiles: string[];            // files earlier versions made, offered for removal in settings
  valueHistory: HistoryPoint[];     // Discogs' value of the collection, one entry per day it was fetched
  sections: Record<string, boolean>;   // dashboard sections turned off: { key: false }
  autoBases: boolean;               // a sync creates a base for each format that has none
  currency: string;                 // prices' currency; "" = the Discogs account's, set at the first sync or Test
  rates: Rates;                     // Discogs' exchange rates last measured: { "SEK>USD": { rate, date } }
  skippedFormats: string[];         // formats whose base the user stopped syncing: not created again
  colours: ColourSettings;          // bases: colour per base id, for Custom
  libraries: Base[];                // the bases
}

// A "base" (library) takes the records of one or more Discogs formats into its own vault folder, with
// its own tag, and its own place in the Library and Dashboard views. A new install starts with none and
// sets them up from the formats in the user's collection.
const defaults = (): Settings => ({
  last: null, username: "", folder: DEFAULT_FOLDER, lyrics: true, gallery: true, pdf: { size: "A4", orientation: "portrait" },
  value: null, tab: "dashboard",
  library: { base: "", view: "gallery", size: "small", sort: "", search: "" },
  legacyFiles: [], valueHistory: [], sections: {}, autoBases: true, currency: "", rates: {}, skippedFormats: [],
  colours: { mode: "theme", bases: {}, accent: DEFAULT_ACCENT },
  libraries: [],
});

/* ---- reading saved settings: each value checked, anything missing or malformed taken from the defaults ---- */

const text = (v: JsonValue | undefined, fallback: string): string => (isText(v) ? v : fallback);
const bool = (v: JsonValue | undefined, fallback: boolean): boolean => (isBoolean(v) ? v : fallback);
const numOrNull = (v: JsonValue | undefined): number | null => (isNumber(v) ? v : null);

function readLastRun(v: JsonValue | undefined): LastRun | null {
  const mode = field(v, "mode"), at = field(v, "at");
  return mode === "sync" || mode === "prices" || mode === "dashboard"
    ? { at: isNumber(at) ? at : 0, mode, ok: field(v, "ok") === true, summary: text(field(v, "summary"), "") } : null;
}
function readValue(v: JsonValue | undefined): StoredValue | null {
  if (!isJsonObject(v)) return null;
  return { min: numOrNull(v.min), med: numOrNull(v.med), max: numOrNull(v.max), currency: text(v.currency, ""), checked: text(v.checked, "") };
}
function readHistory(v: JsonValue | undefined): HistoryPoint[] {
  return items(v).filter(isJsonObject).filter((h) => isText(h.date))
    .map((h) => ({ date: text(h.date, ""), min: numOrNull(h.min), med: numOrNull(h.med), max: numOrNull(h.max), currency: text(h.currency, "") }));
}
function readRates(v: JsonValue | undefined) {
  const out: Rates = {};
  for (const [k, r] of entries(v)) { const rate = field(r, "rate"); if (isNumber(rate)) out[k] = { rate, date: text(field(r, "date"), "") }; }
  return out;
}

// One saved base. Before 0.10 a base synced a Discogs folder; the folders were named after their formats
// (Vinyl, CD, Cassette), which are Discogs' own spellings, so each becomes the format its base takes.
// Before 0.11 each base had a .base file, which the views replace: it is handed back for removal.
function readBase(v: JsonObject, legacyFile: (path: string) => void): Base {
  const name = text(v.name, "");
  const formats = Array.isArray(v.formats) ? texts(v.formats) : [text(v.discogsFolder, "") || name];
  if (isText(v.base) && v.base) legacyFile(v.base);
  return { id: text(v.id, ""), name, dir: text(v.dir, ""), tag: text(v.tag, ""), icon: text(v.icon, "disc-3"), formats };
}

// Settings as saved by any version (or nothing, for a new install), read into today's shape. Settings this
// version doesn't know are kept as they are, so they survive a save.
function loadSettings(saved: JsonValue | undefined): Settings {
  const raw: JsonObject = isJsonObject(saved) ? saved : {};
  const d = defaults();
  const legacyFiles = texts(raw.legacyFiles);
  const libraries = items(raw.libraries).filter(isJsonObject)
    .map((l) => readBase(l, (p) => { if (!legacyFiles.includes(p)) legacyFiles.push(p); }));
  const value = readValue(raw.value);
  const pdf = raw.pdf, library = raw.library, colours = raw.colours;
  const sections: Record<string, boolean> = {};
  for (const [k, on] of entries(raw.sections)) if (isBoolean(on)) sections[k] = on;
  const bases: Record<string, string> = {};
  for (const [k, c] of entries(field(colours, "bases"))) if (isText(c)) bases[k] = c;
  const size = field(pdf, "size"), mode = field(colours, "mode");
  const libraryText = (key: keyof LibraryState) => text(field(library, key), d.library[key]);
  // Before 0.16 every price was in kronor, so an install from then keeps kronor until the user chooses.
  const currency = raw.currency === undefined && isJsonObject(saved) && (libraries.length || value) ? LEGACY_CURRENCY : currencyCode(raw.currency);
  return {
    ...raw,
    last: readLastRun(raw.last),
    username: text(raw.username, d.username),
    folder: cleanFolder(raw.folder) || DEFAULT_FOLDER,
    lyrics: bool(raw.lyrics, d.lyrics),
    gallery: bool(raw.gallery, d.gallery),
    pdf: { size: isText(size) && paperSize(size) ? size : d.pdf.size, orientation: field(pdf, "orientation") === "landscape" ? "landscape" : "portrait" },
    value,
    tab: text(raw.tab, d.tab),
    library: { base: libraryText("base"), view: libraryText("view"), size: libraryText("size"), sort: libraryText("sort"), search: libraryText("search") },
    legacyFiles,
    valueHistory: readHistory(raw.valueHistory),
    sections,
    autoBases: bool(raw.autoBases, d.autoBases),
    currency,
    rates: readRates(raw.rates),
    skippedFormats: texts(raw.skippedFormats),
    colours: { mode: isColourMode(mode) ? mode : d.colours.mode, bases, accent: text(field(colours, "accent"), d.colours.accent) },
    libraries,
  };
}

export type { Settings, LastRun, RunMode, StoredValue, Rate, Rates, PdfSettings, Orientation, ColourSettings };
export { DEFAULT_FOLDER, cleanFolder, folderProblem, PAPER, MARGIN, paperSize, defaults, loadSettings };
