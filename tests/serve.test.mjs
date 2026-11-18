// Tests for deciding on the review page: archive --only, and the served page (key, host and origin checks, and
// actions that only do what the plan or the draft file allows, whatever the page sends).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mem, fixture, standard, serve, BETA, DELTA } from "./helpers.mjs";

const THETA = "Theta says to run the slow browser suite only on the merge queue.";
const IOTA = "Iota says retry a flaky browser test once, then quarantine it.";

function setup() {
  const fx = fixture(); standard(fx);
  fx.write("hub_ops.md", mem("hub_ops", "reference", "Ops hub", "- [Beta](beta.md) staging · [[gamma]] flaky · [Alpha](alpha.md)"));
  fx.write("eps.md", mem("eps", "project", "Old payment flow", "Epsilon explains the old payment flow that was replaced in March."));
  fx.session([{ tool: "Bash", input: { command: "cat beta.md" }, result: BETA }], { ageDays: 70 });
  fx.session([{ tool: "Bash", input: { command: "cat delta.md" }, result: DELTA }], { ageDays: 3 });
  const flags = ["--project", fx.project, "--state", fx.state, "--days", "60"];
  const ok = (args) => { const r = fx.run([...args, ...flags]); assert.equal(r.status, 0, r.stderr); return r; };
  const exists = (rel) => fs.existsSync(path.join(fx.memDir, rel));
  return { fx, flags, ok, exists };
}

test("archive --apply --only moves just the named planned files and ignores names the plan does not hold", () => {
  const { fx, ok, exists } = setup();
  const only = path.join(fx.state, "only.json");
  fs.mkdirSync(fx.state, { recursive: true });
  fs.writeFileSync(only, JSON.stringify(["beta.md", "MEMORY.md", "delta.md", "../outside.md"]));
  ok(["archive", "--apply", "--only", only]);
  assert.ok(exists("memory-archive/beta.md") && !exists("beta.md"), "beta moved");
  assert.ok(exists("eps.md") && exists("gamma.md"), "planned but not picked: stays");
  assert.ok(exists("MEMORY.md") && exists("delta.md"), "named but not planned: stays");
  assert.ok(fs.readFileSync(path.join(fx.memDir, "hub_ops.md"), "utf8").includes("[Beta](memory-archive/beta.md)"));
});

