// The Music Library view's logic: which records to show, in what order, in which groups, and what
// each table column shows. The views are the ones the .base files used to provide. No Obsidian
// dependency, so it is tested directly; views.ts draws the result.

import { formatMoney } from "./currency.ts";
import type { MusicRecord } from "./report.ts";

type Rec = MusicRecord;
const text = (v: number | null): string => (v === null ? "" : String(v));
// each record in the currency its prices were fetched in
const money = (r: Rec, k: "low" | "mid" | "high" | "myCopy" | "list"): string => { const v = r[k]; return v === null ? "" : formatMoney(v, r.currency); };

// A table column: its heading, how a record fills it, and whether it's a number.
interface Column { label: string; get: (r: Rec) => string; num?: boolean }
// A view: cards with covers (optionally grouped), or a table with some columns, optionally sorted.
interface View { label: string; cards?: boolean; group?: (r: Rec) => string[]; columns?: ColumnKey[]; sort?: SortKey }
interface Sort { label: string; compare: (a: Rec, b: Rec) => number }
interface Size { label: string; text: boolean }
// One group of records to show, named "" when the view doesn't group.
interface LibraryGroup { name: string; records: Rec[] }

// Every column a table view can show: its heading, how a record fills it, and whether it's a number.
const COLUMNS = {
  artist: { label: "Artist", get: (r) => r.artist },
  title: { label: "Album", get: (r) => r.title },
  year: { label: "Year", get: (r) => text(r.year), num: true },
  label: { label: "Label", get: (r) => r.label },
  catno: { label: "Cat. no.", get: (r) => r.catno },
  country: { label: "Country", get: (r) => r.country },
  genres: { label: "Genres", get: (r) => r.genres.join(", ") },
  purchased: { label: "Purchased", get: (r) => r.purchased },
  shop: { label: "Shop", get: (r) => r.shop },
  media: { label: "Base", get: (r) => r.media },
  mediaCondition: { label: "Media", get: (r) => r.mediaCondition },
  sleeveCondition: { label: "Sleeve", get: (r) => r.sleeveCondition },
  low: { label: "Low G+", get: (r) => money(r, "low"), num: true },
  mid: { label: "Mid VG+", get: (r) => money(r, "mid"), num: true },
  high: { label: "High NM", get: (r) => money(r, "high"), num: true },
  myCopy: { label: "My copy", get: (r) => money(r, "myCopy"), num: true },
  list: { label: "Lowest listing", get: (r) => money(r, "list"), num: true },
  forSale: { label: "For sale", get: (r) => text(r.forSale), num: true },
  checked: { label: "Checked", get: (r) => r.checked },
} satisfies Record<string, Column>;
type ColumnKey = keyof typeof COLUMNS;

// The views: cards with covers, or a table with these columns. A view can group or sort.
const VIEWS = {
  gallery: { label: "Gallery", cards: true },
  genre: { label: "By genre", cards: true, group: (r) => (r.genres.length ? r.genres : ["No genre"]) },
  catalogue: { label: "Catalogue", columns: ["artist", "title", "year", "label", "catno", "country", "genres", "purchased", "shop", "mediaCondition", "sleeveCondition", "list"] },
  value: { label: "Value", columns: ["artist", "title", "catno", "mediaCondition", "low", "mid", "high", "myCopy", "list", "forSale", "checked"], sort: "value" },
} satisfies Record<string, View>;

// Card sizes for the card views. Small is how cards looked before sizes could be chosen, and the default.
const SIZES = {
  artwork: { label: "Artwork only", text: false },
  small: { label: "Small", text: true },
  large: { label: "Large", text: true },
} satisfies Record<string, Size>;
const DEFAULT_SIZE = "small";

// The value used to rank records: the VG+ suggestion where there is one, else the cheapest listing.
const worth = (r: Rec): number => r.mid ?? r.list ?? -1;
const SORTS = {
  artist: { label: "Artist", compare: (a, b) => a.artist.localeCompare(b.artist) || (a.year || 0) - (b.year || 0) || a.title.localeCompare(b.title) },
  title: { label: "Album", compare: (a, b) => a.title.localeCompare(b.title) },
  year: { label: "Year", compare: (a, b) => (a.year || 9999) - (b.year || 9999) || a.artist.localeCompare(b.artist) },
  added: { label: "Newest first", compare: (a, b) => b.added.localeCompare(a.added) },
  value: { label: "Most valuable", compare: (a, b) => worth(b) - worth(a) },
} satisfies Record<string, Sort>;
type SortKey = keyof typeof SORTS;

// A view, card size or sort by the key the settings keep; undefined for a key no longer known.
const VIEW_TABLE = new Map<string, View>(Object.entries(VIEWS)), SIZE_TABLE = new Map<string, Size>(Object.entries(SIZES)), SORT_TABLE = new Map<string, Sort>(Object.entries(SORTS));
const viewOf = (key: string): View | undefined => VIEW_TABLE.get(key);
const sizeOf = (key: string): Size | undefined => SIZE_TABLE.get(key);
const sortOf = (key: string): Sort | undefined => SORT_TABLE.get(key);

const matches = (r: Rec, words: string[]): boolean => {
  const hay = [r.artist, r.title, r.label, r.catno, r.country, r.shop, r.media, ...r.genres, ...r.styles].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
};

// The records to show for a base ("" for all), view, search text and sort, in groups.
// Returns [{ name, records }]: one group named "" unless the view groups.
function libraryGroups(records: Rec[], base: string, viewKey: string, search: string, sortKey: string): LibraryGroup[] {
  const view: View = viewOf(viewKey) ?? VIEWS.gallery;
  const words = (search || "").toLowerCase().split(/\s+/).filter(Boolean);
  const sort = sortOf(sortKey) ?? (view.sort ? SORTS[view.sort] : undefined) ?? SORTS.artist;
  const shown = records.filter((r) => (!base || r.media === base) && matches(r, words)).sort(sort.compare);
  if (!view.group) return [{ name: "", records: shown }];
  const groups = new Map<string, Rec[]>();
  for (const r of shown) for (const g of view.group(r)) { const rs = groups.get(g) ?? []; rs.push(r); groups.set(g, rs); }
  return [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([name, rs]) => ({ name, records: rs }));
}

export type { Column, ColumnKey, View, Sort, SortKey, Size, LibraryGroup };
export { COLUMNS, VIEWS, SORTS, SIZES, DEFAULT_SIZE, libraryGroups, viewOf, sizeOf, sortOf };
