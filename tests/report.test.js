// Tests src/report.js directly: the PDF report is built without Obsidian, Dataview or Charts.
const { test } = require("node:test");
const assert = require("node:assert");
const { primaryFormat, decodeRecord, decodeCollectionValue, cssColorToHex, buildReport, reportParts, tracklist } = require("../src/report.js");

const THEME = { fg: "#33ff66", bg: "#0a0f06", muted: "#4fcc77", border: "#1a5530", font: "Monaco, monospace" };
const BODY = `# A – B

## Tracklist

| # | Title | Length | Lyrics |
|---|---|---|---|
| | **Side A** | | |
| A1 | One | 4:20 | [Lyrics](https://genius.com/x) |
| A2 | Two | 3:40 |  |
| B1 | Three |  |  |
`;
const rec = (over) => decodeRecord({ title: "T", artist: "A", price_mid_sek: 100, market_lowest_sek: 50, original_year: 1988,
  purchased: "2026-05-29", genres: ["Rock"], styles: ["Pop Rock"], shop: "Tradera", ...over }, "Vinyl", BODY, "file name");

test("a record is decoded from its frontmatter and tracklist", () => {
  const r = decodeRecord({ title: " ...Ish ", artist: "1927", year: 1990, original_year: 1988, price_low_sek: "73", price_mid_sek: 191,
    price_high_sek: 249, market_lowest_sek: 40, added_to_discogs: "2026-06-04", genres: "Rock" }, "Vinyl", BODY, "fallback");
  assert.strictEqual(r.title, "...Ish");
  assert.strictEqual(r.year, 1988, "original year wins");
  assert.strictEqual(r.low, 73, "numbers typed as text are decoded");
  assert.strictEqual(r.max, 249, "no Mint price falls back to Near Mint");
  assert.strictEqual(r.added, "2026-06-04", "no purchase date falls back to the Discogs date");
  assert.deepStrictEqual(r.genres, ["Rock"], "a single genre becomes a list");
  assert.strictEqual("ripped" in r, false, "ripped isn't tracked");
  assert.strictEqual(r.listened, false);
  assert.deepStrictEqual(tracklist(BODY), { tracks: 3, secs: 480 }, "headings aren't tracks; blank lengths count as 0");
  assert.strictEqual(decodeRecord({}, "CDs", "", "fallback").title, "fallback");
  assert.strictEqual(decodeRecord({ price_mid_sek: "n/a" }, "CDs", "", "x").mid, null);
});

test("the collection value is decoded, with missing figures as null", () => {
  assert.deepStrictEqual(decodeCollectionValue({ discogs_value_min: 100, discogs_value_median: 200, discogs_value_max: 300 }), { min: 100, med: 200, max: 300 });
  assert.deepStrictEqual(decodeCollectionValue(null), { min: null, med: null, max: null });
});

test("computed CSS colours become hex", () => {
  assert.strictEqual(cssColorToHex("rgb(51, 255, 102)", "#000000"), "#33ff66");
  assert.strictEqual(cssColorToHex("rgba(10, 15, 6, 0.5)", "#000000"), "#0a0f06");
  assert.strictEqual(cssColorToHex("color(srgb 0.2 1 0.4)", "#000000"), "#33ff66");
  assert.strictEqual(cssColorToHex("", "#123456"), "#123456");
});

test("the report has every dashboard section, charts drawn as SVG, and correct totals", () => {
  const records = [rec({}), rec({ title: "Second", price_mid_sek: 300 }), { ...rec({ title: "Third" }), media: "CDs" }];
  const html = buildReport(records, ["Vinyl", "CDs"], decodeCollectionValue({ discogs_value_max: 900 }), THEME, "28 September 2026");
  for (const heading of ["Overview", "Value spread", "What's in the collection", "By decade", "Top artists", "Buying"])
    assert.ok(html.includes(`<h2>${heading.replace("'", "&#39;")}</h2>`), heading);
  assert.strictEqual((html.match(/<svg /g) || []).length, 8, "6 bar charts and 2 doughnuts");
  assert.doesNotMatch(html, /Where you buy|Ripped/);
  assert.match(html, /<tr class="total"><td>Total<\/td><td class="num">3<\/td><td class="num">9<\/td>/, "3 records, 9 tracks");
  assert.match(html, /Top 20 albums by value \(Medium, VG\+\)/);
  assert.ok(html.includes("#33ff66") && html.includes("#0a0f06") && html.includes("Monaco, monospace"), "theme colours and font");
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
  assert.match(html, /Exported 28 September 2026/);
});

test("titles and names are escaped", () => {
  const html = buildReport([rec({ title: "<script>alert(1)</script>", artist: "Simon & Garfunkel", shop: "\"Q\" <shop>" })], ["Vinyl"], decodeCollectionValue(null), THEME, "now");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Simon &amp; Garfunkel/);
});

