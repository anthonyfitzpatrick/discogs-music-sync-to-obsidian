// The Music Dashboard: its figures, its SVG charts and its layout, shared by the dashboard view and
// the PDF export. It needs no other plugin: records are decoded here from each note's frontmatter and
// tracklist, the figures are computed here, and the charts are drawn here. Nothing in this file
// touches Obsidian, so it is tested directly.

/* ------------------------------------------------------------------ decoding */

// A frontmatter value as a finite number, or null.
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v) => (v === null || v === undefined ? "" : String(v).trim());
const list = (v) => [].concat(v ?? []).map(text).filter(Boolean);
const day = (v) => text(v).slice(0, 10);

// Track count and playing time from the note's tracklist table (| # | Title | Length | Lyrics |).
function tracklist(body) {
  const rows = (String(body).match(/^\| ([^|]*) \| (.*?) \| ([^|]*) \| (.*) \|$/gm) || []).map((l) => l.split(" | "))
    .filter((c) => c[0] !== "| #" && !c[0].startsWith("|---") && !c[1].startsWith("**"));
  const secs = rows.reduce((a, c) => { const m = c[2].trim().match(/^(\d+):(\d\d)$/); return a + (m ? +m[1] * 60 + +m[2] : 0); }, 0);
  return { tracks: rows.length, secs };
}

// Discogs' wrappers around the media inside them: a box set of LPs is listed "Box Set; 4x Vinyl".
const CONTAINERS = new Set(["box set", "all media"]);
// A record's format, as Discogs reports it: the first in its format property ("1x Box Set,
// Compilation; 4x Vinyl, LP") that isn't a wrapper, else its media property, else "Unknown".
function primaryFormat(format, media) {
  const names = text(format).split(";").map((part) => part.trim().replace(/^\d+\s*x\s*/i, "").split(",")[0].trim()).filter(Boolean);
  return names.find((n) => !CONTAINERS.has(n.toLowerCase())) || text(media) || "Unknown";
}

// A cover property ("[[123.jpeg]]") as the linked file's name.
const linkTarget = (v) => text(v).replace(/^\[\[|\]\]$/g, "").split("|")[0];

// One record note: its frontmatter, the name of the base it belongs to, its text and its path.
function decodeRecord(fm, media, body, fallbackTitle, path = "") {
  return {
    path, title: text(fm.title) || fallbackTitle, artist: text(fm.artist), media,
    label: text(fm.label), catno: text(fm.catno), country: text(fm.country), format: text(fm.format), cover: linkTarget(fm.cover),
    discogsFormat: primaryFormat(fm.format, fm.media),
    mediaCondition: text(fm.media_condition), sleeveCondition: text(fm.sleeve_condition),
    purchased: day(fm.purchased), forSale: num(fm.market_for_sale), myCopy: num(fm.price_my_copy_sek), checked: day(fm.price_checked),
    releaseYear: num(fm.year), originalYear: num(fm.original_year),
    compilation: /\bcompilation\b/i.test(text(fm.format)),
    // Only what Discogs calls the pressing: a later year alone is often a first pressing in another country.
    reissue: /\b(reissue|repress|remaster(ed)?)\b/i.test(text(fm.format)),
    low: num(fm.price_low_sek), mid: num(fm.price_mid_sek), high: num(fm.price_high_sek),
    max: num(fm.price_max_sek) ?? num(fm.price_high_sek), list: num(fm.market_lowest_sek),
    year: num(fm.original_year) || num(fm.year), added: day(fm.purchased) || day(fm.added_to_discogs),
    genres: list(fm.genres), styles: list(fm.styles), shop: text(fm.shop),
    listened: fm.listened === true,
    ...tracklist(body),
  };
}

// Music/.vinyl-sync/collection-value.json → Discogs' own value of the collection.
function decodeCollectionValue(json) {
  return { min: num(json?.discogs_value_min), med: num(json?.discogs_value_median), max: num(json?.discogs_value_max) };
}

/* ------------------------------------------------------------------ colours */

const hex = (a) => "#" + a.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
// A computed CSS colour ("rgb(…)", "rgba(…)" or "color(srgb …)") as #rrggbb.
function cssColorToHex(css, fallback) {
  const s = text(css), n = (s.match(/[\d.]+/g) || []).map(Number);
  if (n.length < 3) return fallback;
  return hex(s.startsWith("color(") ? n.slice(0, 3).map((v) => v * 255) : n.slice(0, 3));
}
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => { const y = rgb(b); return hex(rgb(a).map((v, i) => v * t + y[i] * (1 - t))); };
const lum = (h) => { const [r, g, b] = rgb(h).map((c) => c / 255).map((c) => (c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)); return .2126 * r + .7152 * g + .0722 * b; };

