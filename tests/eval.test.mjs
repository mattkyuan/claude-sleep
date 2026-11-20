// Tests for the eval harness (eval/run.mjs, eval/score.mjs) against a fake claude: every call runs clean on the
// subscription against its own arm's memory copy, anything that would make a run untrustworthy stops it, and scoring
// is blind and follows the plan's bars.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, mem } from "./helpers.mjs";
import { bars } from "../eval/score.mjs";

const RUN = path.join(ROOT, "eval", "run.mjs"), SCORE = path.join(ROOT, "eval", "score.mjs");
const FAKE = path.join(ROOT, "tests", "fake-eval-claude.mjs");
const PROBES = [
  { id: "commit", kind: "rule", prompt: "Write a commit message; see commit_style.", mustNot: ["\u2014"] },
  { id: "deploy", kind: "fact", source: "deploy_day.md", prompt: "When do deploys run? deploy_day", must: ["Thursday"] },
  { id: "old", kind: "fact", source: "old_flow.md", prompt: "How did the old_flow work?", judge: "Says the old flow used cheques." },
];

function setup({ probes = PROBES, freeze = true } = {}) {
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sleep-eval-")));
  const home = path.join(t, "home"), config = path.join(t, "config"), work = path.join(t, "work"), dir = path.join(t, "eval");
  for (const d of [home, config, dir]) fs.mkdirSync(d, { recursive: true });
  const arm = (label, files) => {
    const d = path.join(t, "arms", label);
    for (const [n, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true }); fs.writeFileSync(path.join(d, n), text); }
    return d;
  };
  const A = arm("A", {
    "MEMORY.md": "# Index\n- [Commit](commit_style.md): no em dashes\n- [Deploy](deploy_day.md): deploy day\n",
    "commit_style.md": mem("commit_style", "feedback", "Commit style", "Commit messages use no em dashes."),
    "deploy_day.md": mem("deploy_day", "project", "Deploy day", "Deploys run on Thursday."),
    "old_flow.md": mem("old_flow", "project", "Old flow", "The old flow used cheques."),
  });
  const C = arm("C", {
    "MEMORY.md": "# Index\n- [Commit](commit_style.md)\n",
    "commit_style.md": mem("commit_style", "feedback", "Commit style", "Commit messages use no em dashes."),
    "hub.md": mem("hub", "reference", "Hub", "- [Deploy](deploy_day.md)"),
    "deploy_day.md": mem("deploy_day", "project", "Deploy day", "Deploys run on Thursday."),
    "memory-archive/old_flow.md": mem("old_flow", "project", "Old flow", "The old flow used cheques."),
  });
  fs.writeFileSync(path.join(dir, "probes.json"), JSON.stringify({ probes }));
  fs.writeFileSync(path.join(dir, "rubric.md"), "Judge only what the answer says.\n");
  const log = path.join(t, "fake.log");
  // The parent's own variables, and a desktop session's, must not reach claude; the fake's knobs pass by name.
  const env = (extra = {}) => {
    const e = { ...process.env, HOME: home, SLEEP_CLAUDE: FAKE, ANTHROPIC_API_KEY: "sk-should-never-reach-claude", ANTHROPIC_BASE_URL: "http://127.0.0.1:9", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SIMPLE: "1", STRAY_VAR: "x", FAKE_LOG: log, ...extra };
    return { ...e, SLEEP_EVAL_PASS_ENV: Object.keys(e).filter((k) => k.startsWith("FAKE_")).join(",") };
  };
  const run = (args, extra) => spawnSync(process.execPath, [RUN, ...args], { encoding: "utf8", env: env(extra) });
  const score = (args, extra) => spawnSync(process.execPath, [SCORE, ...args], { encoding: "utf8", env: env(extra) });
  const go = (extra = {}, more = []) => run(["run", "--dir", dir, "--model", "sonnet", "--config", config, "--work", work, "--arm", `A=${A}`, "--arm", `C=${C}`, "--repeats", "2", ...more], extra);
  const calls = () => { try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
  const results = () => { const out = []; for (const l of ["A", "C"]) { const d = path.join(dir, "runs", l); if (fs.existsSync(d)) for (const f of fs.readdirSync(d).filter((f) => f.endsWith(".json"))) out.push(JSON.parse(fs.readFileSync(path.join(d, f), "utf8"))); } return out; };
  if (freeze) assert.equal(run(["freeze", "--dir", dir]).status, 0);
  return { t, home, config, work, dir, A, C, run, score, go, calls, results };
}