test("the report copes with no records and with records lacking prices", () => {
  assert.match(buildReport([], ["Vinyl"], decodeCollectionValue(null), THEME, "now"), /No record notes found in Vinyl/);
  const html = buildReport([rec({ price_mid_sek: null, market_lowest_sek: null, genres: [], styles: [], shop: "", purchased: "" })],
    ["Vinyl"], decodeCollectionValue(null), THEME, "now");
  assert.match(html, /cheapest listing/, "falls back to cheapest listings without price suggestions");
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
});

test("in the dashboard view, albums open their notes and new records can be ticked as listened", () => {
  const records = [decodeRecord({ title: "T", artist: "A", purchased: "2026-09-01", price_mid_sek: 10 }, "Vinyl", "", "x", 'Music/Vinyl/A "quoted" <note>.md')];
  const { body, css } = reportParts(records, ["Vinyl"], decodeCollectionValue(null), THEME, true);
  assert.match(body, /<a class="mls-open" data-path="Music\/Vinyl\/A &quot;quoted&quot; &lt;note&gt;\.md">T<\/a>/, "the path is escaped");
  assert.match(body, /<input type="checkbox" class="mls-listen" data-path="Music\/Vinyl\/A &quot;quoted&quot; &lt;note&gt;\.md"/);
  assert.doesNotMatch(buildReport(records, ["Vinyl"], decodeCollectionValue(null), THEME, "now"), /class="mls-open"|class="mls-listen"/, "the PDF has neither");
  assert.ok(css.split("}").filter((r) => r.trim()).every((r) => r.trim().startsWith(".mls-report")), "every style is scoped to the report");
});

test("the report's styles have no declarations outside a rule", () => {
  // Leftover declarations with no selector swallow the next rule; it happened to the old dashboard's table.
  const { css } = reportParts([rec({})], ["Vinyl"], decodeCollectionValue(null), THEME, true);
  let depth = 0, selector = "";
  for (const ch of css) {
    if (ch === "{") { if (depth++ === 0) { assert.doesNotMatch(selector, /;/, selector.trim()); selector = ""; } }
    else if (ch === "}") { assert.ok(depth > 0); depth--; }
    else if (depth === 0) selector += ch;
  }
  assert.strictEqual(depth, 0);
});

test("a record's format is the first Discogs lists that isn't a wrapper", () => {
  assert.strictEqual(primaryFormat("1x Vinyl, LP, Album, Stereo", "Vinyl"), "Vinyl");
  assert.strictEqual(primaryFormat("1x Box Set, Compilation; 4x Vinyl, LP, Stereo", "Box Set"), "Vinyl", "a box set of LPs is vinyl");
  assert.strictEqual(primaryFormat("1x All Media, Compilation, Reissue; 1x CD, Album; 1x CD, Album", "All Media"), "CD");
  assert.strictEqual(primaryFormat("", "Cassette"), "Cassette", "no format property: the media property");
  assert.strictEqual(primaryFormat("", ""), "Unknown");
});

test("a typical album is reported for each format and for all of them", () => {
  const vinyl = (mid) => decodeRecord({ title: `V${mid}`, format: "1x Vinyl, LP", media: "Vinyl", price_mid_sek: mid }, "Vinyl", "", "x");
  const cd = (mid) => decodeRecord({ title: `C${mid}`, format: "1x CD, Album", media: "CD", price_mid_sek: mid }, "CDs", "", "x");
  const boxed = decodeRecord({ title: "Box", format: "1x Box Set; 4x Vinyl, LP", media: "Box Set", price_mid_sek: 900 }, "Vinyl", "", "x");
  const html = buildReport([vinyl(100), vinyl(200), vinyl(300), boxed, cd(50)], ["Vinyl", "CDs"], decodeCollectionValue(null), THEME, "now");
  const card = html.slice(html.indexOf("A typical album, by format"), html.indexOf("Top 20 albums"));
  assert.match(card, /<th><\/th><th class="num">Vinyl<\/th><th class="num">CD<\/th><th class="num">All<\/th>/, "most common format first, then all");
  assert.match(card, /<td>Records<\/td><td class="num">4<\/td><td class="num">1<\/td><td class="num">5<\/td>/, "the box set counts as vinyl");
  assert.match(card, /<td>Most valuable record<\/td><td class="num">900 kr<\/td><td class="num">50 kr<\/td><td class="num">900 kr<\/td>/);
  assert.doesNotMatch(card, /Box Set/);
  const one = buildReport([vinyl(100)], ["Vinyl"], decodeCollectionValue(null), THEME, "now");
  assert.match(one.slice(one.indexOf("A typical album")), /<th><\/th><th class="num">Vinyl<\/th><\/tr>/, "one format: one column, named for it");
});