test("the served page needs the key, then a cookie, and runs only its own nonce-tagged script", async (t) => {
  const { fx, flags } = setup();
  const { url, token, req } = await serve(t, flags, fx);
  assert.equal((await req("GET", "/")).status, 403);
  assert.equal((await req("GET", "/?token=wrong")).status, 403);
  assert.equal((await req("GET", `/?token=${token}`, { headers: { Host: `evil.example:${url.port}` } })).status, 403, "wrong host");
  const enter = await req("GET", `/?token=${token}`);
  assert.equal(enter.status, 303);
  const cookie = enter.headers["set-cookie"][0].split(";")[0];
  const page = await req("GET", "/", { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const csp = page.headers["content-security-policy"];
  const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)[1];
  assert.doesNotMatch(csp, /https?:|unsafe-eval/);
  const scripts = [...page.body.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
  const run = scripts.filter((a) => !a.includes('type="application/json"'));
  assert.equal(run.length, 2, "the page script and the map module");
  for (const a of run) assert.ok(a.includes(`nonce="${nonce}"`), a);
  assert.ok(!scripts.some((a) => /\ssrc=/.test(a)), "no script loads from a src");
  for (const name of ["beta.md", "gamma.md", "eps.md"]) assert.match(page.body, new RegExp(`data-pick value="${name.replace(".", "\\.")}"`));
});

test("actions need the key in a header and a local origin; nothing moves otherwise", async (t) => {
  const { fx, flags, exists } = setup();
  const { act, req } = await serve(t, flags, fx);
  const noKey = await req("POST", "/apply", { headers: { "Content-Type": "application/json" }, body: { moves: ["beta.md"] } });
  assert.equal(noKey.status, 403);
  assert.equal((await act("/apply", { moves: ["beta.md"] }, { Origin: "http://evil.example" })).status, 403);
  assert.equal((await act("/apply", { moves: ["beta.md"] }, { "X-Sleep-Token": "wrong" })).status, 403);
  assert.ok(exists("beta.md"), "still in place");
});

test("apply moves only the picked files the plan holds", async (t) => {
  const { fx, flags, exists } = setup();
  const { act } = await serve(t, flags, fx);
  const r = await act("/apply", { moves: ["beta.md", "MEMORY.md", "delta.md"] });
  assert.equal(r.status, 200, r.body);
  assert.match(JSON.parse(r.body).message, /^Moved 1 file/);
  assert.ok(exists("memory-archive/beta.md") && exists("eps.md") && exists("MEMORY.md") && exists("delta.md"));
});

test("notes for Claude are saved and reach the skill; merge takes its sources from the draft file, not the request", async (t) => {
  const { fx, flags, ok, exists } = setup();
  fx.write("theta.md", mem("theta", "feedback", "Slow suite", THETA));
  fx.write("iota.md", mem("iota", "feedback", "Retry flaky once", IOTA));
  ok(["archive", "--apply"]);
  const drafts = path.join(fx.state, "drafts");
  fs.mkdirSync(drafts, { recursive: true });
  fs.writeFileSync(path.join(drafts, "browser_tests.md"), `---\nname: browser_tests\ndescription: Browser test rules\nsleep_sources: theta.md, iota.md\nmetadata:\n  type: feedback\n---\n\n${THETA}\n${IOTA}\n`);
  const { act } = await serve(t, flags, fx);

  assert.equal((await act("/note", { draft: "browser_tests.md", note: "Keep the quarantine step first." })).status, 200);
  const q = JSON.parse(ok(["queue", "--json"]).stdout);
  assert.equal(q.notes["browser_tests.md"].note, "Keep the quarantine step first.");
  for (const bad of ["../config.json", "nope.md", "x/../browser_tests.md"]) assert.equal((await act("/note", { draft: bad, note: "x" })).status, 400, bad);

  // The request names extra sources; the server ignores them and uses the draft's sleep_sources line.
  const r = await act("/merge", { draft: "browser_tests.md", sources: ["zeta.md"] });
  assert.equal(r.status, 200, r.body);
  assert.ok(exists("browser_tests.md") && exists("memory-archive/theta.md") && exists("memory-archive/iota.md"));
  assert.ok(exists("consolidate/zeta.md"), "zeta untouched");
  assert.equal(JSON.parse(ok(["queue", "--json"]).stdout).notes["browser_tests.md"], undefined, "a merge clears its note");
});

test("a note is open until the draft is rewritten after it", () => {
  const { fx, ok } = setup();
  ok(["archive", "--apply"]);
  const drafts = path.join(fx.state, "drafts");
  fs.mkdirSync(drafts, { recursive: true });
  const draft = path.join(drafts, "front.md");
  fs.writeFileSync(draft, `---\nname: front\ndescription: Front\nsleep_sources: zeta.md\nmetadata:\n  type: feedback\n---\n\nx\n`);
  const mtime = fs.statSync(draft).mtimeMs;
  const note = (atMs) => fs.writeFileSync(path.join(fx.state, "notes.json"), JSON.stringify({ "front.md": { note: "Name the reviewers.", at: new Date(atMs).toISOString() } }));
  note(mtime + 60_000);
  assert.equal(JSON.parse(ok(["queue", "--json"]).stdout).notes["front.md"].note, "Name the reviewers.", "draft older than the note: open");
  note(mtime - 60_000);
  assert.deepEqual(JSON.parse(ok(["queue", "--json"]).stdout).notes, {}, "draft rewritten after the note: handled");
});

test("merge refuses a draft named like a memory that already exists", async (t) => {
  const { fx, flags, ok, exists } = setup();
  ok(["archive", "--apply"]);
  fs.mkdirSync(path.join(fx.state, "drafts"), { recursive: true });
  fs.writeFileSync(path.join(fx.state, "drafts", "delta.md"), `---\nname: delta\ndescription: Clash\nsleep_sources: zeta.md\nmetadata:\n  type: feedback\n---\n\nx\n`);
  const { act } = await serve(t, flags, fx);
  const r = await act("/merge", { draft: "delta.md" });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.body).error, /already exists/);
  assert.ok(exists("consolidate/zeta.md"), "source still queued");
});

