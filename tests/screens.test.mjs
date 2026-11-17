// Tests for the Consolidate screens: the start card says what a run would read, the job reports progress per topic,
// and the result groups drafts by topic with a tick each, unticking any draft with a warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mem, fixture, standard, serve } from "./helpers.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs");
const WORDS = ["billing", "search", "upload", "export", "login", "sync", "backup", "invoice", "render", "import", "cache", "report"];

// hub_big links 12 unused feedback rules, hub_tests links theta (which cites #193) and iota.
function setup() {
  const fx = fixture(); standard(fx);
  const big = Array.from({ length: 12 }, (_, i) => `rule${String(i + 1).padStart(2, "0")}.md`);
  fx.write("MEMORY.md", "# Index\n- [Alpha](alpha.md): deploys\n- [Hub](hub_ops.md): ops\n- [Tests](hub_tests.md): tests\n- [Big](hub_big.md): big\n", 1);
  fx.write("hub_tests.md", mem("hub_tests", "reference", "Test hub", "- [Theta](theta.md)\n- [Iota](iota.md)"));
  fx.write("hub_big.md", mem("hub_big", "reference", "Big hub", big.map((f) => `- [${f}](${f})`).join("\n")));
  fx.write("theta.md", mem("theta", "feedback", "Slow suite", "Theta: run the slow suite on the merge queue, since #193."));
  fx.write("iota.md", mem("iota", "feedback", "Retry", "Iota: retry a flaky test once."));
  big.forEach((f, i) => fx.write(f, mem(f.slice(0, -3), "feedback", `Rule ${WORDS[i]}`, `The ${WORDS[i]} pipeline waits ${(i + 2) * 7} seconds before it retries a failed ${WORDS[(i + 5) % 12]} step.`)));
  fx.session([{ tool: "Bash", input: { command: "ls" }, result: "x" }], { ageDays: 70 });
  const flags = ["--project", fx.project, "--state", fx.state, "--days", "60"];
  return { fx, flags, env: (mode) => ({ SLEEP_CLAUDE: FAKE, FAKE_MODE: mode }) };
}
async function finish(act) {
  for (let i = 0; i < 300; i++) {
    const j = JSON.parse((await act("/job", {})).body).job;
    if (j && j.state !== "running") return j;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error("job did not finish");
}
async function page({ req, token }) {
  const cookie = (await req("GET", `/?token=${token}`)).headers["set-cookie"][0].split(";")[0];
  return (await req("GET", "/", { headers: { Cookie: cookie } })).body;
}
const ticked = (html, draft) => {
  const m = new RegExp(`data-include value="${draft.replace(/\./g, "\\.")}"( checked)?>`).exec(html);
  assert.ok(m, `no include box for ${draft}`);
  return !!m[1];
};

test("the start card says what Consolidate everything would read; the file version has none", async (t) => {
  const { fx, flags, env } = setup();
  const s = await serve(t, flags, fx, env("good"));
  const html = await page(s);
  assert.match(html, /<b>14<\/b> memories<\/span><span><b>2<\/b> topics<\/span><span><b>3<\/b> batches/);
  assert.match(html, /data-consolidate>/);
  const file = fx.run(["review", ...flags]).stdout.match(/Review: (\S+)/)[1];
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /Consolidate with Claude/);
});

test("the job reports progress per topic, and after the run the result groups drafts by topic", async (t) => {
  const { fx, flags, env } = setup();
  const s = await serve(t, flags, fx, env("good"));
  await s.act("/consolidate", {});
  const job = await finish(s.act);
  assert.deepEqual(job.progress.topics["hub_big.md"], { batches: 2, done: 2, running: 0, memories: 12, became: 2, failed: 0 });
  assert.deepEqual(job.progress.topics["hub_tests.md"], { batches: 1, done: 1, running: 0, memories: 2, became: 1, failed: 0 });
  const html = await page(s);
  assert.doesNotMatch(html, /data-consolidate>/, "nothing left to read, so no start card");
  assert.match(html, /<s>6<\/s> → 3<\/b>/, "6 sources became 3 merged memories");
  assert.match(html, /data-topic="hub_big\.md"[\s\S]*?<span class="num">4 → 2<\/span>/);
  assert.match(html, /data-topic="hub_tests\.md"[\s\S]*?<span class="num">2 → 1<\/span>/);
});

test("a draft that dropped a fact starts unticked; a clean one starts ticked", async (t) => {
  const { fx, flags, env } = setup();
  const s = await serve(t, flags, fx, env("good"));
  await s.act("/consolidate", {});
  await finish(s.act);
  const html = await page(s);
  const meta = JSON.parse(fs.readFileSync(path.join(fx.state, "drafts.json"), "utf8"));
  const tests = Object.keys(meta).find((d) => meta[d].topic === "hub_tests.md"), big = Object.keys(meta).find((d) => meta[d].topic === "hub_big.md");
  assert.equal(ticked(html, tests), false, "theta's #193 is missing from the draft");
  assert.match(html, /1 draft to check/);
  assert.equal(ticked(html, big), true);
});

test("a draft whose source changed since Claude read it starts unticked and says so", async (t) => {
  const { fx, flags, env } = setup();
  const s = await serve(t, flags, fx, env("good"));
  await s.act("/consolidate", {});
  await finish(s.act);
  const meta = JSON.parse(fs.readFileSync(path.join(fx.state, "drafts.json"), "utf8"));
  const big = Object.keys(meta).filter((d) => meta[d].topic === "hub_big.md").sort();
  const src = Object.keys(meta[big[0]].sources)[0];
  fs.appendFileSync(path.join(fx.memDir, src), "Edited after the draft.\n");
  const html = await page(s);
  assert.equal(ticked(html, big[0]), false);
  assert.match(html, new RegExp(`data-stale>${src.replace(".", "\\.")} changed since Claude read it`));
  assert.equal(ticked(html, big[1]), true, "the other draft is untouched");
});
