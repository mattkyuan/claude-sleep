#!/usr/bin/env node
// Builds a made-up memory folder and session logs for trying sleep, and for screenshots that carry no private data.
// The project is an invented recipe app. Nothing here touches your own ~/.claude.
//   node examples/demo.mjs [dir]      (default: <tmp>/sleep-demo; an existing demo there is replaced)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAY = 864e5;
const root = path.resolve(process.argv[2] || path.join(os.tmpdir(), "sleep-demo"));
if (fs.existsSync(root)) {
  if (!fs.existsSync(path.join(root, ".sleep-demo"))) throw new Error(`${root} exists and is not a sleep demo; pick another folder`);
  fs.rmSync(root, { recursive: true, force: true });
}
const claude = path.join(root, "claude");
const project = path.join(root, "recipe-box");
const key = project.replace(/[^A-Za-z0-9]/g, "-");
const pdir = path.join(claude, "projects", key);
const memDir = path.join(pdir, "memory");
fs.mkdirSync(memDir, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(root, ".sleep-demo"), "");

const mem = (name, type, desc, body) => `---\nname: ${name}\ndescription: ${desc}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;
const files = {};
const write = (name, text, ageDays) => {
  const f = path.join(memDir, name);
  fs.writeFileSync(f, text);
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(f, t, t);
  files[name] = text;
};

// [file, type, description, body, age in days, read in a session?]
const notes = [
  ["user_role.md", "user", "Who the user is", "Solo developer on Recipe Box, a recipe-sharing web app. Prefers short answers and small PRs.", 120, true],
  ["deploy_from_main.md", "project", "Deploys run from main", "Every push to main deploys to production within 5 minutes. Feature work goes on a branch.", 110, true],
  ["db_migrations.md", "feedback", "Run migrations by hand", "A merged migration is not applied in production. Run it with `npm run migrate:prod` after the deploy.\n\n**Why:** v2.3 shipped code that read a column that did not exist yet.", 100, true],
  ["image_cdn.md", "project", "Photos go through the CDN", "Recipe photos are served from the image CDN at 3 widths (320, 640, 1280). Never link the bucket directly.", 95, true],
  ["search_index.md", "project", "Search uses a nightly index", "Recipe search reads an index rebuilt nightly at 02:00 UTC, so a new recipe is searchable the next day.", 90, true],
  ["tests_hub.md", "reference", "Testing hub", "- [Flaky timer test](test_flaky_timer.md)\n- [Snapshot updates](test_snapshots.md)\n- [[test_fixtures]]", 100, true],
  ["ui_hub.md", "reference", "Frontend hub", "- [Mobile layout](fe_mobile_layout.md)\n- [Dark mode tokens](fe_dark_tokens.md)\n- [Form errors](fe_form_errors.md)", 100, true],
  // Unused lessons that say much the same thing, queued for Consolidate.
  ["test_flaky_timer.md", "feedback", "Timer test is flaky", "The cooking-timer test fails when the machine is slow. Use fake timers, never a real `setTimeout` in tests.", 85, false],
  ["test_fake_timers.md", "feedback", "Use fake timers", "Tests that wait on time must use fake timers. Real waits made CI flaky twice in PR #41 and PR #57.", 80, false],
  ["test_snapshots.md", "feedback", "Snapshot updates need a look", "Never run `--update-snapshots` blind. Read each changed snapshot first.", 84, false],
  ["test_snapshot_review.md", "feedback", "Review snapshot diffs", "A snapshot update in PR #63 hid a broken price label. Review every snapshot diff before committing it.", 78, false],
  ["test_fixtures.md", "feedback", "Fixtures are synthetic", "Test fixtures use made-up recipes, never real user data.", 88, false],
  ["fe_mobile_layout.md", "feedback", "Check the phone layout", "Check every new screen at 390px wide before calling it done.", 82, false],
  ["fe_mobile_check.md", "feedback", "Phone width first", "The ingredient list overflowed on phones in v2.1. Check 390px wide for every UI change.", 79, false],
  ["fe_dark_tokens.md", "feedback", "Colors come from tokens", "Use the color tokens in `theme.css`; a hard-coded color breaks dark mode.", 86, false],
  ["fe_dark_mode.md", "feedback", "Dark mode breaks on raw colors", "Two raw hex colors in the comments panel broke dark mode (PR #72). Only use tokens.", 76, false],
  ["fe_form_errors.md", "feedback", "Form errors sit under the field", "Show a form error under its field, not in a toast.", 83, false],
  // Old project notes nobody reads, headed for Archive.
  ["old_payment_flow.md", "project", "The old payment flow", "Premium used a one-time payment until 2025-03, replaced by subscriptions.", 200, false],
  ["launch_checklist_2025.md", "project", "Launch checklist for v1", "The v1 launch on 2025-02-10 needed: DNS, the email sender, and the privacy page.", 230, false],
  ["holiday_banner.md", "project", "Holiday banner", "The December 2025 banner ran from Dec 1 to Dec 31 and is removed.", 160, false],
  ["api_v1_shutdown.md", "project", "API v1 shutdown", "API v1 was turned off on 2025-06-30. Nothing calls it now.", 150, false],
  ["beta_testers.md", "project", "Beta tester group", "The 2024 beta group of 12 testers was closed after launch.", 260, false],
];
// A realistic folder is mostly notes the agent reads: one per feature, all linked from a hub.
const features = ["shopping_list", "meal_planner", "nutrition_panel", "unit_converter", "recipe_import", "print_view", "comments", "ratings", "collections", "follow_cooks", "push_alerts", "email_digest", "pantry", "cook_mode", "timers", "serving_scaler", "tags", "search_filters", "recipe_editor", "photo_upload", "share_links", "offline_mode", "account_export", "premium_plans", "onboarding", "moderation", "reports_queue", "admin_panel", "translations", "accessibility"];
for (const [i, f] of features.entries()) {
  const label = f.replace(/_/g, " ");
  notes.push([`feature_${f}.md`, "project", `How ${label} works`, `${label[0].toUpperCase() + label.slice(1)} lives in \`src/${f}/\`. Its API routes start with \`/api/${f.replace(/_/g, "-")}\`, and its tests are in \`tests/${f}.test.ts\`.`, 40 + (i % 50), true]);
}
notes.push(["features_hub.md", "reference", "Features hub", features.map((f) => `- [${f.replace(/_/g, " ")}](feature_${f}.md)`).join("\n"), 100, true]);
// More lessons nobody looked up, in pairs that say the same thing, under a third hub.
const lessons = [
  ["api_errors", "API errors use one shape", "Every API error returns `{ error, code }`. A bare string broke the mobile app in v2.4.", "Errors from the API keep the `{ error, code }` shape; PR #88 returned a string and the app crashed."],
  ["api_pagination", "Lists are paginated by cursor", "List endpoints page by cursor, never by offset; offsets skipped recipes in PR #91.", "Use a cursor for every list endpoint. Offset paging dropped items while new recipes arrived."],
  ["api_rate_limits", "Rate limits per user", "The API limits each user to 60 requests a minute; tests must not hit the real limiter.", "Stub the rate limiter in tests. The real one (60 a minute) made CI fail in PR #95."],
  ["api_versions", "Breaking changes need a version", "A breaking API change ships under a new version path, as v2 did on 2025-06-30.", "Never change a response shape in place; add a version, as with v2."],
];
for (const [i, [k, desc, a, b]] of lessons.entries()) {
  notes.push([`${k}.md`, "feedback", desc, a, 75 + i * 3, false]);
  notes.push([`${k}_again.md`, "feedback", `${desc} (again)`, b, 70, false]);
}
notes.push(["api_hub.md", "reference", "API hub", lessons.map(([k, d]) => `- [${d}](${k}.md)`).join("\n"), 100, true]);
// Old sprint notes nobody reads any more, headed for Archive.
for (let w = 1; w <= 10; w++) notes.push([`sprint_2025_w${String(w * 4).padStart(2, "0")}.md`, "project", `Sprint notes, 2025 week ${w * 4}`, `Goals for 2025 week ${w * 4}: ship ${features[w * 2]} fixes and close ${w + 3} bugs. Done.`, 180 + w * 10, false]);
for (const [name, type, desc, body, age] of notes) write(name, mem(name.slice(0, -3), type, desc, body), age);
write("MEMORY.md", [
  "# Recipe Box memory",
  "- [Who I work with](user_role.md)",
  "- [Deploys run from main](deploy_from_main.md)",
  "- [Run migrations by hand](db_migrations.md)",
  "- [Photos go through the CDN](image_cdn.md)",
  "- [Search index is nightly](search_index.md)",
  "- [Testing »](tests_hub.md) [Frontend »](ui_hub.md) [API »](api_hub.md) [Features »](features_hub.md)",
  "- [Old payment flow](old_payment_flow.md)",
  "",
].join("\n"), 2);