test("every call runs clean on the subscription, against its own arm's copy, and a rerun resumes", () => {
  const s = setup();
  const r = s.go();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /All 12 calls done on claude-test-1/);
  const calls = s.calls();
  assert.equal(calls.length, 12);
  for (const c of calls) {
    assert.equal(c.env.ANTHROPIC_API_KEY, null, "no API key reaches claude");
    assert.equal(c.env.CLAUDE_CONFIG_DIR, s.config);
    assert.equal(c.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    for (const k of ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SIMPLE", "STRAY_VAR", "SLEEP_CLAUDE", "SLEEP_EVAL_PASS_ENV"]) assert.ok(!c.keys.includes(k), `${k} reaches claude`);
    for (const k of ["HOME", "PATH"]) assert.ok(c.keys.includes(k), `${k} missing`);
    for (const f of ["--strict-mcp-config", "--disable-slash-commands"]) assert.ok(c.argv.includes(f), f);
    assert.equal(c.argv[c.argv.indexOf("--tools") + 1], "Read,Grep,Glob");
    assert.equal(c.argv[c.argv.indexOf("--model") + 1], "sonnet");
    assert.ok(c.cwd.startsWith(s.work + "/arm-"), "an opaque folder per arm");
    assert.doesNotMatch(path.basename(c.cwd), /^(A|C)$/);
  }
  assert.equal(new Set(calls.map((c) => c.cwd)).size, 2);
  const res = s.results();
  assert.equal(res.length, 12);
  assert.ok(res.every((x) => x.status === "ok"));
  assert.deepEqual(res.find((x) => x.arm === "C" && x.probe === "old").reads, ["memory-archive/old_flow.md"]);
  assert.match(res.find((x) => x.arm === "A" && x.probe === "deploy").answer, /Thursday/);
  // A second run calls nothing: every result is on disk.
  assert.equal(s.go().status, 0);
  assert.equal(s.calls().length, 12);
});

test("the run refuses the real Claude folder, a work folder under home, and probes changed since the freeze", () => {
  const s = setup();
  const real = path.join(s.home, ".claude");
  fs.mkdirSync(real);
  let r = s.run(["run", "--dir", s.dir, "--model", "sonnet", "--config", real, "--work", s.work, "--arm", `A=${s.A}`]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /real Claude Code folder/);
  r = s.run(["run", "--dir", s.dir, "--model", "sonnet", "--config", s.config, "--work", path.join(s.home, "w"), "--arm", `A=${s.A}`]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /under your home folder/);
  fs.writeFileSync(path.join(s.dir, "probes.json"), JSON.stringify({ probes: [...PROBES, { id: "x", kind: "fact", prompt: "x", must: ["x"] }] }));
  r = s.go();
  assert.notEqual(r.status, 0); assert.match(r.stderr, /probes changed since the freeze/);
  const u = setup({ freeze: false });
  r = u.go();
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Not frozen/);
  assert.equal(u.calls().length + s.calls().length, 0, "nothing ran");
});

test("a search that reaches outside the arm, by a relative pattern, a glob, \"..\" or a symbolic link, voids the answer", () => {
  const outside = (env) => { const s = setup(); assert.equal(s.go(env, ["--limit", "1"]).status, 0); return s.results()[0]; };
  for (const env of [{ FAKE_GLOB: "../../elsewhere/*.md" }, { FAKE_GREP_GLOB: "../*.md" }, { FAKE_GLOB: "/etc/*.conf" }, { FAKE_GLOB: "**/../../../elsewhere/*.md" }, { FAKE_GLOB: "{..,x}/{..,y}/elsewhere/*.md" }, { FAKE_TOOL_USE: "Bash" }]) {
    const r = outside(env);
    assert.equal(r.status, "void", JSON.stringify(env));
  }
  const inside = outside({ FAKE_GLOB: "**/*.md" });
  assert.equal(inside.status, "ok", "a pattern inside the project folder is fine");
  // A path that reads as inside the project folder but runs through a link to somewhere else.
  const s = setup();
  assert.equal(s.go({}, ["--limit", "1"]).status, 0);
  const cwd = JSON.parse(fs.readFileSync(path.join(s.dir, "arms.json"), "utf8")).arms[0].cwd;
  fs.mkdirSync(path.join(s.t, "elsewhere"));
  fs.symlinkSync(path.join(s.t, "elsewhere"), path.join(cwd, "door"));
  assert.equal(s.go({ FAKE_READ: path.join(cwd, "door", "secret.md") }, ["--limit", "1"]).status, 0);
  const v = s.results().find((x) => x.status === "void");
  assert.ok(v, "the read through the link is voided"); assert.match(v.why, /elsewhere/);
});

