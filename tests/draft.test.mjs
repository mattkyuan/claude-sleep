// Tests for "Draft with Claude" on the served page. Claude runs with no tools and gets the batch on stdin; it can only
// answer with text. The server picks the batch, checks every draft Claude returns, and is the only thing that writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mem, fixture, standard, serve } from "./helpers.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs");
const THETA = "Theta says to run the slow browser suite only on the merge queue.";
const IOTA = "Iota says retry a flaky browser test once, then quarantine it.";

// Two feedback memories queued under hub_tests, and zeta queued with no hub.
function setup() {
  const fx = fixture(); standard(fx);
  fx.write("MEMORY.md", "# Index\n- [Alpha](alpha.md): deploys\n- [Hub](hub_ops.md): ops\n- [Tests](hub_tests.md): tests\n", 1);
  fx.write("hub_tests.md", mem("hub_tests", "reference", "Test hub", "- [Theta](theta.md)\n- [Iota](iota.md)"));
  fx.write("theta.md", mem("theta", "feedback", "Slow suite", THETA));
  fx.write("iota.md", mem("iota", "feedback", "Retry flaky once", IOTA));
  fx.session([{ tool: "Bash", input: { command: "ls" }, result: "x" }], { ageDays: 70 });
  const flags = ["--project", fx.project, "--state", fx.state, "--days", "60"];
  const r = fx.run(["archive", "--apply", ...flags]);
  assert.equal(r.status, 0, r.stderr);
  const queue = JSON.parse(fx.run(["queue", "--json", ...flags]).stdout);
  assert.deepEqual(queue.topics.find((t) => t.topic === "hub_tests.md")?.files.map((f) => f.name), ["iota.md", "theta.md"], "fixture queues theta and iota under hub_tests");
  const drafts = path.join(fx.state, "drafts");
  const log = path.join(fx.claude, "fake.json");
  const env = (mode, extra = {}) => ({ SLEEP_CLAUDE: FAKE, FAKE_LOG: log, FAKE_MODE: mode, ...extra });
  return { fx, flags, drafts, log, env };
}

