// Tests for `sleep report`: inventory, usage by content, the ledger, checks and candidates.
// Every fixture lives in a temp folder that stands in for ~/.claude, so nothing real is read or written.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "sleep.mjs");
const DAY = 864e5;

const key = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
const mem = (name, type, desc, body) => `---\nname: ${name}\ndescription: ${desc}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;

// A fake ~/.claude with one project, its memory folder, and helpers to write session logs.
function fixture() {
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), "sleep-test-"));
  const project = path.join(claude, "work", "proj");
  fs.mkdirSync(project, { recursive: true });
  const pdir = path.join(claude, "projects", key(project));
  const memDir = path.join(pdir, "memory");
  fs.mkdirSync(memDir, { recursive: true });
  const write = (name, text, ageDays = 90) => {
    const f = path.join(memDir, name);
    fs.writeFileSync(f, text);
    const t = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(f, t, t);
  };
  let n = 0;
  // One session = one .jsonl; entries are [kind, payload] pairs turned into log lines.
  const session = (entries, { ageDays = 1, dir = pdir, sub = null } = {}) => {
    const sid = `s${++n}`;
    const at = new Date(Date.now() - ageDays * DAY).toISOString();
    const lines = [];
    for (const [i, e] of entries.entries()) {
      const id = `toolu_${sid}_${i}`;
      lines.push(JSON.stringify({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name: e.tool, input: e.input || {} }] } }));
      lines.push(JSON.stringify({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id, content: e.result ?? "" }] } }));
    }
    let file = path.join(dir, `${sid}.jsonl`);
    if (sub) { fs.mkdirSync(path.join(dir, sid, "subagents"), { recursive: true }); fs.writeFileSync(file, ""); file = path.join(dir, sid, "subagents", `${sub}.jsonl`); }
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return { sid, file };
  };
  const state = path.join(claude, "state");
  const run = (args = [], env = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: claude, ...env } });
    return r;
  };
  const report = (extra = []) => {
    const r = run(["report", "--project", project, "--state", state, "--json", ...extra]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  return { claude, project, pdir, memDir, write, session, state, run, report };
}

const ALPHA = "Alpha says the deploy runs from the main branch every morning.";
const BETA = "Beta notes that the staging database is rebuilt nightly at two.";
const GAMMA = "Gamma records that the flaky login test needs a retry wrapper.";
const DELTA = "Delta warns that the cache must be cleared before a schema change.";
const EPS = "Epsilon explains the old payment flow that was replaced in March.";
const ZETA = "Zeta lists the reviewers who own the frontend checkout component.";

function standard(fx) {
  fx.write("MEMORY.md", "# Index\n- [Alpha](alpha.md): deploys\n- [Hub](hub_ops.md): ops\n", 1);
  fx.write("alpha.md", mem("alpha", "project", "Deploys run from main", ALPHA));
  fx.write("beta.md", mem("beta", "project", "Staging rebuild", BETA));
  fx.write("gamma.md", mem("gamma", "project", "Flaky login test", GAMMA));
  fx.write("delta.md", mem("delta", "project", "Clear cache before schema change", DELTA));
  fx.write("eps.md", mem("eps", "project", "Old payment flow", EPS));
  fx.write("zeta.md", mem("zeta", "feedback", "Frontend reviewers", ZETA));
  fx.write("hub_ops.md", mem("hub_ops", "reference", "Ops hub", "- [Beta](beta.md)\n- [[gamma]]"));
}

test("usage counts a file whose text came back, whatever command was used", () => {
  const fx = fixture(); standard(fx);
  fx.session([{ tool: "Bash", input: { command: "cat alpha.md" }, result: `---\nname: alpha\n---\n\n${ALPHA}\n` }]);
  fx.session([{ tool: "Read", input: { file_path: path.join(fx.memDir, "beta.md") }, result: `<system-reminder>This memory is 3 days old.</system-reminder>\n1\t---\n6\t\n7\t${BETA}\n` }]);
  fx.session([{ tool: "Grep", input: { pattern: "flaky" }, result: `${path.join(fx.memDir, "gamma.md")}:7:${GAMMA}` }]);
  fx.session([{ tool: "Bash", input: { command: "python3 -c 'print(open(x).read())'" }, result: [{ type: "text", text: `${DELTA}\n` }] }]);
  const r = fx.report();
  const used = Object.fromEntries(r.files.map((f) => [f.name, f.usage.sessions]));
  assert.equal(used["alpha.md"], 1, "cat");
  assert.equal(used["beta.md"], 1, "Read with line numbers");
  assert.equal(used["gamma.md"], 1, "grep content output");
  assert.equal(used["delta.md"], 1, "array result from a script");
  assert.equal(used["eps.md"], 0);
});

test("a memory the harness attaches on its own counts as use", () => {
  const fx = fixture(); standard(fx);
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(fx.pdir, "recall.jsonl"), JSON.stringify({ type: "attachment", timestamp: at, attachment: { type: "relevant_memories", memories: [{ path: "eps.md", content: `---\nname: eps\n---\n${EPS}` }] } }) + "\n");
  assert.equal(fx.report().files.find((f) => f.name === "eps.md").usage.sessions, 1);
});

test("an old copy of MEMORY.md loaded at session start is not use of the files its lines moved to", () => {
  const fx = fixture(); standard(fx);
  const at = new Date().toISOString();
  // Before a tidy-up, GAMMA's line sat in the index; now it lives in gamma.md. The session only loaded the index.
  const files = [{ path: path.join(fx.memDir, "MEMORY.md"), type: "AutoMem", content: `# Index\n${GAMMA}\n` }];
  fs.writeFileSync(path.join(fx.pdir, "start.jsonl"), JSON.stringify({ type: "attachment", timestamp: at, attachment: { type: "instructions", files } }) + "\n");
  assert.equal(fx.report().files.find((f) => f.name === "gamma.md").usage.sessions, 0);
});

