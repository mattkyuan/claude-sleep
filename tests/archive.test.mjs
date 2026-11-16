// Tests for `sleep archive` and `sleep restore`: moves, link rewrites, the search-order line, git, restore, purge.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mem, fixture, standard, BETA, DELTA, ZETA } from "./helpers.mjs";

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
