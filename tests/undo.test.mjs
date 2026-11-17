// Tests for sleep undo: it reverts sleep's newest step in the memory folder's git history and puts sleep's own records
// (moves.json, a merged draft and its record) back to match, so a later run sees the folder as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mem, fixture, standard, BETA, DELTA } from "./helpers.mjs";

const THETA = "Theta says to run the slow browser suite only on the merge queue.";
const IOTA = "Iota says retry a flaky browser test once, then quarantine it.";
const KAPPA = "Kappa notes the support inbox is checked every weekday morning.";

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
  const git = (...a) => spawnSync("git", ["-C", fx.memDir, ...a], { encoding: "utf8" }).stdout.trim();
  // Every file in the memory folder (not .git) with its text, and sleep's records.
  const tree = () => {
    const out = {};
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === ".git") continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(fx.memDir, p)] = fs.readFileSync(p, "utf8"); } };
    walk(fx.memDir);
    return out;
  };
  const moves = () => { try { return JSON.parse(fs.readFileSync(path.join(fx.state, "moves.json"), "utf8")); } catch { return []; } };
  const stateFile = (n) => { try { return fs.readFileSync(path.join(fx.state, n), "utf8"); } catch { return null; } };
  const draftOf = (into, sources, body) => {
    fs.mkdirSync(path.join(fx.state, "drafts"), { recursive: true });
    fs.writeFileSync(path.join(fx.state, "drafts", into), `---\nname: ${into.slice(0, -3)}\ndescription: merged\nsleep_sources: ${sources.join(", ")}\nmetadata:\n  type: feedback\n---\n\n${body}\n`);
  };
  return { fx, cli, ok, git, tree, moves, stateFile, draftOf };
}

test("undo after a merge puts back the files, the links, the move records and the draft", () => {
  const { fx, ok, git, tree, moves, stateFile, draftOf } = setup();
  ok(["archive", "--apply"]);
  draftOf("browser_tests.md", ["theta.md", "iota.md"], `${THETA}\n${IOTA}`);
  fs.writeFileSync(path.join(fx.state, "drafts.json"), JSON.stringify({ "browser_tests.md": { topic: "hub_testing.md", sources: {} } }));
  const before = tree(), movesBefore = moves(), draftBefore = stateFile("drafts/browser_tests.md"), metaBefore = JSON.parse(stateFile("drafts.json"));
  ok(["merged", "--into", "browser_tests.md", "theta.md", "iota.md"]);
  assert.ok(fs.existsSync(path.join(fx.memDir, "browser_tests.md")));
  const r = ok(["undo"]);
  assert.match(r.stdout, /Undid: merged 2 into browser_tests\.md/);
  assert.deepEqual(tree(), before, "files and links as before the merge");
  assert.deepEqual(moves(), movesBefore, "move records as before the merge");
  assert.equal(stateFile("drafts/browser_tests.md"), draftBefore, "the draft is back to apply again");
  assert.deepEqual(JSON.parse(stateFile("drafts.json")), metaBefore);
  assert.match(git("log", "-1", "--format=%s"), /^sleep: undid merged 2 into browser_tests\.md$/);
  assert.equal(git("status", "--porcelain"), "");
  // The folder reads as it did: the sources are queued again, and the draft can merge again.
  const rep = fx.report(["--days", "60"]);
  assert.equal(rep.files.find((f) => f.name === "theta.md").area, "consolidate");
  ok(["merged", "--into", "browser_tests.md", "theta.md", "iota.md"]);
});

