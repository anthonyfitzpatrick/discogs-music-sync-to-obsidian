// Decoders for Discogs and Genius responses. Each checks a response once, where it arrives. The collection
// fails with a reason rather than letting a malformed reply turn into an empty list or a misplaced record;
// a release, a master or a price is read leniently, as the plugin always has: a missing field becomes an
// empty value (""/0/[]) rather than an error, since Discogs leaves out what a release doesn't have and a
// note is still worth making from what it does.

import { currencyCode } from "./currency.ts";
import { field, isNumber, isText, items, entries, texts } from "./json.ts";
import type { JsonValue } from "./json.ts";

// A positive whole number, such as a release or copy number.
const isWhole = (v: JsonValue | undefined): v is number => isNumber(v) && Number.isInteger(v) && v > 0;
// Text, or a number written as text; "" when it is neither.
const str = (v: JsonValue | undefined): string => (isText(v) ? v : isNumber(v) ? String(v) : "");
// A number, or a number written as digits; 0 when it is neither.
const whole = (v: JsonValue | undefined): number => (isNumber(v) ? v : isText(v) && /^\d+$/.test(v) ? Number(v) : 0);

// One of the user's own collection fields (media condition, sleeve condition, notes).
interface CollectionNote { field_id: number; value: string }
// One item of the collection: the release, this copy of it, when it was added, its format names
// in Discogs' order (for example ["Box Set", "Vinyl"]), and the user's own fields (conditions, notes).
interface CollectionItem { id: number; instance: string; added: string; formats: string[]; notes: CollectionNote[] }
interface CollectionPage { items: CollectionItem[]; pages: number }

const decodeNote = (v: JsonValue): CollectionNote[] => {
  const id = field(v, "field_id"), value = field(v, "value");
  return isNumber(id) && Number.isInteger(id) && isText(value) ? [{ field_id: id, value }] : [];
};

function decodeCollectionItem(raw: JsonValue, where: string): CollectionItem {
  const id = field(raw, "id"), instance = field(raw, "instance_id");
  if (!isWhole(id) || !isWhole(instance)) throw new Error(`Discogs sent ${where} without its release or copy number`);
  const formats = field(field(raw, "basic_information"), "formats");
  if (!Array.isArray(formats)) throw new Error(`Discogs sent ${where} without its formats`);
  const added = field(raw, "date_added");
  return {
    id,
    instance: String(instance),
    added: isText(added) ? added.slice(0, 10) : "",
    formats: formats.map((f) => field(f, "name")).filter(isText).map((n) => n.trim()).filter(Boolean),
    notes: items(field(raw, "notes")).flatMap(decodeNote),
  };
}

// GET users/{username}/collection/folders/0/releases?page=n → that page's items and the page count.
function decodeCollectionPage(json: JsonValue | undefined): CollectionPage {
  const releases = field(json, "releases"), pagination = field(json, "pagination");
  const pages = field(pagination, "pages"), page = field(pagination, "page");
  if (!Array.isArray(releases) || !isWhole(pages)) throw new Error("Discogs sent a collection page in an unexpected form");
  const pageName = isWhole(page) ? String(page) : "?";
  return { items: releases.map((r, i) => decodeCollectionItem(r, `record ${i + 1} of page ${pageName}`)), pages };
}

// GET oauth/identity → the username the token belongs to.
function decodeIdentity(json: JsonValue | undefined): string {
  const name = field(json, "username");
  if (!isText(name) || !name) throw new Error("Discogs didn't say which account the token belongs to");
  return name;
}

// GET users/{username} → the currency the account prices in ("SEK"), or "" when Discogs doesn't say
// or names one the plugin doesn't know.
function decodeProfileCurrency(json: JsonValue | undefined): string { return currencyCode(field(json, "curr_abbr")); }

