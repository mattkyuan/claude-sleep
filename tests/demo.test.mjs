// The demo folder in examples/ must keep showing every part of sleep: archive candidates, a Consolidate queue the
// canned Claude can merge, and checks that pass. README screenshots come from it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, CLI, serve } from "./helpers.mjs";

const DEMO = path.join(ROOT, "examples", "demo.mjs");
const CANNED = path.join(ROOT, "examples", "demo-claude.mjs");

// A space in the folder name checks that the printed commands are quoted.
function build() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sleep-demo-test-")), "my demo");
  const r = spawnSync(process.execPath, [DEMO, dir], { encoding: "utf8", cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  return { dir, claude: path.join(dir, "claude"), project: path.join(dir, "recipe-box"), printed: r.stdout };
}

// The values the demo prints, read back the way a shell would ('...' with '\'' for a quote).
const printedVar = (out, name) => {
  const m = new RegExp(`${name}='((?:[^']|'\\\\'')*)'`).exec(out);
  return m && m[1].replace(/'\\''/g, "'");
};

test("the demo builds a folder with archive candidates, a queue and passing checks", () => {
  const d = build();
  const r = spawnSync(process.execPath, [CLI, "report", "--project", d.project, "--json"], { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: d.claude } });
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.ok(rep.usage.coverageDays >= 60, "a full window of usage on record");
  assert.deepEqual(rep.candidates.map((c) => c.name).sort(), ["api_v1_shutdown.md", "beta_testers.md", "holiday_banner.md", "launch_checklist_2025.md"]);
  assert.equal(rep.consolidate.length, 10);
  assert.deepEqual(rep.checks.filter((c) => c.status === "fail").map((c) => c.id), []);
});

test("the demo refuses to replace a folder it did not make", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sleep-demo-test-"));
  fs.writeFileSync(path.join(dir, "keep.txt"), "mine");
  const r = spawnSync(process.execPath, [DEMO, dir], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(dir, "keep.txt"), "utf8"), "mine");
});

test("the demo's canned Claude merges the queue on the served page", async (t) => {
  const d = build();
  const canned = printedVar(d.printed, "SLEEP_CLAUDE");
  assert.equal(canned, CANNED, "the demo prints the stand-in's absolute path");
  assert.equal(printedVar(d.printed, "CLAUDE_CONFIG_DIR"), d.claude);
  const s = await serve(t, ["--project", d.project], { claude: d.claude }, { SLEEP_CLAUDE: canned });
  assert.equal((await s.act("/consolidate", {})).status, 200);
  let job;
  for (let i = 0; i < 50; i++) {
    job = JSON.parse((await s.act("/job", {})).body).job;
    if (job && job.state !== "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(job.state, "done");
  assert.match(job.message, /wrote 4 merged memories/);
  assert.doesNotMatch(job.message, /failed/);
});
