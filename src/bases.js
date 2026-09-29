// Pure logic about bases, with no Obsidian dependency, so it is tested directly.

const tidy = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
const slug = (s) => tidy(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// A sensible icon for a base named after a Discogs format.
const guessIcon = (name) => {
  const n = name.toLowerCase();
  if (/cass|tape/.test(n)) return "cassette-tape";
  if (/vinyl|lp|record|7"|12"|45|78/.test(n)) return "disc-3";
  if (/\bcd(s|r)?\b|compact|sacd|minidisc|\bmd\b/.test(n)) return "disc";
  if (/dvd|blu|video/.test(n)) return "disc-2";
  return "music";
};

// Why a proposed base can't be used, judged against the other bases (not the one being edited),
// or "" when it can. Checks against files in the vault are made by the caller.
// No two bases may share a name, ignoring case and spacing.
function nameProblem(v, others, editing) {
  const name = tidy(v.name), s = slug(name);
  if (!name) return "Give the base a name.";
  if (/[\\/:*?"<>|#^[\]]/.test(name) || name.startsWith(".")) return "A name can't start with a dot or contain \\ / : * ? \" < > | # ^ [ ]";
  if (name.length > 60) return "Keep the name to 60 characters or fewer.";
  if (!s) return "The name needs at least one letter or number.";
  const same = others.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (same) return `There's already a base called “${same.name}”. Pick a different name.`;
  const close = others.find((l) => slug(l.name) === s || (!editing && l.tag === `${s}-library`));
  if (close) return `“${name}” is too close to the existing base “${close.name}”. Pick a different name.`;
  if (!v.formats?.length) return "Choose at least one format for the base.";
  for (const f of v.formats) {
    const taken = others.find((l) => l.formats.some((g) => sameFormat(g, f)));
    if (taken) return `The base “${taken.name}” already takes ${f} records.`;
  }
  return "";
}

// Format names are compared as Discogs spells them, ignoring only capitals and spacing.
const sameFormat = (a, b) => tidy(a).toLowerCase() === tidy(b).toLowerCase();

// The base for a record: the first of its formats, in Discogs' order, that a base takes. A box set
// listed as ["Box Set", "Vinyl"] goes to the Vinyl base unless a base takes Box Set. null if none.
function baseFor(formats, libs) {
  for (const f of formats) {
    const lib = libs.find((l) => l.formats.some((g) => sameFormat(g, f)));
    if (lib) return lib;
  }
  return null;
}

// Discogs' wrappers around the media inside them: a box set of LPs is listed "Box Set; 4x Vinyl".
const CONTAINERS = new Set(["box set", "all media"]);

// The formats that need a base of their own so that every record has a place, most records first.
// For each record no base takes: its first format that isn't a wrapper (a wrapper only when that is
// all it has), unless the user stopped syncing that format.
function basesNeeded(items, libs, skipped = []) {
  const counts = new Map();
  for (const item of items) {
    if (baseFor(item.formats, libs)) continue;
    const f = item.formats.find((x) => !CONTAINERS.has(tidy(x).toLowerCase())) ?? item.formats[0];
    if (!f || skipped.some((x) => sameFormat(x, f))) continue;
    const key = [...counts.keys()].find((k) => sameFormat(k, f)) ?? tidy(f);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f]) => f);
}

// How many records include each format, most common first: what Set up and the base dialog offer.
function formatCounts(items) {
  const counts = new Map();
  for (const item of items) for (const f of new Set(item.formats)) counts.set(f, (counts.get(f) || 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export { tidy, slug, guessIcon, nameProblem, baseFor, formatCounts, basesNeeded, sameFormat, CONTAINERS };
