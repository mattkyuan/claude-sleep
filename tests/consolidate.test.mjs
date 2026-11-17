// Tests for Consolidate everything: one job drafts every topic in batches of up to 10, three at a time, with progress,
// Stop, and a second run that picks up only what no draft covers yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mem, fixture, standard, serve } from "./helpers.mjs";
import { parseDrafts } from "../lib/draft.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs");

// hub_big links 12 unused feedback memories (two batches: 10 and 2), hub_tests links 2, and zeta has no hub.
function setup() {
  const fx = fixture(); standard(fx);
  const big = Array.from({ length: 12 }, (_, i) => `rule${String(i + 1).padStart(2, "0")}.md`);
  fx.write("MEMORY.md", "# Index\n- [Alpha](alpha.md): deploys\n- [Hub](hub_ops.md): ops\n- [Tests](hub_tests.md): tests\n- [Big](hub_big.md): big\n", 1);
  fx.write("hub_tests.md", mem("hub_tests", "reference", "Test hub", "- [Theta](theta.md)\n- [Iota](iota.md)"));
  fx.write("hub_big.md", mem("hub_big", "reference", "Big hub", big.map((f) => `- [${f}](${f})`).join("\n")));
  fx.write("theta.md", mem("theta", "feedback", "Slow suite", "Theta: slow suite on the merge queue."));
  fx.write("iota.md", mem("iota", "feedback", "Retry", "Iota: retry a flaky test once."));
  const WORDS = ["billing", "search", "upload", "export", "login", "sync", "backup", "invoice", "render", "import", "cache", "report"];
  // Distinct sentences, so usage can tell each file apart (identical text would read as "no data", never as unused).
  big.forEach((f, i) => fx.write(f, mem(f.slice(0, -3), "feedback", `Rule ${WORDS[i]}`, `The ${WORDS[i]} pipeline waits ${(i + 2) * 7} seconds before it retries a failed ${WORDS[(i + 5) % 12]} step.`)));
  fx.session([{ tool: "Bash", input: { command: "ls" }, result: "x" }], { ageDays: 70 });
  const flags = ["--project", fx.project, "--state", fx.state, "--days", "60"];
  const logs = fs.mkdtempSync(path.join(fx.claude, "calls-"));
  const env = (mode, extra = {}) => ({ SLEEP_CLAUDE: FAKE, FAKE_MODE: mode, FAKE_LOGDIR: logs, ...extra });
  const drafts = () => { try { return fs.readdirSync(path.join(fx.state, "drafts")).filter((f) => f.endsWith(".md")).sort(); } catch { return []; } };
  const calls = () => fs.readdirSync(logs).map((f) => JSON.parse(fs.readFileSync(path.join(logs, f), "utf8")));
  return { fx, flags, env, drafts, calls };
}
async function finish(act, until = (j) => j.state !== "running") {
  for (let i = 0; i < 300; i++) {
    const j = JSON.parse((await act("/job", {})).body).job;
    if (j && until(j)) return j;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error("job did not finish");
}

test("a batch may answer that nothing merges", () => {
  assert.deepEqual(parseDrafts("Nothing here repeats.\n<<<NONE>>>"), []);
  assert.throws(() => parseDrafts("I could not decide."), /no drafts/);
});

test("Consolidate everything drafts every topic in batches of up to 10, three at a time, and reports progress", async (t) => {
  const { fx, flags, env, drafts, calls } = setup();
  const { act } = await serve(t, flags, fx, env("slow", { FAKE_MS: "600" }));
  const r = await act("/consolidate", {});
  assert.equal(r.status, 200, r.body);
  const job = await finish(act);
  assert.equal(job.state, "done", job.message);
  const sizes = calls().map((c) => c.batch.length).sort((a, b) => a - b);
  assert.deepEqual(sizes, [2, 2, 10], "hub_big in 10 + 2, hub_tests in 2; zeta alone cannot merge and is not sent");
  const all = calls().flatMap((c) => c.batch);
  assert.equal(new Set(all).size, all.length, "no memory is in two batches");
  const runs = calls();
  const overlap = runs.some((a, i) => runs.some((b, k) => i !== k && a.start < b.end && b.start < a.end));
  assert.ok(overlap, "batches run at the same time");
  assert.deepEqual([job.progress.total, job.progress.done, job.progress.read], [3, 3, 14]);
  assert.equal(drafts().length, 3, "one draft per batch, names made unique");
  const meta = JSON.parse(fs.readFileSync(path.join(fx.state, "drafts.json"), "utf8"));
  assert.deepEqual(Object.values(meta).map((m) => m.topic).sort(), ["hub_big.md", "hub_big.md", "hub_tests.md"]);
});

test("a second run sends nothing Claude already read, until a memory changes", async (t) => {
  const { fx, flags, env, calls } = setup();
  const { act } = await serve(t, flags, fx, env("good"));
  await act("/consolidate", {});
  await finish(act);
  const first = calls().length;
  await act("/consolidate", {});
  const again = await finish(act);
  assert.equal(calls().length, first, "no batch sent: every memory was read, merged or not");
  assert.match(again.message, /Nothing left to consolidate/);
  fx.write("rule05.md", mem("rule05", "feedback", "Rule login", "The login pipeline now waits a minute."));
  fx.write("rule06.md", mem("rule06", "feedback", "Rule sync", "The sync pipeline now waits a minute."));
  await act("/consolidate", {});
  await finish(act);
  assert.deepEqual(calls().slice(first).flatMap((c) => c.batch).sort(), ["rule05.md", "rule06.md"], "only the two edited, unmerged memories go again");
});

test("a stopped run resumes: batches that never finished are sent again", async (t) => {
  const { fx, flags, env } = setup();
  const { act } = await serve(t, flags, fx, env("good", { FAKE_FAIL_IF: "theta.md" }));
  await act("/consolidate", {});
  await finish(act);
  await act("/consolidate", {});
  const again = await finish(act);
  assert.deepEqual(Object.keys(again.progress.topics), ["hub_tests.md"], "the failed batch goes again; finished ones do not");
  assert.equal(again.progress.topics["hub_tests.md"].memories, 2);
});

test("one failed batch does not fail the run, and a batch that merges nothing is fine", async (t) => {
  const { fx, flags, env, drafts } = setup();
  const { act } = await serve(t, flags, fx, env("good", { FAKE_NONE_IF: "theta.md" }));
  await act("/consolidate", {});
  const job = await finish(act);
  assert.equal(job.state, "done");
  assert.equal(job.progress.failed, 0);
  assert.equal(drafts().length, 2, "hub_big's two batches drafted; hub_tests answered nothing");
});

test("one failed batch does not fail the run; the others still draft", async (t) => {
  const { fx, flags, env, drafts } = setup();
  const { act } = await serve(t, flags, fx, env("good", { FAKE_FAIL_IF: "theta.md" }));
  await act("/consolidate", {});
  const job = await finish(act);
  assert.equal(job.state, "done");
  assert.equal(job.progress.failed, 1);
  assert.match(job.message, /1 batch\(es\) failed: hub_tests\.md: Rate limited/);
  assert.equal(drafts().length, 2);
});

test("a draft from a single memory is refused: a merge needs at least 2 sources", async (t) => {
  const { fx, flags, env, drafts } = setup();
  const { act } = await serve(t, flags, fx, env("single"));
  await act("/consolidate", {});
  const job = await finish(act);
  assert.equal(job.progress.failed, 3);
  assert.match(job.errors[0], /at least 2 sources/);
  assert.deepEqual(drafts(), []);
});

test("Stop ends the run and its Claude processes; nothing more is written", async (t) => {
  const { fx, flags, env, drafts } = setup();
  const { act } = await serve(t, flags, fx, env("slow", { FAKE_MS: "4000" }));
  await act("/consolidate", {});
  await finish(act, (j) => j.state === "running" && j.progress.running > 0);
  assert.equal((await act("/stop-job", {})).status, 200);
  const job = await finish(act);
  assert.equal(job.state, "stopped");
  await new Promise((ok) => setTimeout(ok, 4500));
  assert.deepEqual(drafts(), [], "killed batches wrote nothing");
});