test("a memory that quotes tool output is not used just because the tool printed that output", () => {
  const fx = fixture(); standard(fx);
  const out = "ERROR tests/smoke_test.py::test_collect_everything\n!!!!!!!!!! stopping after 1 failures !!!!!!!!!!\n122 passed, 49 skipped, 5 warnings, 1 error in 175.14s";
  fx.write("trap.md", mem("trap", "project", "pytest -x trap", `The run printed:\n${out}\nThe collection error silently caps every run that uses the stop-on-first-failure flag.`));
  fx.session([{ tool: "Bash", input: { command: "pytest -x" }, result: out }]);
  assert.equal(fx.report().files.find((f) => f.name === "trap.md").usage.sessions, 0);
  fx.session([{ tool: "Bash", input: { command: "cat trap.md" }, result: fs.readFileSync(path.join(fx.memDir, "trap.md"), "utf8") }]);
  assert.equal(fx.report().files.find((f) => f.name === "trap.md").usage.sessions, 1);
});

test("one quoted error line is not use; two lines, or one line from a command that names the file, is", () => {
  const fx = fixture(); standard(fx);
  const err = "failed to run git: fatal: 'main' is already used by worktree at /tmp/x";
  const how = "Run the merge from the primary checkout so the local branch can be updated afterwards.";
  fx.write("merge.md", mem("merge", "project", "gh merge from a worktree", `The merge printed:\n${err}\n${how}`));
  fx.session([{ tool: "Bash", input: { command: "gh pr merge 12" }, result: err }]);
  assert.equal(fx.report().files.find((f) => f.name === "merge.md").usage.sessions, 0, "error output alone");
  fx.session([{ tool: "Bash", input: { command: "grep -h primary merge.md" }, result: how }]);
  assert.equal(fx.report().files.find((f) => f.name === "merge.md").usage.sessions, 1, "a command naming the file");
  fx.session([{ tool: "Bash", input: { command: "cat $M/x" }, result: `${err}\n${how}` }]);
  assert.equal(fx.report().files.find((f) => f.name === "merge.md").usage.sessions, 2, "two lines");
});

