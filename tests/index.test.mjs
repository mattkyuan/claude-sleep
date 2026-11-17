// Tests for tightening MEMORY.md: the checks every proposed line change must pass, the job that asks Claude, and
// index-apply, the only thing that writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mem, fixture, standard, serve } from "./helpers.mjs";
import { checkIndexChanges, indexFolder, parseIndexChanges } from "../lib/index.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs");
const OLD = "- [Old eval](eval_old.md): closed eval rules, see [[eval_notes]]";
const INDEX = `# Index\n- [Alpha](alpha.md): deploys\n- [Hub](hub_ops.md): ops\n${OLD}\n- [Lonely](lonely.md): the only link to lonely\n`;

function setup() {
  const fx = fixture(); standard(fx);
  fx.write("MEMORY.md", INDEX, 1);
  fx.write("eval_old.md", mem("eval_old", "feedback", "Old eval rules", "The old eval screen merged docs only."));
  fx.write("eval_notes.md", mem("eval_notes", "reference", "Eval notes", "Notes on the old eval."));
  fx.write("lonely.md", mem("lonely", "feedback", "Lonely rule", "A rule only the index links."));
  fx.session([{ tool: "Bash", input: { command: "ls" }, result: "x" }], { ageDays: 70 });
  const flags = ["--project", fx.project, "--state", fx.state, "--days", "60"];
  const check = (changes) => checkIndexChanges(changes.map((c) => ({ reason: "Closed.", new: "", add: "", hub: null, ...c })), { indexText: fs.readFileSync(path.join(fx.memDir, "MEMORY.md"), "utf8"), folder: indexFolder(fx.memDir) });
  return { fx, flags, check };
}
const why = (r) => r.refused.map((c) => c.why);

test("a graduated line keeps its files one hop away, and says which files lose the index's protection", () => {
  const { check } = setup();
  const r = check([{ kind: "graduate", old: OLD, hub: "hub_ops.md", add: "- [Old eval](eval_old.md) and [[eval_notes]]" }]);
  assert.deepEqual(why(r), []);
  assert.deepEqual(r.ok[0].unprotects.sort(), ["eval_notes.md", "eval_old.md"]);
  assert.equal(r.after.lines, INDEX.split("\n").length - 1);
});

test("a change that would leave a file the index links out of reach is refused", () => {
  const { check } = setup();
  assert.match(why(check([{ kind: "graduate", old: OLD, hub: "hub_ops.md", add: "- [Old eval](eval_old.md)" }]))[0], /eval_notes\.md would no longer be reachable/);
  assert.match(why(check([{ kind: "shorten", old: "- [Lonely](lonely.md): the only link to lonely", new: "- Lonely rule" }]))[0], /lonely\.md would no longer be reachable/);
  assert.match(why(check([{ kind: "graduate", old: OLD, hub: "zeta.md", add: "- [Old eval](eval_old.md) [[eval_notes]]" }]))[0], /zeta\.md is not linked from MEMORY\.md/, "a hub MEMORY.md does not link is out of reach");
  assert.match(why(check([{ kind: "graduate", old: OLD, hub: "../MEMORY.md", add: "x" }]))[0], /not a memory file here/);
});

test("a hub's own line cannot graduate into another hub: its files would be two hops away", () => {
  const { check } = setup();
  const r = check([{ kind: "graduate", old: "- [Hub](hub_ops.md): ops", hub: "eval_notes.md", add: "- [Hub](hub_ops.md)" }]);
  assert.match(why(r)[0], /beta\.md, gamma\.md would no longer be reachable/);
});

test("the old line must be a whole line of MEMORY.md, once; sleep's own line and headings are not Claude's to change", () => {
  const { fx, check } = setup();
  assert.match(why(check([{ kind: "shorten", old: OLD + " ", new: "- x" }]))[0], /not in MEMORY\.md/);
  assert.match(why(check([{ kind: "shorten", old: "# Index", new: "#" }]))[0], /heading/);
  const hint = "- Search order: look in the archive last. (added by sleep)";
  fx.write("MEMORY.md", INDEX + hint + "\n", 1);
  assert.match(why(check([{ kind: "shorten", old: hint, new: "- archive last (added by sleep)" }]))[0], /belongs to sleep/);
  const twice = check([{ kind: "shorten", old: OLD, new: "- [Old eval](eval_old.md) [[eval_notes]]" }, { kind: "shorten", old: OLD, new: "- [Old](eval_old.md) [[eval_notes]]" }]);
  assert.equal(twice.ok.length, 1);
  assert.match(why(twice)[0], /not in MEMORY\.md/, "the second change sees the first one's result");
});

test("a shortened line must be shorter, one line, with no em dash", () => {
  const { check } = setup();
  assert.match(why(check([{ kind: "shorten", old: OLD, new: OLD + " more" }]))[0], /not shorter/);
  assert.match(why(check([{ kind: "shorten", old: OLD, new: "- [Old](eval_old.md) — [[eval_notes]]" }]))[0], /em dash/);
  assert.match(why(check([{ kind: "shorten", old: OLD, new: "- [Old](eval_old.md)\n[[eval_notes]]" }]))[0], /line break/);
  assert.match(why(check([{ kind: "shorten", old: OLD, new: "- [Old](eval_old.md) [[eval_notes]]", reason: "" }]))[0], /no reason/);
});

