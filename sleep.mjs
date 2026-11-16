#!/usr/bin/env node
// sleep: memory upkeep for Claude Code. This file is the command line; the work is in lib/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMemory } from "./lib/memory.mjs";
import { usage, loadLedger, saveLedger } from "./lib/usage.mjs";
import { DEFAULTS, checks, candidates } from "./lib/checks.mjs";
import { writeReport } from "./lib/report.mjs";
import { loadMoves, saveMoves, activeArchived, planMoves, applyMoves, setHint, pruneEmpty } from "./lib/archive.mjs";
import { ensureRepo, commitAll } from "./lib/git.mjs";

const HELP = `sleep: memory upkeep for Claude Code

Usage:
  sleep report [options]          inventory, usage, checks and what could move; changes nothing
  sleep archive [options]         show what would move; with --apply, move it
  sleep restore <file> [options]  put a moved file back where it was, links and all (--all: every moved file)

Options:
  --project DIR      the project whose memory to read (default: the current folder)
  --days N           a file must go unused this many days before it moves (default ${DEFAULTS.days})
  --apply            archive: actually move files (and purge, if a purge window is set)
  --purge-after N    archive: delete files archived over N days ago and unused since (default: never)
  --out DIR          where to write the report (default: <project data>/sleep/reports)
  --state DIR        where sleep keeps its ledger and moves (default: <project data>/sleep)
  --json             print the result as json instead of writing a report
  --help             show this

Moves: unused project memories go to memory/memory-archive/, unused feedback memories to memory/consolidate/
to be merged. Links to them are rewritten, never deleted. Before changing anything, sleep commits the memory
folder to its own git history, and commits again after.
`;

function parse(argv) {
  const o = { cmd: argv[0], args: [], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { o.args.push(a); continue; }
    const k = a.slice(2);
    if (["json", "help", "apply", "all"].includes(k)) o.flags[k] = true;
    else { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); o.flags[k] = argv[++i]; }
  }
  return o;
}

const untilde = (p) => (p && p.startsWith("~") ? os.homedir() + p.slice(1) : p);
const projectKey = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : null);

// Paths, memory, usage and candidates: everything a command needs, read once.
async function context(flags) {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const project = path.resolve(untilde(flags.project || process.cwd()));
  const key = projectKey(project);
  const pdir = path.join(claudeDir, "projects", key);
  const memDir = path.join(pdir, "memory");
  if (!fs.existsSync(memDir)) throw new Error(`No memory folder at ${memDir}`);
  const days = flags.days ? Number(flags.days) : DEFAULTS.days;
  if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a whole number of days");
  const opt = { ...DEFAULTS, days };
  // Sleep's own files live next to the memory folder, never in it, so a grep of memory never hits them.
  const state = path.resolve(untilde(flags.state || path.join(pdir, "sleep")));
  const movesFile = path.join(state, "moves.json");
  const moves = loadMoves(movesFile);

  const mem = readMemory(memDir, { archived: activeArchived(moves) });
  // The same folder as commands may spell it: as is, resolved through symlinks, and with ~.
  const memDirs = [...new Set([memDir, fs.realpathSync(memDir), memDir.replace(os.homedir(), "~")])];
  const ledgerFile = path.join(state, "ledger.json");
  const ledger = loadLedger(ledgerFile);
  const progress = (msg) => { if (process.stderr.isTTY) process.stderr.write(`\r${msg}   `); };
  const u = await usage({ mem, claudeDir, projectKey: key, memDirs, ledger, progress });
  if (process.stderr.isTTY) process.stderr.write("\r" + " ".repeat(60) + "\r");
  saveLedger(ledgerFile, ledger);

  const of = (f) => u.per.get(f.name) || { sessions: 0, last: 0 };
  const status = (f) => (of(f).sessions ? "used" : u.fingerprintLines.get(f.name) ? "unused" : "no data");
  const use = { of, status };
  // Checks and candidates look at live memory; files sleep archived are only counted for use.
  const live = { ...mem, files: mem.files.filter((f) => f.area !== "archive") };
  const cand = candidates(live, use, opt, u.summary.coverageDays);
  const main = (list) => list.filter((c) => live.files.find((f) => f.name === c.name)?.area === "main").map((c) => ({ ...c, rel: live.files.find((f) => f.name === c.name).rel }));
  return { project, pdir, memDir, state, movesFile, moves, opt, mem, live, u, use, cand: { ...cand, list: main(cand.list), consolidate: main(cand.consolidate) } };
}

