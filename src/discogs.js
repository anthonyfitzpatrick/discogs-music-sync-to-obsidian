// Decoders for Discogs responses. Each checks a response once, where it arrives, and fails with a
// reason instead of letting a malformed reply turn into an empty list or a misplaced record.

const isText = (v) => v === String(v);
const isWhole = (v) => Number.isInteger(v) && v > 0;

// One item of the collection: the release, this copy of it, when it was added, its format names
// in Discogs' order (for example ["Box Set", "Vinyl"]), and the user's own fields (conditions, notes).
function decodeCollectionItem(raw, where) {
  if (!isWhole(raw?.id) || !isWhole(raw?.instance_id)) throw new Error(`Discogs sent ${where} without its release or copy number`);
  const formats = raw.basic_information?.formats;
  if (!Array.isArray(formats)) throw new Error(`Discogs sent ${where} without its formats`);
  return {
    id: raw.id,
    instance: String(raw.instance_id),
    added: isText(raw.date_added) ? raw.date_added.slice(0, 10) : "",
    formats: formats.map((f) => f?.name).filter((n) => isText(n) && n.trim()).map((n) => n.trim()),
    notes: Array.isArray(raw.notes) ? raw.notes : [],
  };
}

// GET users/{username}/collection/folders/0/releases?page=n → that page's items and the page count.
function decodeCollectionPage(json) {
  if (!Array.isArray(json?.releases) || !isWhole(json?.pagination?.pages)) throw new Error("Discogs sent a collection page in an unexpected form");
  return { items: json.releases.map((r, i) => decodeCollectionItem(r, `record ${i + 1} of page ${json.pagination.page ?? "?"}`)), pages: json.pagination.pages };
}

// GET oauth/identity → the username the token belongs to.
function decodeIdentity(json) {
  const name = json?.username;
  if (!isText(name) || !name) throw new Error("Discogs didn't say which account the token belongs to");
  return name;
}

export { decodeCollectionPage, decodeIdentity };
