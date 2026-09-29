// Dates and times as the plugin writes them, with the platform's own Intl formatting: no moment.js, whose
// types reach the plugin only through Obsidian's and aren't there when the plugin is checked on its own.

const pad = (n: number): string => String(n).padStart(2, "0");

// "30 September 2026, 14:05" (in the computer's language), for the PDF's header and footer.
function exportStamp(at: Date): string {
  const day = at.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  return `${day}, ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

// "2026-09-30 1405", for the PDF's file name: sortable, and the same in every language.
const fileStamp = (at: Date): string => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}`;

// How long ago a moment was ("5 minutes ago", "yesterday"), for the sync panel.
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
function timeAgo(at: number, now = Date.now()): string {
  const secs = Math.round((now - at) / 1000);
  const words = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of UNITS) if (Math.abs(secs) >= size) return words.format(-Math.round(secs / size), unit);
  return words.format(0, "second");
}

export { exportStamp, fileStamp, timeAgo };