function buildReport(ctx, mode) {
  const { mem, live, u, use, cand, opt } = ctx;
  return {
    version: 1, generatedAt: new Date().toISOString(), mode, project: ctx.project, memDir: ctx.memDir,
    options: { days: opt.days, expirable: opt.expirable, protectedTypes: opt.protectedTypes, consolidateTypes: opt.consolidateTypes },
    index: { lines: mem.index.lines, bytes: mem.index.bytes, tokens: mem.index.tokens, loadedLines: mem.index.loadedLines, truncatedLines: mem.index.truncatedLines },
    usage: u.summary,
    files: mem.files.map((f) => ({
      name: f.name, rel: f.rel, area: f.area, type: f.type, description: f.description, bytes: f.bytes, tokens: f.tokens,
      created: day(f.createdMs), edited: day(f.mtimeMs), linkedFrom: f.linkedFrom,
      usage: { status: use.status(f), sessions: use.of(f).sessions, lastUsed: day(use.of(f).last) },
    })),
    checks: checks(live, use, opt),
    candidates: cand.list, consolidate: cand.consolidate, candidatesNote: cand.note,
  };
}

function finish(r, ctx, flags, line) {
  if (flags.json) { process.stdout.write(JSON.stringify(r, null, 2) + "\n"); return; }
  const out = path.resolve(untilde(flags.out || path.join(ctx.state, "reports")));
  const { md } = writeReport(r, out);
  console.log(line);
  console.log(`Report: ${md}`);
}

async function report(flags) {
  const ctx = await context(flags);
  const r = buildReport(ctx, "report");
  const failed = r.checks.filter((c) => c.status === "fail" || c.status === "warn").length;
  finish(r, ctx, flags, `${r.files.length} memory files; ${ctx.u.summary.coverageDays} days of usage on record; ${failed} check(s) need attention; ${r.candidates.length} archive candidate(s); ${r.consolidate.length} queued for consolidation.`);
}

// Files archived over N days ago that nothing has read since they were archived.
function purgeList(ctx, days) {
  if (days == null) return [];
  const cut = Date.now() - days * 864e5;
  return ctx.moves.filter((m) => {
    if (m.kind !== "archive" || m.status !== "active" || Date.parse(m.at) > cut) return false;
    if (!fs.existsSync(path.join(ctx.memDir, m.to))) return false;
    const f = ctx.mem.files.find((x) => x.rel === m.to);
    return !(f && ctx.use.of(f).last > Date.parse(m.at));
  });
}

function purgeDays(flags, state) {
  let v = flags["purge-after"];
  if (v == null) { try { v = JSON.parse(fs.readFileSync(path.join(state, "config.json"), "utf8")).purgeAfterDays; } catch {} }
  if (v == null || v === "never") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error("--purge-after must be a whole number of days, or never");
  return n;
}