const hsl2hex = (h, sat, l) => {
  const S = sat / 100, L = l / 100, k = (n) => (n + h / 30) % 12, A = S * Math.min(L, 1 - L);
  return hex([0, 8, 4].map((n) => 255 * (L - A * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))));
};
const hexToHsl = (h) => {
  const [r, g, b] = rgb(h).map((c) => c / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l * 100];
  const sat = d / (1 - Math.abs(2 * l - 1));
  const hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hue * 60 + 360) % 360, sat * 100, l * 100];
};
// Evenly spread over the given stops, strongest at the end.
const along = (stops, n) => Array.from({ length: n }, (_, i) => {
  const t = n < 2 ? 1 : i / (n - 1), x = t * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x));
  return mix(stops[k + 1], stops[k], x - k);
});

// The colour modes. Text, lines and backgrounds always come from the theme; these colour the data.
const COLOUR_MODES = { theme: "Theme", full: "Full colour", custom: "Custom" };
// Full colour: the plugin's original palette.
const FULL_BASES = ["#7c3aed", "#db2777", "#f59e0b", "#0ea5e9", "#10b981", "#ef4444", "#6366f1", "#84cc16"];
const FULL_SCALE = ["#c4b5fd", "#a78bfa", "#8b5cf6", "#7c3aed", "#db2777", "#f97316", "#f59e0b"];
const DEFAULT_ACCENT = "#7c3aed";