test("a listing of file names is not use", () => {
  const fx = fixture(); standard(fx);
  fx.session([{ tool: "Bash", input: { command: "ls" }, result: "alpha.md\nbeta.md\neps.md\nzeta.md" }]);
  const r = fx.report();
  assert.ok(r.files.every((f) => f.usage.sessions === 0));
});

test("sessions that write memory are upkeep, not use", () => {
  const fx = fixture(); standard(fx);
  fx.session([
    { tool: "Bash", input: { command: "cat eps.md" }, result: EPS },
    { tool: "Edit", input: { file_path: path.join(fx.memDir, "zeta.md"), old_string: "a", new_string: "b" }, result: ZETA },
  ]);
  fx.session([
    { tool: "Bash", input: { command: "cat beta.md" }, result: BETA },
    { tool: "Bash", input: { command: `sed -i '' 's/x/y/' ${fx.memDir}/alpha.md` }, result: "" },
  ]);
  const r = fx.report();
  for (const f of r.files) assert.equal(f.usage.sessions, 0, f.name);
  assert.equal(r.usage.upkeepSessions, 2);
});

test("a subagent's reads count for its parent session", () => {
  const fx = fixture(); standard(fx);
  fx.session([{ tool: "Bash", input: { command: "cat eps.md" }, result: EPS }], { sub: "agent-1" });
  const r = fx.report();
  assert.equal(r.files.find((f) => f.name === "eps.md").usage.sessions, 1);
});

test("a file with no line long enough to recognize is no data, never unused", () => {
  const fx = fixture(); standard(fx);
  fx.write("tiny.md", mem("tiny", "project", "Tiny", "short"));
  const r = fx.report();
  assert.equal(r.files.find((f) => f.name === "tiny.md").usage.status, "no data");
  assert.equal(r.files.find((f) => f.name === "eps.md").usage.status, "unused");
});

test("the ledger keeps use after the session log is deleted", () => {
  const fx = fixture(); standard(fx);
  const { file } = fx.session([{ tool: "Bash", input: { command: "cat alpha.md" }, result: ALPHA }], { ageDays: 5 });
  const first = fx.report();
  const last = first.files.find((f) => f.name === "alpha.md").usage.lastUsed;
  assert.ok(last);
  fs.rmSync(file);
  const second = fx.report();
  assert.equal(second.files.find((f) => f.name === "alpha.md").usage.lastUsed, last);
  assert.equal(second.files.find((f) => f.name === "alpha.md").usage.sessions, 1);
});

test("nothing is a candidate until usage history covers the window", () => {
  const fx = fixture(); standard(fx);
  fx.session([{ tool: "Bash", input: { command: "cat alpha.md" }, result: ALPHA }], { ageDays: 10 });
  const r = fx.report(["--days", "60"]);
  assert.equal(r.candidates.length, 0);
  assert.match(r.candidatesNote, /covers 10 days/);
});

test("candidates are unused, expirable, unprotected and old enough", () => {
  const fx = fixture(); standard(fx);
  fx.write("fresh.md", mem("fresh", "project", "Written yesterday", "Fresh memory written yesterday about the release checklist."), 1);
  fx.session([{ tool: "Bash", input: { command: "cat beta.md" }, result: BETA }], { ageDays: 70 });
  fx.session([{ tool: "Bash", input: { command: "cat delta.md" }, result: DELTA }], { ageDays: 3 });
  const names = fx.report(["--days", "60"]).candidates.map((c) => c.name).sort();
  // alpha: linked from MEMORY.md. beta: last used 70 days ago. delta: used 3 days ago. zeta: feedback.
  // hub_ops: reference. fresh: edited a day ago. gamma: unused, linked only from a hub.
  assert.deepEqual(names, ["beta.md", "eps.md", "gamma.md"]);
});

