// Pure logic about bases, with no Obsidian dependency, so it is tested directly.

const tidy = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
const slug = (s) => tidy(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// The .base file written for a new library: the same views as Vinyl.base, CDs.base and Tapes.base.
const baseYaml = (dir, tag) => `filters:
  and:
    - file.inFolder(${JSON.stringify(dir)})
    - file.hasTag(${JSON.stringify(tag)})
formulas:
  decade: if(note.original_year, (number(note.original_year) / 10).floor() * 10 + "s", "")
properties:
  note.artist:
    displayName: Artist
  note.title:
    displayName: Album
  note.original_year:
    displayName: Year
  note.market_lowest_sek:
    displayName: Lowest listing (kr)
  note.price_low_sek:
    displayName: Low G+ (kr)
  note.price_mid_sek:
    displayName: Mid VG+ (kr)
  note.price_high_sek:
    displayName: High NM (kr)
  note.price_my_copy_sek:
    displayName: My copy (kr)
  note.media_condition:
    displayName: Media
  note.sleeve_condition:
    displayName: Sleeve
  formula.decade:
    displayName: Decade
views:
  - type: cards
    name: Gallery
    order:
      - title
      - artist
      - original_year
      - format
      - genres
    sort:
      - property: artist
        direction: ASC
      - property: original_year
        direction: ASC
    image: note.cover
    imageFit: cover
    imageAspectRatio: 1
  - type: cards
    name: By genre
    groupBy:
      property: genres
      direction: ASC
    order:
      - title
      - artist
    image: note.cover
    imageFit: cover
    imageAspectRatio: 1
  - type: table
    name: Catalogue
    order:
      - artist
      - title
      - original_year
      - label
      - catno
      - country
      - genres
      - purchased
      - shop
      - media_condition
      - sleeve_condition
      - ripped
      - market_lowest_sek
    sort:
      - property: artist
        direction: ASC
  - type: table
    name: Value
    order:
      - artist
      - title
      - catno
      - media_condition
      - price_low_sek
      - price_mid_sek
      - price_high_sek
      - price_my_copy_sek
      - market_lowest_sek
      - market_for_sale
      - price_checked
    sort:
      - property: price_mid_sek
        direction: DESC
      - property: market_lowest_sek
        direction: DESC
  - type: cards
    name: Not ripped yet
    filters:
      and:
        - note.ripped != true
    order:
      - title
      - artist
    image: note.cover
    imageFit: cover
    imageAspectRatio: 1
`;

// All Media.base, for a vault that doesn't have one yet: every base together.
const allMediaYaml = (tags) => `filters:
  or:
${tags.map((t) => `    - file.hasTag(${JSON.stringify(t)})`).join("\n")}
properties:
  note.artist:
    displayName: Artist
  note.title:
    displayName: Album
  note.media:
    displayName: Media
  note.original_year:
    displayName: Year
  note.market_lowest_sek:
    displayName: Lowest listing (kr)
views:
  - type: cards
    name: Everything
    groupBy:
      property: media
      direction: DESC
    order:
      - title
      - artist
      - original_year
    sort:
      - property: artist
        direction: ASC
    image: note.cover
    imageFit: cover
    imageAspectRatio: 1
  - type: table
    name: All records
    order:
      - media
      - artist
      - title
      - original_year
      - genres
      - label
      - catno
      - shop
      - purchased
      - market_lowest_sek
    sort:
      - property: artist
        direction: ASC
  - type: table
    name: Most valuable
    order:
      - media
      - artist
      - title
      - market_lowest_sek
      - price_mid_sek
    sort:
      - property: market_lowest_sek
        direction: DESC
`;

// A sensible icon for a base named after a Discogs folder.
const guessIcon = (name) => {
  const n = name.toLowerCase();
  if (/cass|tape/.test(n)) return "cassette-tape";
  if (/vinyl|lp|record|7"|12"|45|78/.test(n)) return "disc-3";
  if (/\bcds?\b|compact|sacd|minidisc|\bmd\b/.test(n)) return "disc";
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
  const folder = tidy(v.discogsFolder) || name;
  const dup = others.find((l) => l.discogsFolder.toLowerCase() === folder.toLowerCase());
  if (dup) return `The base “${dup.name}” already syncs the Discogs folder “${dup.discogsFolder}”.`;
  return "";
}

module.exports = { tidy, slug, baseYaml, allMediaYaml, guessIcon, nameProblem };