async function finish(act) {
  for (let i = 0; i < 100; i++) {
    const j = JSON.parse((await act("/job", {})).body).job;
    if (j && j.state !== "running") return j;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error("job did not finish");
}

test("Draft with Claude runs claude with no tools, outside the project, with the batch on stdin, and writes the draft it returns", async (t) => {
  const { fx, flags, drafts, log, env } = setup();
  const { act } = await serve(t, flags, fx, env("good"));
  const r = await act("/draft", { topic: "hub_tests.md" });
  assert.equal(r.status, 200, r.body);
  const job = await finish(act);
  assert.equal(job.state, "done", job.message);
  const seen = JSON.parse(fs.readFileSync(log, "utf8"));
  const i = seen.argv.indexOf("--tools");
  assert.ok(i >= 0 && seen.argv[i + 1] === "", "no tools");
  for (const f of ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) assert.ok(seen.argv.includes(f), f);
  assert.ok(!seen.argv.join(" ").includes(THETA), "memory text is not in the arguments");
  assert.ok(seen.input.includes(THETA) && seen.input.includes(IOTA), "memory text goes on stdin");
  assert.ok(!seen.input.includes("Zeta"), "only the chosen topic");
  const real = (p) => fs.realpathSync(p);
  assert.ok(!seen.cwd.startsWith(real(fx.claude)) && !seen.cwd.startsWith(real(fx.project)), "runs outside the project and its data");
  const text = fs.readFileSync(path.join(drafts, "merged_rules.md"), "utf8");
  assert.match(text, /sleep_sources: iota\.md, theta\.md/);
  assert.ok(fs.existsSync(path.join(fx.memDir, "consolidate", "theta.md")), "nothing merged until you approve");
});

for (const [mode, why] of [["outside", "a source outside the batch"], ["escape", "a name that leaves the drafts folder"], ["clash", "a name a memory already has"]]) {
  test(`a draft with ${why} is refused and nothing is written`, async (t) => {
    const { fx, flags, drafts, env } = setup();
    const { act } = await serve(t, flags, fx, env(mode));
    assert.equal((await act("/draft", { topic: "hub_tests.md" })).status, 200);
    const job = await finish(act);
    assert.equal(job.state, "failed");
    assert.ok(!fs.existsSync(drafts) || fs.readdirSync(drafts).filter((f) => f.endsWith(".md")).length === 0, "no draft written");
    assert.ok(!fs.existsSync(path.join(fx.state, "escaped.md")) && !fs.existsSync(path.join(path.dirname(drafts), "..", "escaped.md")));
  });
}

test("a failed claude run fails the job with its message", async (t) => {
  const { fx, flags, env } = setup();
  const { act } = await serve(t, flags, fx, env("fail"));
  await act("/draft", { topic: "hub_tests.md" });
  const job = await finish(act);
  assert.equal(job.state, "failed");
  assert.match(job.message, /Not logged in/);
});

test("one job at a time, only topics in the queue, and no merge while a job runs", async (t) => {
  const { fx, flags, drafts, env } = setup();
  fs.mkdirSync(drafts, { recursive: true });
  fs.writeFileSync(path.join(drafts, "old.md"), `---\nname: old\ndescription: x\nsleep_sources: zeta.md\nmetadata:\n  type: feedback\n---\n\nx\n`);
  const { act } = await serve(t, flags, fx, env("slow"));
  assert.equal((await act("/draft", { topic: "nope.md" })).status, 400, "unknown topic");
  assert.equal((await act("/draft", { topic: "../hub_tests.md" })).status, 400);
  assert.equal((await act("/draft", { topic: "hub_tests.md" })).status, 200);
  const again = await act("/draft", { topic: "unfiled" });
  assert.equal(again.status, 400);
  assert.match(JSON.parse(again.body).error, /already/);
  assert.equal((await act("/merge", { draft: "old.md" })).status, 400, "no merge while Claude is drafting");
  assert.equal((await finish(act)).state, "done");
});

test("Redo with Claude sends the draft, its sources and your note, and rewrites only that draft", async (t) => {
  const { fx, flags, drafts, log, env } = setup();
  fs.mkdirSync(drafts, { recursive: true });
  fs.writeFileSync(path.join(drafts, "browser.md"), `---\nname: browser\ndescription: x\nsleep_sources: theta.md, iota.md\nmetadata:\n  type: feedback\n---\n\nFirst try.\n`);
  const { act } = await serve(t, flags, fx, env("redo", { FAKE_NAME: "browser.md" }));
  assert.equal((await act("/note", { draft: "browser.md", note: "Put the quarantine step first." })).status, 200);
  assert.equal((await act("/draft", { redo: "browser.md" })).status, 200);
  assert.equal((await finish(act)).state, "done");
  const seen = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.ok(seen.input.includes("Put the quarantine step first.") && seen.input.includes("First try.") && seen.input.includes(THETA));
  assert.match(fs.readFileSync(path.join(drafts, "browser.md"), "utf8"), /Redone after the note/);
});

test("a redo that comes back under another name is refused and the draft stays as it was", async (t) => {
  const { fx, flags, drafts, env } = setup();
  fs.mkdirSync(drafts, { recursive: true });
  const before = `---\nname: browser\ndescription: x\nsleep_sources: theta.md, iota.md\nmetadata:\n  type: feedback\n---\n\nFirst try.\n`;
  fs.writeFileSync(path.join(drafts, "browser.md"), before);
  const { act } = await serve(t, flags, fx, env("redo", { FAKE_NAME: "other.md" }));
  assert.equal((await act("/draft", { redo: "browser.md" })).status, 200);
  assert.equal((await finish(act)).state, "failed");
  assert.equal(fs.readFileSync(path.join(drafts, "browser.md"), "utf8"), before);
  assert.ok(!fs.existsSync(path.join(drafts, "other.md")));
});

test("the served page offers Draft with Claude per queued topic and Redo with Claude per draft; the file version offers neither", async (t) => {
  const { fx, flags, drafts } = setup();
  fs.mkdirSync(drafts, { recursive: true });
  fs.writeFileSync(path.join(drafts, "browser.md"), `---\nname: browser\ndescription: x\nsleep_sources: theta.md, iota.md\nmetadata:\n  type: feedback\n---\n\nFirst try.\n`);
  const { req, token } = await serve(t, flags, fx);
  const cookie = (await req("GET", `/?token=${token}`)).headers["set-cookie"][0].split(";")[0];
  const page = (await req("GET", "/", { headers: { Cookie: cookie } })).body;
  assert.match(page, /data-claude-topic="hub_tests\.md"/);
  assert.match(page, /data-claude-redo/);
  const file = fx.run(["review", ...flags]).stdout.match(/Review: (\S+)/)[1];
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /data-claude/);
});