// A money amount as Discogs writes it in text ("SEK10,742.13", "$1,234.56", "€99.00") → 10742.13, or null.
function decodeMoneyText(v: JsonValue | undefined): number | null {
  if (!isText(v)) return null;
  const n = parseFloat(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/* ---- releases, masters, prices and Genius ---- */

interface DiscogsArtist { name: string; anv: string; join: string }
interface DiscogsTrack { position: string; title: string; duration: string; type_: string; artists: DiscogsArtist[]; sub_tracks: DiscogsTrack[] }
interface DiscogsLabel { name: string; catno: string }
interface DiscogsFormat { name: string; qty: string; descriptions: string[] }
interface DiscogsImage { type: string; uri: string }
interface DiscogsRelease {
  id: number; title: string; year: number; master_id: number; uri: string; country: string;
  artists: DiscogsArtist[]; labels: DiscogsLabel[]; formats: DiscogsFormat[];
  genres: string[]; styles: string[]; images: DiscogsImage[]; tracklist: DiscogsTrack[];
}
interface DiscogsMaster { year: number; main_release: number; tracklist: DiscogsTrack[] }
// GET marketplace/stats/{id}: the cheapest listing's price (null when none), and how many are for sale.
interface MarketStats { lowest: number | null; forSale: number | null }
// One Genius search hit.
interface GeniusHit { type: string; title: string; url: string; primaryArtist: string; featuredArtists: string[] }
// Discogs' own value of the collection: its low, median and high estimates.
interface ValueEstimates { min: number | null; med: number | null; max: number | null }

const decodeArtist = (v: JsonValue): DiscogsArtist => ({ name: str(field(v, "name")), anv: str(field(v, "anv")), join: str(field(v, "join")) });
const decodeTrack = (v: JsonValue): DiscogsTrack => ({
  position: str(field(v, "position")), title: str(field(v, "title")), duration: str(field(v, "duration")), type_: str(field(v, "type_")),
  artists: items(field(v, "artists")).map(decodeArtist), sub_tracks: items(field(v, "sub_tracks")).map(decodeTrack),
});

// GET releases/{id}
function decodeRelease(json: JsonValue | undefined): DiscogsRelease {
  return {
    id: whole(field(json, "id")), title: str(field(json, "title")), year: whole(field(json, "year")), master_id: whole(field(json, "master_id")),
    uri: str(field(json, "uri")), country: str(field(json, "country")),
    artists: items(field(json, "artists")).map(decodeArtist),
    labels: items(field(json, "labels")).map((l) => ({ name: str(field(l, "name")), catno: str(field(l, "catno")) })),
    formats: items(field(json, "formats")).map((f) => ({ name: str(field(f, "name")), qty: str(field(f, "qty")), descriptions: texts(field(f, "descriptions")) })),
    genres: texts(field(json, "genres")), styles: texts(field(json, "styles")),
    images: items(field(json, "images")).map((i) => ({ type: str(field(i, "type")), uri: str(field(i, "uri")) })),
    tracklist: items(field(json, "tracklist")).map(decodeTrack),
  };
}

// GET masters/{id}
function decodeMaster(json: JsonValue | undefined): DiscogsMaster {
  return { year: whole(field(json, "year")), main_release: whole(field(json, "main_release")), tracklist: items(field(json, "tracklist")).map(decodeTrack) };
}

// A price as Discogs sends it ({ value, currency }), or null.
const priceValue = (v: JsonValue | undefined): number | null => { const n = field(v, "value"); return isNumber(n) ? n : null; };

function decodeMarketStats(json: JsonValue | undefined): MarketStats {
  const n = field(json, "num_for_sale");
  return { lowest: priceValue(field(json, "lowest_price")), forSale: isNumber(n) ? n : null };
}

// GET marketplace/price_suggestions/{id} → grade ("Very Good Plus (VG+)") → suggested price.
function decodePriceSuggestions(json: JsonValue | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const [grade, v] of entries(json)) { const p = priceValue(v); if (p !== null) out.set(grade, p); }
  return out;
}

// GET users/{username}/collection/fields → field id → its name ("Media Condition", "Notes").
function decodeCollectionFields(json: JsonValue | undefined): Map<number, string> {
  return new Map(items(field(json, "fields")).map((f): [number, string] => [whole(field(f, "id")), str(field(f, "name"))]));
}

// GET users/{username}/collection/value → the collection's value in text ("SEK10,742.13") per estimate.
function decodeCollectionValueText(json: JsonValue | undefined): ValueEstimates {
  return { min: decodeMoneyText(field(json, "minimum")), med: decodeMoneyText(field(json, "median")), max: decodeMoneyText(field(json, "maximum")) };
}

// GET https://api.genius.com/search → its hits.
function decodeGeniusHits(json: JsonValue | undefined): GeniusHit[] {
  return items(field(field(json, "response"), "hits")).map((h) => {
    const r = field(h, "result");
    return { type: str(field(h, "type")), title: str(field(r, "title")), url: str(field(r, "url")),
      primaryArtist: str(field(field(r, "primary_artist"), "name")),
      featuredArtists: items(field(r, "featured_artists")).map((a) => str(field(a, "name"))) };
  });
}

export type { CollectionItem, CollectionNote, CollectionPage, DiscogsArtist, DiscogsTrack, DiscogsRelease, DiscogsMaster, MarketStats, GeniusHit, ValueEstimates };
export { decodeCollectionPage, decodeIdentity, decodeProfileCurrency, decodeMoneyText,
  decodeRelease, decodeMaster, decodeMarketStats, decodePriceSuggestions, decodeCollectionFields, decodeCollectionValueText, decodeGeniusHits };