test("an arm with a symbolic link in it is refused; with no --work, the work folder is in the system temp folder", () => {
  const s = setup();
  fs.symlinkSync(path.join(s.t, "home"), path.join(s.A, "linked"));
  const r = s.go();
  assert.notEqual(r.status, 0); assert.match(r.stderr, /linked is a symbolic link/);
  assert.equal(s.calls().length, 0);
  const u = setup();
  const tmp = path.join(u.t, "systmp");
  fs.mkdirSync(tmp);
  const r2 = u.run(["run", "--dir", u.dir, "--model", "sonnet", "--config", u.config, "--arm", `A=${u.A}`, "--repeats", "1", "--limit", "1"], { TMPDIR: tmp });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(u.calls()[0].cwd.startsWith(path.join(tmp, "sleep-eval") + "/"), u.calls()[0].cwd);
});

test("a resume refuses when an arm's memory copy or its source folder changed since the run started", () => {
  const s = setup();
  assert.equal(s.go({}, ["--limit", "2"]).status, 0);
  const arms = JSON.parse(fs.readFileSync(path.join(s.dir, "arms.json"), "utf8")).arms;
  const copy = path.join(arms[1].memDir, "deploy_day.md"), saved = fs.readFileSync(copy, "utf8");
  fs.writeFileSync(copy, saved + "edited\n");
  let r = s.go();
  assert.notEqual(r.status, 0); assert.match(r.stderr, /memory copy for arm C changed since the run started/);
  fs.writeFileSync(copy, saved);
  fs.appendFileSync(path.join(s.A, "deploy_day.md"), "edited\n");
  r = s.go();
  assert.notEqual(r.status, 0); assert.match(r.stderr, /changed since this eval started/);
  assert.equal(s.calls().length, 2, "neither resume called claude");
});

test("a call not on the subscription, with other tools, MCP, another memory folder or another model stops the run", () => {
  const cases = [
    [{ FAKE_APIKEY: "ANTHROPIC_API_KEY" }, /not the subscription/],
    [{ FAKE_TOOLS: "Bash,Glob,Grep,Read" }, /had tools/],
    [{ FAKE_MCP: "gmail" }, /MCP servers/],
    [{ FAKE_MEMPATH: "/Users/someone/.claude/projects/x/memory" }, /loaded memory from/],
  ];
  for (const [env, why] of cases) {
    const s = setup();
    const r = s.go(env);
    assert.notEqual(r.status, 0, JSON.stringify(env)); assert.match(r.stderr, why);
    assert.equal(s.calls().length, 1, "stops at the first call");
    assert.equal(s.results().length, 0, "records nothing");
  }
  const s = setup();
  const r = s.run(["run", "--dir", s.dir, "--model", "claude-pinned-9", "--config", s.config, "--work", s.work, "--arm", `A=${s.A}`]);
  assert.match(r.stderr, /ran claude-test-1, not claude-pinned-9/);
  const m = setup();
  assert.equal(m.go({}, ["--limit", "1"]).status, 0);
  const r2 = m.go({ FAKE_MODEL: "claude-test-2" });
  assert.match(r2.stderr, /earlier calls ran claude-test-1/);
});

test("a read outside the arm voids that answer; a changed memory copy or a failed call stops the run, and a rerun retries", () => {
  const s = setup();
  const other = path.join(s.t, "elsewhere.md");
  fs.writeFileSync(other, "x");
  assert.equal(s.go({ FAKE_READ: other }, ["--limit", "1"]).status, 0);
  const v = s.results()[0];
  assert.equal(v.status, "void"); assert.match(v.why, /elsewhere\.md/);
  let r = s.go({ FAKE_WRITE: "commit_style.md" });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /memory copy for arm \w changed/);
  const f = setup();
  r = f.go({ FAKE_FAIL: "deploy_day" });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /claude failed on deploy.*Rate limited/);
  const before = f.results().length;
  assert.ok(before >= 2 && !f.results().some((x) => x.probe === "deploy"), "nothing recorded for the failed call");
  assert.equal(f.go().status, 0);
  assert.equal(f.results().length, 12);
  for (const exit of ["1", "0"]) {
    const x = setup();
    r = x.go({ FAKE_IS_ERROR: "API Error: 529 overloaded", FAKE_EXIT: exit });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /claude failed on .*529 overloaded/);
    assert.equal(x.results().length, 0, "an error result is never an answer");
  }
  const k = setup();
  r = k.go({ FAKE_EXIT: "2" });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /claude failed on .*exit 2/, "an answer from a call that then failed is not kept");
  assert.equal(k.results().length, 0);
  const i = setup();
  assert.equal(i.go({ FAKE_ANSWER: '<invoke name="Read">' }, ["--limit", "1"]).status, 0);
  assert.equal(i.results()[0].status, "invalid");
});

