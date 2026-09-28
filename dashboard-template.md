# Music Dashboard

```music-sync
```

```dataviewjs
// ───────────────────────── Music Dashboard (live: Dataview + Charts) ─────────────────────────
// Generated from dashboard-template.md in the Discogs music sync and dashboard plugin — edit the template, not this note.
// The bases come from the Discogs music sync and dashboard settings; the original three if the plugin is off.
const LIBS = app.plugins.plugins["music-library-sync"]?.libraries?.() ||
  [{ name: "Vinyl", tag: "vinyl-library" }, { name: "CDs", tag: "cd-library" }, { name: "Tapes", tag: "tape-library" }];
const TAGS = Object.fromEntries(LIBS.map((l) => [`#${l.tag}`, l.name]));
const MEDIA = LIBS.map((l) => l.name);
// Every colour comes from the active theme's CSS variables, read when the note renders, so the
// dashboard follows the theme and light/dark mode. Charts draw on canvas, which can't use var(),
// so each variable is resolved to a hex value through a hidden probe element.
const probe = document.body.createDiv(); probe.style.display = "none";
const rgbOf = (c) => { probe.style.color = ""; probe.style.color = c; const s = getComputedStyle(probe).color, n = (s.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
  return (s.startsWith("color(") ? n.slice(0, 3).map((v) => v * 255) : n.slice(0, 3)); };
const hex = (a) => "#" + a.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const themeHex = (name, fallback) => hex(rgbOf(`var(${name}, ${fallback})`));
const FG = themeHex("--text-normal", "#222222"), BG = themeHex("--background-primary", "#ffffff");
const BORDER = themeHex("--background-modifier-border", "#cccccc");
probe.remove();
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => { const y = hexRgb(b); return hex(hexRgb(a).map((v, i) => v * t + y[i] * (1 - t))); };   // t parts a, rest b
const shade = (t) => mix(FG, BG, t);                  // 1 = full theme text colour, towards 0 = fades into the background
// n shades of the theme colour, strongest to faintest; interleaved so neighbouring slices and bars never look alike.
const ramp = (n) => Array.from({ length: n }, (_, i) => shade(n < 2 ? 1 : 1 - 0.7 * i / (n - 1)));
const distinct = (n) => { const r = ramp(n), h = Math.ceil(n / 2); return r.map((_, i) => r[i % 2 ? h + (i >> 1) : i >> 1]); };
const MC = Object.fromEntries(MEDIA.map((m, i) => [m, ramp(MEDIA.length)[i]]));
const TXT = FG;                                        // chart text: the theme's own body text colour
const GRID = BORDER;
const lum = (hex) => { const h = hex.replace("#", ""); const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  .map((c) => (c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)); return .2126 * r + .7152 * g + .0722 * b; };
const ink = (hex) => (Math.abs(lum(hex) - lum(FG)) > Math.abs(lum(hex) - lum(BG)) ? FG : BG);   // theme text or background, whichever reads on the fill
const kr = (v) => v == null || v === "" ? "—" : `${Math.round(v).toLocaleString("sv-SE")} kr`;
const num = (v) => (typeof v === "number" && !isNaN(v) ? v : null);
const count = (arr) => { const m = new Map(); arr.forEach((x) => m.set(x, (m.get(x) || 0) + 1)); return [...m].sort((a, b) => b[1] - a[1]); };
const ym = (d) => !d ? "" : d.toFormat ? d.toFormat("yyyy-MM") : String(d).slice(0, 7);
const ymd = (d) => !d ? "" : d.toFormat ? d.toFormat("yyyy-MM-dd") : String(d).slice(0, 10);
const has = typeof window.renderChart === "function";
const open = (el, file) => el.addEventListener("click", (e) => { e.preventDefault(); app.workspace.openLinkText(file, dv.current().file.path, e.ctrlKey || e.metaKey); });

// ---------- wait for Dataview to finish indexing (e.g. right after Obsidian starts) ----------
const dvPlugin = app.plugins.plugins.dataview;
if (dvPlugin && dvPlugin.index && !dvPlugin.index.initialized) {
  const waiting = dv.el("div", "Loading your collection…", { cls: "md-sub" });
  await new Promise((resolve) => {
    const ref = app.metadataCache.on("dataview:index-ready", () => { app.metadataCache.offref(ref); resolve(); });
    setTimeout(resolve, 20000);                      // safety net
  });
  waiting.remove();
}
// safety net: poll until the album notes are visible to Dataview (max ~20 s)
for (let i = 0; i < 40 && dv.pages(Object.keys(TAGS).join(" or ")).length === 0; i++) await new Promise((r) => setTimeout(r, 500));
// ---------- data ----------
const recs = dv.pages(Object.keys(TAGS).join(" or ")).array().map((p) => {
  const media = MEDIA.find((m) => (p.file.tags || []).includes(Object.keys(TAGS).find((t) => TAGS[t] === m)));
  return { p, media, low: num(p.price_low_sek), mid: num(p.price_mid_sek), high: num(p.price_high_sek), max: num(p.price_max_sek) ?? num(p.price_high_sek), list: num(p.market_lowest_sek),
           year: num(p.original_year) || num(p.year), added: p.purchased || p.added_to_discogs };
});
// tracks + playing time come from each note's tracklist table
let tracks = 0, secs = 0, linked = 0; const perMedia = {};
const TC = (window.musicDashTrackCache ||= new Map());           // path -> {mtime, tracks, secs, linked}
for (const r of recs) {
  const mt = r.p.file.mtime?.toMillis?.() ?? 0, hit = TC.get(r.p.file.path);
  if (hit && hit.mtime === mt) { Object.assign(r, hit); tracks += r.tracks; secs += r.secs; linked += r.linked; continue; }
  const t = await dv.io.load(r.p.file.path);
  const rows = (t.match(/^\| ([^|]*) \| (.*?) \| ([^|]*) \| (.*) \|$/gm) || []).map((l) => l.split(" | "))
    .filter((c) => c[0] !== "| #" && !c[0].startsWith("|---") && !c[1].startsWith("**"));
  const s = rows.reduce((a, c) => { const m = c[2].trim().match(/^(\d+):(\d\d)$/); return a + (m ? +m[1] * 60 + +m[2] : 0); }, 0);
  r.tracks = rows.length; r.secs = s; r.linked = rows.filter((c) => /\[Lyrics\]/.test(c[3])).length;
  tracks += r.tracks; secs += s; linked += r.linked;
  TC.set(r.p.file.path, { mtime: mt, tracks: r.tracks, secs: r.secs, linked: r.linked });
}
const sum = (arr, k) => arr.reduce((a, r) => a + (r[k] || 0), 0);

const haveSugg = recs.some((r) => r.mid != null);
let cur = {};
try { cur = JSON.parse(await app.vault.adapter.read("Music/.vinyl-sync/collection-value.json")); } catch (e) {}

// ---------- layout helpers ----------
const root = dv.el("div", "", { cls: "md-root" });
root.createEl("style", { text: `
  .md-root table.md-table th, .md-root table.md-table td { text-align: left !important; padding: 6px 10px !important; white-space: nowrap; }
  .md-root table.md-table th.md-num, .md-root table.md-table td.md-num { text-align: right !important; font-variant-numeric: tabular-nums; }
  .md-root table.md-table td:nth-child(2) { white-space: normal; }
  .md-root input.md-listen { width: 18px; height: 18px; cursor: pointer; margin: 0; }
` });
root.createEl("style", { text: "/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 Music Dashboard (dataviewjs) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.md-root { display: flex; flex-direction: column; gap: 26px; }\n.md-root .md-section h2 { margin: 0 0 2px; font-size: 1.35em; font-weight: 800; color: var(--text-normal);\n  padding-left: 12px; border-left: 5px solid; border-image: linear-gradient(180deg, var(--text-normal), var(--text-muted), var(--background-modifier-border)) 1; }\n.md-root .md-sub { color: var(--text-muted); font-size: var(--font-ui-small); margin-bottom: 12px; }\n.md-root .md-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 16px; }\n.md-root .md-card { background: var(--background-secondary); border: 1px solid var(--background-modifier-border);\n  border-radius: 16px; padding: 14px 16px; box-shadow: 0 4px 14px -8px rgba(0,0,0,.25); margin-bottom: 16px; }\n.md-root .md-grid > .md-card { margin-bottom: 0; }\n.md-root .md-card-title { font-weight: 700; margin-bottom: 8px; }\n.md-root .md-chart { position: relative; width: 100%; }\n  background: linear-gradient(135deg, var(--tile), color-mix(in srgb, var(--tile) 70%, var(--background-primary) 30%));\n  box-shadow: 0 8px 20px -10px var(--tile); }\n.md-root .md-table { width: 100%; border-collapse: collapse; font-size: var(--font-ui-small); }\n.md-root .md-table th { text-align: left; color: var(--text-muted); font-weight: 600; border-bottom: 1px solid var(--background-modifier-border); padding: 6px; }\n.md-root .md-table td { padding: 6px; border-bottom: 1px solid var(--background-modifier-border-hover, var(--background-modifier-border)); vertical-align: middle; }\n.md-root .md-table tr:hover td { background: var(--background-modifier-hover); }\n.md-root .md-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }\n.md-root .md-pill { color: var(--text-on-accent); font-size: var(--font-ui-smaller); font-weight: 700; padding: 2px 8px; border-radius: 999px; }\n\n.md-root .md-table tr.md-total td { font-weight: 800; border-top: 2px solid var(--background-modifier-border); border-bottom: none; }\n\n/* readability fixes */\n.md-root .md-card { color: var(--text-normal); }\n.md-root .md-card-title { color: var(--text-normal); }\n.md-root .md-sub { color: var(--text-muted); }\n.md-root .md-table th { color: var(--text-muted); }\n.md-root .md-table td { color: var(--text-normal); }\n.md-root .md-table a.internal-link { color: var(--text-normal); font-weight: 600; text-decoration: underline;\n  text-decoration-color: color-mix(in srgb, var(--interactive-accent) 60%, transparent); text-underline-offset: 3px; }\n.md-root .md-table a.internal-link:hover { color: var(--interactive-accent); }\n.md-root .md-pill { display: inline-block; }\n\n.md-root .md-section { padding: 16px 18px; border-radius: 16px; background: var(--background-primary-alt, rgba(0,0,0,.03));\n  border: 1px solid var(--background-modifier-border); }\n.md-root .md-card { background: var(--background-primary); }\n.md-root .md-table { margin: 0; }\n.md-root .md-table th, .md-root .md-table td { border-left: none !important; border-right: none !important; }\n" });
const section = (title, sub) => { const s = root.createDiv({ cls: "md-section" }); s.createEl("h2", { text: title }); if (sub) s.createDiv({ cls: "md-sub", text: sub }); return s; };
const grid = (parent, cls = "md-grid") => parent.createDiv({ cls });
const card = (parent, title) => { const c = parent.createDiv({ cls: "md-card" }); if (title) c.createDiv({ cls: "md-card-title", text: title }); return c; };
const chart = (parent, cfg, h = 260) => {
  const box = parent.createDiv({ cls: "md-chart" }); box.style.height = h + "px";
  if (!has) { box.setText("Enable the Charts plugin to see this chart."); return; }
  cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: TXT, boxWidth: 12 } }, tooltip: { mode: "index", intersect: false } } }, cfg.options || {});
  if (!["doughnut", "pie", "polarArea"].includes(cfg.type)) {
    const ax = { ticks: { color: TXT }, grid: { color: GRID } };
    cfg.options.scales = Object.assign({ x: { ...ax }, y: { ...ax, beginAtZero: true } }, cfg.options.scales || {});
  }
  window.renderChart(cfg, box);
};
const pctText = (v) => (v < 0.01 ? "<1%" : `${Math.round(v * 100)}%`);
const pctPlugin = { id: "pct", afterDatasetsDraw(c) {
  const ds = c.data.datasets[0], tot = ds.data.reduce((a, b) => a + b, 0), ctx = c.ctx;
  const colors = [].concat(ds.backgroundColor);
  const arcs = c.getDatasetMeta(0).data;
  const outside = { left: [], right: [] };
  ctx.save(); ctx.font = "600 12px sans-serif"; ctx.textBaseline = "middle";
  arcs.forEach((arc, i) => {
    const v = ds.data[i] / tot; if (!v) return;
    if (v >= 0.07) {                                     // big slice: label inside, contrast-aware
      const p = arc.tooltipPosition(); ctx.fillStyle = ink(colors[i % colors.length]); ctx.textAlign = "center";
      ctx.fillText(pctText(v), p.x, p.y); return;
    }
    const mid = (arc.startAngle + arc.endAngle) / 2, R = arc.outerRadius;
    const side = Math.cos(mid) >= 0 ? "right" : "left";
    outside[side].push({ i, v, mid, R, cx: arc.x, cy: arc.y, y: arc.y + Math.sin(mid) * (R + 16) });
  });
  const GAP = 16;
  for (const side of ["left", "right"]) {
    const L = outside[side].sort((a, b) => a.y - b.y);
    for (let k = 1; k < L.length; k++) if (L[k].y - L[k - 1].y < GAP) L[k].y = L[k - 1].y + GAP;       // push down
    const top = c.chartArea.top + 6;
    if (L.length && L[0].y < top) { const d = top - L[0].y; L.forEach((l) => (l.y += d)); }          // keep inside canvas
    for (const l of L) {
      const dir = side === "right" ? 1 : -1;
      const x1 = l.cx + Math.cos(l.mid) * l.R, y1 = l.cy + Math.sin(l.mid) * l.R;
      const xElbow = l.cx + dir * (l.R + 14), xText = l.cx + dir * (l.R + 26);
      ctx.strokeStyle = colors[l.i % colors.length]; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(xElbow, l.y); ctx.lineTo(xText, l.y); ctx.stroke();
      ctx.fillStyle = TXT; ctx.textAlign = side === "right" ? "left" : "right";
      ctx.fillText(pctText(l.v), xText + dir * 4, l.y);
    }
  }
  ctx.restore();
} };
const pie = (parent, labels, values, colors) => {
  const tot = values.reduce((a, b) => a + b, 0);
  chart(parent, { type: "doughnut", plugins: [pctPlugin],
    data: { labels: labels.map((l, i) => `${l} — ${pctText(values[i] / tot)}`), datasets: [{ data: values, backgroundColor: colors, borderColor: BG, borderWidth: 2 }] },
    options: { cutout: "50%", layout: { padding: { top: 30, bottom: 30, left: 60, right: 60 } },
      plugins: { legend: { position: "bottom", labels: { color: TXT, boxWidth: 12, padding: 12 } },
      tooltip: { callbacks: { label: (c) => ` ${c.raw} records (${pctText(c.raw / tot)})` } } } } }, 380);
};
const axTitle = (text) => ({ display: true, text, color: TXT, font: { size: 12, weight: "600" }, padding: { top: 6, bottom: 4 } });
const tile = (parent, label, value, hint, color) => {
  const t = parent.createDiv({ cls: "md-tile" }); t.style.setProperty("--tile", color);
  t.createDiv({ cls: "md-tile-label", text: label }); t.createDiv({ cls: "md-tile-value", text: value });
  if (hint) t.createDiv({ cls: "md-tile-hint", text: hint });
};

