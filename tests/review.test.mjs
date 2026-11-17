// Tests for the review page: what it shows, that it is inert (no scripts, everything escaped), and merge drafts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mem, fixture, standard, BETA, DELTA, ZETA } from "./helpers.mjs";

const THETA = "Theta says to run the slow browser suite only on the merge queue.";
const IOTA = "Iota says retry a flaky browser test once, then quarantine it.";

function setup() {
  const fx = fixture(); standard(fx);
  fx.write("hub_ops.md", mem("hub_ops", "reference", "Ops hub", "- [Beta](beta.md) staging · [[gamma]] flaky · [Alpha](alpha.md)"));
  fx.write("eps.md", mem("eps", "project", "Old payment flow <b>bold</b>", "Epsilon explains the old payment flow that was replaced in March.\n<script>alert('x')</script> & more"));
  fx.session([{ tool: "Bash", input: { command: "cat beta.md" }, result: BETA }], { ageDays: 70 });
  fx.session([{ tool: "Bash", input: { command: "cat delta.md" }, result: DELTA }], { ageDays: 3 });
  const run = (args) => fx.run([...args, "--project", fx.project, "--state", fx.state, "--days", "60"]);
  const ok = (args) => { const r = run(args); assert.equal(r.status, 0, r.stderr); return r; };
  const pagePath = (stdout) => /Review: (\S+\.html)/.exec(stdout)[1];
  return { fx, run, ok, pagePath };
}

test("review writes a page with every proposed move, its evidence and the link edits it causes", () => {
  const { fx, ok, pagePath } = setup();
  const before = fs.readFileSync(path.join(fx.memDir, "hub_ops.md"), "utf8");
  const html = fs.readFileSync(pagePath(ok(["review"]).stdout), "utf8");
  for (const name of ["beta.md", "gamma.md", "eps.md", "zeta.md"]) assert.ok(html.includes(name), name);
  assert.ok(html.includes("memory-archive/beta.md") && html.includes("consolidate/zeta.md"));
  // The hub line, before and after, with only the moved link changed.
  assert.ok(html.includes("- [Beta](beta.md) staging"));
  assert.ok(html.includes("- [Beta](memory-archive/beta.md) staging"));
  // The line MEMORY.md would gain.
  assert.ok(html.includes("Search order: retired memories are in memory-archive/"));
  // Evidence: last seen date for beta, never for eps.
  assert.match(html, /beta\.md[\s\S]{0,2000}Last seen in a session on \d{4}-\d{2}-\d{2}/);
  assert.equal(fs.readFileSync(path.join(fx.memDir, "hub_ops.md"), "utf8"), before, "review changes nothing");
});

test("the page is inert: no scripts, a policy that blocks them, and memory text escaped", () => {
  const { ok, pagePath } = setup();
  const html = fs.readFileSync(pagePath(ok(["review"]).stdout), "utf8");
  assert.ok(!/<script/i.test(html), "no script tags, not even from memory text");
  assert.ok(html.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; more"));
  assert.ok(html.includes("Old payment flow &lt;b&gt;bold&lt;/b&gt;"));
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/);
  assert.ok(!html.includes("—"), "no em dashes");
});

test("an archive dry run writes the review page too", () => {
  const { ok, pagePath } = setup();
  assert.ok(fs.existsSync(pagePath(ok(["archive"]).stdout)));
});

test("merge drafts show beside their sources, and merged adopts an approved draft", () => {
  const { fx, ok, pagePath } = setup();
  fx.write("theta.md", mem("theta", "feedback", "Slow suite", THETA));
  fx.write("iota.md", mem("iota", "feedback", "Retry flaky once", IOTA));
  ok(["archive", "--apply"]);
  const drafts = path.join(fx.state, "drafts");
  fs.mkdirSync(drafts, { recursive: true });
  fs.writeFileSync(path.join(drafts, "browser_tests.md"), `---\nname: browser_tests\ndescription: Browser test rules\nsleep_sources: theta.md, iota.md\nmetadata:\n  type: feedback\n---\n\n${THETA}\n${IOTA}\n`);
  const html = fs.readFileSync(pagePath(ok(["review"]).stdout), "utf8");
  const draftAt = html.indexOf("browser_tests.md");
  assert.ok(draftAt > 0, "the draft is listed");
  const section = html.slice(draftAt, draftAt + 6000);
  assert.ok(section.includes(THETA) && section.includes(IOTA) && section.includes("Slow suite") && section.includes("Retry flaky once"), "sources beside it");
  // Approving: the draft moves into memory without its sleep_sources line, and the draft is gone.
  ok(["merged", "--into", "browser_tests.md", "theta.md", "iota.md"]);
  const merged = fs.readFileSync(path.join(fx.memDir, "browser_tests.md"), "utf8");
  assert.ok(merged.includes(THETA) && !merged.includes("sleep_sources"));
  assert.ok(!fs.existsSync(path.join(drafts, "browser_tests.md")));
  assert.ok(fs.existsSync(path.join(fx.memDir, "memory-archive", "theta.md")));
});

test("a draft whose sources are not all queued is flagged on the page", () => {
  const { fx, ok, pagePath } = setup();
  ok(["archive", "--apply"]);
  fs.mkdirSync(path.join(fx.state, "drafts"), { recursive: true });
  fs.writeFileSync(path.join(fx.state, "drafts", "odd.md"), `---\nname: odd\ndescription: Odd\nsleep_sources: zeta.md, alpha.md\nmetadata:\n  type: feedback\n---\n\n${ZETA}\n`);
  const html = fs.readFileSync(pagePath(ok(["review"]).stdout), "utf8");
  assert.match(html, /alpha\.md[\s\S]{0,300}not in Consolidate/);
});
