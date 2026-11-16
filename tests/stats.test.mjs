// Tests for effectiveness tracking: every run appends to stats.jsonl, and `sleep stats` summarizes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, standard, BETA, DELTA, GAMMA } from "./helpers.mjs";

function setup() {
  const fx = fixture(); standard(fx);
  fx.session([{ tool: "Bash", input: { command: "cat beta.md" }, result: BETA }], { ageDays: 70 });
  fx.session([{ tool: "Bash", input: { command: "cat delta.md" }, result: DELTA }], { ageDays: 3 });
  const ok = (args) => { const r = fx.run([...args, "--project", fx.project, "--state", fx.state, "--days", "60"]); assert.equal(r.status, 0, r.stderr); return r; };
  const lines = () => fs.readFileSync(path.join(fx.state, "stats.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { fx, ok, lines };
}

test("each run that looks at or changes memory appends one line of stats", () => {
  const { ok, lines } = setup();
  ok(["report", "--json"]);
  ok(["archive", "--json"]);
  ok(["archive", "--apply", "--json"]);
  const l = lines();
  assert.deepEqual(l.map((x) => x.cmd), ["report", "archive (dry run)", "archive"]);
  const last = l[2];
  assert.equal(last.moved.archive, 3); // beta, gamma, eps
  assert.equal(last.moved.consolidate, 1); // zeta
  assert.deepEqual(last.files, { main: 3, consolidate: 1, archive: 3 }); // alpha, delta, hub_ops; MEMORY.md is not counted
  assert.ok(last.indexTokens > 0 && last.liveBytes > 0);
  assert.equal(typeof last.used, "number");
});

test("stats counts restores and archived files read again as sleep's mistakes", () => {
  const { fx, ok, lines } = setup();
  ok(["archive", "--apply", "--json"]);
  ok(["restore", "eps.md"]);
  // A later session reads gamma from the archive: a sign it should not have moved.
  fx.session([{ tool: "Bash", input: { command: "cat memory-archive/gamma.md" }, result: GAMMA }], { ageDays: 0 });
  const s = JSON.parse(ok(["stats", "--json"]).stdout);
  assert.equal(s.archived, 3);
  assert.equal(s.restored, 1);
  assert.deepEqual(s.readAgain.map((r) => r.name), ["gamma.md"]);
  assert.equal(s.mistakeRate, 2 / 3);
  assert.equal(lines().at(-1).cmd, "stats");
});

test("stats with no history says so instead of failing", () => {
  const fx = fixture(); standard(fx);
  const r = fx.run(["stats", "--project", fx.project, "--state", fx.state, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).runs, 1);
});
