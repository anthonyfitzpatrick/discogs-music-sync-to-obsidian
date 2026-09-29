import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

// The rules the Obsidian plugin review runs (eslint-plugin-obsidianmd), so its findings surface here,
// in the pre-commit hook and in CI rather than after a release. oxlint (oxlint.config.mts) runs the
// anti-slop rules alongside.
export default tseslint.config(
  { ignores: ["main.js", "node_modules/**", "tools/**", "tests/**", "*.mjs", "*.mts"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      sourceType: "module",
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Discogs and Genius are the services the plugin talks to, MiniDiscs a format name as Discogs
      // spells it, and the plugin's own name keeps its casing; sentence case applies to the rest.
      "obsidianmd/ui/sentence-case": ["warn", {
        brands: ["Discogs", "Genius", "Obsidian", "MiniDiscs", "Discogs music sync and dashboard"],
        acronyms: ["PDF", "API", "ID", "SEK", "VG", "NM", "G"],
      }],
    },
  },
);