async function archive(flags) {
  const ctx = await context(flags);
  const planned = planMoves(ctx.memDir, ctx.cand.list, ctx.cand.consolidate);
  const purge = purgeList(ctx, purgeDays(flags, ctx.state));
  const r = { ...buildReport(ctx, flags.apply ? "archive" : "archive (dry run)"), applied: !!flags.apply, moves: planned, purged: purge.map((m) => m.to), commits: {} };
  if (flags.apply && (planned.length || purge.length)) {
    ensureRepo(ctx.memDir);
    r.commits.before = commitAll(ctx.memDir, "sleep: snapshot before archiving");
    applyMoves(ctx.memDir, planned);
    const at = new Date().toISOString();
    for (const m of planned) ctx.moves.push({ ...m, at, status: "active" });
    for (const m of purge) { fs.unlinkSync(path.join(ctx.memDir, m.to)); m.status = "purged"; m.purgedAt = at; }
    setHint(ctx.memDir, ctx.moves.some((m) => m.status === "active"));
    saveMoves(ctx.movesFile, ctx.moves);
    const archived = planned.filter((m) => m.kind === "archive").length, queued = planned.length - archived;
    r.commits.after = commitAll(ctx.memDir, `sleep: archived ${archived}, queued ${queued} for consolidation${purge.length ? `, purged ${purge.length}` : ""}`);
  } else if (flags.apply) {
    // Nothing to move, but a snapshot still records edits made since the last run.
    if (fs.existsSync(path.join(ctx.memDir, ".git"))) r.commits.before = commitAll(ctx.memDir, "sleep: snapshot before archiving");
  }
  const verb = flags.apply ? "Moved" : "Would move";
  finish(r, ctx, flags, `${verb} ${planned.length} file(s) (${planned.filter((m) => m.kind === "archive").length} to the archive, ${planned.filter((m) => m.kind === "consolidate").length} to consolidate)${purge.length ? `; ${flags.apply ? "purged" : "would purge"} ${purge.length}` : ""}.${flags.apply ? "" : " Run with --apply to do it."}`);
}

// Puts moved files back and points their links at them again. A link that was already broken before the move
// can come back pointing at the file it meant; a link that worked is never changed.
async function restore(flags, args) {
  if (flags.all ? args.length : args.length !== 1) throw new Error("Usage: sleep restore <file>, or sleep restore --all");
  const ctx = await context(flags);
  const active = ctx.moves.filter((x) => x.status === "active");
  const picked = flags.all ? active : active.filter((x) => x.name === args[0] || x.from === args[0] || x.to === args[0]).slice(0, 1);
  if (!picked.length) throw new Error(flags.all ? "Nothing sleep moved is waiting to be restored." : `Nothing sleep moved matches ${args[0]}. Moved files are listed in ${ctx.movesFile}.`);
  for (const m of picked) if (fs.existsSync(path.join(ctx.memDir, m.from))) throw new Error(`${m.from} exists again, so ${m.to} cannot go back without overwriting it.`);
  ensureRepo(ctx.memDir);
  commitAll(ctx.memDir, "sleep: snapshot before restoring");
  applyMoves(ctx.memDir, picked.map((m) => ({ from: m.to, to: m.from })));
  const at = new Date().toISOString();
  for (const m of picked) { m.status = "restored"; m.restoredAt = at; }
  setHint(ctx.memDir, ctx.moves.some((x) => x.status === "active"));
  pruneEmpty(ctx.memDir);
  saveMoves(ctx.movesFile, ctx.moves);
  const hash = commitAll(ctx.memDir, picked.length === 1 ? `sleep: restored ${picked[0].from}` : `sleep: restored ${picked.length} files`);
  if (flags.json) process.stdout.write(JSON.stringify({ restored: picked, commit: hash }, null, 2) + "\n");
  else console.log(picked.length === 1 ? `Restored ${picked[0].to} to ${picked[0].from}.` : `Restored ${picked.length} files.`);
}

async function main() {
  const { cmd, args, flags } = parse(process.argv.slice(2));
  if (!cmd || cmd === "help" || flags.help) { process.stdout.write(HELP); return; }
  if (cmd !== "restore" && args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  if (cmd === "report") return report(flags);
  if (cmd === "archive") return archive(flags);
  if (cmd === "restore") return restore(flags, args);
  throw new Error(`Unknown command: ${cmd}. Try: sleep help`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
