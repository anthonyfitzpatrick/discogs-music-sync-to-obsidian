// Lints the dashboard's JavaScript, which lives inside src/dashboard-template.md where oxlint
// can't see it. The dataviewjs block is written out as the body of an async function (Dataview
// runs it the same way, with `dv` and `app` in scope), linted with the project's rules, and removed.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const template = readFileSync("src/dashboard-template.md", "utf8");
const block = template.match(/^```dataviewjs\n([\s\S]*?)^```$/m);
if (!block) { console.error("lint-dashboard: no dataviewjs block in src/dashboard-template.md"); process.exit(1); }

const dir = "dashboard-lint-tmp";   // visible and not git-ignored, because oxlint skips both; removed below
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/dashboard.js`, `async function renderMusicDashboard(dv, app) {\n${block[1]}}\nmodule.exports = renderMusicDashboard;\n`);
let run;
try { run = spawnSync("npx", ["oxlint", "--deny-warnings", dir], { stdio: "inherit" }); }
finally { rmSync(dir, { recursive: true, force: true }); }
process.exit(run.status ?? 1);
