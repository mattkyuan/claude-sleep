// Shared test fixture: a fake ~/.claude with one project, its memory folder and session logs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CLI = path.join(ROOT, "sleep.mjs");
export const DAY = 864e5;

export const key = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
export const mem = (name, type, desc, body) => `---\nname: ${name}\ndescription: ${desc}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;

// A fake ~/.claude with one project, its memory folder, and helpers to write session logs.
export function fixture() {
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), "sleep-test-"));
  const project = path.join(claude, "work", "proj");
  fs.mkdirSync(project, { recursive: true });
  const pdir = path.join(claude, "projects", key(project));
  const memDir = path.join(pdir, "memory");
  fs.mkdirSync(memDir, { recursive: true });
  const write = (name, text, ageDays = 90) => {
    const f = path.join(memDir, name);
    fs.writeFileSync(f, text);
    const t = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(f, t, t);
  };
  let n = 0;
  // One session = one .jsonl; entries are [kind, payload] pairs turned into log lines.
  const session = (entries, { ageDays = 1, dir = pdir, sub = null } = {}) => {
    const sid = `s${++n}`;
    const at = new Date(Date.now() - ageDays * DAY).toISOString();
    const lines = [];
    for (const [i, e] of entries.entries()) {
      const id = `toolu_${sid}_${i}`;
      lines.push(JSON.stringify({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name: e.tool, input: e.input || {} }] } }));
      lines.push(JSON.stringify({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id, content: e.result ?? "" }] } }));
    }
    let file = path.join(dir, `${sid}.jsonl`);
    if (sub) { fs.mkdirSync(path.join(dir, sid, "subagents"), { recursive: true }); fs.writeFileSync(file, ""); file = path.join(dir, sid, "subagents", `${sub}.jsonl`); }
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return { sid, file };
  };
  const state = path.join(claude, "state");
  const run = (args = [], env = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: claude, ...env } });
    return r;
  };
  const report = (extra = []) => {
    const r = run(["report", "--project", project, "--state", state, "--json", ...extra]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  return { claude, project, pdir, memDir, write, session, state, run, report };
}

export const ALPHA = "Alpha says the deploy runs from the main branch every morning.";
export const BETA = "Beta notes that the staging database is rebuilt nightly at two.";
export const GAMMA = "Gamma records that the flaky login test needs a retry wrapper.";
export const DELTA = "Delta warns that the cache must be cleared before a schema change.";
export const EPS = "Epsilon explains the old payment flow that was replaced in March.";
export const ZETA = "Zeta lists the reviewers who own the frontend checkout component.";

export function standard(fx) {
  fx.write("MEMORY.md", "# Index\n- [Alpha](alpha.md): deploys\n- [Hub](hub_ops.md): ops\n", 1);
  fx.write("alpha.md", mem("alpha", "project", "Deploys run from main", ALPHA));
  fx.write("beta.md", mem("beta", "project", "Staging rebuild", BETA));
  fx.write("gamma.md", mem("gamma", "project", "Flaky login test", GAMMA));
  fx.write("delta.md", mem("delta", "project", "Clear cache before schema change", DELTA));
  fx.write("eps.md", mem("eps", "project", "Old payment flow", EPS));
  fx.write("zeta.md", mem("zeta", "feedback", "Frontend reviewers", ZETA));
  fx.write("hub_ops.md", mem("hub_ops", "reference", "Ops hub", "- [Beta](beta.md)\n- [[gamma]]"));
}

