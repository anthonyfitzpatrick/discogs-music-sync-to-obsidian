// The Music Library view's logic: which records to show, in what order, in which groups, and what
// each table column shows. The views are the ones the .base files used to provide. No Obsidian
// dependency, so it is tested directly; views.js draws the result.

const { kr } = require("./report.js");

const text = (v) => (v === null || v === undefined ? "" : String(v));
const money = (v) => (v === null || v === undefined ? "" : kr(v));

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
  ripped: { label: "Ripped", get: (r) => (r.ripped ? "✓" : "") },
  low: { label: "Low G+", get: (r) => money(r.low), num: true },
  mid: { label: "Mid VG+", get: (r) => money(r.mid), num: true },
  high: { label: "High NM", get: (r) => money(r.high), num: true },
  myCopy: { label: "My copy", get: (r) => money(r.myCopy), num: true },
  list: { label: "Lowest listing", get: (r) => money(r.list), num: true },
  forSale: { label: "For sale", get: (r) => text(r.forSale), num: true },
  checked: { label: "Checked", get: (r) => r.checked },
};

// The views: cards with covers, or a table with these columns. A view can filter, group or sort.
const VIEWS = {
  gallery: { label: "Gallery", cards: true },
  genre: { label: "By genre", cards: true, group: (r) => (r.genres.length ? r.genres : ["No genre"]) },
  catalogue: { label: "Catalogue", columns: ["artist", "title", "year", "label", "catno", "country", "genres", "purchased", "shop", "mediaCondition", "sleeveCondition", "ripped", "list"] },
  value: { label: "Value", columns: ["artist", "title", "catno", "mediaCondition", "low", "mid", "high", "myCopy", "list", "forSale", "checked"], sort: "value" },
  unripped: { label: "Not ripped yet", cards: true, filter: (r) => !r.ripped },
};

// The value used to rank records: the VG+ suggestion where there is one, else the cheapest listing.
const worth = (r) => r.mid ?? r.list ?? -1;
const SORTS = {
  artist: { label: "Artist", compare: (a, b) => a.artist.localeCompare(b.artist) || (a.year || 0) - (b.year || 0) || a.title.localeCompare(b.title) },
  title: { label: "Album", compare: (a, b) => a.title.localeCompare(b.title) },
  year: { label: "Year", compare: (a, b) => (a.year || 9999) - (b.year || 9999) || a.artist.localeCompare(b.artist) },
  added: { label: "Newest first", compare: (a, b) => b.added.localeCompare(a.added) },
  value: { label: "Most valuable", compare: (a, b) => worth(b) - worth(a) },
};

const matches = (r, words) => {
  const hay = [r.artist, r.title, r.label, r.catno, r.country, r.shop, r.media, ...r.genres, ...r.styles].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
};

// The records to show for a base ("" for all), view, search text and sort, in groups.
// Returns [{ name, records }]: one group named "" unless the view groups.
function libraryGroups(records, base, viewKey, search, sortKey) {
  const view = VIEWS[viewKey] || VIEWS.gallery;
  const words = String(search || "").toLowerCase().split(/\s+/).filter(Boolean);
  const sort = SORTS[sortKey] || SORTS[view.sort] || SORTS.artist;
  const shown = records.filter((r) => (!base || r.media === base) && (!view.filter || view.filter(r)) && matches(r, words)).sort(sort.compare);
  if (!view.group) return [{ name: "", records: shown }];
  const groups = new Map();
  for (const r of shown) for (const g of view.group(r)) { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
  return [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([name, rs]) => ({ name, records: rs }));
}

module.exports = { COLUMNS, VIEWS, SORTS, libraryGroups };