test("unused feedback memories are never archived but are queued for consolidation", () => {
  const fx = fixture(); standard(fx);
  fx.write("old_lesson.md", mem("old_lesson", "feedback", "An old lesson", "An old lesson about retrying the flaky upload step twice before giving up."));
  fx.write("new_lesson.md", mem("new_lesson", "feedback", "A new lesson", "A new lesson about pinning the browser version in the end to end tests."), 1);
  fx.session([{ tool: "Bash", input: { command: "cat beta.md" }, result: BETA }], { ageDays: 70 });
  const r = fx.report(["--days", "60"]);
  const cand = r.candidates.map((c) => c.name), queue = r.consolidate.map((c) => c.name).sort();
  assert.ok(!cand.includes("old_lesson.md") && !cand.includes("zeta.md"));
  // zeta: unused feedback. old_lesson: unused feedback. new_lesson: created yesterday.
  assert.deepEqual(queue, ["old_lesson.md", "zeta.md"]);
});

test("age is when a file was created, so a tidy-up that edits every file does not reset it", { skip: process.platform !== "darwin" && "needs file creation times" }, () => {
  const fx = fixture(); standard(fx);
  // Created 90 days ago, then rewritten today: still old enough to be a candidate.
  const f = path.join(fx.memDir, "eps.md");
  fs.writeFileSync(f, mem("eps", "project", "Old payment flow, tidied", EPS));
  fs.utimesSync(f, new Date(), new Date());
  fx.session([{ tool: "Bash", input: { command: "cat beta.md" }, result: BETA }], { ageDays: 70 });
  assert.ok(fx.report(["--days", "60"]).candidates.some((c) => c.name === "eps.md"));
});

test("a project memory that a feedback memory links to is kept", () => {
  const fx = fixture(); standard(fx);
  fx.write("zeta.md", mem("zeta", "feedback", "Frontend reviewers", `${ZETA}\nSee [[eps]].`));
  fx.session([{ tool: "Bash", input: { command: "cat beta.md" }, result: BETA }], { ageDays: 70 });
  const names = fx.report(["--days", "60"]).candidates.map((c) => c.name);
  assert.ok(!names.includes("eps.md"));
  assert.ok(names.includes("gamma.md"));
});

test("checks catch an index past the cap, broken links and long descriptions", () => {
  const fx = fixture(); standard(fx);
  const long = Array.from({ length: 210 }, (_, i) => `- line ${i}`).join("\n");
  fx.write("MEMORY.md", `- [Gone](missing.md)\n${long}\n`, 1);
  fx.write("wordy.md", mem("wordy", "project", "x".repeat(200), "A body line that is long enough to be recognized later on."));
  const r = fx.report();
  const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.equal(by["index-cap"].status, "fail");
  assert.equal(by["index-links"].status, "fail");
  assert.deepEqual(by["index-links"].files, ["missing.md"]);
  assert.equal(by["description-length"].status, "warn");
  assert.ok(by["description-length"].files.includes("wordy.md"));
  assert.ok(r.index.truncatedLines > 0);
});

test("report writes markdown and json and never touches the memory folder", () => {
  const fx = fixture(); standard(fx);
  fx.session([{ tool: "Bash", input: { command: "cat alpha.md" }, result: ALPHA }]);
  const hash = () => {
    const h = crypto.createHash("sha256");
    for (const f of fs.readdirSync(fx.memDir).sort()) { const p = path.join(fx.memDir, f); h.update(f); h.update(fs.readFileSync(p)); h.update(String(fs.statSync(p).mtimeMs)); }
    return h.digest("hex");
  };
  const before = hash();
  const out = path.join(fx.claude, "reports");
  const r = fx.run(["report", "--project", fx.project, "--state", fx.state, "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(hash(), before);
  const files = fs.readdirSync(out).sort();
  assert.equal(files.length, 2);
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}.*\.json$/);
  const md = fs.readFileSync(path.join(out, files[1]), "utf8");
  for (const h of ["## Summary", "## Checks", "## Usage", "## Archive candidates"]) assert.ok(md.includes(h), h);
  assert.ok(!md.includes("\u2014"), "no em dashes");
});
