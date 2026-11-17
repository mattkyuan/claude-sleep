#!/usr/bin/env node
// sleep: memory upkeep for Claude Code. This file is the command line; the work is in lib/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMemory } from "./lib/memory.mjs";
import { usage, loadLedger, saveLedger } from "./lib/usage.mjs";
import { DEFAULTS, checks, candidates } from "./lib/checks.mjs";
import { writeReport } from "./lib/report.mjs";
import { loadMoves, saveMoves, activeArchived, planMoves, applyMoves, setHint, pruneEmpty, redirectSlugs, linkEdits, hasHint, HINT } from "./lib/archive.mjs";
import { ensureRepo, commitAll } from "./lib/git.mjs";
import { record, summarize } from "./lib/stats.mjs";
import { parseSchedule, describe, command, plist, cronLine, install, remove, labelFor } from "./lib/schedule.mjs";
import { fileURLToPath } from "node:url";
import { frontmatter } from "./lib/memory.mjs";
import { reviewHtml } from "./lib/review.mjs";
import { startServer } from "./lib/serve.mjs";
import { spawn } from "node:child_process";

const CLI = fileURLToPath(import.meta.url);
const loadConfig = (state) => { try { const c = JSON.parse(fs.readFileSync(path.join(state, "config.json"), "utf8")); return c && typeof c === "object" ? c : {}; } catch { return {}; } };
const saveConfig = (state, c) => { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(c, null, 2) + "\n"); };