test("a change that would push MEMORY.md past 25 KB is refused", () => {
  const { fx, check } = setup();
  fx.write("MEMORY.md", INDEX + `- filler ${"x".repeat(24_990 - Buffer.byteLength(INDEX))}\n`, 1);
  const r = check([{ kind: "graduate", old: OLD, hub: "hub_ops.md", new: OLD + " and more words than before", add: "- [Old eval](eval_old.md) [[eval_notes]]" }]);
  assert.match(why(r)[0], /past its cap/);
});

test("Claude's answer is read field by field; nothing else in it counts", () => {
  const c = parseIndexChanges("Sure.\n<<<CHANGE shorten>>>\nreason: Same links.\nold: - [A](a.md): long words\nnew: - [A](a.md)\n<<<END>>>\nold: - ignored");
  assert.deepEqual(c, [{ kind: "shorten", reason: "Same links.", hub: null, old: "- [A](a.md): long words", new: "- [A](a.md)", add: "" }]);
  assert.deepEqual(parseIndexChanges("<<<NONE>>>"), []);
  assert.throws(() => parseIndexChanges("I would change a few lines."), /no changes/);
});

async function finish(act) {
  for (let i = 0; i < 200; i++) {
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
const graduate = { FAKE_MODE: "index", FAKE_KIND: "graduate", FAKE_OLD_MATCH: "[Old eval](eval_old.md)", FAKE_HUB: "hub_ops.md", FAKE_ADD: "- [Old eval](eval_old.md) [[eval_notes]]" };

test("the page asks Claude, shows the checked change from disk, and Apply writes it in one commit", async (t) => {
  const { fx, flags } = setup();
  const s = await serve(t, flags, fx, { SLEEP_CLAUDE: FAKE, FAKE_LOG: path.join(fx.claude, "fake.json"), ...graduate });
  assert.equal((await s.act("/index", {})).status, 200);
  assert.equal((await finish(s.act)).state, "done");
  const sent = JSON.parse(fs.readFileSync(path.join(fx.claude, "fake.json"), "utf8"));
  assert.match(sent.argv.join(" "), /--tools  --strict-mcp-config/, "no tools, no MCP");
  assert.match(sent.input, /## MEMORY\.md[\s\S]*- eval_old\.md \(feedback; /, "Claude gets the index and what each linked file is");
  const html = await page(s);
  assert.match(html, /data-index-pick value="c1" checked/);
  assert.match(html, /<code>eval_notes\.md<\/code>, <code>eval_old\.md<\/code> lose MEMORY\.md's protection/);
  const r = await s.act("/index-apply", { ids: ["c1"] });
  assert.equal(r.status, 200, r.body);
  assert.match(JSON.parse(r.body).message, /Changed 1 line\(s\) in MEMORY\.md\. Undo with: git -C .* revert [0-9a-f]+/);
  assert.ok(!fs.readFileSync(path.join(fx.memDir, "MEMORY.md"), "utf8").includes(OLD));
  assert.match(fs.readFileSync(path.join(fx.memDir, "hub_ops.md"), "utf8"), /- \[Old eval\]\(eval_old\.md\) \[\[eval_notes\]\]\n$/);
  assert.match(execFileSync("git", ["-C", fx.memDir, "log", "-1", "--format=%s"], { encoding: "utf8" }), /tightened MEMORY\.md \(1 change\)/);
  assert.ok(!fs.existsSync(path.join(fx.state, "index-proposal.json")), "the proposal is used up");
});

test("a change Claude got wrong never reaches the page; a proposal goes stale when MEMORY.md changes", async (t) => {
  const { fx, flags } = setup();
  const s = await serve(t, flags, fx, { SLEEP_CLAUDE: FAKE, ...graduate, FAKE_ADD: "- [Old eval](eval_old.md)" });
  await s.act("/index", {});
  const job = await finish(s.act);
  assert.match(job.message, /0 passed the checks\. Refused: eval_notes\.md would no longer be reachable/);
  assert.doesNotMatch(await page(s), /data-index-pick value=/);
  assert.equal((await s.act("/index-apply", { ids: ["c1"] })).status, 400);
  const s2 = await serve(t, flags, fx, { SLEEP_CLAUDE: FAKE, ...graduate });
  await s2.act("/index", {});
  await finish(s2.act);
  fx.write("MEMORY.md", INDEX + "- [Zeta](zeta.md): reviewers\n", 1);
  const html = await page(s2);
  assert.match(html, /data-index-stale/);
  assert.match(html, /data-index-pick value="c1" disabled/);
});

test("index-apply checks again on disk: a hand-written change that loses a link changes nothing", () => {
  const { fx, flags } = setup();
  const f = path.join(fx.state, "changes.json");
  fs.mkdirSync(fx.state, { recursive: true });
  fs.writeFileSync(f, JSON.stringify([{ kind: "shorten", reason: "x", old: "- [Lonely](lonely.md): the only link to lonely", new: "- Lonely" }]));
  const r = fx.run(["index-apply", "--changes", f, ...flags]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Nothing changed\..*lonely\.md would no longer be reachable/);
  assert.equal(fs.readFileSync(path.join(fx.memDir, "MEMORY.md"), "utf8"), INDEX);
});