// simple table helper
const table = (parent, head, rows, numCols = []) => {
  const t = parent.createEl("table", { cls: "md-table" });
  const hr = t.createEl("tr"); head.forEach((h, i) => hr.createEl("th", { text: h, cls: numCols.includes(i) ? "md-num" : "" }));
  for (const r of rows) { const tr = t.createEl("tr"); r.forEach((c, i) => {
    const td = tr.createEl("td", { cls: numCols.includes(i) ? "md-num" : "" });
    if (c instanceof Function) c(td); else td.setText(String(c)); }); }
  return t;
};
const albumLink = (r) => (td) => open(td.createEl("a", { cls: "internal-link", text: r.p.title || r.p.file.name, attr: { href: r.p.file.path, "data-href": r.p.file.path } }), r.p.file.path);
const mediaPill = (m) => (td) => { const sp = td.createSpan({ cls: "md-pill", text: m }); sp.style.background = MC[m]; sp.style.color = ink(MC[m]); };

// ---------- 1. overview ----------
const ov = card(section("Overview", `${recs.length} records · live from the ${new Intl.ListFormat("en").format(MEDIA)} base${MEDIA.length === 1 ? "" : "s"}`), "");
const highest = (g, isTotal) => g.some((r) => r.max != null) ? kr(sum(g, "max")) : isTotal && cur.discogs_value_max ? `${kr(cur.discogs_value_max)} *` : "—";
const ovRow = (label, g, isTotal) => [label, g.length.toLocaleString("sv-SE"), sum(g, "tracks").toLocaleString("sv-SE"),
  `${Math.round(sum(g, "secs") / 3600)} h`, kr(sum(g, "list")), highest(g, isTotal), `${g.filter((r) => r.p.ripped === true).length} / ${g.length}`];