// The colours for a report. theme: { fg, bg, muted, border }. colours: { mode, bases: [hex per base], accent }.
//   bases(n)    one colour per base
//   distinct(n) n colours for the parts of one chart, neighbours never alike
//   scale(n)    n colours from faint to strong, for value bands
//   ink(fill)   text that reads on a fill
function palette(theme, colours = {}) {
  const mode = COLOUR_MODES[colours.mode] ? colours.mode : "theme";
  const shade = (t) => mix(theme.fg, theme.bg, t);
  const ramp = (n) => Array.from({ length: n }, (_, i) => shade(n < 2 ? 1 : 1 - 0.7 * i / (n - 1)));
  const interleave = (r) => { const h = Math.ceil(r.length / 2); return r.map((_, i) => r[i % 2 ? h + (i >> 1) : i >> 1]); };
  if (mode === "theme") {
    return { ...theme, mode, bases: ramp, distinct: (n) => interleave(ramp(n)), scale: (n) => ramp(n).reverse(),
      ink: (fill) => (Math.abs(lum(fill) - lum(theme.fg)) > Math.abs(lum(fill) - lum(theme.bg)) ? theme.fg : theme.bg) };
  }
  const ink = (fill) => (lum(fill) > 0.35 ? "#111827" : "#ffffff");
  if (mode === "full") {
    return { ...theme, mode, ink, bases: (n) => Array.from({ length: n }, (_, i) => FULL_BASES[i % FULL_BASES.length]),
      distinct: (n) => Array.from({ length: n }, (_, i) => hsl2hex((265 + i * 360 / n) % 360, 68, i % 2 ? 62 : 46)),
      scale: (n) => (n === FULL_SCALE.length ? [...FULL_SCALE] : along(FULL_SCALE, n)) };
  }
  const accent = /^#[0-9a-f]{6}$/i.test(colours.accent || "") ? colours.accent : DEFAULT_ACCENT;
  const [h0, s0, l0] = hexToHsl(accent);
  return { ...theme, mode, ink,
    bases: (n) => Array.from({ length: n }, (_, i) => (/^#[0-9a-f]{6}$/i.test(colours.bases?.[i] || "") ? colours.bases[i] : FULL_BASES[i % FULL_BASES.length])),
    distinct: (n) => Array.from({ length: n }, (_, i) => hsl2hex((h0 + i * 360 / n) % 360, Math.max(35, s0), Math.min(70, Math.max(30, l0 + (i % 2 ? 10 : -6))))),
    scale: (n) => Array.from({ length: n }, (_, i) => mix(accent, theme.bg, n < 2 ? 1 : 0.3 + 0.7 * i / (n - 1))) };
}

/* ------------------------------------------------------------------ formatting */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const kr = (v) => (v === null || v === undefined ? "—" : `${Math.round(v).toLocaleString("sv-SE")} kr`);
const int = (v) => Math.round(v).toLocaleString("sv-SE");
const pct = (v) => (v < 0.01 ? "<1%" : `${Math.round(v * 100)}%`);
const sum = (arr, k) => arr.reduce((a, r) => a + (r[k] || 0), 0);
const count = (arr) => { const m = new Map(); arr.forEach((x) => m.set(x, (m.get(x) || 0) + 1)); return [...m].sort((a, b) => b[1] - a[1]); };
// A round axis step; never below 1, as every axis counts records, hours or kronor.
const niceStep = (max, n) => { const raw = Math.max(max, 1) / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p; return Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p); };

/* ------------------------------------------------------------------ SVG charts */

const W = 640;   // doughnuts are drawn 640 units wide and scale to their box

// Bars, vertical or horizontal, one colour per series or one per bar; stacked when there are several series.
// width: 640 for a chart in a two-column grid, 1000 for one across the page, so text keeps one size.
function barChart(P, { labels, series, horizontal = false, height = 260, width = 640, xTitle = "", yTitle = "" }) {
  const fmt = int;
  const legend = series.length > 1;
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const max = Math.max(1, ...totals), step = niceStep(max, 4), top = Math.ceil(max / step) * step;
  const longest = Math.max(0, ...labels.map((l) => String(l).length));
  const tickWidth = fmt(top).length * 6.6;                     // the widest value label on the axis
  const rotate = !horizontal && (width - tickWidth - 60) / Math.max(1, labels.length) < 46;   // month labels and the like
  const m = { top: legend ? 30 : 12, right: 16, bottom: horizontal ? 36 : rotate ? 78 : 48,
    left: horizontal ? Math.min(210, 18 + longest * 6.2) : 14 + tickWidth + (yTitle ? 22 : 0) };
  const pw = width - m.left - m.right, ph = height - m.top - m.bottom;
  const out = [`<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" font-size="11" fill="${P.fg}">`];
  if (legend) {
    let x = m.left;
    for (const s of series) { out.push(`<rect x="${x}" y="8" width="11" height="11" fill="${s.color}"/><text x="${x + 16}" y="17">${esc(s.name)}</text>`); x += 28 + s.name.length * 6.5; }
  }
  for (let v = 0; v <= top + 1e-9; v += step) {
    const at = horizontal ? m.left + (v / top) * pw : m.top + ph - (v / top) * ph;
    out.push(horizontal
      ? `<line x1="${at}" y1="${m.top}" x2="${at}" y2="${m.top + ph}" stroke="${P.border}"/><text x="${at}" y="${m.top + ph + 14}" text-anchor="middle">${fmt(v)}</text>`
      : `<line x1="${m.left}" y1="${at}" x2="${m.left + pw}" y2="${at}" stroke="${P.border}"/><text x="${m.left - 6}" y="${at + 4}" text-anchor="end">${fmt(v)}</text>`);
  }
  const band = (horizontal ? ph : pw) / Math.max(1, labels.length), thick = band * 0.7;
  labels.forEach((label, i) => {
    let from = 0;
    for (const s of series) {
      const v = s.values[i] || 0; if (!v) continue;
      const fill = s.colors ? s.colors[i % s.colors.length] : s.color;
      if (horizontal) {
        const y = m.top + i * band + (band - thick) / 2, x = m.left + (from / top) * pw, w = (v / top) * pw;
        out.push(`<rect x="${x}" y="${y}" width="${w}" height="${thick}" fill="${fill}"/>`);
      } else {
        const x = m.left + i * band + (band - thick) / 2, h = (v / top) * ph, y = m.top + ph - (from / top) * ph - h;
        out.push(`<rect x="${x}" y="${y}" width="${thick}" height="${h}" fill="${fill}"/>`);
      }
      from += v;
    }
    if (horizontal) out.push(`<text x="${m.left - 6}" y="${m.top + i * band + band / 2 + 4}" text-anchor="end">${esc(label)}</text>`);
    else {
      const x = m.left + i * band + band / 2, y = m.top + ph + 14;
      out.push(rotate ? `<text x="${x}" y="${y}" text-anchor="end" transform="rotate(-40 ${x} ${y})">${esc(label)}</text>` : `<text x="${x}" y="${y}" text-anchor="middle">${esc(label)}</text>`);
    }
  });
  if (xTitle) out.push(`<text x="${m.left + pw / 2}" y="${height - 4}" text-anchor="middle" font-weight="600">${esc(xTitle)}</text>`);
  if (yTitle) out.push(`<text x="12" y="${m.top + ph / 2}" text-anchor="middle" font-weight="600" transform="rotate(-90 12 ${m.top + ph / 2})">${esc(yTitle)}</text>`);
  out.push("</svg>");
  return out.join("");
}

// A doughnut with percentages on the larger slices and a legend beside it.
function doughnut(P, labels, values, colors) {
  const total = values.reduce((a, b) => a + b, 0), cx = 150, cy = 130, r = 110, ri = 55, height = Math.max(260, 24 + labels.length * 20);
  const out = [`<svg viewBox="0 0 ${W} ${height}" xmlns="http://www.w3.org/2000/svg" font-size="12" fill="${P.fg}">`];
  if (!total) { out.push(`<text x="${cx}" y="${cy}" text-anchor="middle">No records</text></svg>`); return out.join(""); }
  let a0 = -Math.PI / 2;
  values.forEach((v, i) => {
    if (!v) return;
    const a1 = a0 + (v / total) * Math.PI * 2, big = a1 - a0 > Math.PI ? 1 : 0, c = colors[i % colors.length];
    const p = (rad, a) => `${cx + rad * Math.cos(a)} ${cy + rad * Math.sin(a)}`;
    out.push(v === total
      ? `<circle cx="${cx}" cy="${cy}" r="${(r + ri) / 2}" fill="none" stroke="${c}" stroke-width="${r - ri}"/>`
      : `<path d="M ${p(r, a0)} A ${r} ${r} 0 ${big} 1 ${p(r, a1)} L ${p(ri, a1)} A ${ri} ${ri} 0 ${big} 0 ${p(ri, a0)} Z" fill="${c}" stroke="${P.bg}" stroke-width="2"/>`);
    if (v / total >= 0.07) { const mid = (a0 + a1) / 2, rm = (r + ri) / 2; out.push(`<text x="${cx + rm * Math.cos(mid)}" y="${cy + rm * Math.sin(mid) + 4}" text-anchor="middle" font-weight="600" fill="${P.ink(c)}">${pct(v / total)}</text>`); }
    a0 = a1;
  });
  labels.forEach((l, i) => out.push(`<rect x="300" y="${14 + i * 20}" width="12" height="12" fill="${colors[i % colors.length]}"/><text x="320" y="${24 + i * 20}">${esc(l)} — ${pct(values[i] / total)} (${int(values[i])})</text>`));
  out.push("</svg>");
  return out.join("");
}

// Lines over time: one per series, values may be null (a gap). Labels are thinned to fit.
function lineChart(P, { labels, series, height = 260, width = 1000, xTitle = "", yTitle = "", money = false }) {
  const fmt = money ? (v) => `${int(v)}` : int;
  const legend = series.length > 1;
  const all = series.flatMap((s) => s.values).filter((v) => v !== null);
  const max = Math.max(1, ...all), step = niceStep(max, 4), top = Math.ceil(max / step) * step;
  const tickWidth = fmt(top).length * 6.6;
  const m = { top: legend ? 30 : 12, right: 12 + String(labels[labels.length - 1] ?? "").length * 3.4, bottom: xTitle ? 44 : 30, left: 14 + tickWidth + (yTitle ? 22 : 0) };
  const pw = width - m.left - m.right, ph = height - m.top - m.bottom;
  const x = (i) => m.left + (labels.length < 2 ? pw / 2 : (i / (labels.length - 1)) * pw), y = (v) => m.top + ph - (v / top) * ph;
  const out = [`<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" font-size="11" fill="${P.fg}">`];
  if (legend) {
    let lx = m.left;
    for (const s of series) { out.push(`<rect x="${lx}" y="8" width="11" height="11" fill="${s.color}"/><text x="${lx + 16}" y="17">${esc(s.name)}</text>`); lx += 28 + s.name.length * 6.5; }
  }
  for (let v = 0; v <= top + 1e-9; v += step) out.push(`<line x1="${m.left}" y1="${y(v)}" x2="${m.left + pw}" y2="${y(v)}" stroke="${P.border}"/><text x="${m.left - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`);
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(pw / 70))));
  const last = labels.length - 1;
  labels.forEach((l, i) => { if (i === last || (i % every === 0 && last - i >= every)) out.push(`<text x="${x(i)}" y="${m.top + ph + 16}" text-anchor="middle">${esc(l)}</text>`); });
  for (const s of series) {
    let d = "", drawing = false;
    s.values.forEach((v, i) => {
      if (v === null) { drawing = false; return; }
      d += `${drawing ? "L" : "M"}${x(i)},${y(v)} `; drawing = true;
    });
    out.push(`<path d="${d.trim()}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2.5}" stroke-linejoin="round" stroke-linecap="round"/>`);
    if (labels.length <= 24) s.values.forEach((v, i) => { if (v !== null) out.push(`<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${s.color}"/>`); });
  }
  if (xTitle) out.push(`<text x="${m.left + pw / 2}" y="${height - 4}" text-anchor="middle" font-weight="600">${esc(xTitle)}</text>`);
  if (yTitle) out.push(`<text x="12" y="${m.top + ph / 2}" text-anchor="middle" font-weight="600" transform="rotate(-90 12 ${m.top + ph / 2})">${esc(yTitle)}</text>`);
  out.push("</svg>");
  return out.join("");
}

