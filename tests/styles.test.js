// Tests styles.css for rules that are known to break Obsidian.
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const css = require("node:fs").readFileSync(path.join(__dirname, "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

test("reading view is never reordered, so a record note shows in full", () => {
  // Reading view draws a note in sections placed by where they sit on the page. Reordering them with
  // flex order left a record opened in reading view showing only its last heading, "Notes".
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel]) => /markdown-preview/.test(sel));
  for (const [, sel, body] of rules) assert.doesNotMatch(body, /\b(order|display\s*:\s*flex)\b/, sel.trim());
});
