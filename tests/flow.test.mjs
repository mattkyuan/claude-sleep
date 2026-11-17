// Tests for the one flow: Claude consolidates files the plan would move, and Apply moves then merges, skipping a draft
// whose sources changed since Claude read them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mem, fixture, standard, serve } from "./helpers.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs");
const THETA = "Theta says to run the slow browser suite only on the merge queue, since #193.";
const IOTA = "Iota says retry a flaky browser test once, then quarantine it.";

// theta and iota are unused feedback linked from hub_tests: planned for Consolidate, not moved yet.
function setup() {
  const fx = fixture(); standard(fx);
  fx.write("MEMORY.md", "# Index\n- [Alpha](alpha.md): deploys\n- [Hub](hub_ops.md): ops\n- [Tests](hub_tests.md): tests\n", 1);
  fx.write("hub_tests.md", mem("hub_tests", "reference", "Test hub", "- [Theta](theta.md)\n- [Iota](iota.md)"));
  fx.write("theta.md", mem("theta", "feedback", "Slow suite", THETA));
  fx.write("iota.md", mem("iota", "feedback", "Retry flaky once", IOTA));
  fx.session([{ tool: "Bash", input: { command: "ls" }, result: "x" }], { ageDays: 70 });
  const flags = ["--project", fx.project, "--state", fx.state, "--days", "60"];
  const env = { SLEEP_CLAUDE: FAKE, FAKE_LOG: path.join(fx.claude, "fake.json"), FAKE_MODE: "good" };
  const exists = (rel) => fs.existsSync(path.join(fx.memDir, rel));
  return { fx, flags, env, exists };
}
async function finish(act) {
  for (let i = 0; i < 200; i++) {
    const j = JSON.parse((await act("/job", {})).body).job;
    if (j && j.state !== "running") return j;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error("job did not finish");
}

test("Claude can consolidate files the plan would move, before anything moves, and the draft records what it read", async (t) => {
  const { fx, flags, env, exists } = setup();
  const { act } = await serve(t, flags, fx, env);
  const r = await act("/draft", { topic: "hub_tests.md" });
  assert.equal(r.status, 200, r.body);
  assert.equal((await finish(act)).state, "done");
  assert.ok(exists("theta.md") && exists("iota.md"), "nothing moved");
  const meta = JSON.parse(fs.readFileSync(path.join(fx.state, "drafts.json"), "utf8"))["merged_rules.md"];
  assert.equal(meta.topic, "hub_tests.md");
  assert.deepEqual(Object.keys(meta.sources).sort(), ["iota.md", "theta.md"]);
});

test("Apply moves the picked files, then merges each picked draft, in one job", async (t) => {
  const { fx, flags, env, exists } = setup();
  const { act } = await serve(t, flags, fx, env);
  await act("/draft", { topic: "hub_tests.md" });
  await finish(act);
  const r = await act("/apply-all", { moves: ["beta.md"], drafts: ["merged_rules.md"] });
  assert.equal(r.status, 200, r.body);
  const job = await finish(act);
  assert.equal(job.state, "done", job.message);
  assert.ok(exists("memory-archive/beta.md"), "picked move done");
  assert.ok(exists("merged_rules.md") && exists("memory-archive/theta.md") && exists("memory-archive/iota.md"), "merged, sources archived");
  assert.ok(exists("zeta.md"), "a move nobody picked stays");
  assert.match(fs.readFileSync(path.join(fx.memDir, "hub_tests.md"), "utf8"), /\(merged_rules\.md\)/);
  assert.deepEqual(job.results.map((x) => [x.draft, x.ok]), [["merged_rules.md", true]]);
  const head = execFileSync("git", ["-C", fx.memDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(job.results[0].commit, head, "each merge keeps its own commit");
  assert.ok(job.message.includes(`revert --no-edit ${head} (`), job.message);
});

test("a source counts as unchanged when an earlier merge in the same Apply redirected its [[slug]] links", async (t) => {
  const { fx, flags, env, exists } = setup();
  fx.write("theta.md", mem("theta", "feedback", "Slow suite", THETA + " See [[beta]]."));
  const { act } = await serve(t, flags, fx, env);
  await act("/draft", { topic: "hub_tests.md" });
  await finish(act);
  fx.write("theta.md", mem("theta", "feedback", "Slow suite", THETA + " See [[merged_beta]]."));
  await act("/apply-all", { moves: [], drafts: ["merged_rules.md"] });
  const job = await finish(act);
  assert.equal(job.results[0].ok, true, job.results[0].reason);
  assert.ok(exists("merged_rules.md"));
});

test("Apply cannot be stopped halfway, so no second job starts while it runs", async (t) => {
  const { fx, flags, env } = setup();
  const { act } = await serve(t, flags, fx, env);
  await act("/draft", { topic: "hub_tests.md" });
  await finish(act);
  await act("/apply-all", { moves: ["beta.md"], drafts: ["merged_rules.md"] });
  const r = await act("/stop-job", {});
  assert.equal(r.status, 400, r.body);
  assert.match(JSON.parse(r.body).error, /cannot stop halfway/);
  assert.equal((await finish(act)).state, "done");
});

test("a draft whose source changed after Claude read it is skipped with the reason; the rest still applies", async (t) => {
  const { fx, flags, env, exists } = setup();
  const { act } = await serve(t, flags, fx, env);
  await act("/draft", { topic: "hub_tests.md" });
  await finish(act);
  fx.write("theta.md", mem("theta", "feedback", "Slow suite", THETA + " Also on Fridays."));
  await act("/apply-all", { moves: ["beta.md"], drafts: ["merged_rules.md"] });
  const job = await finish(act);
  assert.ok(exists("memory-archive/beta.md"), "the move still applied");
  assert.ok(!exists("merged_rules.md"), "the stale draft did not merge");
  assert.equal(job.results[0].ok, false);
  assert.match(job.results[0].reason, /theta\.md changed/);
});

test("a source counts as unchanged when only its links were rewritten by a move", async (t) => {
  const { fx, flags, env, exists } = setup();
  fx.write("theta.md", mem("theta", "feedback", "Slow suite", THETA + " See [Beta](beta.md)."));
  const { act } = await serve(t, flags, fx, env);
  await act("/draft", { topic: "hub_tests.md" });
  await finish(act);
  await act("/apply-all", { moves: ["beta.md"], drafts: ["merged_rules.md"] });
  const job = await finish(act);
  assert.equal(job.results[0].ok, true, job.results[0].reason);
  assert.ok(exists("merged_rules.md"));
});
