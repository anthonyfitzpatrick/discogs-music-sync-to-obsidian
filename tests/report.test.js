// Tests src/report.js directly: the PDF report is built without Obsidian, Dataview or Charts.
const { test } = require("node:test");
const STYLES = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "styles.css"), "utf8");
const assert = require("node:assert");
const { primaryFormat, decodeRecord, decodeCollectionValue, cssColorToHex, buildReport, reportParts, tracklist, palette, SECTIONS, FULL_BASES } = require("../src/report.js");

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
  // the six sections the dashboard started with
  const six = { sections: Object.fromEntries(SECTIONS.map(([k]) => [k, ["overview", "value", "contents", "decades", "artists", "buying"].includes(k)])) };
  const html = buildReport(records, ["Vinyl", "CDs"], decodeCollectionValue({ discogs_value_max: 900 }), THEME, "28 September 2026", six);
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
  const { body } = reportParts(records, ["Vinyl"], decodeCollectionValue(null), THEME, true);
  assert.match(body, /<a class="mls-open" data-path="Music\/Vinyl\/A &quot;quoted&quot; &lt;note&gt;\.md">T<\/a>/, "the path is escaped");
  assert.match(body, /<input type="checkbox" class="mls-listen" data-path="Music\/Vinyl\/A &quot;quoted&quot; &lt;note&gt;\.md"/);
  assert.doesNotMatch(buildReport(records, ["Vinyl"], decodeCollectionValue(null), THEME, "now"), /class="mls-open"|class="mls-listen"/, "the PDF has neither");
});

test("the report's styles are in styles.css, where the PDF finds them, with its colours as variables", () => {
  const css = STYLES.slice(STYLES.indexOf("/* The dashboard report."));
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.trim()).filter(Boolean);
  const report = rules.filter((r) => r.startsWith(".mls-report"));
  assert.ok(report.length > 10, "the report's rules are there");
  assert.doesNotMatch(report.join("}"), /#[0-9a-f]{3,6}\b/i, "colours come from variables, so the theme and the PDF can set them");
  const html = buildReport([rec({})], ["Vinyl"], decodeCollectionValue(null), THEME, "now", { css: STYLES });
  assert.ok(html.includes(".mls-report h2 {"), "the PDF embeds the stylesheet");
  assert.match(html, new RegExp(`--mls-fg: ${THEME.fg}`), "and sets the colours to the theme's");
});