test("one Apply is one step: undo takes back every commit made under the same run, newest step first", () => {
  const { fx, ok, cli, tree, moves } = setup();
  // An older copy of the same name already in the archive, as in a folder tidied by hand before sleep.
  fs.mkdirSync(path.join(fx.memDir, "memory-archive"));
  fx.write("memory-archive/theta.md", mem("theta", "feedback", "Old slow suite", THETA), 200);
  const created = () => Object.fromEntries(fx.report(["--days", "60"]).files.map((f) => [f.rel, f.created]));
  const createdStart = created();
  const start = tree();
  const plan = () => JSON.parse(ok(["archive", "--json"]).stdout).moves.map((m) => `${m.kind} ${m.name}`).sort();
  const planStart = plan();
  assert.ok(planStart.length >= 4, planStart.join());
  ok(["archive", "--apply", "--run", "r1"]);
  fs.writeFileSync(path.join(fx.memDir, "browser_tests.md"), mem("browser_tests", "feedback", "Browser test rules", `${THETA}\n${IOTA}`));
  ok(["merged", "--into", "browser_tests.md", "theta.md", "iota.md", "--run", "r1"]);
  const afterRun1 = tree(), movesRun1 = moves();
  fs.writeFileSync(path.join(fx.memDir, "inbox.md"), mem("inbox", "feedback", "Inbox", KAPPA));
  ok(["merged", "--into", "inbox.md", "kappa.md", "--run", "r2"]);
  const list = ok(["undo", "--list"]).stdout;
  assert.match(list, /merged 1 into inbox\.md[\s\S]*merged 2 into browser_tests\.md[\s\S]*archived/);
  ok(["undo"]);
  assert.deepEqual(tree(), afterRun1, "only the newest run is undone");
  assert.deepEqual(moves(), movesRun1);
  const r = ok(["undo"]);
  assert.match(r.stdout, /Undid: 2 steps: archived \d+, queued \d+ for consolidation; 1 merge\./);
  assert.deepEqual(tree(), start, "the whole first Apply, moves and merge, is gone, the search-order line too");
  assert.deepEqual(moves(), []);
  assert.deepEqual(plan(), planStart, "every file keeps its age, so the same moves are planned again");
  assert.deepEqual(created(), createdStart, "each file has its own creation date back, not a same-named copy's");
  assert.match(cli(["undo"]).stderr, /Nothing sleep did is left to undo/);
});

test("undo refuses, and changes nothing, when a later edit touched the same lines", () => {
  const { fx, ok, cli, git, moves } = setup();
  ok(["archive", "--apply"]);
  fs.writeFileSync(path.join(fx.memDir, "browser_tests.md"), mem("browser_tests", "feedback", "Browser test rules", `${THETA}\n${IOTA}`));
  ok(["merged", "--into", "browser_tests.md", "theta.md", "iota.md"]);
  const hub = path.join(fx.memDir, "hub_testing.md");
  fs.writeFileSync(hub, fs.readFileSync(hub, "utf8").replace("[slow suite](browser_tests.md)", "[slow suite, edited](browser_tests.md)"));
  const movesBefore = moves(), hubBefore = fs.readFileSync(hub, "utf8");
  const r = cli(["undo"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Nothing was undone[\s\S]*hub_testing\.md/);
  assert.equal(fs.readFileSync(hub, "utf8"), hubBefore, "the hand edit stays");
  assert.deepEqual(moves(), movesBefore);
  assert.equal(git("status", "--porcelain"), "", "no revert left half done");
  assert.match(cli(["undo", "--list"]).stdout, /merged 2 into browser_tests\.md/, "the step can still be undone later");
  // Once the hand edit is gone, the same undo goes through: the refused one left no revert in progress.
  fs.writeFileSync(hub, hubBefore.replace("[slow suite, edited](browser_tests.md)", "[slow suite](browser_tests.md)"));
  ok(["undo"]);
  assert.ok(fs.existsSync(path.join(fx.memDir, "consolidate", "theta.md")) && !fs.existsSync(path.join(fx.memDir, "browser_tests.md")));
});

test("undo takes back a restore and a MEMORY.md tightening too", () => {
  const { fx, ok, tree, moves } = setup();
  ok(["archive", "--apply"]);
  const archived = tree(), movesArchived = moves();
  ok(["restore", "beta.md"]);
  ok(["undo"]);
  assert.deepEqual(tree(), archived);
  assert.deepEqual(moves(), movesArchived);
  const f = path.join(fx.state, "changes.json");
  fs.writeFileSync(f, JSON.stringify([{ kind: "shorten", reason: "Shorter.", old: "- [Testing](hub_testing.md): tests", new: "- [Testing](hub_testing.md)" }]));
  ok(["index-apply", "--changes", f]);
  assert.notDeepEqual(tree(), archived);
  ok(["undo"]);
  assert.deepEqual(tree(), archived);
});

test("a step whose commit left the history cannot be undone, and says so", () => {
  const { fx, ok, cli, git } = setup();
  ok(["archive", "--apply"]);
  spawnSync("git", ["-C", fx.memDir, "reset", "-q", "--hard", "HEAD~1"]);
  const r = cli(["undo"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no longer in the memory folder's history/);
  assert.equal(git("status", "--porcelain"), "");
});
