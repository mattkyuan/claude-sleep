#!/usr/bin/env node
// Runs the eval's probes with `claude -p` on the subscription, one call per probe, arm and repeat.
//
//   node eval/run.mjs freeze --dir out/eval
//   node eval/run.mjs run --dir out/eval --model sonnet --arm A=<memory copy> --arm C=<memory copy> [--repeats 3]
//       [--config ~/.claude-ablation] [--work <system temp>/sleep-eval] [--limit N] [--timeout 300]
//
// Each arm's memory copy goes where Claude Code's auto memory looks for a folder outside $HOME, under a config folder
// that is not ~/.claude, with an opaque name so nothing in a prompt or path says which arm it is. Every call is
// checked: subscription (no API key), only Read/Grep/Glob, no MCP, the right memory folder, the same model, the
// memory copy unchanged, and no file read outside the arm. A failed call stops the run; a rerun resumes.
// Plan: docs/plans/2026-11-17-eval.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { checkFrozen, frozenHashes, hashDir, keyOf, loadProbes, manifestFile, parseFlags, readJSON, runFile, sha, within, writeJSON } from "./lib.mjs";

const TOOLS = ["Glob", "Grep", "Read"];
const real = (p) => fs.realpathSync(p);

function freeze(dir) {
  loadProbes(dir);
  const f = path.join(dir, "freeze.json");
  if (fs.existsSync(f)) throw new Error(`Already frozen on ${readJSON(f, {}).at}. A changed eval needs a new folder.`);
  const h = { ...frozenHashes(dir), at: new Date().toISOString() };
  writeJSON(f, h);
  console.log(`Frozen. Commit these hashes before any answer:\n  probes.json ${h.probes}\n  rubric.md   ${h.rubric}`);
}

// The arms, made once per eval folder and checked on every resume.
function arms(dir, flags, config, work) {
  const want = flags.arm.map((a) => {
    const m = /^([A-Za-z0-9]+)=(.+)$/.exec(a);
    if (!m) throw new Error(`--arm must be LABEL=folder, got ${a}`);
    const source = real(m[2]);
    if (!fs.existsSync(path.join(source, "MEMORY.md"))) throw new Error(`${source} has no MEMORY.md: not a memory folder`);
    return { label: m[1], source };
  });
  if (!want.length) throw new Error("Give at least one --arm LABEL=folder.");
  if (new Set(want.map((a) => a.label)).size !== want.length) throw new Error("Arm labels must differ.");
  const have = readJSON(manifestFile(dir), null);
  if (have) {
    const same = have.arms.length === want.length && want.every((a, i) => have.arms[i].label === a.label && have.arms[i].source === a.source && hashDir(a.source) === have.arms[i].hash);
    if (!same || have.config !== config || have.work !== work) throw new Error("The arms, their folders or their contents changed since this eval started. Use a new --dir.");
    for (const a of have.arms) if (hashDir(a.memDir) !== a.hash) throw new Error(`The memory copy for arm ${a.label} changed since the run started.`);
    return have;
  }
  const out = { config, work, model: null, arms: [] };
  for (const a of want) {
    const id = `arm-${crypto.randomBytes(5).toString("hex")}`;
    const cwd = path.join(work, id);
    fs.mkdirSync(cwd, { recursive: true });
    const memDir = path.join(config, "projects", keyOf(real(cwd)), "memory");
    fs.rmSync(memDir, { recursive: true, force: true });
    fs.cpSync(a.source, memDir, { recursive: true, preserveTimestamps: true });
    out.arms.push({ ...a, id, cwd: real(cwd), memDir, hash: hashDir(a.source) });
  }
  writeJSON(manifestFile(dir), out);
  return out;
}