test("styles.css has no declarations outside a rule", () => {
  // Leftover declarations with no selector swallow the next rule; it happened to the old dashboard's table.
  const css = STYLES.replace(/\/\*[\s\S]*?\*\//g, "");
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

// ------------------------------------------------------------------ the added reports

const rich = [
  decodeRecord({ title: "Rare One", artist: "A", format: "1x Vinyl, LP, Album", year: 1975, original_year: 1975, country: "UK", label: "Harvest",
    market_for_sale: 2, market_lowest_sek: 900, price_mid_sek: 600, price_paid_sek: 150, purchased: "2025-03-01", shop: "Shop", cover: "[[1.jpg]]",
    genres: ["Rock"], listened: true, listened_on: "2026-09-10", media_condition: "Very Good Plus (VG+)" }, "Vinyl", BODY, "x", "Music/Vinyl/Rare.md"),
  decodeRecord({ title: "Common Two", artist: "B", format: "1x CD, Compilation, Reissue", year: 2001, original_year: 1990, country: "Europe", label: "EMI",
    market_for_sale: 80, market_lowest_sek: 20, price_mid_sek: 60, added_to_discogs: "2026-01-15", genres: [] }, "CDs", BODY, "x", "Music/CDs/Common.md"),
];

test("the added sections are all in the dashboard, each can be left out, and all can be", () => {
  const all = buildReport(rich, ["Vinyl", "CDs"], decodeCollectionValue(null), THEME, "now");
  for (const [, title] of SECTIONS) assert.ok(all.includes(`<h2>${title.replace("'", "&#39;")}</h2>`), title);
  const noMarket = buildReport(rich, ["Vinyl", "CDs"], decodeCollectionValue(null), THEME, "now", { sections: { market: false, spending: false } });
  assert.doesNotMatch(noMarket, /<h2>Market<\/h2>|<h2>Spending<\/h2>/);
  assert.match(noMarket, /<h2>Pressings<\/h2>/);
  const none = buildReport(rich, ["Vinyl"], decodeCollectionValue(null), THEME, "now", { sections: Object.fromEntries(SECTIONS.map(([k]) => [k, false])) });
  assert.match(none, /Every dashboard section is turned off/);
  assert.doesNotMatch(all, /NaN|undefined|Infinity/);
});

test("the market, pressings, spending, listening, condition and attention figures are right", () => {
  const html = buildReport(rich, ["Vinyl", "CDs"], decodeCollectionValue(null), THEME, "now");
  const part = (from, to) => html.slice(html.indexOf(`<h2>${from}</h2>`), to ? html.indexOf(`<h2>${to}</h2>`) : undefined);
  assert.match(part("Market", "What&#39;s in the collection"), /Rare One<\/td><td>A<\/td><td><span[^>]*>Vinyl<\/span><\/td><td class="num">2<\/td>/, "fewest for sale first");
  assert.match(part("Market", "What&#39;s in the collection"), /Above estimate[\s\S]*Rare One[\s\S]*\+50%/, "900 listed against a 600 estimate");
  assert.match(part("Pressings", "By decade"), /Reissue or repress — 50% \(1\)/);
  assert.match(part("Pressings", "By decade"), /Compilation — 50% \(1\)/);
  assert.match(part("Spending", "Listening"), /Total paid<\/td><td class="num">150 kr/);
  assert.match(part("Spending", "Listening"), /Gain or loss<\/td><td class="num">\+450 kr \(300%\)/);
  const listening = part("Listening", "Condition");
  assert.match(listening, /Waiting longest[\s\S]*Common Two/, "not listened to, so waiting");
  assert.doesNotMatch(listening, /Rare One|Listened so far|Listened per month/);
  assert.match(part("Condition", "Needs attention"), /1 of 2 records are graded/);
  const attention = part("Needs attention");
  assert.match(attention, /No purchase date<\/td><td class="num">1<\/td><td>Common Two/);
  assert.match(attention, /No cover image<\/td><td class="num">1</);
  assert.doesNotMatch(attention, /No original year/, "both have one");
});

test("spending and condition explain what's missing when nobody has filled them in", () => {
  const bare = [decodeRecord({ title: "T", format: "1x Vinyl", added_to_discogs: "2026-01-01" }, "Vinyl", "", "x")];
  const html = buildReport(bare, ["Vinyl"], decodeCollectionValue(null), THEME, "now");
  assert.match(html, /No record has one yet/);
  assert.match(html, /No record has a condition yet/);
});

test("growth charts records owned, and the collection's value once two syncs are recorded", () => {
  const one = buildReport(rich, ["Vinyl", "CDs"], decodeCollectionValue(null), THEME, "now", { history: [{ date: "2026-09-28", min: 1, med: 2, max: 3 }] });
  const growth = one.slice(one.indexOf("<h2>Growth over time</h2>"), one.indexOf("<h2>Value spread</h2>"));
  assert.match(growth, /<path d="M/, "a line for records owned");
  assert.match(growth, /appears once there are two syncs/);
  const two = buildReport(rich, ["Vinyl", "CDs"], decodeCollectionValue(null), THEME, "now",
    { history: [{ date: "2026-09-28", min: 1, med: 2, max: 3 }, { date: "2026-10-05", min: 2, med: 3, max: 4 }] });
  assert.doesNotMatch(two, /appears once there are two syncs/);
  assert.match(two.slice(two.indexOf("Collection value (Discogs)")), /2026-10-05/);
});

test("colours: theme shades, the original full colours, or the user's own", () => {
  const theme = palette(THEME);
  assert.strictEqual(theme.bases(2)[0], THEME.fg, "the first base in the theme's own colour");
  assert.notStrictEqual(theme.bases(2)[1], THEME.fg, "the next a lighter shade");
  const full = palette(THEME, { mode: "full" });
  assert.deepStrictEqual(full.bases(3), ["#7c3aed", "#db2777", "#f59e0b"], "the original purple, pink and orange");
  assert.deepStrictEqual(full.scale(7), ["#c4b5fd", "#a78bfa", "#8b5cf6", "#7c3aed", "#db2777", "#f97316", "#f59e0b"]);
  const custom = palette(THEME, { mode: "custom", bases: ["#112233", "not a colour"], accent: "#00aa55" });
  assert.deepStrictEqual(custom.bases(3), ["#112233", FULL_BASES[1], FULL_BASES[2]], "a bad colour falls back");
  assert.strictEqual(new Set(custom.distinct(6)).size, 6);
  assert.strictEqual(custom.fg, THEME.fg, "text keeps the theme's colour in every mode");
  const html = buildReport(rich, ["Vinyl", "CDs"], decodeCollectionValue(null), THEME, "now", { colours: { mode: "full" } });
  assert.match(html, /#7c3aed/);
});

test("line charts join their points, and break only at a gap", () => {
  const two = buildReport(rich, ["Vinyl", "CDs"], decodeCollectionValue(null), THEME, "now",
    { sections: { ...Object.fromEntries(SECTIONS.map(([k]) => [k, false])), growth: true },
      history: [{ date: "2026-09-26", min: 1, med: 2, max: 3 }, { date: "2026-09-27", min: 2, med: 3, max: 4 }, { date: "2026-09-28", min: 3, med: 4, max: 5 }] });
  const paths = two.match(/<path d="[^"]+"/g) || [];
  assert.ok(paths.length >= 2);
  for (const p of paths) assert.match(p, /^<path d="M[\d.]+,[\d.]+ (L[\d.]+,[\d.]+ ?)+"$/, "one move, then lines");
});

test("axes never show the same number twice", () => {
  const html = buildReport([rich[0]], ["Vinyl"], decodeCollectionValue(null), THEME, "now",
    { sections: { ...Object.fromEntries(SECTIONS.map(([k]) => [k, false])), condition: true } });
  const ticks = [...html.matchAll(/<text x="[\d.]+" y="[\d.]+" text-anchor="middle">(\d+)<\/text>/g)].map((m) => m[1]);
  assert.deepStrictEqual(ticks, ["0", "1"], "a single record: 0 and 1 only");
});