table(ov, ["Media", "Records", "Tracks", "Playing time", "Lowest listings", "Highest", "Ripped"],
  [...MEDIA.map((m) => ovRow(m, recs.filter((r) => r.media === m))), ovRow("Total", recs, true)], [1, 2, 3, 4, 5, 6])
  .lastElementChild?.addClass?.("md-total");

// ---------- 2. value spread ----------
const sv = section("Value spread", "How the value of your collection is spread across your records (Discogs data)");
const VK = haveSugg ? "mid" : "list";                      // value used for "typical record" & Top 20
const vals = recs.map((r) => r[VK]).filter((v) => v != null).sort((a, b) => a - b);
const q = (p) => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : null;
const listed = sum(recs, "list");
table(card(sv, "Whole collection"), ["", "Low", "Medium", "High"], [
  ["Discogs collection value", kr(cur.discogs_value_min), kr(cur.discogs_value_median), kr(cur.discogs_value_max)],
  ...(haveSugg ? [["Sum of per-album estimates", kr(sum(recs, "low")), kr(sum(recs, "mid")), kr(sum(recs, "high"))]] : []),
], [1, 2, 3]);
const top20 = recs.filter((r) => r[VK] != null).sort((a, b) => b[VK] - a[VK]).slice(0, 20);
const typ = card(sv, "A typical record");
table(typ, ["", "Value"], [
  ["Cheapest quarter of records are worth up to", kr(q(0.25))],
  ["Median record", kr(q(0.5))],
  ["Top quarter of records start at", kr(q(0.75))],
  ["Most valuable record", kr(vals[vals.length - 1])],
  ["Share of value in your top 20 records", sum(recs, VK) ? `${Math.round(sum(top20, VK) / sum(recs, VK) * 100)}%` : "—"],
], [1]);
const vg = grid(sv);
const bands = haveSugg
  ? [[0, 50, "<50"], [50, 100, "50–100"], [100, 200, "100–200"], [200, 400, "200–400"], [400, 700, "400–700"], [700, 1000, "700–1 000"], [1000, 1e9, "1 000+"]]
  : [[0, 25, "<25"], [25, 50, "25–50"], [50, 100, "50–100"], [100, 200, "100–200"], [200, 300, "200–300"], [300, 500, "300–500"], [500, 1e9, "500+"]];