// Every place a tool call read or searched, as an absolute path, or a reason it is out of bounds. A file pattern
// (Glob's pattern, Grep's glob) is resolved against the folder it searches, relative or absolute, and its fixed part
// before any wildcard is what gets checked. A ".." anywhere in a path-like input counts as outside.
function pathsOf(tool, cwd) {
  const i = tool.input || {};
  const abs = (p) => path.resolve(cwd, p);
  const fixed = (base, pat) => path.resolve(base, pat.split(/[*?[{]/)[0] || ".");
  const fields = { Read: ["file_path"], Grep: ["path", "glob"], Glob: ["path", "pattern"] }[tool.name];
  if (!fields) return [`${tool.name} (not an allowed tool)`];
  const up = fields.filter((k) => typeof i[k] === "string" && i[k].split(/[\\/]/).includes(".."));
  if (up.length) return [`${tool.name} ${up.join(", ")} uses ".."`];
  if (tool.name === "Read") return [abs(i.file_path ?? "")];
  const base = abs(i.path ?? ".");
  const pat = tool.name === "Grep" ? i.glob : i.pattern;
  return typeof pat === "string" ? [base, fixed(base, pat)] : [base];
}

// The real path, through any symbolic link, even for a file that does not exist: the nearest existing folder above
// it is resolved, and the rest is added back.
function canon(p) {
  let head = p, tail = "";
  while (!fs.existsSync(head)) { const up = path.dirname(head); if (up === head) break; tail = path.join(path.basename(head), tail); head = up; }
  try { return path.join(fs.realpathSync(head), tail); } catch { return p; }
}

function call(bin, arm, probe, model, config, timeout) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  const args = ["-p", probe.prompt, "--model", model, "--tools", "Read,Grep,Glob", "--strict-mcp-config", "--disable-slash-commands", "--output-format", "stream-json", "--verbose"];
  const r = spawnSync(bin, args, { cwd: arm.cwd, env, encoding: "utf8", timeout: timeout * 1000, maxBuffer: 64 << 20 });
  const events = (r.stdout || "").split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  return { r, events, raw: r.stdout || "" };
}

// Checks a finished call; throws on anything that makes the run untrustworthy, so it stops.
function check(events, r, arm, probe, state, wantModel) {
  const where = `${probe.id} on arm ${arm.label}`;
  const result = events.find((e) => e.type === "result");
  if (r.error || r.status !== 0 || !result || result.is_error) {
    const why = r.error?.message || (result?.is_error ? result.result : "") || (r.stderr || "").trim().split("\n").pop() || `exit ${r.status}`;
    throw new Error(`claude failed on ${where}: ${why}. Nothing was recorded for it; rerun to resume.`);
  }
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  if (!init) throw new Error(`No init event on ${where}: cannot confirm the call ran clean.`);
  if (init.apiKeySource !== "none") throw new Error(`${where} ran with API key source "${init.apiKeySource}", not the subscription. Stopped.`);
  if (JSON.stringify([...(init.tools || [])].sort()) !== JSON.stringify(TOOLS)) throw new Error(`${where} had tools ${JSON.stringify(init.tools)}, not ${TOOLS.join(", ")}. Stopped.`);
  if ((init.mcp_servers || []).length) throw new Error(`${where} had MCP servers attached. Stopped.`);
  const auto = (init.memory_paths?.auto || "").replace(/\/+$/, "");
  if (auto !== arm.memDir) throw new Error(`${where} loaded memory from ${auto || "nowhere"}, not the arm's copy ${arm.memDir}. Stopped.`);
  if (/^claude-/.test(wantModel) && init.model !== wantModel) throw new Error(`${where} ran ${init.model}, not ${wantModel}. Stopped.`);
  if (state.model && init.model !== state.model) throw new Error(`${where} ran ${init.model}, but earlier calls ran ${state.model}. Stopped.`);
  if (hashDir(arm.memDir) !== arm.hash) throw new Error(`The memory copy for arm ${arm.label} changed during ${where}. Stopped; start a new eval folder.`);
  return { init, result };
}

function record(events, arm, probe, rep, init, result) {
  const tools = events.filter((e) => e.type === "assistant").flatMap((e) => (e.message?.content || []).filter((c) => c.type === "tool_use").map((c) => ({ name: c.name, input: c.input })));
  const outside = [], reads = [];
  for (const t of tools) for (const raw of pathsOf(t, arm.cwd)) {
    if (!path.isAbsolute(raw)) { outside.push(raw); continue; }
    const p = canon(raw);
    if (!within(p, arm.memDir) && !within(p, arm.cwd)) outside.push(p);
    else if (t.name === "Read" && within(p, arm.memDir)) reads.push(path.relative(arm.memDir, p));
  }
  const answer = String(result.result ?? "");
  const status = outside.length ? "void" : /<invoke|<function_calls/.test(answer) ? "invalid" : "ok";
  const why = outside.length ? `read outside the arm: ${outside.join(", ")}` : status === "invalid" ? "the answer holds a tool-call stub as text" : "";
  return { probe: probe.id, arm: arm.label, rep, status, why, answer, reads, searches: tools.filter((t) => t.name !== "Read").length, tools, model: init.model, usage: result.usage ?? null, at: new Date().toISOString() };
}

// Probe order: repeats outermost, arms shuffled per probe and repeat, so rate limits and drift hit all arms alike.
function order(probes, armList, repeats) {
  const out = [];
  for (let rep = 1; rep <= repeats; rep++) for (const p of probes) {
    const seeded = [...armList].sort((a, b) => (sha(`${p.id}/${rep}/${a.label}`) < sha(`${p.id}/${rep}/${b.label}`) ? -1 : 1));
    for (const a of seeded) out.push({ arm: a, probe: p, rep });
  }
  return out;
}

async function run(dir, flags) {
  const probes = loadProbes(dir);
  checkFrozen(dir);
  if (!flags.model) throw new Error("--model is required: the eval pins one model.");
  const repeats = Number(flags.repeats ?? 3), limit = flags.limit == null ? Infinity : Number(flags.limit), timeout = Number(flags.timeout ?? 300);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be a whole number");
  const home = real(os.homedir());
  const config = real(flags.config || path.join(home, ".claude-ablation"));
  const realClaude = path.join(home, ".claude");
  if (within(config, fs.existsSync(realClaude) ? real(realClaude) : realClaude)) throw new Error(`--config ${config} is the real Claude Code folder. Use a separate, logged-in config folder.`);
  const workArg = flags.work || path.join(os.tmpdir(), "sleep-eval");
  fs.mkdirSync(workArg, { recursive: true });
  const work = real(workArg);
  if (within(work, home)) throw new Error(`--work ${work} is under your home folder, where CLAUDE.md files up the tree would load. Use a folder outside it.`);
  const state = arms(dir, flags, config, work);
  const bin = process.env.SLEEP_CLAUDE || "claude";
  const todo = order(probes, state.arms, repeats).filter((c) => !fs.existsSync(runFile(dir, c.arm.label, c.probe.id, c.rep)));
  const total = Math.min(todo.length, limit);
  let n = 0;
  for (const c of todo.slice(0, total)) {
    const { r, events, raw } = call(bin, c.arm, c.probe, flags.model, config, timeout);
    const { init, result } = check(events, r, c.arm, c.probe, state, flags.model);
    if (!state.model) { state.model = init.model; writeJSON(manifestFile(dir), state); }
    const rec = record(events, c.arm, c.probe, c.rep, init, result);
    const f = runFile(dir, c.arm.label, c.probe.id, c.rep);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f.replace(/\.json$/, ".jsonl"), raw);
    writeJSON(f, rec);
    console.log(`[${++n}/${total}] ${c.arm.label} ${c.probe.id} #${c.rep}: ${rec.status}${rec.why ? ` (${rec.why})` : ""}, ${rec.reads.length} read(s)`);
  }
  const left = order(probes, state.arms, repeats).filter((c) => !fs.existsSync(runFile(dir, c.arm.label, c.probe.id, c.rep))).length;
  console.log(left ? `${left} call(s) left; rerun to continue.` : `All ${probes.length * state.arms.length * repeats} calls done on ${state.model}. Next: node eval/score.mjs bundle --dir ${dir}`);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  const flags = parseFlags(rest);
  const dir = path.resolve(flags.dir || "out/eval");
  if (cmd === "freeze") freeze(dir);
  else if (cmd === "run") await run(dir, flags);
  else throw new Error("Usage: node eval/run.mjs freeze|run --dir <eval folder> ...");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
