// Tests for the 3D map (/map on the served page): the graph it draws before and after the plan, its escaping, its
// security policy, and the vendored library it loads from 127.0.0.1 only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { mem, fixture, standard, serve, ROOT } from "./helpers.mjs";

function setup() {
  const fx = fixture(); standard(fx);
  fx.write("hub_ops.md", mem("hub_ops", "reference", "Ops hub", "- [Beta](beta.md) staging · [[gamma]] flaky · [Alpha](alpha.md)"));
  fx.write("eps.md", mem("eps", "project", "Old flow </script><b>x", "Epsilon explains the old payment flow that was replaced in March."));
  fx.write("theta.md", mem("theta", "feedback", "Slow suite", "Theta says to run the slow browser suite only on the merge queue."));
  fx.session([{ tool: "Bash", input: { command: "ls" }, result: "x" }], { ageDays: 70 });
  const flags = ["--project", fx.project, "--state", fx.state, "--days", "60"];
  return { fx, flags };
}

async function open(t, fx, flags) {
  const s = await serve(t, flags, fx);
  const cookie = (await s.req("GET", `/?token=${s.token}`)).headers["set-cookie"][0].split(";")[0];
  const get = (p) => s.req("GET", p, { headers: { Cookie: cookie } });
  return { ...s, get };
}
const graphOf = (html) => JSON.parse(/<script type="application\/json" id="graph">([\s\S]*?)<\/script>/.exec(html)[1]);

test("the map shows each memory on its floor before the plan and after it, with its links", async (t) => {
  const { fx, flags } = setup();
  // Queue theta first, then draft a merge of it, so the map has a queued file, a planned merge and a new draft.
  assert.equal(fx.run(["archive", "--apply", "--only", writeOnly(fx, ["theta.md"]), ...flags]).status, 0);
  fs.mkdirSync(path.join(fx.state, "drafts"), { recursive: true });
  fs.writeFileSync(path.join(fx.state, "drafts", "suites.md"), `---\nname: suites\ndescription: Suites\nsleep_sources: theta.md\nmetadata:\n  type: feedback\n---\n\nx\n`);
  const { get } = await open(t, fx, flags);
  const r = await get("/map");
  assert.equal(r.status, 200);
  const g = graphOf(r.body);
  const node = (id) => g.nodes.find((n) => n.id === id);
  assert.deepEqual([node("MEMORY.md").before, node("MEMORY.md").after], ["index", "index"]);
  assert.deepEqual([node("alpha.md").before, node("alpha.md").after, node("alpha.md").status], ["memory", "memory", "stays"]);
  assert.deepEqual([node("beta.md").before, node("beta.md").after, node("beta.md").status], ["memory", "archive", "archive"]);
  assert.deepEqual([node("zeta.md").after, node("zeta.md").status], ["queue", "queue"]);
  assert.deepEqual([node("theta.md").before, node("theta.md").after, node("theta.md").status], ["queue", "archive", "merged"]);
  assert.deepEqual([node("suites.md").before, node("suites.md").after, node("suites.md").status], [null, "memory", "new"]);
  const has = (s, t, kind = "link") => g.links.some((l) => l.source === s && l.target === t && l.kind === kind);
  assert.ok(has("MEMORY.md", "alpha.md") && has("hub_ops.md", "beta.md") && has("hub_ops.md", "gamma.md"));
  assert.ok(has("theta.md", "suites.md", "merge"), "a merge links each source to its draft");
  assert.ok(!r.body.includes("Epsilon explains"), "no memory text on the map, only names and descriptions");
});

function writeOnly(fx, names) {
  const f = path.join(fx.state, "only-test.json");
  fs.mkdirSync(fx.state, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(names));
  return f;
}

test("memory text cannot break out of the map's data", async (t) => {
  const { fx, flags } = setup();
  const { get } = await open(t, fx, flags);
  const r = await get("/map");
  assert.equal((r.body.match(/<\/script/gi) || []).length, 2, "only the page's own two script blocks close");
  assert.equal(graphOf(r.body).nodes.find((n) => n.id === "eps.md").description, "Old flow </script><b>x", "and intact in the data");
});

test("the map runs only its own script and the vendored library, from this address, without eval", async (t) => {
  const { fx, flags } = setup();
  const { get, req } = await open(t, fx, flags);
  const r = await get("/map");
  const csp = r.headers["content-security-policy"];
  assert.match(csp, /script-src 'self' 'nonce-[^']+'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval|https?:/);
  assert.match(r.body, /import \{ ForceGraph3D, THREE \} from "\/vendor\/graph3d\.mjs"/);
  const lib = await get("/vendor/graph3d.mjs");
  assert.equal(lib.status, 200);
  assert.match(lib.headers["content-type"], /^text\/javascript/);
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  assert.equal(sha(lib.body), sha(fs.readFileSync(path.join(ROOT, "vendor", "graph3d.mjs"), "utf8")));
  for (const bad of ["/vendor/../sleep.mjs", "/vendor/%2e%2e/sleep.mjs", "/vendor/LICENSES.md", "/vendor/entry.mjs"]) assert.equal((await get(bad)).status, 404, bad);
  assert.equal((await req("GET", "/map")).status, 403, "the map needs the cookie");
});

test("the map follows the project picker, and the review page links to it", async (t) => {
  const { fx, flags } = setup();
  const { get } = await open(t, fx, flags);
  assert.equal((await get("/map?project=nope")).status, 400);
  assert.match((await get("/")).body, /href="\/map\?project=[^"]+"/);
});
