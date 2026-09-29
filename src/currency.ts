// The currencies Discogs prices in, and how money is written in each. No Obsidian dependency, so it is
// tested directly. Each currency is written the way its own country writes it (its locale), so the
// dashboard reads "1 234 kr", "$1,234" or "1.234 €" whatever the computer's language.

import { isText } from "./json.ts";
import type { JsonValue } from "./json.ts";

interface CurrencyInfo { name: string; locale: string; scale: number }

const CURRENCIES = {
  USD: { name: "US dollar", locale: "en-US", scale: 0.1 },
  EUR: { name: "Euro", locale: "de-DE", scale: 0.1 },
  GBP: { name: "Pound sterling", locale: "en-GB", scale: 0.1 },
  CAD: { name: "Canadian dollar", locale: "en-CA", scale: 0.1 },
  AUD: { name: "Australian dollar", locale: "en-AU", scale: 0.1 },
  NZD: { name: "New Zealand dollar", locale: "en-NZ", scale: 0.1 },
  CHF: { name: "Swiss franc", locale: "de-CH", scale: 0.1 },
  SEK: { name: "Swedish krona", locale: "sv-SE", scale: 1 },
  JPY: { name: "Japanese yen", locale: "ja-JP", scale: 15 },
  MXN: { name: "Mexican peso", locale: "es-MX", scale: 2 },
  BRL: { name: "Brazilian real", locale: "pt-BR", scale: 0.5 },
  ZAR: { name: "South African rand", locale: "en-ZA", scale: 2 },
} satisfies Record<string, CurrencyInfo>;
const TABLE = new Map(Object.entries(CURRENCIES));
// Used until the Discogs account's currency is known, and for anything Discogs sends unlabelled.
const DEFAULT_CURRENCY = "USD";
// Notes written before 0.16 kept prices in kronor, in properties ending in _sek.
const LEGACY_CURRENCY = "SEK";

// A currency code as one of Discogs', or "" when it isn't one.
// It takes a JSON value, as codes arrive from Discogs and from notes' properties.
const currencyCode = (v: JsonValue | undefined): string => { const c = isText(v) ? v.trim().toUpperCase() : ""; return TABLE.has(c) ? c : ""; };
// DEFAULT_CURRENCY is always in the table, so the fallback is never undefined.
const info = (code: string): CurrencyInfo => TABLE.get(currencyCode(code) || DEFAULT_CURRENCY) ?? CURRENCIES.USD;

// An amount in whole units of the currency, or "—" when there is none.
function formatMoney(v: number | null | undefined, code: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const c = currencyCode(code) || DEFAULT_CURRENCY;
  return new Intl.NumberFormat(info(c).locale, { style: "currency", currency: c, maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(Math.round(v));
}
// A plain number written the currency's way ("1 000", "1,000", "1.000", "2.5"), for chart bands: whole
// numbers, except small amounts, which keep one decimal.
const formatNumber = (v: number, code: string): string => new Intl.NumberFormat(info(code).locale, { maximumFractionDigits: Math.abs(v) < 10 ? 1 : 0 }).format(v);
// The currency's symbol as its own country writes it ("kr", "$", "€"), for chart titles.
function currencySymbol(code: string): string {
  const c = currencyCode(code) || DEFAULT_CURRENCY;
  return new Intl.NumberFormat(info(c).locale, { style: "currency", currency: c }).formatToParts(0).find((p) => p.type === "currency")?.value || c;
}
// How big a "typical" amount is next to kronor, the plugin's first currency: value bands of 50–100 kr
// become $5–10 or ¥750–1,500, so the dashboard's charts spread the same way in any currency.
const currencyScale = (code: string): number => info(code).scale;

// The dropdown's choices: code → "SEK — Swedish krona".
const currencyOptions = (): Record<string, string> => Object.fromEntries(Object.entries(CURRENCIES).map(([c, { name }]) => [c, `${c} — ${name}`]));

export type { CurrencyInfo };
export { CURRENCIES, DEFAULT_CURRENCY, LEGACY_CURRENCY, currencyCode, formatMoney, formatNumber, currencySymbol, currencyScale, currencyOptions };
