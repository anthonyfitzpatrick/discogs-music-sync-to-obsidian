// Tests the pure logic in src/bases.js and src/discogs.js directly: no Obsidian stand-in needed.
const { test } = require("node:test");
const assert = require("node:assert");
const { tidy, slug, baseYaml, allMediaYaml, guessIcon, nameProblem, baseFor, formatCounts } = require("../src/bases.js");
const { decodeCollectionPage, decodeIdentity } = require("../src/discogs.js");

const vinyl = { id: "vinyl", name: "Vinyl", formats: ["Vinyl"], tag: "vinyl-library" };
const cds = { id: "cds", name: "CDs", formats: ["CD", "CDr"], tag: "cd-library" };

test("names are tidied and turned into tag slugs", () => {
  assert.strictEqual(tidy("  Mini   Discs "), "Mini Discs");
  assert.strictEqual(slug("Mini Discs"), "mini-discs");
  assert.strictEqual(slug("Rock & Roll"), "rock-and-roll");
  assert.strictEqual(slug("Café Classics"), "cafe-classics");
  assert.strictEqual(slug("!!!"), "");
});

test("no two bases can share a name, ignoring case and spacing", () => {
  assert.match(nameProblem({ name: "vinyl" }, [vinyl], false), /already a base called “Vinyl”/);
  assert.match(nameProblem({ name: "  VINYL " }, [vinyl], false), /already a base called “Vinyl”/);
  assert.strictEqual(nameProblem({ name: "Vinyl", formats: ["Vinyl"] }, [cds], true), "", "a base being edited isn't among the others");
});

test("names that would share a tag are refused", () => {
  const miniDisc = { name: "Mini Disc", formats: ["Minidisc"], tag: "mini-disc-library" };
  assert.match(nameProblem({ name: "Mini-Disc" }, [miniDisc], false), /too close to the existing base “Mini Disc”/);
});

test("a base takes at least one format, and each format belongs to one base", () => {
  assert.match(nameProblem({ name: "Minidiscs", formats: [] }, [cds], false), /Choose at least one format/);
  assert.match(nameProblem({ name: "Minidiscs", formats: ["Minidisc", "cdr"] }, [cds], false), /“CDs” already takes cdr records/, "compared ignoring capitals");
  assert.strictEqual(nameProblem({ name: "Minidiscs", formats: ["Minidisc"] }, [vinyl, cds], false), "");
});

test("a record goes to the base of its first format that has one", () => {
  const boxSets = { id: "box", name: "Box Sets", formats: ["Box Set"], tag: "box-sets-library" };
  assert.strictEqual(baseFor(["Vinyl"], [vinyl, cds]), vinyl);
  assert.strictEqual(baseFor(["cdr"], [vinyl, cds]), cds, "capitals don't matter");
  assert.strictEqual(baseFor(["Box Set", "Vinyl", "CD"], [vinyl, cds]), vinyl, "a box set without its own base follows its first format with one");
  assert.strictEqual(baseFor(["Box Set", "Vinyl"], [vinyl, cds, boxSets]), boxSets);
  assert.strictEqual(baseFor(["Cassette"], [vinyl, cds]), null, "no base: reported, never guessed");
  assert.strictEqual(baseFor([], [vinyl, cds]), null);
});

test("formats are counted per record, most common first", () => {
  const items = [{ formats: ["Vinyl"] }, { formats: ["Vinyl", "Vinyl"] }, { formats: ["Box Set", "CD"] }, { formats: ["CD"] }, { formats: ["Vinyl"] }];
  assert.deepStrictEqual(formatCounts(items), [{ name: "Vinyl", count: 3 }, { name: "CD", count: 2 }, { name: "Box Set", count: 1 }]);
});

test("names must work as file names", () => {
  assert.match(nameProblem({ name: "" }, [], false), /Give the base a name/);
  for (const bad of ["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", "a#b", "a^b", "a[b", "a]b", ".hidden"])
    assert.match(nameProblem({ name: bad }, [], false), /can't start with a dot or contain/, bad);
  assert.match(nameProblem({ name: "x".repeat(61) }, [], false), /60 characters or fewer/);
  assert.match(nameProblem({ name: "!!!" }, [], false), /at least one letter or number/);
  assert.strictEqual(nameProblem({ name: "Box Sets (2024)", formats: ["Box Set"] }, [vinyl, cds], false), "");
});

test(".base files point at the base's folder and tag, with the standard views", () => {
  const yaml = baseYaml("Music/Mini Discs", "mini-discs-library");
  assert.match(yaml, /file\.inFolder\("Music\/Mini Discs"\)/);
  assert.match(yaml, /file\.hasTag\("mini-discs-library"\)/);
  for (const view of ["Gallery", "By genre", "Catalogue", "Value", "Not ripped yet"]) assert.match(yaml, new RegExp(`name: ${view}\\n`));
  const all = allMediaYaml(["vinyl-library", "cd-library"]);
  assert.match(all, /^filters:\n  or:\n    - file\.hasTag\("vinyl-library"\)\n    - file\.hasTag\("cd-library"\)\n/);
});

test("icons follow the folder name", () => {
  assert.deepStrictEqual(["Vinyl", "LPs", "CD", "CDr", "Compact Discs", "Cassette", "Tapes", "DVD", "Blu-ray", "Box Set"].map(guessIcon),
    ["disc-3", "disc-3", "disc", "disc", "disc", "cassette-tape", "cassette-tape", "disc-2", "disc-2", "music"]);
});

test("collection pages are decoded, or rejected with a reason", () => {
  const raw = { id: 7, instance_id: 70, date_added: "2026-05-29T10:00:00-07:00", notes: [{ field_id: 1, value: "Mint (M)" }],
    basic_information: { formats: [{ name: "Box Set", qty: "1" }, { name: " Vinyl ", qty: "3" }, { qty: "1" }] } };
  assert.deepStrictEqual(decodeCollectionPage({ releases: [raw], pagination: { page: 1, pages: 2 } }), {
    items: [{ id: 7, instance: "70", added: "2026-05-29", formats: ["Box Set", "Vinyl"], notes: [{ field_id: 1, value: "Mint (M)" }] }], pages: 2 });
  assert.throws(() => decodeCollectionPage({}), /unexpected form/);
  assert.throws(() => decodeCollectionPage({ releases: [{ id: 7 }], pagination: { page: 1, pages: 1 } }), /record 1 of page 1 without its release or copy number/);
  assert.throws(() => decodeCollectionPage({ releases: [{ id: 7, instance_id: 70 }], pagination: { page: 3, pages: 3 } }), /record 1 of page 3 without its formats/);
});

test("Discogs identities are decoded, or rejected with a reason", () => {
  assert.strictEqual(decodeIdentity({ id: 1, username: "someone" }), "someone");
  for (const bad of [{}, { username: "" }, { username: 42 }, null]) assert.throws(() => decodeIdentity(bad), /which account/);
});