const inBand = (r, a, b) => r[VK] != null && r[VK] >= a && r[VK] < b;
chart(card(vg, "Records by value (kr)"), { type: "bar", data: { labels: bands.map((b) => b[2]),
  datasets: MEDIA.map((m) => ({ label: m, data: bands.map(([a, b]) => recs.filter((r) => r.media === m && inBand(r, a, b)).length), backgroundColor: MC[m], borderRadius: 4 })) },
  options: { scales: { x: { stacked: true, title: axTitle(haveSugg ? "Value per record (kr, Medium VG+)" : "Value per record (kr, cheapest listing)"), ticks: { color: TXT }, grid: { display: false } },
    y: { stacked: true, title: axTitle("Number of records"), ticks: { color: TXT, precision: 0 }, grid: { color: GRID } } } } });
const bandVal = bands.map(([a, b]) => recs.filter((r) => inBand(r, a, b)).reduce((t, r) => t + r[VK], 0));
const bandTot = bandVal.reduce((a, b) => a + b, 0);
chart(card(vg, "Where the value sits (kr per value band)"), { type: "bar", data: { labels: bands.map((b) => b[2]),
  datasets: [{ label: "Total value", data: bandVal, backgroundColor: ramp(bands.length).reverse(), borderRadius: 6 }] },
  options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${kr(c.raw)} (${bandTot ? Math.round(c.raw / bandTot * 100) : 0}% of total)` } } },
    scales: { x: { title: axTitle(haveSugg ? "Value per record (kr, Medium VG+)" : "Value per record (kr, cheapest listing)"), ticks: { color: TXT }, grid: { display: false } },
      y: { title: axTitle("Total value in band (kr)"), ticks: { color: TXT, callback: (v) => Number(v).toLocaleString("sv-SE") }, grid: { color: GRID }, beginAtZero: true } } } });
table(card(sv, `Top 20 albums by value (${haveSugg ? "Medium, VG+" : "cheapest listing"})`),
  ["#", "Album", "Artist", "Media", "Lowest", ...(haveSugg ? ["Medium"] : []), "Highest"],
  top20.map((r, n) => [n + 1, albumLink(r), r.p.artist || "", mediaPill(r.media), kr(r.list), ...(haveSugg ? [kr(r.mid)] : []), kr(r.max)]),
  haveSugg ? [0, 4, 5, 6] : [0, 4, 5]);

sv.createDiv({ cls: "md-sub", text: "Lowest = cheapest copy on Discogs now. Highest = Discogs' Mint price suggestion (appears once Discogs accepts your Seller Settings). * Total highest = Discogs' own collection maximum." });

// ---------- 3. what's in the collection ----------
const sc = section("What's in the collection");
const cg = grid(sc);
pie(card(cg, "Media"), MEDIA, MEDIA.map((m) => recs.filter((r) => r.media === m).length), MEDIA.map((m) => MC[m]));
const gen = count(recs.flatMap((r) => r.p.genres || [])).slice(0, 10);
pie(card(cg, "Genres"), gen.map((g) => g[0]), gen.map((g) => g[1]), distinct(gen.length));
const sty = count(recs.flatMap((r) => r.p.styles || [])).slice(0, 15);
chart(card(sc, "Top styles"), { type: "bar", data: { labels: sty.map((s) => s[0]), datasets: [{ label: "Records", data: sty.map((s) => s[1]), backgroundColor: distinct(sty.length), borderRadius: 6 }] },
  options: { indexAxis: "y", plugins: { legend: { display: false } } } }, 380);

// ---------- 4. decades ----------
const decs = [...new Set(recs.filter((r) => r.year).map((r) => Math.floor(r.year / 10) * 10))].sort();
chart(card(section("By decade", "Original release year"), ""), { type: "bar", data: { labels: decs.map((d) => `${d}s`),
  datasets: MEDIA.map((m) => ({ label: m, data: decs.map((d) => recs.filter((r) => r.media === m && r.year && Math.floor(r.year / 10) * 10 === d).length), backgroundColor: MC[m], borderRadius: 4 })) },
  options: { scales: { x: { stacked: true, ticks: { color: TXT }, grid: { display: false } }, y: { stacked: true, ticks: { color: TXT }, grid: { color: GRID } } } } }, 280);

// ---------- 5. artists ----------
const arts = count(recs.map((r) => r.p.artist).filter((a) => a && a !== "Various")).slice(0, 15);
chart(card(section("Top artists"), ""), { type: "bar", data: { labels: arts.map((a) => a[0]),
  datasets: [{ label: "Records", data: arts.map((a) => a[1]), backgroundColor: distinct(arts.length), borderRadius: 6 }] },
  options: { indexAxis: "y", plugins: { legend: { display: false } } } }, 400);

// ---------- 6. buying ----------
const sb = section("Buying", "Purchase date where known, otherwise the date added to Discogs");
const bg = grid(sb);
const months = [...new Set(recs.map((r) => ym(r.added)).filter(Boolean))].sort().slice(-18);
chart(card(bg, "Records added per month"), { type: "bar", data: { labels: months,
  datasets: MEDIA.map((m) => ({ label: m, data: months.map((mo) => recs.filter((r) => r.media === m && ym(r.added) === mo).length), backgroundColor: MC[m], borderRadius: 4 })) },
  options: { scales: { x: { stacked: true, title: axTitle("Month (purchase date, else date added to Discogs)"), ticks: { color: TXT }, grid: { display: false } },
    y: { stacked: true, title: axTitle("Records added"), ticks: { color: TXT, precision: 0 }, grid: { color: GRID } } } } });
const shops = count(recs.map((r) => r.p.shop).filter(Boolean)).slice(0, 10);
chart(card(bg, "Where you buy"), { type: "bar", data: { labels: shops.map((s) => s[0]), datasets: [{ label: "Records", data: shops.map((s) => s[1]), backgroundColor: distinct(shops.length), borderRadius: 6 }] },
  options: { indexAxis: "y", plugins: { legend: { display: false } },
    scales: { x: { title: axTitle("Records bought"), ticks: { color: TXT, precision: 0 }, grid: { color: GRID }, beginAtZero: true },
      y: { title: axTitle("Shop"), ticks: { color: TXT }, grid: { display: false } } } } });
const latest = recs.filter((r) => r.p.listened !== true)
  .sort((a, b) => ymd(b.added).localeCompare(ymd(a.added))).slice(0, 15);
const listenBox = (r) => (td) => {
  const cb = td.createEl("input", { type: "checkbox", cls: "task-list-item-checkbox md-listen" });
  cb.setAttr("aria-label", `Mark ${r.p.title || r.p.file.name} as listened to`);
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", async () => {
    if (!cb.checked) return;
    const row = td.parentElement; row.style.transition = "opacity .3s"; row.style.opacity = "0.3";
    try {
      const f = app.vault.getAbstractFileByPath(r.p.file.path);
      await app.fileManager.processFrontMatter(f, (fm) => { fm.listened = true; fm.listened_on = new Date().toISOString().slice(0, 10); });
      setTimeout(() => row.remove(), 300);
    } catch (err) { cb.checked = false; row.style.opacity = "1"; td.setAttr("title", "Couldn’t save: " + err.message); console.error(err); }
  });
};
table(card(sb, "Latest additions — not listened to yet"), ["Date", "Album", "Artist", "Media", "Listened"],
  latest.map((r) => [ymd(r.added), albumLink(r), r.p.artist || "", mediaPill(r.media), listenBox(r)]));

```
