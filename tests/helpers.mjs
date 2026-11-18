// Shared test fixture: a fake ~/.claude with one project, its memory folder and session logs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
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
  const session = (entries, { ageDays = 1, dir = pdir, sub = null, cwd = null } = {}) => {
    const sid = `s${++n}`;
    const at = new Date(Date.now() - ageDays * DAY).toISOString();
    const lines = [];
    for (const [i, e] of entries.entries()) {
      const id = `toolu_${sid}_${i}`;
      const where = cwd ? { cwd } : {};
      lines.push(JSON.stringify({ type: "assistant", timestamp: at, ...where, message: { content: [{ type: "tool_use", id, name: e.tool, input: e.input || {} }] } }));
      lines.push(JSON.stringify({ type: "user", timestamp: at, ...where, message: { content: [{ type: "tool_result", tool_use_id: id, content: e.result ?? "", ...(e.isError ? { is_error: true } : {}) }] } }));
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


// Starts `review --serve` on a free port and returns helpers that speak to it.
export async function serve(t, flags, fx, env = {}) {
  const p = spawn(process.execPath, [CLI, "review", "--serve", "--port", "0", ...flags], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CLAUDE_CONFIG_DIR: fx.claude, ...env } });
  t.after(() => p.kill());
  const url = await new Promise((resolve, reject) => {
    let out = "";
    p.stdout.on("data", (c) => { out += c; const m = /Review: (http:\/\/\S+)/.exec(out); if (m) resolve(new URL(m[1])); });
    p.on("close", (code) => reject(new Error(`server exited ${code}`)));
  });
  const token = url.searchParams.get("token");
  const req = (method, pathname, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: url.port, method, path: pathname, headers: { Host: `127.0.0.1:${url.port}`, ...headers } }, (res) => {
      let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on("error", reject);
    if (body != null) r.write(typeof body === "string" ? body : JSON.stringify(body));
    r.end();
  });
  const act = (pathname, body, headers = {}) => req("POST", pathname, { headers: { "Content-Type": "application/json", "X-Sleep-Token": token, ...headers }, body });
  return { url, token, req, act };
}