/* ------------------------------------------------------------------ the page */

function table(headers, rows, numeric = [], totalRow = false) {
  const cell = (tag, v, i) => `<${tag}${numeric.includes(i) ? ' class="num"' : ""}>${v}</${tag}>`;
  const body = rows.map((r, k) => `<tr${totalRow && k === rows.length - 1 ? ' class="total"' : ""}>${r.map((v, i) => cell("td", v, i)).join("")}</tr>`).join("");
  return `<table><thead><tr>${headers.map((h, i) => cell("th", esc(h), i)).join("")}</tr></thead><tbody>${body}</tbody></table>`;
}
const card = (title, inner) => `<div class="card">${title ? `<div class="card-title">${esc(title)}</div>` : ""}${inner}</div>`;
const section = (title, sub, inner) => `<section><h2>${esc(title)}</h2>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}${inner}</section>`;
const grid = (...cards) => `<div class="grid">${cards.join("")}</div>`;

// The dashboard's sections, in order, with the names settings show. Each can be turned off there.
const SECTIONS = [
  ["overview", "Overview"], ["growth", "Growth over time"], ["value", "Value spread"], ["market", "Market"],
  ["contents", "What's in the collection"], ["pressings", "Pressings"], ["decades", "By decade"], ["artists", "Top artists"],
  ["playing", "Playing time"], ["buying", "Buying"], ["listening", "Listening"],
  ["condition", "Condition"], ["attention", "Needs attention"],
];
// Discogs' grading scale, best first, for the condition report.
const GRADES = ["Mint (M)", "Near Mint (NM or M-)", "Very Good Plus (VG+)", "Very Good (VG)", "Good Plus (G+)", "Good (G)", "Fair (F)", "Poor (P)", "Generic", "No Cover", "Not Graded"];
const minutes = (secs) => `${Math.round(secs / 60)} min`;
const monthsBetween = (from, to) => {
  const out = []; let [y, m] = from.split("-").map(Number); const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
};