const HELP = `sleep: memory upkeep for Claude Code

Usage:
  sleep report [options]          inventory, usage, checks and what could move; changes nothing
  sleep archive [options]         show what would move; with --apply, move it
  sleep restore <file> [options]  put a moved file back where it was, links and all (--all: every moved file)
  sleep schedule [--every daily|weekly|monthly] [--day D] [--at HH:MM] [--mode report|archive] [--off]
                                  run sleep on its own (report only unless --mode archive); no flags shows it
  sleep review [--open]           a local page with every proposed move, link edit and merge draft; changes nothing
  sleep review --serve [--port N] the same page on 127.0.0.1, where you pick moves, approve merges and leave notes,
                                  for any project with memory (pick it at the top of the page)
  sleep projects [--json]         every project with memory, and how many files each has
  sleep stats [options]           how well sleep is doing: size over time, restores and re-reads (its error rate), merges
  sleep queue [options]           the consolidation queue, grouped by the hub that links to each memory
  sleep merged --into <file> <queued>...  record a merge: archive the sources, point their links at <file>

Options:
  --project DIR      the project whose memory to read (default: the current folder)
  --key KEY          the same, by the folder name under ~/.claude/projects (as sleep projects shows it)
  --days N           a file must go unused this many days before it moves (default ${DEFAULTS.days})
  --apply            archive: actually move files (and purge, if a purge window is set)
  --port N           review --serve: the port (default 8767; a free one if taken)
  --purge-after N    archive: delete files archived over N days ago and unused since (default: never)
  --only FILE        archive: move only the planned files named in FILE (a JSON list); no purge
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
    if (["json", "help", "apply", "all", "off", "open", "serve"].includes(k)) o.flags[k] = true;
    else { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); o.flags[k] = argv[++i]; }
  }
  return o;
}

const untilde = (p) => (p && p.startsWith("~") ? os.homedir() + p.slice(1) : p);
const projectKey = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
// Claude Code keeps a worktree's memory under its main checkout, so map a worktree back to that checkout:
// either by Claude Code's own worktree folder, or by the .git file a git worktree has.
function mainCheckout(dir) {
  const cut = dir.match(/^(.*?)\/\.claude\/worktrees\//);
  if (cut) return cut[1];
  try {
    const dotgit = path.join(dir, ".git");
    if (fs.statSync(dotgit).isFile()) {
      const m = fs.readFileSync(dotgit, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
      const w = m && m[1].match(/^(.*)\/\.git\/worktrees\/[^/]+$/);
      if (w) return path.resolve(dir, w[1]);
    }
  } catch {}
  return dir;
}
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : null);

// Paths, memory, usage and candidates: everything a command needs, read once.
// Where everything is, without reading anything yet.
const claudeDirOf = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

// The project folder a key stands for, read from the newest session log that names one. Keys are lossy (a dash may
// have been a slash), so a folder counts only if it encodes back to the same key; otherwise the answer is null.
function folderOf(pdir, key) {
  let logs = [];
  try { logs = fs.readdirSync(pdir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(pdir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); } catch {}
  for (const log of logs.slice(0, 5)) {
    let head = "";
    try { const fd = fs.openSync(log, "r"); const buf = Buffer.alloc(65536); head = buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0)); fs.closeSync(fd); } catch { continue; }
    for (const line of head.split("\n")) {
      let cwd; try { cwd = JSON.parse(line).cwd; } catch { continue; }
      if (typeof cwd !== "string" || !cwd) continue;
      const main = mainCheckout(cwd);
      if (projectKey(main) === key) return main;
    }
  }
  return null;
}

// Every project with memory to look at, by the key Claude Code files it under. A worktree's folder is left out (it
// shares its main checkout's memory), and so is a memory folder with no files. Reads folder listings only.
function listProjects(claudeDir = claudeDirOf()) {
  const root = path.join(claudeDir, "projects");
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch {}
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory() || e.name.includes("--claude-worktrees-")) continue;
    const pdir = path.join(root, e.name), memDir = path.join(pdir, "memory");
    let files;
    try { files = fs.readdirSync(memDir).filter((f) => f.endsWith(".md")); } catch { continue; }
    if (!files.length) continue;
    out.push({ key: e.name, path: folderOf(pdir, e.name), files: files.length, memDir });
  }
  return out.sort((a, b) => b.files - a.files || a.key.localeCompare(b.key));
}

function locate(flags) {
  const claudeDir = claudeDirOf();
  let project, key;
  if (flags.key != null) {
    // A key is taken only if it names a project found on disk, never joined into a path as given.
    const p = listProjects(claudeDir).find((x) => x.key === flags.key);
    if (!p) throw new Error(`No project with memory under the key ${flags.key}. Run: sleep projects`);
    key = p.key; project = p.path;
  } else {
    project = mainCheckout(path.resolve(untilde(flags.project || process.cwd())));
    key = projectKey(project);
  }
  const pdir = path.join(claudeDir, "projects", key);
  const memDir = path.join(pdir, "memory");
  if (!fs.existsSync(memDir)) throw new Error(`No memory folder at ${memDir}`);
  // Sleep's own files live next to the memory folder, never in it, so a grep of memory never hits them.
  const state = path.resolve(untilde(flags.state || path.join(pdir, "sleep")));
  // How to name this project to a later run of the command line: by folder when it is known, else by key.
  const target = project ? ["--project", project] : ["--key", key];
  return { claudeDir, project: project || key, key, target, pdir, memDir, state, config: loadConfig(state) };
}

async function context(flags) {
  const { claudeDir, project, key, target, pdir, memDir, state, config } = locate(flags);
  // A flag wins over config.json, which wins over the default.
  const days = flags.days != null ? Number(flags.days) : config.days ?? DEFAULTS.days;
  if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a whole number of days");
  const opt = { ...DEFAULTS, days };
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
  return { project, key, target, pdir, memDir, state, movesFile, moves, opt, mem, live, u, use, cand: { ...cand, list: main(cand.list), consolidate: main(cand.consolidate) } };
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
  record(ctx, "report");
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

// --only: a JSON list of names. Only planned moves whose name is on it go ahead; a name the plan does not hold is ignored.
function onlyList(flags) {
  if (flags.only == null) return null;
  let v; try { v = JSON.parse(fs.readFileSync(path.resolve(untilde(flags.only)), "utf8")); } catch { throw new Error("--only needs a file holding a JSON list of file names"); }
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error("--only needs a file holding a JSON list of file names");
  return new Set(v);
}

async function archive(flags) {
  const ctx = await context(flags);
  const only = onlyList(flags);
  const keep = (list) => (only ? list.filter((c) => only.has(c.name)) : list);
  const planned = planMoves(ctx.memDir, keep(ctx.cand.list), keep(ctx.cand.consolidate));
  const purge = only ? [] : purgeList(ctx, purgeDays(flags, ctx.state));
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
  record(ctx, r.mode, { moved: { archive: planned.filter((m) => m.kind === "archive").length, consolidate: planned.filter((m) => m.kind === "consolidate").length }, purged: purge.length, applied: !!flags.apply });
  const reviewFile = flags.apply ? null : writeReview(ctx, planned, purge);
  const verb = flags.apply ? "Moved" : "Would move";
  if (reviewFile && !flags.json) console.log(`Review: ${reviewFile}`);
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
  record(ctx, "restore", { restored: picked.map((m) => m.name) });
  const hash = commitAll(ctx.memDir, picked.length === 1 ? `sleep: restored ${picked[0].from}` : `sleep: restored ${picked.length} files`);
  if (flags.json) process.stdout.write(JSON.stringify({ restored: picked, commit: hash }, null, 2) + "\n");
  else console.log(picked.length === 1 ? `Restored ${picked[0].to} to ${picked[0].from}.` : `Restored ${picked.length} files.`);
}

// The consolidation queue, grouped by the file that links to each memory (a hub, usually), so related lessons can be
// merged together. A memory nothing in the main folder links to is "unfiled".
async function queue(flags) {
  const ctx = await context(flags);
  const queued = ctx.live.files.filter((f) => f.area === "consolidate");
  const mainNames = new Set(ctx.live.files.filter((f) => f.area === "main").map((f) => f.name));
  const topics = new Map();
  for (const f of queued) {
    const topic = f.linkedFrom.filter((n) => mainNames.has(n)).sort()[0] || "unfiled";
    if (!topics.has(topic)) topics.set(topic, []);
    topics.get(topic).push({ name: f.name, rel: f.rel, description: f.description, bytes: f.bytes, created: day(f.createdMs), lastUsed: day(ctx.use.of(f).last) });
  }
  const list = [...topics].map(([topic, files]) => ({ topic, files: files.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => (a.topic === "unfiled") - (b.topic === "unfiled") || b.files.length - a.files.length);
  if (flags.json) { process.stdout.write(JSON.stringify({ memDir: ctx.memDir, drafts: path.join(ctx.state, "drafts"), notes: openNotes(ctx.state), queued: queued.length, topics: list }, null, 2) + "\n"); return; }
  console.log(`${queued.length} memories waiting to be merged, in ${list.length} topic(s):`);
  for (const t of list) console.log(`  ${t.topic}: ${t.files.length}`);
}

// Records a merge the skill wrote: the merged memory is already in the folder; its queued sources move to the archive,
// links to them now point at the merged memory, and one commit holds the whole merge.
async function merged(flags, sources) {
  const into = String(flags.into || "");
  if (!into) throw new Error("Usage: sleep merged --into <merged.md> <queued.md>...");
  if (into.includes("/") || !into.endsWith(".md")) throw new Error("The merged memory goes at the top of the memory folder, not in a subfolder, and ends in .md.");
  if (!sources.length) throw new Error("Name the queued memories that went into it: sleep merged --into <merged.md> <queued.md>...");
  const ctx = await context(flags);
  const draft = path.join(ctx.state, "drafts", into);
  if (!fs.existsSync(path.join(ctx.memDir, into)) && !fs.existsSync(draft)) throw new Error(`Write the merged memory first: ${into} is not in the memory folder or in ${path.dirname(draft)}.`);
  const picked = sources.map((s) => {
    const m = ctx.moves.find((x) => x.status === "active" && x.kind === "consolidate" && (x.name === s || x.to === s));
    if (!m || !fs.existsSync(path.join(ctx.memDir, m.to))) throw new Error(`${s} is not in the consolidation queue.`);
    return m;
  });
  const targets = planMoves(ctx.memDir, picked.map((m) => ({ name: m.name, rel: m.to })), []);
  ensureRepo(ctx.memDir);
  commitAll(ctx.memDir, "sleep: snapshot before merging", [into]);
  // An approved draft moves into memory without the line that named its sources.
  if (loadNotes(ctx.state)[into]) saveNote(ctx.state, into, "");
  if (!fs.existsSync(path.join(ctx.memDir, into))) { fs.writeFileSync(path.join(ctx.memDir, into), fs.readFileSync(draft, "utf8").replace(SOURCES_LINE, "")); fs.unlinkSync(draft); }
  // Slugs the sources answer to (file name and frontmatter name), read before they move.
  const slugOf = (rel) => { const t = fs.readFileSync(path.join(ctx.memDir, rel), "utf8"); const n = /^name:\s*["']?([^\s"']+)/m.exec(t.slice(0, 600)); return [path.basename(rel, ".md"), n && n[1]].filter(Boolean); };
  const mergedSlug = slugOf(into).at(-1);
  const slugMap = new Map(picked.flatMap((m) => slugOf(m.to).map((sl) => [sl, mergedSlug])));
  applyMoves(ctx.memDir, targets, picked.map((m) => ({ from: m.to, to: into })));
  redirectSlugs(ctx.memDir, slugMap);
  const at = new Date().toISOString();
  for (const [i, m] of picked.entries()) {
    m.status = "merged"; m.mergedAt = at;
    ctx.moves.push({ kind: "merged", name: m.name, from: m.to, to: targets[i].to, into, at, status: "active" });
  }
  setHint(ctx.memDir, true);
  pruneEmpty(ctx.memDir);
  saveMoves(ctx.movesFile, ctx.moves);
  record(ctx, "merged", { merged: { into, sources: picked.map((m) => m.name) } });
  const hash = commitAll(ctx.memDir, `sleep: merged ${picked.length} into ${into}`);
  if (flags.json) process.stdout.write(JSON.stringify({ into, sources: targets, commit: hash }, null, 2) + "\n");
  else console.log(`Merged ${picked.length} into ${into}; the sources are in the archive. Undo with: git -C "${ctx.memDir}" revert ${hash}`);
}

async function stats(flags) {
  const ctx = await context(flags);
  record(ctx, "stats");
  const s = summarize(ctx);
  if (flags.json) { process.stdout.write(JSON.stringify(s, null, 2) + "\n"); return; }
  const pct = (x) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
  console.log(`${s.runs} run(s) on record.`);
  if (s.first && s.last) console.log(`Memory: ${s.first.files.main + s.first.files.consolidate} live files, MEMORY.md ~${s.first.indexTokens} tokens (${s.first.at}) -> ${s.last.files.main + s.last.files.consolidate} live files, ~${s.last.indexTokens} tokens (${s.last.at}).`);
  console.log(`Archived ${s.archived}; restored ${s.restored}; read again from the archive ${s.readAgain.length}; mistake rate ${pct(s.mistakeRate)}.`);
  console.log(`Queued ${s.queued} for consolidation; merged ${s.merged.sources} into ${s.merged.outputs}; purged ${s.purged}.`);
}

// Shows, sets or removes the schedule. Settings live in config.json next to sleep's other records.
async function schedule(flags) {
  const loc = locate(flags);
  const cfg = loc.config;
  const label = labelFor(loc.key);
  const platform = process.env.SLEEP_PLATFORM || process.platform;
  if (flags.off) {
    if (platform === "darwin") remove(label);
    saveConfig(loc.state, { ...cfg, schedule: null });
    console.log(platform === "darwin" ? "Schedule removed." : "Schedule cleared. Remove the crontab line by hand (crontab -e).");
    return;
  }
  if (!flags.every) {
    console.log(cfg.schedule ? `Runs ${describe(cfg.schedule)}. Change it with --every, or remove it with --off.` : "No schedule. Set one with: sleep schedule --every weekly");
    return;
  }
  const s = parseSchedule(flags);
  const args = command(s, { cli: CLI, target: loc.target, state: loc.state });
  const log = path.join(loc.state, "schedule.log");
  fs.mkdirSync(loc.state, { recursive: true });
  if (platform === "darwin") {
    const file = install(label, plist(label, args, s, log));
    saveConfig(loc.state, { ...cfg, schedule: s });
    console.log(`Scheduled: ${describe(s)}. Job: ${file}. Log: ${log}`);
  } else {
    saveConfig(loc.state, { ...cfg, schedule: s });
    console.log(`Add this line with crontab -e to run ${describe(s)}:`);
    console.log(cronLine(s, args, log));
  }
}

// Merge drafts the skill wrote to <state>/drafts, each naming its sources in a sleep_sources: line.
const SOURCES_LINE = /^sleep_sources:.*\n/m;
const DRAFT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
// Notes for Claude about drafts, left on the review page. The skill reads them through queue --json.
const notesFile = (state) => path.join(state, "notes.json");
const loadNotes = (state) => { try { const v = JSON.parse(fs.readFileSync(notesFile(state), "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
// A note is open until the draft is rewritten after it; then Claude has handled it.
function openNotes(state) {
  const out = {};
  for (const [d, v] of Object.entries(loadNotes(state))) {
    let t = 0; try { t = fs.statSync(path.join(state, "drafts", d)).mtimeMs; } catch { continue; }
    if (t <= Date.parse(v?.at || 0)) out[d] = v;
  }
  return out;
}
function saveNote(state, draft, note) {
  const all = loadNotes(state);
  if (note) all[draft] = { note, at: new Date().toISOString() }; else delete all[draft];
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(notesFile(state), JSON.stringify(all, null, 2) + "\n");
}
function readDrafts(ctx) {
  const dir = path.join(ctx.state, "drafts");
  const notes = loadNotes(ctx.state), open = openNotes(ctx.state);
  let names = []; try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch {}
  return names.map((name) => {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    const { fm } = frontmatter(text);
    const list = String(fm.sleep_sources || "").split(",").map((x) => x.trim()).filter(Boolean);
    const sources = list.map((sn) => {
      const f = ctx.live.files.find((x) => x.name === sn || x.rel === sn);
      return { name: sn, queued: f?.area === "consolidate", description: f?.description, body: f?.body, bytes: f?.bytes || 0 };
    });
    return { name, note: notes[name]?.note || "", noteOpen: !!open[name], description: typeof fm.description === "string" ? fm.description : "", body: text.replace(SOURCES_LINE, ""), sources, beforeBytes: sources.reduce((a, x) => a + x.bytes, 0), afterBytes: Buffer.byteLength(text.replace(SOURCES_LINE, "")) };
  });
}

// What archive would do now, plus any merge drafts, for the review page. Reads only.
function reviewData(ctx, planned, purge) {
  const body = (rel) => ctx.mem.files.find((f) => f.rel === rel)?.body;
  const info = new Map([...ctx.cand.list, ...ctx.cand.consolidate].map((c) => [c.name, c]));
  const r = {
    generatedAt: new Date().toISOString(), memDir: ctx.memDir, days: ctx.opt.days, usage: ctx.u.summary, candidatesNote: ctx.cand.note,
    moves: planned.map((m) => ({ ...info.get(m.name), ...m, body: body(m.from) })),
    purged: purge.map((m) => m.to),
    edits: planned.length ? linkEdits(ctx.memDir, planned) : [],
    hint: { add: planned.length > 0 && !hasHint(ctx.memDir), present: hasHint(ctx.memDir), line: HINT },
    drafts: readDrafts(ctx),
    queued: ctx.live.files.filter((f) => f.area === "consolidate").length,
  };
  return r;
}

function writeReview(ctx, planned, purge) {
  const r = reviewData(ctx, planned, purge);
  const out = path.join(ctx.state, "reports");
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `${r.generatedAt.replace(/[:.]/g, "-").replace("T", "-").slice(0, 19)}-review.html`);
  fs.writeFileSync(file, reviewHtml(r));
  return file;
}

async function review(flags) {
  if (flags.serve) return serveReview(flags);
  const ctx = await context(flags);
  const planned = planMoves(ctx.memDir, ctx.cand.list, ctx.cand.consolidate);
  const file = writeReview(ctx, planned, purgeList(ctx, purgeDays(flags, ctx.state)));
  record(ctx, "review");
  console.log(`Review: ${file}`);
  console.log(`To decide on the page: "${process.execPath}" "${CLI}" review --serve ${ctx.target.map((a) => `"${a}"`).join(" ")}`);
  if (flags.open) spawnOpen(file);
}

// Runs this command line as a child, the same way a person would, so the page's actions take the same path.
function runCli(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

async function serveReview(flags) {
  const launch = locate(flags);
  // Every page load and action names its project by key. The project the server started on keeps the flags it was
  // started with; any other must be one listProjects found on disk, and uses its own state and config.
  const pick = (k) => {
    if (k == null || k === "" || k === launch.key) {
      return { loc: launch, flags, pass: [...launch.target, "--state", launch.state, ...(flags.days != null ? ["--days", String(flags.days)] : [])] };
    }
    if (typeof k !== "string" || !listProjects(launch.claudeDir).some((p) => p.key === k)) throw new Error("No such project.");
    const loc = locate({ key: k });
    return { loc, flags: { key: k }, pass: loc.target };
  };
  const projects = () => {
    const list = listProjects(launch.claudeDir);
    return list.some((p) => p.key === launch.key) ? list : [{ key: launch.key, path: launch.project, files: 0 }, ...list];
  };
  const fail = (r) => { throw new Error((r.err || r.out).trim().split("\n").pop() || "The command failed."); };
  const draftNamed = (loc, v) => { const d = String(v || ""); if (!DRAFT_NAME.test(d) || !fs.existsSync(path.join(loc.state, "drafts", d))) throw new Error("No such draft."); return d; };
  const actions = {
    async "/apply"(body) {
      const { loc, pass } = pick(body?.project);
      const names = body?.moves;
      if (!Array.isArray(names) || !names.length || !names.every((x) => typeof x === "string")) throw new Error("Pick at least one move.");
      const tmp = path.join(loc.state, `only-${process.pid}.json`);
      fs.mkdirSync(loc.state, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(names));
      try {
        const r = await runCli(["archive", "--apply", "--only", tmp, ...pass]);
        if (r.code !== 0) fail(r);
        return { message: r.out.trim().split("\n")[0] };
      } finally { fs.rmSync(tmp, { force: true }); }
    },
    async "/merge"(body) {
      const { loc, pass } = pick(body?.project);
      const d = draftNamed(loc, body?.draft);
      if (fs.existsSync(path.join(loc.memDir, d))) throw new Error(`A memory named ${d} already exists. Rename the draft first.`);
      const { fm } = frontmatter(fs.readFileSync(path.join(loc.state, "drafts", d), "utf8"));
      const sources = String(fm.sleep_sources || "").split(",").map((x) => x.trim()).filter(Boolean);
      if (!sources.length) throw new Error(`${d} names no sources.`);
      const r = await runCli(["merged", "--into", d, ...sources, ...pass]);
      if (r.code !== 0) fail(r);
      return { message: r.out.trim().split("\n")[0] };
    },
    async "/note"(body) {
      const { loc } = pick(body?.project);
      const d = draftNamed(loc, body?.draft);
      const note = String(body?.note ?? "").trim();
      if (note.length > 4000) throw new Error("Keep the note under 4,000 characters.");
      saveNote(loc.state, d, note);
      return { message: note ? "Note saved." : "Note cleared." };
    },
  };
  const render = async (nonce, token, url) => {
    const { loc, flags: f } = pick(url.searchParams.get("project"));
    const ctx = await context(f);
    const planned = planMoves(ctx.memDir, ctx.cand.list, ctx.cand.consolidate);
    return reviewHtml(reviewData(ctx, planned, purgeList(ctx, purgeDays(f, ctx.state))), { nonce, token, project: loc.key, projects: projects() });
  };
  const port = flags.port != null ? Number(flags.port) : 8767;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a port number");
  const { url } = await startServer({ port, render, actions });
  console.log(`Review: ${url}`);
  console.log("The address holds a private key: keep it to yourself. Press Ctrl+C to stop.");
  if (flags.open) spawnOpen(url);
}

function spawnOpen(file) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  import("node:child_process").then(({ spawn }) => spawn(cmd, [file], { stdio: "ignore", detached: true }).unref());
}

function projects(flags) {
  const list = listProjects();
  if (flags.json) { process.stdout.write(JSON.stringify(list.map(({ key, path: p, files }) => ({ key, path: p, files })), null, 2) + "\n"); return; }
  if (!list.length) { console.log("No project has a memory folder with files in it yet."); return; }
  const width = Math.max(...list.map((p) => String(p.files).length));
  for (const p of list) console.log(`${String(p.files).padStart(width)} files  ${p.path ? p.path.replace(os.homedir(), "~") : `${p.key} (folder unknown: use --key ${p.key})`}`);
}

async function main() {
  const { cmd, args, flags } = parse(process.argv.slice(2));
  if (!cmd || cmd === "help" || flags.help) { process.stdout.write(HELP); return; }
  if (!["restore", "merged"].includes(cmd) && args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  if (cmd === "report") return report(flags);
  if (cmd === "archive") return archive(flags);
  if (cmd === "restore") return restore(flags, args);
  if (cmd === "queue") return queue(flags);
  if (cmd === "stats") return stats(flags);
  if (cmd === "review") return review(flags);
  if (cmd === "schedule") return schedule(flags);
  if (cmd === "merged") return merged(flags, args);
  if (cmd === "projects") return projects(flags);
  throw new Error(`Unknown command: ${cmd}. Try: sleep help`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
