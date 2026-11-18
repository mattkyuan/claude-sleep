// Tests for `sleep archive` and `sleep restore`: moves, link rewrites, the search-order line, git, restore, purge.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mem, fixture, standard, BETA, DELTA, ZETA } from "./helpers.mjs";
import { applyMoves, heldLinks } from "../lib/archive.mjs";
import os from "node:os";

// Only a link that named nothing is held. f.md's link to x.md works (x.md stays put); a different x.md moving into
// the archive beside f.md must not make that link look completed by chance.
test("heldLinks holds only links that were broken before the moves", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sleep-held-"));
  for (const d of ["memory-archive", "consolidate"]) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, "x.md"), "x\n");
  fs.writeFileSync(path.join(dir, "consolidate", "x.md"), "another x\n");
  fs.writeFileSync(path.join(dir, "f.md"), "[X](x.md)\n");
  fs.writeFileSync(path.join(dir, "memory-archive", "old.md"), "[Y](y.md)\n");
  fs.writeFileSync(path.join(dir, "y.md"), "y\n");
  const held = heldLinks(dir, [
    { from: "f.md", to: "memory-archive/f.md" },
    { from: "consolidate/x.md", to: "memory-archive/x.md" },
    { from: "y.md", to: "memory-archive/y.md" },
  ]);
  assert.deepEqual([...held], [["memory-archive/y.md", ["memory-archive/old.md"]]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Every file and folder under the memory folder except git's own, as relative path -> content.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out[path.relative(dir, p) + "/"] = "(folder)"; walk(p); } else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

// The standard folder, with links that have to survive the moves, and use 70 days ago so the window is covered.
function setup() {
  const fx = fixture(); standard(fx);
  fx.write("zeta.md", mem("zeta", "feedback", "Frontend reviewers", `${ZETA}\nSee [the deploy note](alpha.md) and [[eps]].`));
  fx.write("hub_ops.md", mem("hub_ops", "reference", "Ops hub", "- [Beta](beta.md) staging · [[gamma]] flaky · [Alpha](alpha.md)"));
  fx.session([{ tool: "Bash", input: { command: "cat beta.md" }, result: BETA }], { ageDays: 70 });
  fx.session([{ tool: "Bash", input: { command: "cat delta.md" }, result: DELTA }], { ageDays: 3 });
  const archive = (extra = []) => {
    const r = fx.run(["archive", "--project", fx.project, "--state", fx.state, "--days", "60", "--json", ...extra]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const git = (...a) => spawnSync("git", ["-C", fx.memDir, ...a], { encoding: "utf8" }).stdout.trim();
  return { fx, archive, git };
}

test("archive without --apply lists the moves and changes nothing", () => {
  const { fx, archive } = setup();
  const before = snapshot(fx.memDir);
  const r = archive();
  assert.equal(r.applied, false);
  assert.deepEqual(r.moves.map((m) => `${m.kind} ${m.from} -> ${m.to}`).sort(), [
    "archive beta.md -> memory-archive/beta.md",
    "archive gamma.md -> memory-archive/gamma.md",
    "consolidate zeta.md -> consolidate/zeta.md",
  ]);
  assert.deepEqual(snapshot(fx.memDir), before);
  assert.ok(!fs.existsSync(path.join(fx.memDir, ".git")));
});

test("--apply moves files, rewrites links inside dense lines, and adds the search-order line once", () => {
  const { fx, archive } = setup();
  archive(["--apply"]);
  const s = snapshot(fx.memDir);
  assert.ok(s["memory-archive/beta.md"] && s["memory-archive/gamma.md"] && s["consolidate/zeta.md"]);
  assert.ok(!s["beta.md"] && !s["zeta.md"]);
  // Only the moved link changes; the rest of the hub line stays as it was.
  assert.match(s["hub_ops.md"], /- \[Beta\]\(memory-archive\/beta\.md\) staging · \[\[gamma\]\] flaky · \[Alpha\]\(alpha\.md\)/);
  // A moved file's own links still point at the same files.
  assert.match(s["consolidate/zeta.md"], /\[the deploy note\]\(\.\.\/alpha\.md\) and \[\[eps\]\]/);
  const hint = s["MEMORY.md"].split("\n").filter((l) => l.includes("memory-archive/"));
  assert.equal(hint.length, 1);
  archive(["--apply"]);
  assert.equal(snapshot(fx.memDir)["MEMORY.md"], s["MEMORY.md"], "a second run adds nothing");
});

test("the memory folder becomes a git repo, with a snapshot before and a commit after", () => {
  const { fx, archive, git } = setup();
  archive(["--apply"]);
  const log = git("log", "--format=%an|%s");
  const lines = log.split("\n");
  assert.equal(lines.length, 2, log);
  assert.match(lines[1], /^sleep\|sleep: snapshot before archiving/);
  assert.match(lines[0], /^sleep\|sleep: archived 2, queued 1 for consolidation/);
  assert.equal(git("status", "--porcelain"), "");
  // Edits made between runs are committed as a snapshot before the next run changes anything.
  fs.appendFileSync(path.join(fx.memDir, "alpha.md"), "\nAn extra note added by a session between runs of the tool.\n");
  archive(["--apply"]);
  assert.match(git("log", "-1", "--format=%s"), /sleep: snapshot before archiving/);
  assert.equal(git("status", "--porcelain"), "");
});

test("a name already taken in the archive gets a dated name, and the old file is untouched", () => {
  const { fx, archive } = setup();
  fs.mkdirSync(path.join(fx.memDir, "memory-archive"));
  fs.writeFileSync(path.join(fx.memDir, "memory-archive", "beta.md"), "older history\n");
  const r = archive(["--apply"]);
  const to = r.moves.find((m) => m.from === "beta.md").to;
  assert.match(to, /^memory-archive\/beta\.\d{4}-\d{2}-\d{2}\.md$/);
  assert.equal(fs.readFileSync(path.join(fx.memDir, "memory-archive", "beta.md"), "utf8"), "older history\n");
  assert.match(fs.readFileSync(path.join(fx.memDir, "hub_ops.md"), "utf8"), new RegExp(`\\(${to.replace(/\./g, "\\.")}\\)`));
});

test("restoring every moved file gives back the folder exactly as it was", () => {
  const { fx, archive } = setup();
  const before = snapshot(fx.memDir);
  const moved = archive(["--apply"]).moves.map((m) => m.from);
  for (const name of moved) {
    const r = fx.run(["restore", name, "--project", fx.project, "--state", fx.state]);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(snapshot(fx.memDir), before);
});

test("restore --all undoes a whole run in one commit", () => {
  const { fx, archive, git } = setup();
  const before = snapshot(fx.memDir);
  archive(["--apply"]);
  const r = fx.run(["restore", "--all", "--project", fx.project, "--state", fx.state]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(fx.memDir), before);
  assert.match(git("log", "-1", "--format=%s"), /^sleep: restored 3 files$/);
});

test("MEMORY.md keeps its edit date when sleep adds and removes its search-order line", () => {
  const { fx, archive } = setup();
  const index = path.join(fx.memDir, "MEMORY.md");
  const mtime = () => Math.round(fs.statSync(index).mtimeMs / 1000);
  const before = mtime();
  archive(["--apply"]);
  assert.match(fs.readFileSync(index, "utf8"), /added by sleep/);
  assert.equal(mtime(), before, "after archive");
  assert.equal(fx.run(["undo", "--project", fx.project, "--state", fx.state]).status, 0);
  assert.equal(mtime(), before, "after undo");
  archive(["--apply"]);
  assert.equal(fx.run(["restore", "--all", "--project", fx.project, "--state", fx.state]).status, 0);
  assert.doesNotMatch(fs.readFileSync(index, "utf8"), /added by sleep/);
  assert.equal(mtime(), before, "after restore");
});

// An old file in the archive already linked beta.md by bare name: broken there, since beta.md lives one level up.
// Archiving beta.md makes that link resolve by chance; restoring must leave it as it was, not point it at ../beta.md.
test("restore leaves a link that was broken before the move as it was", () => {
  const { fx, archive } = setup();
  fs.mkdirSync(path.join(fx.memDir, "memory-archive"));
  fx.write("memory-archive/old_index.md", "# Old index\n- [Beta](beta.md) staging\n- [Alpha](../alpha.md) deploys\n");
  const before = snapshot(fx.memDir);
  const moved = archive(["--apply"]).moves;
  assert.ok(moved.some((m) => m.to === "memory-archive/beta.md"));
  assert.equal(fs.readFileSync(path.join(fx.memDir, "memory-archive", "old_index.md"), "utf8"), before["memory-archive/old_index.md"], "archive leaves it alone");
  const r = fx.run(["restore", "--all", "--project", fx.project, "--state", fx.state]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(fx.memDir), before);
  // A link sleep itself rewrote still comes back: the hub's link to beta.md.
  assert.match(fs.readFileSync(path.join(fx.memDir, "hub_ops.md"), "utf8"), /\[Beta\]\(beta\.md\)/);
});

// gamma.md links beta.md, which worked, and both go to the archive, where the link still reads beta.md. Restoring
// beta.md alone must point gamma's link up a level: a link that worked before the move is never held.
test("restoring one file fixes a working link to it from another archived file", () => {
  const { fx, archive } = setup();
  fx.write("gamma.md", mem("gamma", "project", "Flaky login", "Gamma records that the flaky login test needs a retry wrapper.\nSee [Beta](beta.md)."));
  const moved = archive(["--apply"]).moves.map((m) => m.to);
  assert.ok(moved.includes("memory-archive/beta.md") && moved.includes("memory-archive/gamma.md"), moved.join());
  assert.match(fs.readFileSync(path.join(fx.memDir, "memory-archive", "gamma.md"), "utf8"), /\[Beta\]\(beta\.md\)/);
  const r = fx.run(["restore", "beta.md", "--project", fx.project, "--state", fx.state]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(fx.memDir, "memory-archive", "gamma.md"), "utf8"), /\[Beta\]\(\.\.\/beta\.md\)/);
});

test("restore refuses to overwrite a file that has come back in the meantime", () => {
  const { fx, archive } = setup();
  archive(["--apply"]);
  fs.writeFileSync(path.join(fx.memDir, "beta.md"), "a new beta written by a later session\n");
  const r = fx.run(["restore", "beta.md", "--project", fx.project, "--state", fx.state]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot go back without overwriting/);
  assert.equal(fs.readFileSync(path.join(fx.memDir, "beta.md"), "utf8"), "a new beta written by a later session\n");
  assert.ok(fs.existsSync(path.join(fx.memDir, "memory-archive", "beta.md")));
});

test("a move record pointing outside the memory folder is refused, never followed", () => {
  const { fx, archive } = setup();
  archive(["--apply"]);
  const outside = path.join(fx.claude, "outside.md");
  fs.writeFileSync(outside, "not memory\n");
  const mf = path.join(fx.state, "moves.json");
  const moves = JSON.parse(fs.readFileSync(mf, "utf8"));
  moves.push({ kind: "archive", name: "x.md", from: "../../outside.md", to: "memory-archive/x.md", at: new Date().toISOString(), status: "active" });
  moves.push({ kind: "archive", name: "y.md", from: "y.md", to: "../../../../escape.md", at: new Date().toISOString(), status: "active" });
  fs.writeFileSync(mf, JSON.stringify(moves));
  for (const name of ["x.md", "y.md"]) {
    const r = fx.run(["restore", name, "--project", fx.project, "--state", fx.state]);
    assert.notEqual(r.status, 0);
  }
  assert.equal(fs.readFileSync(outside, "utf8"), "not memory\n");
  assert.ok(!fs.existsSync(path.join(fx.memDir, "x.md")));
  assert.equal(fx.run(["restore", "--all", "--project", fx.project, "--state", fx.state]).status, 0, "good records still restore");
});

test("purge deletes archived files unused for the purge window and keeps ones used since", () => {
  const { fx, archive } = setup();
  archive(["--apply"]);
  // Pretend the archive happened 40 days ago.
  const mf = path.join(fx.state, "moves.json");
  const moves = JSON.parse(fs.readFileSync(mf, "utf8"));
  for (const m of moves) m.at = new Date(Date.now() - 40 * 864e5).toISOString();
  fs.writeFileSync(mf, JSON.stringify(moves));
  // Something read beta from the archive 5 days ago.
  fx.session([{ tool: "Bash", input: { command: "cat memory-archive/beta.md" }, result: BETA }], { ageDays: 5 });
  const r = archive(["--apply", "--purge-after", "30"]);
  assert.deepEqual(r.purged, ["memory-archive/gamma.md"]);
  assert.ok(!fs.existsSync(path.join(fx.memDir, "memory-archive", "gamma.md")));
  assert.ok(fs.existsSync(path.join(fx.memDir, "memory-archive", "beta.md")));
  assert.ok(fs.existsSync(path.join(fx.memDir, "consolidate", "zeta.md")), "queued files are never purged");
});

test("purge is off unless asked for", () => {
  const { fx, archive } = setup();
  archive(["--apply"]);
  const mf = path.join(fx.state, "moves.json");
  const moves = JSON.parse(fs.readFileSync(mf, "utf8"));
  for (const m of moves) m.at = new Date(Date.now() - 400 * 864e5).toISOString();
  fs.writeFileSync(mf, JSON.stringify(moves));
  assert.deepEqual(archive(["--apply"]).purged, []);
});

test("after the move, the report still sees queued files and counts their use", () => {
  const { fx, archive } = setup();
  archive(["--apply"]);
  fx.session([{ tool: "Bash", input: { command: "cat consolidate/zeta.md" }, result: ZETA }], { ageDays: 1 });
  const r = fx.report(["--days", "60"]);
  const z = r.files.find((f) => f.name === "zeta.md");
  assert.equal(z.area, "consolidate");
  assert.equal(z.usage.sessions, 1);
  assert.equal(r.candidates.length + r.consolidate.length, 0, "moved files are not proposed again");
});

test("applyMoves itself refuses a path outside the memory folder", () => {
  const { fx } = setup();
  assert.throws(() => applyMoves(fx.memDir, [{ from: "beta.md", to: "../escape.md" }]), /Refusing a move outside the memory folder/);
  assert.throws(() => applyMoves(fx.memDir, [], [{ from: "beta.md", to: "/tmp/x.md" }]), /Refusing/);
  assert.ok(fs.existsSync(path.join(fx.memDir, "beta.md")));
});

test("a moved file keeps its creation date; a restored one starts a new window", () => {
  const { fx, archive } = setup();
  const created = (r, name) => r.files.find((f) => f.name === name).created;
  const start = fx.report(["--days", "60"]);
  const moved = archive(["--apply"]).moves;
  const after = fx.report(["--days", "60"]);
  for (const m of moved) assert.equal(created(after, m.name), created(start, m.name), `${m.name} kept its date`);
  const r = fx.run(["restore", moved[0].from, "--project", fx.project, "--state", fx.state]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(created(fx.report(["--days", "60"]), moved[0].name), new Date().toISOString().slice(0, 10), "restored counts as new");
  assert.ok(!archive([]).moves.some((m) => m.name === moved[0].name), "so it does not move again at once");
});
