// Tests the pure logic in src/bases.js and src/discogs.js directly: no Obsidian stand-in needed.
const { test } = require("node:test");
const assert = require("node:assert");
const { tidy, slug, baseYaml, allMediaYaml, guessIcon, nameProblem } = require("../src/bases.js");
const { decodeFolderNames, decodeIdentity } = require("../src/discogs.js");

const vinyl = { name: "Vinyl", discogsFolder: "Vinyl", tag: "vinyl-library" };
const cds = { name: "CDs", discogsFolder: "CD", tag: "cd-library" };

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
  assert.strictEqual(nameProblem({ name: "Vinyl" }, [cds], true), "", "a base being edited isn't among the others");
});

test("names that would share a tag are refused", () => {
  const miniDisc = { name: "Mini Disc", discogsFolder: "MD", tag: "mini-disc-library" };
  assert.match(nameProblem({ name: "Mini-Disc" }, [miniDisc], false), /too close to the existing base “Mini Disc”/);
});

test("each Discogs folder feeds one base", () => {
  assert.match(nameProblem({ name: "Minidiscs", discogsFolder: "cd" }, [cds], false), /“CDs” already syncs the Discogs folder “CD”/);
  assert.match(nameProblem({ name: "cd", discogsFolder: "" }, [{ ...cds, name: "Compact", tag: "compact-library" }], false), /already syncs/, "an empty folder means the name");
});

test("names must work as file names", () => {
  assert.match(nameProblem({ name: "" }, [], false), /Give the base a name/);
  for (const bad of ["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", "a#b", "a^b", "a[b", "a]b", ".hidden"])
    assert.match(nameProblem({ name: bad }, [], false), /can't start with a dot or contain/, bad);
  assert.match(nameProblem({ name: "x".repeat(61) }, [], false), /60 characters or fewer/);
  assert.match(nameProblem({ name: "!!!" }, [], false), /at least one letter or number/);
  assert.strictEqual(nameProblem({ name: "Box Sets (2024)" }, [vinyl, cds], false), "");
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
  assert.deepStrictEqual(["Vinyl", "LPs", "CD", "Compact Discs", "Cassette", "Tapes", "DVD", "Box Sets"].map(guessIcon),
    ["disc-3", "disc-3", "disc", "disc", "cassette-tape", "cassette-tape", "disc-2", "music"]);
});

test("Discogs folder lists are decoded, or rejected with a reason", () => {
  assert.deepStrictEqual(decodeFolderNames({ folders: [{ id: 0, name: "All" }, { id: 1, name: "Vinyl" }] }), ["All", "Vinyl"]);
  assert.throws(() => decodeFolderNames({}), /unexpected form/);
  assert.throws(() => decodeFolderNames(null), /unexpected form/);
  assert.throws(() => decodeFolderNames({ folders: [{ name: "Vinyl" }, { id: 7 }] }), /folder 2 without a name/);
});

test("Discogs identities are decoded, or rejected with a reason", () => {
  assert.strictEqual(decodeIdentity({ id: 1, username: "someone" }), "someone");
  for (const bad of [{}, { username: "" }, { username: 42 }, null]) assert.throws(() => decodeIdentity(bad), /which account/);
});
