// Tests for the consolidation support the /sleep skill uses: `sleep queue` and `sleep merged`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mem, fixture, standard, BETA, DELTA, ZETA } from "./helpers.mjs";

const THETA = "Theta says to run the slow browser suite only on the merge queue.";
const IOTA = "Iota says retry a flaky browser test once, then quarantine it.";
const KAPPA = "Kappa notes the support inbox is checked every weekday morning.";

// Three unused feedback memories: two filed under a testing hub, one under nothing.
function setup() {
  const fx = fixture(); standard(fx);
  fx.write("theta.md", mem("theta", "feedback", "Slow suite on merge queue", THETA));
  fx.write("iota.md", mem("iota", "feedback", "Retry flaky once", IOTA));
  fx.write("kappa.md", mem("kappa", "feedback", "Support inbox", `${KAPPA}\nSee [[theta]] and [[iota|the flaky rule]].`));
  fx.write("hub_testing.md", mem("hub_testing", "reference", "Testing hub", "- [slow suite](theta.md) · [flaky](iota.md)"));
  fx.write("MEMORY.md", "# Index\n- [Alpha](alpha.md): deploys\n- [Hub](hub_ops.md): ops\n- [Testing](hub_testing.md): tests\n", 1);
  fx.session([{ tool: "Bash", input: { command: "cat beta.md" }, result: BETA }], { ageDays: 70 });
  fx.session([{ tool: "Bash", input: { command: "cat delta.md" }, result: DELTA }], { ageDays: 3 });
  const cli = (args) => fx.run([...args, "--project", fx.project, "--state", fx.state, "--days", "60"]);
  const ok = (args) => { const r = cli(args); assert.equal(r.status, 0, r.stderr); return r; };
  ok(["archive", "--apply"]);
  const git = (...a) => spawnSync("git", ["-C", fx.memDir, ...a], { encoding: "utf8" }).stdout.trim();
  return { fx, cli, ok, git };
}

test("queue groups queued memories by the hub that links to them", () => {
  const { ok } = setup();
  const q = JSON.parse(ok(["queue", "--json"]).stdout);
  const byTopic = Object.fromEntries(q.topics.map((t) => [t.topic, t.files.map((f) => f.name).sort()]));
  assert.deepEqual(byTopic["hub_testing.md"], ["iota.md", "theta.md"]);
  assert.deepEqual(byTopic.unfiled, ["kappa.md", "zeta.md"]);
  const theta = q.topics.find((t) => t.topic === "hub_testing.md").files.find((f) => f.name === "theta.md");
  assert.equal(theta.rel, "consolidate/theta.md");
  assert.equal(theta.description, "Slow suite on merge queue");
});

test("merged archives the sources, points their links at the merged file, and commits", () => {
  const { fx, ok, git } = setup();
  fs.writeFileSync(path.join(fx.memDir, "browser_tests.md"), mem("browser_tests", "feedback", "Browser test rules", `${THETA}\n${IOTA}`));
  ok(["merged", "--into", "browser_tests.md", "theta.md", "iota.md"]);
  assert.ok(!fs.existsSync(path.join(fx.memDir, "consolidate", "theta.md")));
  assert.ok(fs.existsSync(path.join(fx.memDir, "memory-archive", "theta.md")));
  assert.ok(fs.existsSync(path.join(fx.memDir, "memory-archive", "iota.md")));
  assert.equal(fs.readFileSync(path.join(fx.memDir, "hub_testing.md"), "utf8").split("\n").find((l) => l.startsWith("- ")), "- [slow suite](browser_tests.md) · [flaky](browser_tests.md)");
  const moves = JSON.parse(fs.readFileSync(path.join(fx.state, "moves.json"), "utf8"));
  const merged = moves.filter((m) => m.kind === "merged");
  assert.deepEqual(merged.map((m) => [m.name, m.into, m.to]).sort(), [["iota.md", "browser_tests.md", "memory-archive/iota.md"], ["theta.md", "browser_tests.md", "memory-archive/theta.md"]]);
  // [[slug]] links follow the merge too; the label after | stays.
  assert.match(fs.readFileSync(path.join(fx.memDir, "consolidate", "kappa.md"), "utf8"), /See \[\[browser_tests\]\] and \[\[browser_tests\|the flaky rule\]\]\./);
  assert.match(git("log", "-1", "--format=%s"), /^sleep: merged 2 into browser_tests\.md$/);
  assert.equal(git("status", "--porcelain"), "");
  // The merged file is in the commit too, so reverting the commit undoes the whole merge.
  assert.match(git("show", "--stat", "--format=", "HEAD"), /browser_tests\.md/);
});

test("merged refuses a target that is missing, queued or archived, and a source that is not queued", () => {
  const { fx, cli } = setup();
  const before = fs.readFileSync(path.join(fx.memDir, "hub_testing.md"), "utf8");
  assert.match(cli(["merged", "--into", "nope.md", "theta.md"]).stderr, /Write the merged memory first/);
  assert.match(cli(["merged", "--into", "consolidate/kappa.md", "theta.md"]).stderr, /top of the memory folder/);
  fs.writeFileSync(path.join(fx.memDir, "browser_tests.md"), mem("browser_tests", "feedback", "Browser test rules", THETA));
  assert.match(cli(["merged", "--into", "browser_tests.md", "alpha.md"]).stderr, /not in the consolidation queue/);
  assert.match(cli(["merged", "--into", "browser_tests.md", "beta.md"]).stderr, /not in the consolidation queue/, "archived, not queued");
  assert.match(cli(["merged", "--into", "browser_tests.md"]).stderr, /Name the queued memories/);
  assert.equal(fs.readFileSync(path.join(fx.memDir, "hub_testing.md"), "utf8"), before);
  assert.ok(fs.existsSync(path.join(fx.memDir, "consolidate", "theta.md")));
});

test("after a merge the report sees the merged file as live and the sources as archived", () => {
  const { fx, ok } = setup();
  fs.writeFileSync(path.join(fx.memDir, "browser_tests.md"), mem("browser_tests", "feedback", "Browser test rules", `${THETA}\n${IOTA}`));
  ok(["merged", "--into", "browser_tests.md", "theta.md", "iota.md"]);
  const r = fx.report(["--days", "60"]);
  const area = (n) => r.files.find((f) => f.name === n)?.area;
  assert.equal(area("browser_tests.md"), "main");
  assert.equal(area("theta.md"), "archive");
  assert.equal(area("kappa.md"), "consolidate");
});

test("the plugin manifest, marketplace and skill are where Claude Code looks for them", () => {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const plugin = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
  const market = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(plugin.name, "sleep");
  assert.equal(market.plugins[0].name, "sleep");
  assert.equal(market.plugins[0].source, "./");
  const skill = fs.readFileSync(path.join(root, "skills", "sleep", "SKILL.md"), "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill)[1];
  assert.match(fm, /^name: sleep$/m);
  assert.match(fm, /^description: .{40,}/m);
  // The skill runs the bundled CLI, never a copy somewhere else.
  assert.match(skill, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/sleep\.mjs"/);
  assert.ok(!skill.includes("—"), "no em dashes");
});
