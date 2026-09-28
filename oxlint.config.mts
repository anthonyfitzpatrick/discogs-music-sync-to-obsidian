import { defineConfig } from "oxlint";

// The anti-slop rule set (github.com/dmmulroy/anti-slop), vendored in tools/oxlint/anti-slop
// and enabled in full, as in the other Wolf 359 Press plugins. Most rules check TypeScript
// type syntax and stay silent on this JavaScript source; they are enabled so they apply
// the moment any file moves to TypeScript.
export default defineConfig({
	ignorePatterns: [
		".agent/**",
		".agents/**",
		".claude/**",
		".codex/**",
		".continue/**",
		".cursor/**",
		".gemini/**",
		".opencode/**",
		".pi/**",
		".roo/**",
		".windsurf/**",
		"tools/oxlint/anti-slop/**",
		"main.js",
		"node_modules/**",
	],
	jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
	rules: {
		"anti-slop/no-chained-type-assertions": "error",
		"anti-slop/no-conditional-empty-object-spread": "error",
		"anti-slop/no-known-value-widening": "error",
		"anti-slop/no-module-mocking": "error",
		"anti-slop/no-object-parameters": "error",
		"anti-slop/no-reflect-apply": "error",
		"anti-slop/no-reflect-get": "error",
		"anti-slop/no-runtime-typeof": "error",
		"anti-slop/no-shape-in-symbol-names": "error",
		"anti-slop/no-unknown-parameters": "error",
		"anti-slop/no-unknown-returns": "error",
		"anti-slop/no-unknown-type-aliases": "error",
		"anti-slop/no-unsafe-dictionary-type": "error",
		"anti-slop/no-widen-then-assert": "error",
		"anti-slop/require-safety-comment-for-type-assertion": "error",
		// A name that hides another in an outer scope. It caused a real bug (`same` in bases.js).
		"eslint/no-shadow": "error",
	},
});