test("the judge bundle hides which arm each answer came from; the report groups by where the file went", () => {
  const s = setup();
  assert.equal(s.go().status, 0);
  let r = s.score(["report", "--dir", s.dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /UNDECIDED\*\* \(2 pending on A; 2 pending on C\)/, "judged answers wait for verdicts");
  assert.equal(s.score(["bundle", "--dir", s.dir]).status, 0);
  const md = fs.readFileSync(path.join(s.dir, "judge", "bundle.md"), "utf8");
  const key = JSON.parse(fs.readFileSync(path.join(s.dir, "judge", "key.json"), "utf8"));
  assert.equal(Object.keys(key).length, 4, "only the judged probe, both arms, both repeats");
  const arms = JSON.parse(fs.readFileSync(path.join(s.dir, "arms.json"), "utf8")).arms;
  for (const leak of [s.config, s.work, s.t, ...arms.flatMap((a) => [a.id, a.memDir])]) assert.ok(!md.includes(leak), `bundle names ${leak}`);
  assert.match(md, /cheques\. \(from <memory>\/old_flow\.md\)/);
  assert.doesNotMatch(md, /memory-archive|consolidate\//, "where sleep put a file would say which arm it is");
  // Claude quotes the folder without the copy's path in front, too.
  const q = setup();
  assert.equal(q.go({ FAKE_ANSWER: "Per memory/memory-archive/old_flow.md and memory\\consolidate\\x.md, cheques." }).status, 0);
  assert.equal(q.score(["bundle", "--dir", q.dir]).status, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(q.dir, "judge", "bundle.md"), "utf8"), /memory-archive|consolidate[\\/]/i);
  fs.writeFileSync(path.join(s.dir, "judge", "verdicts.json"), JSON.stringify(Object.fromEntries(Object.keys(key).map((id) => [id, { pass: true }]))));
  r = s.score(["report", "--dir", s.dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Verdict: \*\*PASS\*\*/);
  assert.match(r.stdout, /\| deploy \| graduated \| 2\/2 \| 2\/2 \|/);
  assert.match(r.stdout, /\| old \| archived \|/);
  assert.match(r.stdout, /\| commit \| rule \|/);
  fs.mkdirSync(path.join(s.t, "state"));
  fs.writeFileSync(path.join(s.t, "state", "moves.json"), JSON.stringify([{ kind: "merged", name: "old_flow.md", from: "consolidate/old_flow.md", to: "memory-archive/old_flow.md", status: "active" }]));
  r = s.score(["report", "--dir", s.dir, "--moves", `C=${path.join(s.t, "state", "moves.json")}`]);
  assert.match(r.stdout, /\| old \| merged \|/);
  assert.notEqual(s.score(["bundle", "--dir", s.dir]).status, 0, "a judged bundle is not rebuilt");
});

test("the bars: one fewer passing repeat on a rule fails bar 1; groups get their slack; cost must fall", () => {
  const probes = [{ id: "r", kind: "rule" }, { id: "f1", kind: "fact" }, { id: "f2", kind: "fact" }, { id: "a1", kind: "fact" }, { id: "m1", kind: "fact" }];
  const group = { f1: "kept", f2: "kept", a1: "archived", m1: "merged" };
  const run = (A, C, idx = { A: 100, C: 90 }) => {
    const tally = { A: {}, C: {} };
    for (const [arm, v] of Object.entries({ A, C })) for (const [id, pass] of Object.entries(v)) tally[arm][id] = { pass, calls: pass, n: 3 };
    return Object.fromEntries(bars({ probes, tally, groupOf: (p) => (p.kind === "rule" ? "rule" : group[p.id]), base: "A", test: "C", indexTokens: idx }).map((b) => [b.bar, b.ok]));
  };
  const all = { r: 3, f1: 3, f2: 3, a1: 3, m1: 3 };
  assert.deepEqual(run(all, all), { 1: true, 2: true, 3: true, 4: true });
  assert.equal(run(all, { ...all, r: 2 })[1], false, "3 of 3 to 2 of 3 is worse");
  assert.equal(run(all, { ...all, f1: 2 })[2], true, "a group may lose 1");
  assert.equal(run(all, { ...all, f1: 2, f2: 2 })[2], false);
  assert.equal(run(all, { ...all, a1: 1 })[2], true, "archived may lose 2");
  assert.equal(run(all, { ...all, a1: 0 })[2], false);
  assert.equal(run(all, { ...all, m1: 2 })[3], false, "a merged fact may not lose a repeat");
  assert.equal(run(all, all, { A: 100, C: 100 })[4], false, "MEMORY.md must shrink");
  const tally = (calls) => ({ A: { r: { pass: 3, calls: 3, n: 3 } }, C: { r: { pass: 3, calls, n: 3 } } });
  const four = (calls) => bars({ probes: [probes[0]], tally: tally(calls), groupOf: () => "rule", base: "A", test: "C", indexTokens: { A: 100, C: 90 } })[3].ok;
  assert.equal(four(3), true);
  assert.equal(four(4), false, "more tool calls per pass is a cost");
});
