// Tests the Music Library view's logic (src/library.js) directly.
const { test } = require("node:test");
const assert = require("node:assert");
const { decodeRecord } = require("../src/report.js");
const { COLUMNS, VIEWS, libraryGroups } = require("../src/library.js");

const rec = (media, fm) => decodeRecord({ artist: "A", title: "T", ...fm }, media, "", "x", `Music/${media}/${fm.title || "T"}.md`);
const records = [
  rec("Vinyl", { artist: "Queen", title: "A Night At The Opera", original_year: 1975, genres: ["Rock"], price_mid_sek: 1163, ripped: true, purchased: "2026-05-01" }),
  rec("Vinyl", { artist: "Metallica", title: "Master Of Puppets", original_year: 1986, genres: ["Rock", "Metal"], price_mid_sek: 1724, purchased: "2026-09-26" }),
  rec("CDs", { artist: "Norah Jones", title: "Come Away With Me", original_year: 2002, genres: ["Jazz"], market_lowest_sek: 40, label: "Blue Note" }),
];
const titles = (groups) => groups.map((g) => [g.name, g.records.map((r) => r.title)]);

test("the gallery shows every base, sorted by artist", () => {
  assert.deepStrictEqual(titles(libraryGroups(records, "", "gallery", "", "")), [["", ["Master Of Puppets", "Come Away With Me", "A Night At The Opera"]]]);
});

test("a base, a search and a sort narrow and order the records", () => {
  assert.deepStrictEqual(titles(libraryGroups(records, "CDs", "gallery", "", "")), [["", ["Come Away With Me"]]]);
  assert.deepStrictEqual(titles(libraryGroups(records, "", "gallery", "blue note", "")), [["", ["Come Away With Me"]]], "search reaches the label");
  assert.deepStrictEqual(titles(libraryGroups(records, "", "gallery", "rock 1975", "")), [["", []]], "every word must match; the year isn't searched");
  assert.deepStrictEqual(titles(libraryGroups(records, "", "gallery", "", "added")), [["", ["Master Of Puppets", "A Night At The Opera", "Come Away With Me"]]]);
});

test("the views match the old .base files: grouped by genre, value first, not ripped", () => {
  assert.deepStrictEqual(titles(libraryGroups(records, "", "genre", "", "")),
    [["Jazz", ["Come Away With Me"]], ["Metal", ["Master Of Puppets"]], ["Rock", ["Master Of Puppets", "A Night At The Opera"]]]);
  assert.deepStrictEqual(titles(libraryGroups(records, "", "value", "", "")), [["", ["Master Of Puppets", "A Night At The Opera", "Come Away With Me"]]],
    "most valuable first, by VG+ or else the cheapest listing");
  assert.deepStrictEqual(titles(libraryGroups(records, "", "unripped", "", "")), [["", ["Master Of Puppets", "Come Away With Me"]]]);
  for (const v of Object.values(VIEWS)) for (const c of v.columns || []) assert.ok(COLUMNS[c], c);
});

test("table columns show the record's values, with money and ticks", () => {
  const [queen] = records;
  assert.strictEqual(COLUMNS.mid.get(queen), "1\u00a0163 kr", "Swedish grouping uses a no-break space");
  assert.strictEqual(COLUMNS.low.get(queen), "");
  assert.strictEqual(COLUMNS.ripped.get(queen), "✓");
  assert.strictEqual(COLUMNS.genres.get(records[1]), "Rock, Metal");
});
