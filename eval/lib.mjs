// Shared by the eval's run and score commands: the probe file, hashes, paths and flags.
// Plan: docs/plans/2026-11-17-eval.md. Probe text holds memory content, so it lives in the eval folder (default
// out/eval, ignored by git), never in the repo.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const KINDS = ["rule", "destructive", "fact", "negative"];
export const CRITICAL = new Set(["rule", "destructive"]);

export const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const keyOf = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
export const within = (p, root) => { const r = path.relative(root, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
export const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
export function writeJSON(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(v, null, 2) + "\n");
  fs.renameSync(f + ".tmp", f);
}

// Every file under dir, by path and content, so a probe that changed the memory copy is caught.
export function hashDir(dir) {
  const h = crypto.createHash("sha256");
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) h.update(`${path.relative(dir, f)}\0`).update(fs.readFileSync(f)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}

// --key value pairs; --arm can repeat.
export function parseFlags(argv) {
  const out = { arm: [], moves: [] };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m) throw new Error(`Unexpected argument: ${argv[i]}`);
    const v = argv[++i];
    if (v == null) throw new Error(`--${m[1]} needs a value`);
    if (Array.isArray(out[m[1]])) out[m[1]].push(v); else out[m[1]] = v;
  }
  return out;
}

export const probesFile = (dir) => path.join(dir, "probes.json");
export const rubricFile = (dir) => path.join(dir, "rubric.md");
const text = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
export const frozenHashes = (dir) => ({ probes: sha(text(probesFile(dir))), rubric: sha(text(rubricFile(dir))) });

// probes.json: { probes: [{ id, kind, prompt, source?, must?: [regex], mustNot?: [regex], judge?: "what a pass is" }] }
export function loadProbes(dir) {
  const v = readJSON(probesFile(dir), null);
  if (!v || !Array.isArray(v.probes) || !v.probes.length) throw new Error(`No probes in ${probesFile(dir)}`);
  const seen = new Set();
  for (const p of v.probes) {
    const where = `probe ${p.id ?? "(no id)"}`;
    if (typeof p.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(p.id) || seen.has(p.id)) throw new Error(`${where}: id must be unique letters, digits, _ or -`);
    seen.add(p.id);
    if (!KINDS.includes(p.kind)) throw new Error(`${where}: kind must be one of ${KINDS.join(", ")}`);
    if (typeof p.prompt !== "string" || !p.prompt.trim() || p.prompt.startsWith("-")) throw new Error(`${where}: prompt must be text not starting with -`);
    if (p.source != null && !/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(p.source)) throw new Error(`${where}: source must be a memory file name`);
    for (const k of ["must", "mustNot"]) {
      if (p[k] == null) continue;
      if (!Array.isArray(p[k])) throw new Error(`${where}: ${k} must be a list`);
      for (const r of p[k]) new RegExp(r, "u");
    }
    if (!p.must?.length && !p.mustNot?.length && !p.judge) throw new Error(`${where}: needs must, mustNot or judge, or nothing could fail it`);
  }
  return v.probes;
}

// Refuses unless probes.json and rubric.md are exactly what was frozen.
export function checkFrozen(dir) {
  const f = readJSON(path.join(dir, "freeze.json"), null);
  if (!f) throw new Error(`Not frozen: run "node eval/run.mjs freeze --dir ${dir}" and commit the hashes before any answer.`);
  const now = frozenHashes(dir);
  for (const k of ["probes", "rubric"]) if (f[k] !== now[k]) throw new Error(`${k} changed since the freeze on ${f.at}: the eval would no longer be the one fixed before any answer.`);
  return f;
}

export const manifestFile = (dir) => path.join(dir, "arms.json");
export const runFile = (dir, label, id, rep) => path.join(dir, "runs", label, `${id}-${rep}.json`);
