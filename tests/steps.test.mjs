// Tests for lib/steps.mjs, the step logic the server and the page share: where each memory sits at each map step for
// a set of ticks, checked against what a real Apply does with the same ticks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mem, fixture, standard, serve } from "./helpers.mjs";
import { applySteps, defaultTicks, floorCounts, stepForSection } from "../lib/steps.mjs";

// a and b are unused feedback planned for Consolidate, q already waits there, k stays, x is planned for Archive.
// d1 merges a and b; d2 merges q and k (k never reaches Consolidate); d3 merges q but a source changed.
const G = () => ({
  nodes: [
    { id: "MEMORY.md" },
    { id: "a.md", now: "memory", plan: "consolidate", hub: "h.md" },
    { id: "b.md", now: "memory", plan: "consolidate", hub: "h.md" },
    { id: "q.md", now: "queue", plan: null, hub: "h.md" },
    { id: "k.md", now: "memory", plan: null, hub: "h.md" },
    { id: "x.md", now: "memory", plan: "archive", hub: "h.md" },
    { id: "d1.md", draft: true }, { id: "d2.md", draft: true }, { id: "d3.md", draft: true },
  ],
  drafts: [
    { id: "d1.md", topic: "tests", ok: true, sources: [{ name: "a.md" }, { name: "b.md" }] },
    { id: "d2.md", topic: "ops", ok: false, sources: [{ name: "q.md" }, { name: "k.md" }] },
    { id: "d3.md", topic: "ops", ok: false, sources: [{ name: "q.md", changed: true }] },
  ],
});
const at = (g) => Object.fromEntries(g.nodes.map((n) => [n.id, n.at.join(",")]));

test("default ticks: every move and every draft with no warning; drafts merge into Keep and their sources sink", () => {
  const g = applySteps(G());
  assert.deepEqual(defaultTicks(G()), { moves: ["a.md", "b.md", "x.md"], drafts: ["d1.md"] });
  const a = at(g);
  assert.equal(a["a.md"], "memory,queue,queue,archive");
  assert.equal(a["x.md"], "memory,archive,archive,archive");
  assert.equal(a["q.md"], "queue,queue,queue,queue");
  assert.equal(a["d1.md"], ",,queue,memory");
  assert.equal(a["d2.md"], ",,queue,");
  assert.equal(g.nodes.find((n) => n.id === "a.md").into, "d1.md");
  assert.equal(g.nodes.find((n) => n.id === "a.md").topic, "tests");
  assert.deepEqual(floorCounts(g, 3), { memory: 2, queue: 1, archive: 3 });
});

test("an unticked move stays; a ticked draft still carries its planned source, as Apply does", () => {
  const g = applySteps(G(), { moves: ["b.md"], drafts: [] });
  assert.equal(at(g)["a.md"], "memory,memory,memory,memory");
  assert.equal(at(g)["x.md"], "memory,memory,memory,memory");
  const h = applySteps(G(), { moves: [], drafts: ["d1.md"] });
  assert.equal(at(h)["a.md"], "memory,queue,queue,archive", "a moves because d1 needs it");
  assert.equal(at(h)["d1.md"], ",,queue,memory");
});

test("a ticked draft does not merge when a source never reaches Consolidate, changed, or an earlier merge took it", () => {
  const g = applySteps(G(), { moves: [], drafts: ["d2.md", "d3.md"] });
  assert.equal(at(g)["d2.md"], ",,queue,", "k stays in Keep, so merged would refuse d2");
  assert.equal(at(g)["d3.md"], ",,queue,", "q changed since Claude read it");
  assert.equal(at(g)["q.md"], "queue,queue,queue,queue");
  const both = G();
  both.drafts.push({ id: "d4.md", topic: "tests", ok: true, sources: [{ name: "a.md" }] });
  both.nodes.push({ id: "d4.md", draft: true });
  const h = applySteps(both, { moves: [], drafts: ["d1.md", "d4.md"] });
  assert.equal(at(h)["d4.md"], ",,queue,", "d1 already merged a");
});

