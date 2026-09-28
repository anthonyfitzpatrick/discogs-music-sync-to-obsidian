import esbuild from "esbuild";

// Bundles src/ into the single main.js Obsidian loads. The dashboard template is
// imported as text, so a release needs only main.js, manifest.json and styles.css.
await esbuild.build({
  entryPoints: ["src/main.js"],
  outfile: "main.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2022",
  external: ["obsidian", "electron", "@electron/remote"],
  loader: { ".md": "text" },
  banner: { js: "/* Discogs music sync and dashboard — built from src/ by esbuild.config.mjs. Edit src/, not this file. */" },
  logLevel: "info",
});