// Session logs: one 70 days ago, so sleep has a full window of usage on record, and recent ones reading the used files.
let n = 0;
const session = (ageDays, reads) => {
  const sid = `demo-${++n}`;
  const at = new Date(Date.now() - ageDays * DAY).toISOString();
  const lines = [];
  reads.forEach((name, i) => {
    const id = `toolu_${sid}_${i}`;
    const fp = name ? path.join(memDir, name) : null;
    const input = fp ? { file_path: fp } : { command: "ls" };
    const result = fp ? files[name] : "src";
    lines.push(JSON.stringify({ type: "assistant", timestamp: at, cwd: project, message: { content: [{ type: "tool_use", id, name: fp ? "Read" : "Bash", input }] } }));
    lines.push(JSON.stringify({ type: "user", timestamp: at, cwd: project, message: { content: [{ type: "tool_result", tool_use_id: id, content: result }] } }));
  });
  fs.writeFileSync(path.join(pdir, `${sid}.jsonl`), lines.join("\n") + "\n");
};
session(70, [null]);
const used = notes.filter((x) => x[5]).map((x) => x[0]);
for (let d = 1; d <= 25; d += 4) session(d, ["MEMORY.md", ...used.filter((_, i) => (i + d) % 2 === 0)]);
session(3, ["MEMORY.md", ...used]);

const here = path.dirname(fileURLToPath(import.meta.url));
// Absolute and quoted: sleep runs the stand-in from an empty folder, so a relative path would not resolve.
const q = (p) => `'${p.replace(/'/g, `'\\''`)}'`;
const cli = q(path.join(here, "..", "sleep.mjs"));
const canned = q(path.join(here, "demo-claude.mjs"));
console.log(`Demo memory: ${memDir}
${Object.keys(files).length} files, ${n} sessions. Try:

  CLAUDE_CONFIG_DIR=${q(claude)} node ${cli} report --project ${q(project)}
  CLAUDE_CONFIG_DIR=${q(claude)} SLEEP_CLAUDE=${canned} node ${cli} review --serve --project ${q(project)}

The second serves the page with a canned stand-in for Claude, so Consolidate runs offline and costs nothing.`);