// A second project next to the fixture's, with one old project memory, usage on record, and a log that names its folder.
const OMEGA = "Omega records the retired billing export that ran each quarter.";
function second(fx) {
  const dir = path.join(fx.claude, "work", "other");
  fs.mkdirSync(dir, { recursive: true });
  const k = dir.replace(/[^A-Za-z0-9]/g, "-");
  const pdir = path.join(fx.claude, "projects", k);
  const memDir = path.join(pdir, "memory");
  fs.mkdirSync(memDir, { recursive: true });
  const put = (name, text) => { const f = path.join(memDir, name); fs.writeFileSync(f, text); const t = new Date(Date.now() - 90 * 864e5); fs.utimesSync(f, t, t); };
  put("MEMORY.md", "# Memory\n");
  put("omega.md", mem("omega", "project", "Old billing export", OMEGA));
  fx.session([{ tool: "Bash", input: { command: "ls" }, result: "x" }], { ageDays: 70, dir: pdir, cwd: dir });
  // The newest log ran in a subfolder, whose key differs, so it must not be taken as the project's folder.
  fx.session([{ tool: "Bash", input: { command: "ls" }, result: "x" }], { ageDays: 1, dir: pdir, cwd: path.join(dir, "sub") });
  // Left out of the list: a worktree's folder (it shares the main checkout's memory) and an empty memory folder.
  for (const [name, file] of [[`${k}--claude-worktrees-wt`, "w.md"], ["-empty-proj", null]]) {
    fs.mkdirSync(path.join(fx.claude, "projects", name, "memory"), { recursive: true });
    if (file) fs.writeFileSync(path.join(fx.claude, "projects", name, "memory", file), "x");
  }
  return { dir, key: k, pdir, memDir };
}

test("projects lists each project with memory once, by key, with its folder when a log names it", () => {
  const { fx, ok } = setup();
  const b = second(fx);
  const list = JSON.parse(ok(["projects", "--json"]).stdout);
  assert.deepEqual(list.map((p) => p.key).sort(), [fx.project.replace(/[^A-Za-z0-9]/g, "-"), b.key].sort());
  assert.equal(list.find((p) => p.key === b.key).path, b.dir);
  assert.equal(list.find((p) => p.key === b.key).files, 2);
});

test("the served page picks a project by key, renders it, and its actions act on that project and its own state", async (t) => {
  const { fx, flags, exists } = setup();
  const b = second(fx);
  const { req, token, act } = await serve(t, flags, fx);
  const enter = await req("GET", `/?token=${token}`);
  const cookie = enter.headers["set-cookie"][0].split(";")[0];
  const home = await req("GET", "/", { headers: { Cookie: cookie } });
  assert.match(home.body, new RegExp(`<option value="${b.key}"`), "the picker offers the other project");
  assert.doesNotMatch(home.body, /claude-worktrees-wt|-empty-proj/);
  const other = await req("GET", `/?project=${encodeURIComponent(b.key)}`, { headers: { Cookie: cookie } });
  assert.equal(other.status, 200);
  assert.match(other.body, /data-pick value="omega\.md"/);
  assert.doesNotMatch(other.body, /data-pick value="beta\.md"/);
  assert.ok(other.body.includes(`P = ${JSON.stringify(b.key)}`), "the page sends its project with every action");

  // Apply with the other project's key moves its file, records it in its own state, and leaves the first alone.
  const r = await act("/apply", { project: b.key, moves: ["omega.md", "beta.md"] });
  assert.equal(r.status, 200, r.body);
  assert.ok(fs.existsSync(path.join(b.memDir, "memory-archive", "omega.md")), "omega moved");
  assert.ok(exists("beta.md"), "the first project is untouched");
  assert.ok(fs.existsSync(path.join(b.pdir, "sleep", "moves.json")), "the other project keeps its own state");
  const firstMoves = path.join(fx.state, "moves.json");
  assert.ok(!fs.existsSync(firstMoves) || !fs.readFileSync(firstMoves, "utf8").includes("omega"), "not in the first project's state");
});

test("the served page refuses project keys it did not find itself", async (t) => {
  const { fx, flags, exists } = setup();
  const b = second(fx);
  const { req, token, act } = await serve(t, flags, fx);
  const cookie = (await req("GET", `/?token=${token}`)).headers["set-cookie"][0].split(";")[0];
  for (const bad of ["nope", "..", "../..", `${b.key}--claude-worktrees-wt`, "-empty-proj", b.memDir]) {
    assert.equal((await req("GET", `/?project=${encodeURIComponent(bad)}`, { headers: { Cookie: cookie } })).status, 400, bad);
    assert.equal((await act("/apply", { project: bad, moves: ["omega.md", "beta.md"] })).status, 400, bad);
  }
  assert.ok(exists("beta.md") && fs.existsSync(path.join(b.memDir, "omega.md")), "nothing moved");
});