test("each page section names the step it shows", () => {
  assert.deepEqual(["moves-archive", "moves-queue", "drafts", "apply", "links", "index"].map(stepForSection), [1, 1, 2, 3, null, null]);
});

// The parity test: the folder a real Apply leaves matches the Applied step for the same ticks.
const THETA = "Theta says to run the slow browser suite only on the merge queue.", IOTA = "Iota says retry a flaky test once.";
test("a real Apply with chosen ticks leaves every memory where the Applied step says", async (t) => {
  const fx = fixture(); standard(fx);
  fx.write("MEMORY.md", "# Index\n- [Alpha](alpha.md): deploys\n- [Hub](hub_ops.md): ops\n- [Tests](hub_tests.md): tests\n", 1);
  fx.write("hub_tests.md", mem("hub_tests", "reference", "Test hub", "- [Theta](theta.md)\n- [Iota](iota.md)"));
  fx.write("theta.md", mem("theta", "feedback", "Slow suite", THETA));
  fx.write("iota.md", mem("iota", "feedback", "Retry flaky once", IOTA));
  fx.session([{ tool: "Bash", input: { command: "ls" }, result: "x" }], { ageDays: 70 });
  const flags = ["--project", fx.project, "--state", fx.state, "--days", "60"];
  const draft = (name, sources, body) => {
    fs.mkdirSync(path.join(fx.state, "drafts"), { recursive: true });
    fs.writeFileSync(path.join(fx.state, "drafts", name), `---\nname: ${name.slice(0, -3)}\ndescription: merged\nsleep_sources: ${sources.join(", ")}\nmetadata:\n  type: feedback\n---\n\n${body}\n`);
  };
  draft("browser.md", ["theta.md", "iota.md"], `${THETA}\n${IOTA}`);
  draft("alpha_more.md", ["alpha.md"], "Alpha again.");
  const s = await serve(t, flags, fx);
  const cookie = (await s.req("GET", `/?token=${s.token}`)).headers["set-cookie"][0].split(";")[0];
  const html = (await s.req("GET", "/", { headers: { Cookie: cookie } })).body;
  const g = JSON.parse(/<script type="application\/json" id="graph">([\s\S]*?)<\/script>/.exec(html)[1]);
  const plannedArchive = g.nodes.filter((n) => n.plan === "archive").map((n) => n.id);
  assert.ok(plannedArchive.length >= 2, plannedArchive.join());
  // Tick one archive move, neither of browser.md's planned sources, and both drafts.
  const ticks = { moves: [plannedArchive[0]], drafts: ["browser.md", "alpha_more.md"] };
  applySteps(g, ticks);
  const r = await s.act("/apply-all", ticks);
  assert.equal(r.status, 200, r.body);
  for (let i = 0; i < 200; i++) { const j = JSON.parse((await s.act("/job", {})).body).job; if (j && j.state !== "running") break; await new Promise((ok) => setTimeout(ok, 100)); }
  const where = (name) => fs.existsSync(path.join(fx.memDir, name)) ? "memory" : fs.existsSync(path.join(fx.memDir, "consolidate", name)) ? "queue" : fs.existsSync(path.join(fx.memDir, "memory-archive", name)) ? "archive" : null;
  for (const n of g.nodes) if (n.id !== "MEMORY.md") assert.equal(where(n.id), n.after, `${n.id}: Applied says ${n.after}`);
  assert.equal(g.nodes.find((n) => n.id === "theta.md").after, "archive", "the case under test: an unticked source merged");
  assert.equal(g.nodes.find((n) => n.id === "alpha_more.md").after, null, "and a draft Apply skips");
  assert.equal(g.nodes.find((n) => n.id === plannedArchive[1]).after, "memory", "and an unticked move");
});
