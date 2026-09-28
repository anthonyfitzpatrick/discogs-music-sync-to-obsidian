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

// A cover property ("[[123.jpeg]]") as the linked file's name.
const linkTarget = (v) => text(v).replace(/^\[\[|\]\]$/g, "").split("|")[0];

// One record note: its frontmatter, the name of the base it belongs to, its text and its path.
function decodeRecord(fm, media, body, fallbackTitle, path = "") {
  return {
    path, title: text(fm.title) || fallbackTitle, artist: text(fm.artist), media,
    label: text(fm.label), catno: text(fm.catno), country: text(fm.country), format: text(fm.format), cover: linkTarget(fm.cover),
    mediaCondition: text(fm.media_condition), sleeveCondition: text(fm.sleeve_condition),
    purchased: day(fm.purchased), forSale: num(fm.market_for_sale), myCopy: num(fm.price_my_copy_sek), checked: day(fm.price_checked),
    low: num(fm.price_low_sek), mid: num(fm.price_mid_sek), high: num(fm.price_high_sek),
    max: num(fm.price_max_sek) ?? num(fm.price_high_sek), list: num(fm.market_lowest_sek),
    year: num(fm.original_year) || num(fm.year), added: day(fm.purchased) || day(fm.added_to_discogs),
    genres: list(fm.genres), styles: list(fm.styles), shop: text(fm.shop),
    ripped: fm.ripped === true, listened: fm.listened === true,
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

// The same shading as the live dashboard: shades of the theme's text colour towards its background.
function palette(theme) {
  const shade = (t) => mix(theme.fg, theme.bg, t);
  const ramp = (n) => Array.from({ length: n }, (_, i) => shade(n < 2 ? 1 : 1 - 0.7 * i / (n - 1)));
  const distinct = (n) => { const r = ramp(n), h = Math.ceil(n / 2); return r.map((_, i) => r[i % 2 ? h + (i >> 1) : i >> 1]); };
  const ink = (fill) => (Math.abs(lum(fill) - lum(theme.fg)) > Math.abs(lum(fill) - lum(theme.bg)) ? theme.fg : theme.bg);
  return { ...theme, ramp, distinct, ink };
}

/* ------------------------------------------------------------------ formatting */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const kr = (v) => (v === null || v === undefined ? "—" : `${Math.round(v).toLocaleString("sv-SE")} kr`);
const int = (v) => Math.round(v).toLocaleString("sv-SE");
const pct = (v) => (v < 0.01 ? "<1%" : `${Math.round(v * 100)}%`);
const sum = (arr, k) => arr.reduce((a, r) => a + (r[k] || 0), 0);
const count = (arr) => { const m = new Map(); arr.forEach((x) => m.set(x, (m.get(x) || 0) + 1)); return [...m].sort((a, b) => b[1] - a[1]); };
const niceStep = (max, n) => { const raw = Math.max(max, 1) / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };

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

/* ------------------------------------------------------------------ the page */

function table(headers, rows, numeric = [], totalRow = false) {
  const cell = (tag, v, i) => `<${tag}${numeric.includes(i) ? ' class="num"' : ""}>${v}</${tag}>`;
  const body = rows.map((r, k) => `<tr${totalRow && k === rows.length - 1 ? ' class="total"' : ""}>${r.map((v, i) => cell("td", v, i)).join("")}</tr>`).join("");
  return `<table><thead><tr>${headers.map((h, i) => cell("th", esc(h), i)).join("")}</tr></thead><tbody>${body}</tbody></table>`;
}
const card = (title, inner) => `<div class="card">${title ? `<div class="card-title">${esc(title)}</div>` : ""}${inner}</div>`;
const section = (title, sub, inner) => `<section><h2>${esc(title)}</h2>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}${inner}</section>`;
const grid = (...cards) => `<div class="grid">${cards.join("")}</div>`;

// The dashboard's sections and their styles, scoped to .mls-report so they can sit inside Obsidian.
// records: decoded with decodeRecord. media: the bases' names in order. value: decodeCollectionValue.
// theme: { fg, bg, muted, border, font } as hex colours and a font stack. interactive: album titles
// become links (data-path) and the latest additions get a Listened checkbox, for the dashboard view.
function reportParts(records, media, value, theme, interactive) {
  const P = palette(theme);
  const album = (r) => (interactive && r.path ? `<a class="mls-open" data-path="${esc(r.path)}">${esc(r.title)}</a>` : esc(r.title));
  const MC = Object.fromEntries(media.map((m, i) => [m, P.ramp(media.length)[i]]));
  const recs = records.filter((r) => media.includes(r.media));
  const pill = (m) => `<span class="pill" style="background:${MC[m]};color:${P.ink(MC[m])}">${esc(m)}</span>`;

  // 1. overview
  const haveSugg = recs.some((r) => r.mid !== null);
  const highest = (g, isTotal) => (g.some((r) => r.max !== null) ? kr(sum(g, "max")) : isTotal && value.max !== null ? `${kr(value.max)} *` : "—");
  const ovRow = (label, g, isTotal) => [esc(label), int(g.length), int(sum(g, "tracks")), `${Math.round(sum(g, "secs") / 3600)} h`,
    kr(sum(g, "list")), highest(g, isTotal), `${g.filter((r) => r.ripped).length} / ${g.length}`];
  const overview = section("Overview", `${recs.length} records in ${media.length} base${media.length === 1 ? "" : "s"}: ${media.join(", ")}`,
    card("", table(["Media", "Records", "Tracks", "Playing time", "Lowest listings", "Highest", "Ripped"],
      [...media.map((m) => ovRow(m, recs.filter((r) => r.media === m))), ovRow("Total", recs, true)], [1, 2, 3, 4, 5, 6], true)));

  // 2. value spread
  const VK = haveSugg ? "mid" : "list";
  const vals = recs.map((r) => r[VK]).filter((v) => v !== null).sort((a, b) => a - b);
  const q = (p) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : null);
  const top20 = recs.filter((r) => r[VK] !== null).sort((a, b) => b[VK] - a[VK]).slice(0, 20);
  const bands = haveSugg
    ? [[0, 50, "<50"], [50, 100, "50–100"], [100, 200, "100–200"], [200, 400, "200–400"], [400, 700, "400–700"], [700, 1000, "700–1 000"], [1000, 1e9, "1 000+"]]
    : [[0, 25, "<25"], [25, 50, "25–50"], [50, 100, "50–100"], [100, 200, "100–200"], [200, 300, "200–300"], [300, 500, "300–500"], [500, 1e9, "500+"]];
  const inBand = (r, a, b) => r[VK] !== null && r[VK] >= a && r[VK] < b;
  const valueAxis = haveSugg ? "Value per record (kr, Medium VG+)" : "Value per record (kr, cheapest listing)";
  const valueSection = section("Value spread", "How the value of your collection is spread across your records (Discogs data)",
    grid(
      card("Whole collection", table(["", "Low", "Medium", "High"], [
        ["Discogs collection value", kr(value.min), kr(value.med), kr(value.max)],
        ...(haveSugg ? [["Sum of per-album estimates", kr(sum(recs, "low")), kr(sum(recs, "mid")), kr(sum(recs, "high"))]] : []),
      ], [1, 2, 3])),
      card("A typical record", table(["", "Value"], [
        ["Cheapest quarter of records are worth up to", kr(q(0.25))],
        ["Median record", kr(q(0.5))],
        ["Top quarter of records start at", kr(q(0.75))],
        ["Most valuable record", kr(vals.length ? vals[vals.length - 1] : null)],
        ["Share of value in your top 20 records", sum(recs, VK) ? pct(sum(top20, VK) / sum(recs, VK)) : "—"],
      ], [1])),
      card("Records by value (kr)", barChart(P, { labels: bands.map((b) => b[2]), xTitle: valueAxis, yTitle: "Number of records",
        series: media.map((m) => ({ name: m, color: MC[m], values: bands.map(([a, b]) => recs.filter((r) => r.media === m && inBand(r, a, b)).length) })) })),
      card("Where the value sits (kr per value band)", barChart(P, { labels: bands.map((b) => b[2]), xTitle: valueAxis, yTitle: "Total value in band (kr)",
        series: [{ name: "Total value", colors: P.ramp(bands.length).reverse(), values: bands.map(([a, b]) => recs.filter((r) => inBand(r, a, b)).reduce((t, r) => t + r[VK], 0)) }] })),
    ) +
    card(`Top 20 albums by value (${haveSugg ? "Medium, VG+" : "cheapest listing"})`, table(
      ["#", "Album", "Artist", "Media", "Lowest", ...(haveSugg ? ["Medium"] : []), "Highest"],
      top20.map((r, n) => [n + 1, album(r), esc(r.artist), pill(r.media), kr(r.list), ...(haveSugg ? [kr(r.mid)] : []), kr(r.max)]),
      haveSugg ? [0, 4, 5, 6] : [0, 4, 5])) +
    `<div class="sub">Lowest = cheapest copy on Discogs now. Highest = Discogs' Mint price suggestion. * Total highest = Discogs' own collection maximum.</div>`);

  // 3. what's in the collection
  const gen = count(recs.flatMap((r) => r.genres)).slice(0, 10);
  const sty = count(recs.flatMap((r) => r.styles)).slice(0, 15);
  const contents = section("What's in the collection", "", grid(
    card("Media", doughnut(P, media, media.map((m) => recs.filter((r) => r.media === m).length), media.map((m) => MC[m]))),
    card("Genres", doughnut(P, gen.map((g) => g[0]), gen.map((g) => g[1]), P.distinct(gen.length))),
  ) + card("Top styles", barChart(P, { labels: sty.map((s) => s[0]), horizontal: true, width: 1000, height: 40 + sty.length * 22,
    series: [{ name: "Records", colors: P.distinct(sty.length), values: sty.map((s) => s[1]) }] })));

  // 4. decades
  const decs = [...new Set(recs.filter((r) => r.year).map((r) => Math.floor(r.year / 10) * 10))].sort((a, b) => a - b);
  const decades = section("By decade", "Original release year", card("", barChart(P, { labels: decs.map((d) => `${d}s`), width: 1000,
    series: media.map((m) => ({ name: m, color: MC[m], values: decs.map((d) => recs.filter((r) => r.media === m && r.year && Math.floor(r.year / 10) * 10 === d).length) })) })));

  // 5. artists
  const arts = count(recs.map((r) => r.artist).filter((a) => a && a !== "Various")).slice(0, 15);
  const artists = section("Top artists", "", card("", barChart(P, { labels: arts.map((a) => a[0]), horizontal: true, width: 1000, height: 40 + arts.length * 22,
    series: [{ name: "Records", colors: P.distinct(arts.length), values: arts.map((a) => a[1]) }] })));

  // 6. buying
  const months = [...new Set(recs.map((r) => r.added.slice(0, 7)).filter(Boolean))].sort().slice(-18);
  const shops = count(recs.map((r) => r.shop).filter(Boolean)).slice(0, 10);
  const latest = recs.filter((r) => !r.listened).sort((a, b) => b.added.localeCompare(a.added)).slice(0, 15);
  const buying = section("Buying", "Purchase date where known, otherwise the date added to Discogs", grid(
    card("Records added per month", barChart(P, { labels: months, height: 290, xTitle: "Month", yTitle: "Records added",
      series: media.map((m) => ({ name: m, color: MC[m], values: months.map((mo) => recs.filter((r) => r.media === m && r.added.startsWith(mo)).length) })) })),
    card("Where you buy", barChart(P, { labels: shops.map((s) => s[0]), horizontal: true, height: 40 + shops.length * 24, xTitle: "Records bought",
      series: [{ name: "Records", colors: P.distinct(shops.length), values: shops.map((s) => s[1]) }] })),
  ) + card("Latest additions — not listened to yet", table(["Date", "Album", "Artist", "Media", ...(interactive ? ["Listened"] : [])],
    latest.map((r) => [r.added, album(r), esc(r.artist), pill(r.media),
      ...(interactive ? [`<input type="checkbox" class="mls-listen" data-path="${esc(r.path)}" aria-label="Mark ${esc(r.title)} as listened to">`] : [])]))));

  const R = ".mls-report";
  const css = `
    ${R} { color: ${P.fg}; font-family: ${theme.font}; font-size: 12px; }
    ${R} .sub { color: ${P.muted}; font-size: 11px; margin: 2px 0 10px; }
    ${R} section { margin-bottom: 18px; break-inside: auto; }
    ${R} h2 { font-size: 17px; margin: 0 0 2px; padding-left: 10px; border-left: 5px solid ${P.fg}; break-after: avoid; color: ${P.fg}; }
    ${R} .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 12px; }
    ${R} .card { border: 1px solid ${P.border}; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; break-inside: avoid; }
    ${R} .grid > .card { margin-bottom: 0; }
    ${R} .grid + .card { margin-top: 12px; }
    ${R} .card-title { font-weight: 700; margin-bottom: 6px; }
    ${R} svg { display: block; width: 100%; height: auto; }
    ${R} table { width: 100%; border-collapse: collapse; margin: 0; }
    ${R} th { text-align: left; color: ${P.muted}; font-weight: 600; border-bottom: 1px solid ${P.border}; padding: 4px 6px; }
    ${R} td { padding: 4px 6px; border-bottom: 1px solid ${P.border}; vertical-align: middle; color: ${P.fg}; }
    ${R} tr { break-inside: avoid; }
    ${R} .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    ${R} tr.total td { font-weight: 800; border-top: 2px solid ${P.border}; border-bottom: none; }
    ${R} .pill { font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 999px; white-space: nowrap; }
    ${R} a.mls-open { color: ${P.fg}; font-weight: 600; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }`;
  const body = recs.length ? overview + valueSection + contents + decades + artists + buying
    : section("No records", "", `<p>No record notes found in ${esc(media.join(", ") || "any base")}. Run Sync from Discogs.</p>`);
  return { body, css };
}

// The dashboard as a standalone page, for PDF export.
function buildReport(records, media, value, theme, stamp) {
  const { body, css } = reportParts(records, media, value, theme, false);
  const P = palette(theme);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Music Dashboard</title><style>
    @page { margin: 0; }
    html, body { background: ${P.bg}; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 3px solid ${P.fg}; padding-bottom: 8px; margin-bottom: 14px; }
    header h1 { margin: 0; font-size: 26px; }
    header span { color: ${P.muted}; }${css}</style></head><body>
<div class="mls-report"><header><h1>Music Dashboard</h1><span>Exported ${esc(stamp)}</span></header>
${body}</div>
</body></html>`;
}

module.exports = { decodeRecord, decodeCollectionValue, cssColorToHex, buildReport, reportParts, tracklist, palette, esc, kr };