// The dashboard's sections and their styles, scoped to .mls-report so they can sit inside Obsidian.
// records: decoded with decodeRecord. media: the bases' names in order. value: decodeCollectionValue.
// theme: { fg, bg, muted, border, font } as hex colours and a font stack. interactive: album titles
// become links (data-path) and new records get a Listened checkbox, for the dashboard view.
// options: { sections: { key: false } to leave one out, colours: { mode, bases, accent },
//            history: [{ date, min, med, max }] Discogs' value of the collection at each sync }.
function reportParts(records, media, value, theme, interactive, options = {}) {
  const P = palette(theme, options.colours);
  const on = (key) => options.sections?.[key] !== false;
  const album = (r) => (interactive && r.path ? `<a class="mls-open" data-path="${esc(r.path)}">${esc(r.title)}</a>` : esc(r.title));
  const listenBox = (r) => `<input type="checkbox" class="mls-listen" data-path="${esc(r.path)}" aria-label="Mark ${esc(r.title)} as listened to">`;
  const baseColours = P.bases(media.length);
  const MC = Object.fromEntries(media.map((m, i) => [m, baseColours[i]]));
  const recs = records.filter((r) => media.includes(r.media));
  const pill = (m) => `<span class="pill" style="background:${MC[m]};color:${P.ink(MC[m])}">${esc(m)}</span>`;
  const note = (t) => `<p class="note">${esc(t)}</p>`;
  const haveSugg = recs.some((r) => r.mid !== null);
  const VK = haveSugg ? "mid" : "list";                           // the value a record is ranked by
  const valueLabel = haveSugg ? "Value (VG+)" : "Value (cheapest listing)";

  const build = {
    overview() {
      const highest = (g, isTotal) => (g.some((r) => r.max !== null) ? kr(sum(g, "max")) : isTotal && value.max !== null ? `${kr(value.max)} *` : "—");
      const ovRow = (label, g, isTotal) => [esc(label), int(g.length), int(sum(g, "tracks")), `${Math.round(sum(g, "secs") / 3600)} h`,
        kr(sum(g, "list")), highest(g, isTotal)];
      return section("Overview", `${recs.length} records in ${media.length} base${media.length === 1 ? "" : "s"}: ${media.join(", ")}`,
        card("", table(["Media", "Records", "Tracks", "Playing time", "Lowest listings", "Highest"],
          [...media.map((m) => ovRow(m, recs.filter((r) => r.media === m))), ovRow("Total", recs, true)], [1, 2, 3, 4, 5], true)));
    },

    growth() {
      const dated = recs.filter((r) => r.added);
      let owned = note("No record has a purchase date or a Discogs date added yet.");
      if (dated.length) {
        const months = monthsBetween(dated.map((r) => r.added.slice(0, 7)).sort()[0], dated.map((r) => r.added.slice(0, 7)).sort().pop());
        const upTo = (g, mo) => g.filter((r) => r.added && r.added.slice(0, 7) <= mo).length;
        owned = lineChart(P, { labels: months, yTitle: "Records owned", series: [
          ...(media.length > 1 ? media.map((m) => ({ name: m, color: MC[m], values: months.map((mo) => upTo(recs.filter((r) => r.media === m), mo)) })) : []),
          { name: "All", color: P.fg, width: 3, values: months.map((mo) => upTo(recs, mo)) }] });
      }
      const hist = [...(options.history || [])].filter((h) => h.med !== null).sort((a, b) => a.date.localeCompare(b.date));
      const worth = hist.length >= 2
        ? lineChart(P, { labels: hist.map((h) => h.date), yTitle: "kr", money: true, series: [
          { name: "High", color: P.distinct(3)[2], values: hist.map((h) => h.max) },
          { name: "Median", color: P.fg, width: 3, values: hist.map((h) => h.med) },
          { name: "Low", color: P.distinct(3)[1], values: hist.map((h) => h.min) }] })
        : note(`Discogs' value of your collection is recorded with each sync${hist.length ? ` (so far: ${kr(hist[0].med)} on ${hist[0].date})` : ""}. The chart appears once there are two syncs on different days.`);
      return section("Growth over time", "Records owned at the end of each month (purchase date, else the date added to Discogs), and Discogs' value of the collection at each sync",
        card("Records owned", owned) + card("Collection value (Discogs)", worth));
    },

    value() {
      const top20 = recs.filter((r) => r[VK] !== null).sort((a, b) => b[VK] - a[VK]).slice(0, 20);
      // A typical album, for each Discogs format in the collection and for all of them together.
      const typical = (g) => {
        const vals = g.map((r) => r[VK]).filter((v) => v !== null).sort((a, b) => a - b);
        const q = (p) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : null);
        const top = g.filter((r) => r[VK] !== null).sort((a, b) => b[VK] - a[VK]).slice(0, 20);
        return [int(g.length), kr(q(0.25)), kr(q(0.5)), kr(q(0.75)), kr(vals.length ? vals[vals.length - 1] : null),
          sum(g, VK) ? pct(sum(top, VK) / sum(g, VK)) : "—"];
      };
      const formats = count(recs.map((r) => r.discogsFormat)).map(([f]) => f);
      const typicalCols = [...(formats.length > 1 ? formats.map((f) => [f, typical(recs.filter((r) => r.discogsFormat === f))]) : []), [formats.length > 1 ? "All" : formats[0] || "All", typical(recs)]];
      const typicalRows = ["Records", "Cheapest quarter are worth up to", "Median record", "Top quarter start at", "Most valuable record", "Share of value in the top 20 records"];
      const bands = haveSugg
        ? [[0, 50, "<50"], [50, 100, "50–100"], [100, 200, "100–200"], [200, 400, "200–400"], [400, 700, "400–700"], [700, 1000, "700–1 000"], [1000, 1e9, "1 000+"]]
        : [[0, 25, "<25"], [25, 50, "25–50"], [50, 100, "50–100"], [100, 200, "100–200"], [200, 300, "200–300"], [300, 500, "300–500"], [500, 1e9, "500+"]];
      const inBand = (r, a, b) => r[VK] !== null && r[VK] >= a && r[VK] < b;
      const valueAxis = haveSugg ? "Value per record (kr, Medium VG+)" : "Value per record (kr, cheapest listing)";
      return section("Value spread", "How the value of your collection is spread across your records (Discogs data)",
        card("Whole collection", table(["", "Low", "Medium", "High"], [
          ["Discogs collection value", kr(value.min), kr(value.med), kr(value.max)],
          ...(haveSugg ? [["Sum of per-album estimates", kr(sum(recs, "low")), kr(sum(recs, "mid")), kr(sum(recs, "high"))]] : []),
        ], [1, 2, 3])) +
        card("A typical album, by format", table(["", ...typicalCols.map(([f]) => f)],
          typicalRows.map((label, i) => [esc(label), ...typicalCols.map(([, col]) => col[i])]), typicalCols.map((_, i) => i + 1))) +
        grid(
          card("Records by value (kr)", barChart(P, { labels: bands.map((b) => b[2]), xTitle: valueAxis, yTitle: "Number of records",
            series: media.map((m) => ({ name: m, color: MC[m], values: bands.map(([a, b]) => recs.filter((r) => r.media === m && inBand(r, a, b)).length) })) })),
          card("Where the value sits (kr per value band)", barChart(P, { labels: bands.map((b) => b[2]), xTitle: valueAxis, yTitle: "Total value in band (kr)",
            series: [{ name: "Total value", colors: P.scale(bands.length), values: bands.map(([a, b]) => recs.filter((r) => inBand(r, a, b)).reduce((t, r) => t + r[VK], 0)) }] })),
        ) +
        card(`Top 20 albums by value (${haveSugg ? "Medium, VG+" : "cheapest listing"})`, table(
          ["#", "Album", "Artist", "Media", "Lowest", ...(haveSugg ? ["Medium"] : []), "Highest"],
          top20.map((r, n) => [n + 1, album(r), esc(r.artist), pill(r.media), kr(r.list), ...(haveSugg ? [kr(r.mid)] : []), kr(r.max)]),
          haveSugg ? [0, 4, 5, 6] : [0, 4, 5])) +
        `<div class="sub">Lowest = cheapest copy on Discogs now. Highest = Discogs' Mint price suggestion. * Total highest = Discogs' own collection maximum.</div>`);
    },

    market() {
      const listed = recs.filter((r) => r.forSale !== null);
      const row = (r, extra) => [album(r), esc(r.artist), pill(r.media), ...extra];
      const rarest = [...listed].sort((a, b) => a.forSale - b.forSale || (b[VK] ?? -1) - (a[VK] ?? -1)).slice(0, 10);
      const common = [...listed].sort((a, b) => b.forSale - a.forSale || a.title.localeCompare(b.title)).slice(0, 10);
      const above = recs.filter((r) => r.list !== null && r.mid) .map((r) => ({ r, ratio: r.list / r.mid })).filter((x) => x.ratio > 1)
        .sort((a, b) => b.ratio - a.ratio).slice(0, 10);
      return section("Market", "How easy each record is to find on Discogs today",
        card("Rarest: fewest copies for sale", rarest.length ? table(["Album", "Artist", "Media", "For sale", valueLabel], rarest.map((r) => row(r, [int(r.forSale), kr(r[VK])])), [3, 4]) : note("No record has market data yet.")) +
        card("In demand: cheapest copy costs more than Discogs' VG+ estimate", above.length
          ? table(["Album", "Artist", "Media", "Cheapest listing", "VG+ estimate", "Above estimate"], above.map(({ r, ratio }) => row(r, [kr(r.list), kr(r.mid), `+${Math.round((ratio - 1) * 100)}%`])), [3, 4, 5])
          : note("No record is listed above its VG+ estimate right now.")) +
        card("Easiest to replace: most copies for sale", common.length ? table(["Album", "Artist", "Media", "For sale", "Cheapest listing"], common.map((r) => row(r, [int(r.forSale), kr(r.list)])), [3, 4]) : note("No record has market data yet.")));
    },

    contents() {
      const gen = count(recs.flatMap((r) => r.genres)).slice(0, 10);
      const sty = count(recs.flatMap((r) => r.styles)).slice(0, 15);
      return section("What's in the collection", "", grid(
        card("Media", doughnut(P, media, media.map((m) => recs.filter((r) => r.media === m).length), media.map((m) => MC[m]))),
        card("Genres", doughnut(P, gen.map((g) => g[0]), gen.map((g) => g[1]), P.distinct(gen.length))),
      ) + card("Top styles", barChart(P, { labels: sty.map((s) => s[0]), horizontal: true, width: 1000, height: 40 + sty.length * 22,
        series: [{ name: "Records", colors: P.distinct(sty.length), values: sty.map((s) => s[1]) }] })));
    },

    pressings() {
      const countries = count(recs.map((r) => r.country).filter(Boolean)).slice(0, 10);
      const labels = count(recs.map((r) => r.label).filter(Boolean)).slice(0, 10);
      const reissues = recs.filter((r) => r.reissue).length, comps = recs.filter((r) => r.compilation).length;
      return section("Pressings", "Where and by whom your copies were pressed, and what kind of release they are", grid(
        card("Country of release", barChart(P, { labels: countries.map((c) => c[0]), horizontal: true, height: 40 + countries.length * 24,
          series: [{ name: "Records", colors: P.distinct(countries.length), values: countries.map((c) => c[1]) }] })),
        card("Top labels", barChart(P, { labels: labels.map((l) => l[0]), horizontal: true, height: 40 + labels.length * 24,
          series: [{ name: "Records", colors: P.distinct(labels.length), values: labels.map((l) => l[1]) }] })),
        card("Original releases and reissues", doughnut(P, ["Original release", "Reissue or repress"], [recs.length - reissues, reissues], P.distinct(2))),
        card("Albums and compilations", doughnut(P, ["Album", "Compilation"], [recs.length - comps, comps], P.distinct(2))),
      ) + `<div class="sub">A reissue is a copy Discogs describes as a reissue, repress or remaster.</div>`);
    },

    decades() {
      const decs = [...new Set(recs.filter((r) => r.year).map((r) => Math.floor(r.year / 10) * 10))].sort((a, b) => a - b);
      return section("By decade", "Original release year", card("", barChart(P, { labels: decs.map((d) => `${d}s`), width: 1000,
        series: media.map((m) => ({ name: m, color: MC[m], values: decs.map((d) => recs.filter((r) => r.media === m && r.year && Math.floor(r.year / 10) * 10 === d).length) })) })));
    },

    artists() {
      const arts = count(recs.map((r) => r.artist).filter((a) => a && a !== "Various")).slice(0, 15);
      return section("Top artists", "", card("", barChart(P, { labels: arts.map((a) => a[0]), horizontal: true, width: 1000, height: 40 + arts.length * 22,
        series: [{ name: "Records", colors: P.distinct(arts.length), values: arts.map((a) => a[1]) }] })));
    },

    playing() {
      const longest = recs.filter((r) => r.secs).sort((a, b) => b.secs - a.secs).slice(0, 10);
      const decs = [...new Set(recs.filter((r) => r.year).map((r) => Math.floor(r.year / 10) * 10))].sort((a, b) => a - b);
      return section("Playing time", "From the track lengths in each tracklist", grid(
        card("Longest albums", longest.length ? table(["Album", "Artist", "Tracks", "Length"], longest.map((r) => [album(r), esc(r.artist), int(r.tracks), minutes(r.secs)]), [2, 3]) : note("No track lengths yet.")),
        card("Hours of music by decade", barChart(P, { labels: decs.map((d) => `${d}s`), yTitle: "Hours",
          series: media.map((m) => ({ name: m, color: MC[m], values: decs.map((d) => Math.round(sum(recs.filter((r) => r.media === m && r.year && Math.floor(r.year / 10) * 10 === d), "secs") / 360) / 10) })) })),
      ));
    },

    buying() {
      const months = [...new Set(recs.map((r) => r.added.slice(0, 7)).filter(Boolean))].sort().slice(-18);
      const latest = recs.filter((r) => !r.listened).sort((a, b) => b.added.localeCompare(a.added)).slice(0, 15);
      return section("Buying", "Purchase date where known, otherwise the date added to Discogs",
        card("Records added per month", barChart(P, { labels: months, width: 1000, height: 290, xTitle: "Month", yTitle: "Records added",
          series: media.map((m) => ({ name: m, color: MC[m], values: months.map((mo) => recs.filter((r) => r.media === m && r.added.startsWith(mo)).length) })) })) +
        card("Latest additions — not listened to yet", table(["Date", "Album", "Artist", "Media", ...(interactive ? ["Listened"] : [])],
          latest.map((r) => [r.added, album(r), esc(r.artist), pill(r.media), ...(interactive ? [listenBox(r)] : [])]))));
    },

    listening() {
      const waiting = recs.filter((r) => !r.listened && r.added).sort((a, b) => a.added.localeCompare(b.added)).slice(0, 10);
      return section("Listening", "Records not yet ticked as listened to", card("Waiting longest: owned longest, not listened to yet", waiting.length
        ? table(["Owned since", "Album", "Artist", "Media", ...(interactive ? ["Listened"] : [])], waiting.map((r) => [r.added, album(r), esc(r.artist), pill(r.media), ...(interactive ? [listenBox(r)] : [])]))
        : note("Every record has been listened to.")));
    },

    condition() {
      const graded = recs.filter((r) => r.mediaCondition || r.sleeveCondition);
      const explain = "Conditions are copied from your Discogs collection when a record is first synced; grade copies on Discogs before syncing, or fill in media_condition and sleeve_condition in the note.";
      if (!graded.length) return section("Condition", "", card("", note(`No record has a condition yet. ${explain}`)));
      const chart = (key) => {
        const c = count(recs.map((r) => r[key]).filter(Boolean)).sort((a, b) => (GRADES.indexOf(a[0]) + 99) % 99 - (GRADES.indexOf(b[0]) + 99) % 99);
        return c.length ? barChart(P, { labels: c.map((x) => x[0]), horizontal: true, height: 40 + c.length * 24, series: [{ name: "Records", colors: P.scale(c.length).reverse(), values: c.map((x) => x[1]) }] }) : note("None graded yet.");
      };
      return section("Condition", `${graded.length} of ${recs.length} records are graded. ${explain}`, grid(card("Media", chart("mediaCondition")), card("Sleeve", chart("sleeveCondition"))));
    },

    attention() {
      const checks = [
        ["No purchase date", (r) => !r.purchased], ["No shop", (r) => !r.shop], ["No original year", (r) => !r.originalYear],
        ["No prices from Discogs", (r) => r.mid === null && r.list === null], ["No cover image", (r) => !r.cover], ["No genre", (r) => !r.genres.length],
      ];
      const rows = checks.map(([label, test]) => [label, recs.filter(test)]).filter(([, g]) => g.length);
      if (!rows.length) return section("Needs attention", "", card("", note("Nothing to fill in: every record has a purchase date, shop, original year, prices, cover and genre.")));
      return section("Needs attention", "Details missing from record notes. The first few of each are listed; open a note to fill it in.",
        card("", table(["Missing", "Records", "Such as"], rows.map(([label, g]) => [esc(label), int(g.length),
          g.slice(0, 4).map(album).join(", ") + (g.length > 4 ? `, and ${g.length - 4} more` : "")]), [1])));
    },
  };

  const shown = SECTIONS.filter(([key]) => on(key));
  const body = !recs.length ? section("No records", "", `<p>No record notes found in ${esc(media.join(", ") || "any base")}. Run Sync from Discogs.</p>`)
    : shown.length ? shown.map(([key]) => build[key]()).join("")
      : section("No sections", "", note("Every dashboard section is turned off. Turn some on in Settings → Discogs music sync and dashboard → Dashboard."));
  return { body };
}

// The dashboard as a standalone page, for PDF export. options: as for reportParts, plus css, the
// plugin's styles.css, which holds the report's rules; the page sets its variables to the theme's colours.
function buildReport(records, media, value, theme, stamp, options = {}) {
  const { body } = reportParts(records, media, value, theme, false, options);
  const P = palette(theme, options.colours);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Music Dashboard</title><style>${options.css ?? ""}
    .mls-report { --mls-fg: ${P.fg}; --mls-muted: ${P.muted}; --mls-border: ${P.border}; --mls-font: ${theme.font}; }
    @page { margin: 0; }
    html, body { background: ${P.bg}; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 3px solid ${P.fg}; padding-bottom: 8px; margin-bottom: 14px; }
    header h1 { margin: 0; font-size: 26px; }
    header span { color: ${P.muted}; }</style></head><body>
<div class="mls-report"><header><h1>Music Dashboard</h1><span>Exported ${esc(stamp)}</span></header>
${body}</div>
</body></html>`;
}

export { primaryFormat, decodeRecord, decodeCollectionValue, cssColorToHex, buildReport, reportParts, tracklist, palette, esc, kr,
  SECTIONS, COLOUR_MODES, FULL_BASES, DEFAULT_ACCENT };
