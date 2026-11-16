// Tests for deciding on the review page: archive --only, and the served page (key, host and origin checks, and
// actions that only do what the plan or the draft file allows, whatever the page sends).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { mem, fixture, standard, CLI, BETA, DELTA } from "./helpers.mjs";

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

// Starts `review --serve` on a free port and returns helpers that speak to it.
async function serve(t, flags, fx) {
  const p = spawn(process.execPath, [CLI, "review", "--serve", "--port", "0", ...flags], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CLAUDE_CONFIG_DIR: fx.claude } });
  t.after(() => p.kill());
  const url = await new Promise((resolve, reject) => {
    let out = "";
    p.stdout.on("data", (c) => { out += c; const m = /Review: (http:\/\/\S+)/.exec(out); if (m) resolve(new URL(m[1])); });
    p.on("close", (code) => reject(new Error(`server exited ${code}`)));
  });
  const token = url.searchParams.get("token");
  const req = (method, pathname, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: url.port, method, path: pathname, headers: { Host: `127.0.0.1:${url.port}`, ...headers } }, (res) => {
      let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on("error", reject);
    if (body != null) r.write(typeof body === "string" ? body : JSON.stringify(body));
    r.end();
  });
  const act = (pathname, body, headers = {}) => req("POST", pathname, { headers: { "Content-Type": "application/json", "X-Sleep-Token": token, ...headers }, body });
  return { url, token, req, act };
}

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
  const nonce = /script-src 'nonce-([^']+)'/.exec(page.headers["content-security-policy"])[1];
  const scripts = [...page.body.matchAll(/<script([^>]*)>/g)];
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0][1].includes(`nonce="${nonce}"`));
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
