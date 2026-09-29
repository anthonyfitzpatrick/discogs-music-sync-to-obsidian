// Checks manifest.json against what the Obsidian plugin review requires (the same checks as
// eslint-plugin-obsidianmd's validate-manifest), and that the version is the same everywhere.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", f), "utf8"));
const manifest = read("manifest.json");

test("the manifest has exactly the properties Obsidian allows, of the right types", () => {
  const text = ["id", "name", "version", "minAppVersion", "description", "author"], optional = ["authorUrl", "fundingUrl"];
  for (const key of text) assert.ok(manifest[key] === String(manifest[key]) && manifest[key] !== "", `${key} is text`);
  assert.ok([true, false].includes(manifest.isDesktopOnly), "isDesktopOnly is true or false");
  for (const key of Object.keys(manifest)) assert.ok([...text, "isDesktopOnly", ...optional].includes(key), `${key} is not allowed`);
});

test("the manifest's name, ID and description follow the submission rules", () => {
  for (const key of ["id", "name", "description"]) assert.doesNotMatch(manifest[key], /obsidian|plugin/i, `${key} must not say Obsidian or plugin`);
  assert.ok(manifest.description.length <= 250, "the description is short");
  assert.match(manifest.description, /\.$/, "the description ends with a full stop");
  assert.match(manifest.id, /^[a-z0-9-]+$/);
});

test("the version is the same in the manifest, package.json, versions.json and the code", () => {
  assert.strictEqual(read("package.json").version, manifest.version);
  assert.strictEqual(read("versions.json")[manifest.version], manifest.minAppVersion);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8"), new RegExp(`const VERSION = "${manifest.version.replace(/\./g, "\\.")}";`));
});
