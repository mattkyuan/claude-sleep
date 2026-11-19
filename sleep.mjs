#!/usr/bin/env node
// sleep: memory upkeep for Claude Code. This file is the command line; the work is in lib/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMemory, INDEX } from "./lib/memory.mjs";
import { usage, loadLedger, saveLedger } from "./lib/usage.mjs";
import { DEFAULTS, checks, candidates } from "./lib/checks.mjs";
import { writeReport } from "./lib/report.mjs";
import { loadMoves, saveMoves, activeArchived, planMoves, applyMoves, heldLinks, safeRel, setHint, pruneEmpty, redirectSlugs, linkEdits, hasHint, HINT } from "./lib/archive.mjs";
import { ensureRepo, commitAll } from "./lib/git.mjs";
import { loadSteps, saveSteps, snapshot, movesDiff, rewindMoves, nextGroup, inHistory, revertAll, datesOf, movedBy, putDatesBack } from "./lib/undo.mjs";
import { record, summarize } from "./lib/stats.mjs";
import { parseSchedule, describe, command, plist, cronLine, install, remove, labelFor, pluginInstall, launcherSource } from "./lib/schedule.mjs";
import { fileURLToPath } from "node:url";
import { frontmatter } from "./lib/memory.mjs";
import { reviewHtml, pickerHtml } from "./lib/review.mjs";
import { memoryGraph } from "./lib/graph.mjs";
import { startServer } from "./lib/serve.mjs";
import { spawn } from "node:child_process";
import { indexSystemPrompt, buildIndexInput, parseIndexChanges, checkIndexChanges, applyChanges, indexFolder } from "./lib/index.mjs";
import { DRAFT_NAME, MAX_BATCH, sourcesOf, systemPrompt, buildInput, parseDrafts, checkDrafts, checkFacts, hashText, loadMeta, saveMeta } from "./lib/draft.mjs";

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
  sleep open [--stop]             start the served page in the background (or reuse it) and open it in your browser;
                                  it stops by itself after 2 hours unused
  sleep stats [options]           how well sleep is doing: size over time, restores and re-reads (its error rate), merges
  sleep queue [options]           the consolidation queue, grouped by the hub that links to each memory
  sleep merged --into <file> <queued>...  record a merge: archive the sources, point their links at <file>
  sleep index-apply --changes <file.json> apply checked line changes to MEMORY.md (and its hubs), and commit
  sleep undo [--list]             take back sleep's last step (one Apply from the page counts as one): its commits in
                                  the memory folder, and sleep's records of the moves and drafts; --list shows the steps

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
    if (["json", "help", "apply", "all", "off", "open", "serve", "stop", "launched", "list"].includes(k)) o.flags[k] = true;
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
    const movesBefore = snapshot(ctx.moves);
    ensureRepo(ctx.memDir);
    r.commits.before = commitAll(ctx.memDir, "sleep: snapshot before archiving");
    const held = heldLinks(ctx.memDir, planned);
    applyMoves(ctx.memDir, planned);
    const at = new Date().toISOString();
    for (const m of planned) ctx.moves.push({ ...m, at, status: "active", ...(held.has(m.to) ? { held: held.get(m.to) } : {}) });
    for (const m of purge) { fs.unlinkSync(path.join(ctx.memDir, m.to)); m.status = "purged"; m.purgedAt = at; }
    setHint(ctx.memDir, ctx.moves.some((m) => m.status === "active"));
    saveMoves(ctx.movesFile, ctx.moves);
    const archived = planned.filter((m) => m.kind === "archive").length, queued = planned.length - archived;
    const label = `archived ${archived}, queued ${queued} for consolidation${purge.length ? `, purged ${purge.length}` : ""}`;
    r.commits.after = commitAll(ctx.memDir, `sleep: ${label}`);
    addStep(ctx, flags, { commit: r.commits.after, label, movesBefore });
  } else if (flags.apply) {
    // Nothing to move, but a snapshot still records edits made since the last run.
    if (fs.existsSync(path.join(ctx.memDir, ".git"))) r.commits.before = commitAll(ctx.memDir, "sleep: snapshot before archiving");
  }
  record(ctx, r.mode, { moved: { archive: planned.filter((m) => m.kind === "archive").length, consolidate: planned.filter((m) => m.kind === "consolidate").length }, purged: purge.length, applied: !!flags.apply });
  const reviewFile = flags.apply ? null : writeReview(ctx, planned, purge);
  const verb = flags.apply ? "Moved" : "Would move";
  if (reviewFile && !flags.json) console.log(`Review: ${reviewFile}`);
  finish(r, ctx, flags, `${verb} ${planned.length} file(s) (${planned.filter((m) => m.kind === "archive").length} to Archive, ${planned.filter((m) => m.kind === "consolidate").length} to Consolidate)${purge.length ? `; ${flags.apply ? "purged" : "would purge"} ${purge.length}` : ""}.${flags.apply ? "" : " Run with --apply to do it."}`);
}

// Puts moved files back and points their links at them again. A link that was broken before the move, and that the
// move completed by chance (the record's `held`), is left as it was, so a restore gives back exactly what was there.
async function restore(flags, args) {
  if (flags.all ? args.length : args.length !== 1) throw new Error("Usage: sleep restore <file>, or sleep restore --all");
  const ctx = await context(flags);
  const active = ctx.moves.filter((x) => x.status === "active");
  const picked = flags.all ? active : active.filter((x) => x.name === args[0] || x.from === args[0] || x.to === args[0]).slice(0, 1);
  if (!picked.length) throw new Error(flags.all ? "Nothing sleep moved is waiting to be restored." : `Nothing sleep moved matches ${args[0]}. Moved files are listed in ${ctx.movesFile}.`);
  for (const m of picked) if (fs.existsSync(path.join(ctx.memDir, m.from))) throw new Error(`${m.from} exists again, so ${m.to} cannot go back without overwriting it.`);
  const movesBefore = snapshot(ctx.moves);
  ensureRepo(ctx.memDir);
  commitAll(ctx.memDir, "sleep: snapshot before restoring");
  const keep = new Map();
  for (const m of picked) for (const h of Array.isArray(m.held) ? m.held : []) if (safeRel(h)) { const f = path.join(ctx.memDir, h); (keep.get(f) || keep.set(f, new Set()).get(f)).add(path.join(ctx.memDir, m.to)); }
  applyMoves(ctx.memDir, picked.map((m) => ({ from: m.to, to: m.from })), [], { fresh: true, keep });
  const at = new Date().toISOString();
  for (const m of picked) { m.status = "restored"; m.restoredAt = at; }
  setHint(ctx.memDir, ctx.moves.some((x) => x.status === "active"));
  pruneEmpty(ctx.memDir);
  saveMoves(ctx.movesFile, ctx.moves);
  record(ctx, "restore", { restored: picked.map((m) => m.name) });
  const label = picked.length === 1 ? `restored ${picked[0].from}` : `restored ${picked.length} files`;
  const hash = commitAll(ctx.memDir, `sleep: ${label}`);
  addStep(ctx, flags, { commit: hash, label, movesBefore });
  if (flags.json) process.stdout.write(JSON.stringify({ restored: picked, commit: hash }, null, 2) + "\n");
  else console.log(picked.length === 1 ? `Restored ${picked[0].to} to ${picked[0].from}.` : `Restored ${picked.length} files.`);
}

// The consolidation queue, grouped by the file that links to each memory (a hub, usually), so related lessons can be
// merged together. A memory nothing in the main folder links to is "unfiled".
// The consolidation queue grouped by the main file that links to each memory (usually a hub), largest first.
function queueTopics(ctx, { withPlanned = false } = {}) {
  const planned = withPlanned ? new Set(ctx.cand.consolidate.map((c) => c.name)) : new Set();
  const queued = ctx.live.files.filter((f) => f.area === "consolidate" || (f.area === "main" && planned.has(f.name)));
  const mainNames = new Set(ctx.live.files.filter((f) => f.area === "main").map((f) => f.name));
  const topics = new Map();
  for (const f of queued) {
    const topic = f.linkedFrom.filter((n) => mainNames.has(n)).sort()[0] || "unfiled";
    if (!topics.has(topic)) topics.set(topic, []);
    topics.get(topic).push({ name: f.name, rel: f.rel, description: f.description, bytes: f.bytes, created: day(f.createdMs), lastUsed: day(ctx.use.of(f).last) });
  }
  const list = [...topics].map(([topic, files]) => ({ topic, files: files.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => (a.topic === "unfiled") - (b.topic === "unfiled") || b.files.length - a.files.length);
  return { queued, list };
}

async function queue(flags) {
  const ctx = await context(flags);
  const { queued, list } = queueTopics(ctx);
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
  const meta = loadMeta(ctx.state);
  for (const m of picked) {
    const want = meta[into]?.sources?.[m.name];
    if (want && hashText(fs.readFileSync(path.join(ctx.memDir, m.to), "utf8")) !== want) throw new Error(`${m.name} changed since Claude read it. Redo ${into} first.`);
  }
  const targets = planMoves(ctx.memDir, picked.map((m) => ({ name: m.name, rel: m.to })), []);
  const movesBefore = snapshot(ctx.moves);
  // A draft the merge uses up, kept so undo can put it back to apply again.
  const usedDraft = !fs.existsSync(path.join(ctx.memDir, into)) ? { name: into, text: fs.readFileSync(draft, "utf8"), meta: meta[into] ?? null, note: loadNotes(ctx.state)[into]?.note ?? null } : null;
  ensureRepo(ctx.memDir);
  commitAll(ctx.memDir, "sleep: snapshot before merging", [into]);
  // An approved draft moves into memory without the line that named its sources.
  if (loadNotes(ctx.state)[into]) saveNote(ctx.state, into, "");
  if (!fs.existsSync(path.join(ctx.memDir, into))) { fs.writeFileSync(path.join(ctx.memDir, into), fs.readFileSync(draft, "utf8").replace(SOURCES_LINE, "")); fs.unlinkSync(draft); }
  // Slugs the sources answer to (file name and frontmatter name), read before they move.
  const slugOf = (rel) => { const t = fs.readFileSync(path.join(ctx.memDir, rel), "utf8"); const n = /^name:\s*["']?([^\s"']+)/m.exec(t.slice(0, 600)); return [path.basename(rel, ".md"), n && n[1]].filter(Boolean); };
  const mergedSlug = slugOf(into).at(-1);
  const slugMap = new Map(picked.flatMap((m) => slugOf(m.to).map((sl) => [sl, mergedSlug])));
  const held = heldLinks(ctx.memDir, targets);
  applyMoves(ctx.memDir, targets, picked.map((m) => ({ from: m.to, to: into })));
  redirectSlugs(ctx.memDir, slugMap);
  const at = new Date().toISOString();
  for (const [i, m] of picked.entries()) {
    m.status = "merged"; m.mergedAt = at;
    ctx.moves.push({ kind: "merged", name: m.name, from: m.to, to: targets[i].to, into, at, status: "active", ...(held.has(targets[i].to) ? { held: held.get(targets[i].to) } : {}) });
  }
  setHint(ctx.memDir, true);
  pruneEmpty(ctx.memDir);
  saveMoves(ctx.movesFile, ctx.moves);
  if (meta[into]) { delete meta[into]; saveMeta(ctx.state, meta); }
  record(ctx, "merged", { merged: { into, sources: picked.map((m) => m.name) } });
  const label = `merged ${picked.length} into ${into}`;
  const hash = commitAll(ctx.memDir, `sleep: ${label}`);
  addStep(ctx, flags, { commit: hash, label, movesBefore, draft: usedDraft });
  if (flags.json) process.stdout.write(JSON.stringify({ into, sources: targets, commit: hash }, null, 2) + "\n");
  else console.log(`Merged ${picked.length} into ${into} (commit ${hash}); the sources are in the archive. Undo with: sleep undo`);
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
  fs.mkdirSync(loc.state, { recursive: true });
  // From a plugin, the job runs a launcher that follows plugin updates; from a checkout, the checkout itself.
  const plugin = pluginInstall(CLI), launcher = path.join(loc.state, "run-sleep.mjs");
  if (plugin) fs.writeFileSync(launcher, launcherSource(CLI, plugin));
  else fs.rmSync(launcher, { force: true });
  const args = command(s, { cli: plugin ? launcher : CLI, target: loc.target, state: loc.state });
  const log = path.join(loc.state, "schedule.log");
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
  const notes = loadNotes(ctx.state), open = openNotes(ctx.state), meta = loadMeta(ctx.state);
  let names = []; try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch {}
  return names.map((name) => {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    const { fm } = frontmatter(text);
    const list = String(fm.sleep_sources || "").split(",").map((x) => x.trim()).filter(Boolean);
    const sources = list.map((sn) => {
      const f = ctx.live.files.find((x) => x.name === sn || x.rel === sn);
      const want = meta[name]?.sources?.[sn];
      const changed = !!(want && f && hashText(fs.readFileSync(path.join(ctx.memDir, f.rel), "utf8")) !== want);
      return { name: sn, queued: f?.area === "consolidate", planned: !!f && f.area === "main" && ctx.cand.consolidate.some((c) => c.name === sn), changed, description: f?.description, body: f?.body, bytes: f?.bytes || 0 };
    });
    const facts = checkFacts(text, sources.map((s) => s.body || ""));
    return { name, topic: meta[name]?.topic || "other", stale: sources.filter((s) => s.changed).map((s) => s.name), note: notes[name]?.note || "", noteOpen: !!open[name], description: typeof fm.description === "string" ? fm.description : "", body: text.replace(SOURCES_LINE, ""), sources, facts, beforeBytes: sources.reduce((a, x) => a + x.bytes, 0), afterBytes: Buffer.byteLength(text.replace(SOURCES_LINE, "")) };
  });
}

// The batches Consolidate everything would send: up to MAX_BATCH memories per topic, at least 2 per batch, skipping
// memories a draft already names, so a stopped run picks up where it left off. want limits it to some topics.
// read.json: each memory a finished batch read, with a hash of what it read, so a memory Claude left unmerged is not
// sent again until it changes.
const readFile = (state) => path.join(state, "read.json");
function loadRead(state) { try { return JSON.parse(fs.readFileSync(readFile(state), "utf8")); } catch { return {}; } }
function saveRead(state, add) { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(readFile(state), JSON.stringify({ ...loadRead(state), ...add }, null, 2)); }
function planBatches(ctx, want = null) {
  const { list } = queueTopics(ctx, { withPlanned: true });
  const draftsDir = path.join(ctx.state, "drafts");
  let names = []; try { names = fs.readdirSync(draftsDir).filter((x) => DRAFT_NAME.test(x)); } catch {}
  const covered = new Set(names.flatMap((d) => sourcesOf(fs.readFileSync(path.join(draftsDir, d), "utf8"))));
  const read = loadRead(ctx.state);
  for (const t of list) for (const x of t.files) if (read[x.name] && read[x.name] === hashText(fs.readFileSync(path.join(ctx.memDir, x.rel), "utf8"))) covered.add(x.name);
  const batches = [];
  for (const t of list) {
    if (want && !want.has(t.topic)) continue;
    const free = t.files.filter((x) => !covered.has(x.name));
    for (let i = 0; i < free.length; i += MAX_BATCH) { const b = free.slice(i, i + MAX_BATCH); if (b.length >= 2) batches.push({ topic: t.topic, files: b }); }
  }
  return batches;
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
    topics: queueTopics(ctx, { withPlanned: true }).list.map((t) => ({ topic: t.topic, count: t.files.length })),
    keep: Math.max(0, ctx.live.files.filter((f) => f.area === "main" && f.name !== "MEMORY.md").length - planned.length),
  };
  const p = loadProposal(ctx.state);
  if (p) {
    let now = ""; try { now = fs.readFileSync(path.join(ctx.memDir, INDEX), "utf8"); } catch {}
    r.indexProposal = { ...p, stale: hashText(now) !== p.indexHash };
  }
  const g = nextGroup(loadSteps(ctx.state));
  if (g.length) r.undo = { label: g.length === 1 ? g[0].label : `one Apply of ${g.length} commits, the newest ${g[0].label}`, at: g[0].at };
  const batches = planBatches(ctx);
  r.pool = { memories: batches.reduce((a, b) => a + b.files.length, 0), topics: new Set(batches.map((b) => b.topic)).size, batches: batches.length };
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
  let lastUsed = Date.now();
  // One Claude drafting job at a time, across projects. The child is killed if the server stops.
  let job = null;
  const children = new Set();
  const killAll = () => { for (const c of children) { try { c.kill(); } catch {} } };
  process.on("exit", killAll);
  const RULES = fs.readFileSync(path.join(path.dirname(CLI), "docs", "merge-rules.md"), "utf8");
  const runClaude = (input, system = systemPrompt(RULES)) => new Promise((resolve) => {
    // No tools, no MCP servers or connectors, no slash commands, nothing saved, in an empty folder outside the
    // project, and the memory text on stdin rather than in the arguments (other processes can read arguments).
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sleep-draft-"));
    const args = ["-p", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json", "--system-prompt", system];
    const child = spawn(process.env.SLEEP_CLAUDE || "claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" } });
    children.add(child);
    let out = "", err = "";
    const timer = setTimeout(() => child.kill(), 15 * 60_000);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => (err += e.message));
    child.on("close", (code) => { clearTimeout(timer); children.delete(child); fs.rmSync(cwd, { recursive: true, force: true }); resolve({ code, out, err }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
  // Writes checked drafts and records, per draft, its topic and a hash of each source as Claude read it.
  const writeDrafts = (loc, drafts, texts, topic) => {
    const draftsDir = path.join(loc.state, "drafts"), meta = loadMeta(loc.state);
    fs.mkdirSync(draftsDir, { recursive: true });
    for (const d of drafts) {
      fs.writeFileSync(path.join(draftsDir, d.name), d.text);
      meta[d.name] = { topic, at: new Date().toISOString(), sources: Object.fromEntries(sourcesOf(d.text).map((x) => [x, hashText(texts.get(x))])) };
    }
    saveMeta(loc.state, meta);
  };
  const answerOf = (r) => {
    if (r.code !== 0) throw new Error((r.err || r.out).trim().split("\n").pop() || `claude exited with ${r.code}.`);
    let j; try { j = JSON.parse(r.out); } catch { throw new Error("claude did not answer in JSON."); }
    if (j.is_error) throw new Error(String(j.result || "claude reported an error."));
    return String(j.result || "");
  };
  const used = (fn) => async (...a) => { lastUsed = Date.now(); try { return await fn(...a); } finally { lastUsed = Date.now(); } };
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
      if (job?.state === "running" && job.project === loc.key) throw new Error("Claude is drafting for this project. Merge once it finishes.");
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
    // Starts Claude on one topic of the queue, or on one draft with your note. Returns at once; poll /job.
    async "/draft"(body) {
      if (job?.state === "running") throw new Error("Claude is already drafting. Wait for it to finish.");
      const { loc, flags: f } = pick(body?.project);
      const ctx = await context(f);
      const topics = queueTopics(ctx, { withPlanned: true });
      const queued = new Map(topics.queued.map((x) => [x.name, x]));
      const read = (name) => ({ name, text: fs.readFileSync(path.join(ctx.memDir, queued.get(name).rel), "utf8") });
      let batch, hub = null, redo = null, label;
      if (body?.redo != null) {
        const d = draftNamed(loc, body.redo);
        const text = fs.readFileSync(path.join(loc.state, "drafts", d), "utf8");
        const sources = sourcesOf(text);
        if (!sources.length || sources.some((x) => !queued.has(x))) throw new Error(`${d} names a source that is not in Consolidate.`);
        batch = sources.map(read);
        redo = { name: d, text, note: loadNotes(loc.state)[d]?.note || "" };
        label = `redo of ${d}`;
      } else {
        const t = topics.list.find((x) => x.topic === body?.topic);
        if (!t) throw new Error("That topic is not in Consolidate.");
        batch = t.files.slice(0, MAX_BATCH).map((x) => read(x.name));
        const h = t.topic !== "unfiled" && ctx.live.files.find((x) => x.name === t.topic && x.area === "main");
        if (h) hub = { name: h.name, text: fs.readFileSync(path.join(ctx.memDir, h.rel), "utf8") };
        label = `${t.topic} (${batch.length} of ${t.files.length})`;
      }
      const draftsDir = path.join(loc.state, "drafts");
      job = { project: loc.key, label, state: "running", started: new Date().toISOString(), message: "" };
      const mine = job;
      runClaude(buildInput({ batch, hub, redo })).then((r) => {
        const drafts = checkDrafts(parseDrafts(answerOf(r)), { batch: batch.map((x) => x.name), memDir: ctx.memDir, draftsDir, redo: redo?.name });
        const topic = (redo ? loadMeta(loc.state)[redo.name]?.topic : null) ?? (body?.topic || null);
        writeDrafts(loc, drafts, new Map(batch.map((x) => [x.name, x.text])), topic);
        Object.assign(mine, { state: "done", message: `Claude wrote ${drafts.length} draft(s): ${drafts.map((d) => d.name).join(", ")}.` });
      }).catch((e) => Object.assign(mine, { state: "failed", message: String(e?.message || e) }));
      return { message: `Claude is drafting: ${label}.` };
    },
    async "/apply-all"(body) {
      if (job?.state === "running") throw new Error("Something is already running. Wait for it to finish.");
      const { loc, pass } = pick(body?.project);
      const moves = Array.isArray(body?.moves) ? body.moves.filter((x) => typeof x === "string") : [];
      const drafts = (Array.isArray(body?.drafts) ? body.drafts : []).map((d) => draftNamed(loc, d));
      if (!moves.length && !drafts.length) throw new Error("Pick at least one move or merge.");
      const sources = new Map(drafts.map((d) => [d, sourcesOf(fs.readFileSync(path.join(loc.state, "drafts", d), "utf8"))]));
      job = { kind: "apply", project: loc.key, label: `${moves.length} move(s) and ${drafts.length} merge(s)`, state: "running", started: new Date().toISOString(), message: "", results: [] };
      const mine = job;
      // Every commit this Apply makes shares one run, so sleep undo takes it all back as one step.
      const runId = `apply-${Date.now()}`;
      (async () => {
        // A draft's planned sources move with the picked files, so its merge finds them in Consolidate.
        const only = [...new Set([...moves, ...[...sources.values()].flat()])];
        const tmp = path.join(loc.state, `only-${process.pid}.json`);
        fs.mkdirSync(loc.state, { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(only));
        let moved;
        try { const r = await runCli(["archive", "--apply", "--only", tmp, "--run", runId, ...pass]); if (r.code !== 0) fail(r); moved = r.out.trim().split("\n")[0]; }
        finally { fs.rmSync(tmp, { force: true }); }
        for (const d of drafts) {
          const r = await runCli(["merged", "--into", d, ...sources.get(d), "--run", runId, ...pass]);
          const c = /\(commit ([0-9a-f]+)\)/.exec(r.out);
          mine.results.push({ draft: d, ok: r.code === 0, reason: r.code === 0 ? "" : (r.err || r.out).trim().split("\n").pop(), commit: r.code === 0 && c ? c[1] : null });
        }
        const ok = mine.results.filter((x) => x.ok).length, skipped = mine.results.filter((x) => !x.ok);
        mine.message = `${moved} Merged ${ok} of ${drafts.length}.${skipped.length ? ` Skipped: ${skipped.map((x) => `${x.draft} (${x.reason})`).join("; ")}.` : ""} Undo all of it with Undo last step, or sleep undo.`;
        mine.state = "done";
      })().catch((e) => Object.assign(mine, { state: "failed", message: String(e?.message || e) }));
      return { message: "Applying." };
    },
    // Consolidate everything (or the named topics): batches of up to 10 per topic, three at a time. A memory a draft
    // already names is skipped, so a stopped run picks up where it left off. One failed batch does not stop the rest.
    async "/consolidate"(body) {
      if (job?.state === "running") throw new Error("Something is already running. Wait for it to finish.");
      const { loc, flags: f } = pick(body?.project);
      const ctx = await context(f);
      const draftsDir = path.join(loc.state, "drafts");
      const want = Array.isArray(body?.topics) ? new Set(body.topics.filter((x) => typeof x === "string")) : null;
      const batches = planBatches(ctx, want);
      const topics = {};
      for (const b of batches) { const t = (topics[b.topic] ||= { batches: 0, done: 0, running: 0, memories: 0, became: 0, failed: 0 }); t.batches++; t.memories += b.files.length; }
      const progress = { total: batches.length, done: 0, failed: 0, running: 0, read: 0, became: 0, topics };
      job = { kind: "consolidate", project: loc.key, label: `${batches.length} batch(es) in ${new Set(batches.map((b) => b.topic)).size} topic(s)`, state: "running", started: new Date().toISOString(), message: "", progress, errors: [] };
      const mine = job, taken = new Set();
      if (!batches.length) { Object.assign(mine, { state: "done", message: "Nothing left to consolidate: every memory is already in a draft, or alone in its topic." }); return { message: mine.message }; }
      const hubText = (topic) => { const h = topic !== "unfiled" && ctx.live.files.find((x) => x.name === topic && x.area === "main"); return h ? { name: h.name, text: fs.readFileSync(path.join(ctx.memDir, h.rel), "utf8") } : null; };
      const runBatch = async (b) => {
        const batch = b.files.map((x) => ({ name: x.name, text: fs.readFileSync(path.join(ctx.memDir, x.rel), "utf8") }));
        const r = await runClaude(buildInput({ batch, hub: hubText(b.topic), redo: null }));
        if (mine.state !== "running") return;
        const drafts = checkDrafts(parseDrafts(answerOf(r)), { batch: batch.map((x) => x.name), memDir: ctx.memDir, draftsDir, renameClashes: true, taken });
        for (const d of drafts) taken.add(d.name);
        writeDrafts(loc, drafts, new Map(batch.map((x) => [x.name, x.text])), b.topic);
        saveRead(loc.state, Object.fromEntries(batch.map((x) => [x.name, hashText(x.text)])));
        progress.read += batch.length; progress.became += drafts.length; topics[b.topic].became += drafts.length;
      };
      let next = 0;
      const worker = async () => {
        while (mine.state === "running" && next < batches.length) {
          const b = batches[next++];
          const t = topics[b.topic];
          progress.running++; t.running++;
          try { await runBatch(b); } catch (e) { if (mine.state === "running") { progress.failed++; t.failed++; mine.errors.push(`${b.topic}: ${String(e?.message || e)}`); } }
          finally { progress.running--; progress.done++; t.running--; t.done++; }
        }
      };
      const lanes = Math.max(1, Number(process.env.SLEEP_CONCURRENCY) || 3);
      Promise.all(Array.from({ length: lanes }, worker)).then(() => {
        if (mine.state !== "running") return;
        mine.state = "done";
        mine.message = `Claude read ${progress.read} memories and wrote ${progress.became} merged memories.${progress.failed ? ` ${progress.failed} batch(es) failed: ${mine.errors.slice(0, 3).join("; ")}` : ""}`;
      });
      return { message: `Claude is consolidating: ${mine.label}.` };
    },
    // Tighten MEMORY.md: Claude proposes line changes; the server keeps those that pass the checks and saves them with
    // a hash of the index Claude read. The page shows them from that file; Apply runs sleep index-apply.
    async "/index"(body) {
      if (job?.state === "running") throw new Error("Something is already running. Wait for it to finish.");
      const { loc, flags: f } = pick(body?.project);
      const ctx = await context(f);
      const indexText = fs.readFileSync(path.join(ctx.memDir, INDEX), "utf8");
      const folder = indexFolder(ctx.memDir);
      const linked = ctx.live.files.filter((x) => x.area === "main" && x.linkedFrom.includes(INDEX));
      const files = linked.map((x) => ({ name: x.name, type: x.type, description: x.description, lastUsed: day(ctx.use.of(x).last), sessions: ctx.use.of(x).sessions }));
      const hubs = linked.filter((x) => x.links.length >= 3).map((x) => ({ name: x.name, text: folder.textOf(x.name) }));
      const note = typeof body?.note === "string" ? body.note.slice(0, 2000) : "";
      job = { kind: "index", project: loc.key, label: "MEMORY.md", state: "running", started: new Date().toISOString(), message: "" };
      const mine = job;
      (async () => {
        const r = await runClaude(buildIndexInput({ indexText, files, hubs, days: ctx.opt.days, note }), indexSystemPrompt());
        if (mine.state !== "running") return;
        const { ok, refused, after } = checkIndexChanges(parseIndexChanges(answerOf(r)), { indexText, folder });
        ok.forEach((c, i) => (c.id = `c${i + 1}`));
        fs.mkdirSync(loc.state, { recursive: true });
        fs.writeFileSync(proposalFile(loc.state), JSON.stringify({ at: new Date().toISOString(), indexHash: hashText(indexText), before: { lines: indexText.split("\n").length, bytes: Buffer.byteLength(indexText) }, after, changes: ok, refused }, null, 2));
        mine.state = "done";
        mine.message = `Claude proposed ${ok.length + refused.length} change(s) to MEMORY.md; ${ok.length} passed the checks.${refused.length ? ` Refused: ${refused.map((c) => c.why).join("; ")}` : ""}`;
      })().catch((e) => Object.assign(mine, { state: "failed", message: String(e?.message || e) }));
      return { message: "Claude is reading MEMORY.md." };
    },
    async "/index-apply"(body) {
      if (job?.state === "running") throw new Error("Something is already running. Wait for it to finish.");
      const { loc, pass } = pick(body?.project);
      const p = loadProposal(loc.state);
      if (!p) throw new Error("No proposal for MEMORY.md. Ask Claude first.");
      const ids = new Set(Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === "string") : []);
      const picked = p.changes.filter((c) => ids.has(c.id));
      if (!picked.length) throw new Error("Pick at least one change.");
      const tmp = path.join(loc.state, `index-${process.pid}.json`);
      fs.writeFileSync(tmp, JSON.stringify(picked));
      try { const r = await runCli(["index-apply", "--changes", tmp, ...pass]); if (r.code !== 0) fail(r); return { message: r.out.trim() }; }
      finally { fs.rmSync(tmp, { force: true }); }
    },
    // Takes back sleep's last step (one Apply counts as one), through the command line.
    async "/undo"(body) {
      if (job?.state === "running") throw new Error("Something is running. Undo once it finishes.");
      const { pass } = pick(body?.project);
      const r = await runCli(["undo", ...pass]);
      if (r.code !== 0) fail(r);
      return { message: r.out.trim().split("\n")[0] };
    },
    async "/stop-job"() {
      if (job?.state !== "running") return { message: "Nothing is running." };
      if (job.kind === "apply") throw new Error("Apply cannot stop halfway: each step is its own commit. It finishes in a moment.");
      job.state = "stopped";
      job.message = "Stopped. Drafts already written are kept; run again to pick up the rest.";
      killAll();
      return { message: job.message };
    },
    async "/job"() { return { job }; },
    // For sleep open: proves a recorded server is this one (only it knows the key), and stops it.
    async "/ping"() { return { pid: process.pid }; },
    async "/stop"() { setTimeout(() => process.exit(0), 50); return { message: "Stopping." }; },
  };
  for (const k of Object.keys(actions)) actions[k] = used(actions[k]);
  const render = async (nonce, token, url) => {
    const { loc, flags: f } = pick(url.searchParams.get("project"));
    const ctx = await context(f);
    const planned = planMoves(ctx.memDir, ctx.cand.list, ctx.cand.consolidate);
    const graph = memoryGraph({ mem: ctx.mem, planned, drafts: readDrafts(ctx) });
    return reviewHtml(reviewData(ctx, planned, purgeList(ctx, purgeDays(f, ctx.state))), { nonce, token, project: loc.key, projects: projects(), graph });
  };
  const port = flags.port != null ? Number(flags.port) : 8767;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a port number");
  // The old map page: the map is a view of the review page now.
  const renderMap = async (nonce, token, url) => {
    const { loc } = pick(url.searchParams.get("project"));
    return { redirect: `/?project=${encodeURIComponent(loc.key)}&view=map` };
  };
  const js = (...p) => ({ path: path.join(path.dirname(CLI), ...p), type: "text/javascript; charset=utf-8" });
  const files = { "/vendor/graph3d.mjs": js("vendor", "graph3d.mjs"), "/lib/steps.mjs": js("lib", "steps.mjs"), "/lib/mapview.mjs": js("lib", "mapview.mjs") };
  const { url } = await startServer({ port, render: used(render), actions, pages: { "/map": used(renderMap) }, files });
  if (flags.launched) {
    // Started by sleep open: leave a record only you can read, and stop by itself once unused for the idle time.
    const record = serverRecord(launch.claudeDir);
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ pid: process.pid, port: Number(new URL(url).port), url, project: launch.key }), { mode: 0o600 });
    fs.chmodSync(record, 0o600);
    const drop = () => { try { if (JSON.parse(fs.readFileSync(record, "utf8")).pid === process.pid) fs.rmSync(record); } catch {} };
    process.on("exit", drop);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(0));
    const idle = Number(process.env.SLEEP_IDLE_MS) || IDLE_MS;
    setInterval(() => { if (job?.state !== "running" && Date.now() - lastUsed > idle) process.exit(0); }, Math.min(Math.max(idle / 4, 100), 60_000));
    return;
  }
  console.log(`Review: ${url}`);
  console.log("The address holds a private key: keep it to yourself. Press Ctrl+C to stop.");
  if (flags.open) spawnOpen(url);
}

const IDLE_MS = 2 * 3600_000;
const serverRecord = (claudeDir) => path.join(claudeDir, "sleep", "server.json");

// sleep open: the review page without a terminal. Reuses a server that answers with its own key, otherwise starts
// one in the background and opens it. The keyed address goes only to the browser, never to the output.
async function openPage(flags) {
  const claudeDir = claudeDirOf();
  const record = serverRecord(claudeDir);
  const read = () => { try { return JSON.parse(fs.readFileSync(record, "utf8")); } catch { return null; } };
  const call = async (rec, action) => {
    try {
      const u = new URL(rec.url);
      const r = await fetch(`http://127.0.0.1:${u.port}${action}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Sleep-Token": u.searchParams.get("token") }, body: "{}", signal: AbortSignal.timeout(3000) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  const live = async (rec) => rec && (await call(rec, "/ping"))?.pid === rec.pid;
  const show = (rec, how) => {
    const browser = !process.env.SLEEP_NO_BROWSER;
    if (browser) spawnOpen(rec.url);
    console.log(`${how} on port ${rec.port}${browser ? ", opened in your browser" : ""}. It stops by itself after ${IDLE_MS / 3600_000} hours unused, or with: sleep open --stop`);
  };
  const rec = read();
  if (flags.stop) {
    if (await live(rec)) { await call(rec, "/stop"); console.log("Stopped the review page."); } else console.log("No review page is running.");
    fs.rmSync(record, { force: true });
    return;
  }
  if (await live(rec)) return show(rec, "The review page is already running");
  fs.rmSync(record, { force: true });
  // The project in this folder, or else the one with the most memory; the page's picker reaches the rest.
  let target;
  try { target = locate(flags).target; } catch {
    const first = listProjects(claudeDir)[0];
    if (!first) throw new Error("No project has a memory folder with files in it yet.");
    target = first.path ? ["--project", first.path] : ["--key", first.key];
  }
  fs.mkdirSync(path.dirname(record), { recursive: true });
  const log = fs.openSync(path.join(path.dirname(record), "server.log"), "a");
  const child = spawn(process.execPath, [CLI, "review", "--serve", "--launched", ...target, ...(flags.port != null ? ["--port", String(flags.port)] : [])], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  for (let i = 0; i < 300; i++) {
    const r = read();
    if (r?.pid === child.pid && (await live(r))) return show(r, "Started the review page");
    if (child.exitCode != null) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error(`The review page did not start. See ${path.join(path.dirname(record), "server.log")}`);
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

// The proposal Claude made for MEMORY.md, as the server checked it, with a hash of the index it read.
const proposalFile = (state) => path.join(state, "index-proposal.json");
function loadProposal(state) { try { return JSON.parse(fs.readFileSync(proposalFile(state), "utf8")); } catch { return null; } }

// sleep index-apply --changes <file.json>: exact line changes to MEMORY.md (and lines added to hubs), checked again
// against the folder as it is now, then written and committed.
async function indexApply(flags) {
  if (!flags.changes) throw new Error("Usage: sleep index-apply --changes <file.json>");
  let changes; try { changes = JSON.parse(fs.readFileSync(path.resolve(untilde(flags.changes)), "utf8")); } catch { throw new Error("--changes needs a file holding a JSON list of changes"); }
  if (!Array.isArray(changes) || !changes.length) throw new Error("--changes needs a file holding a JSON list of changes");
  const list = changes.map((c) => ({ kind: String(c?.kind || ""), reason: String(c?.reason || ""), hub: c?.hub ? String(c.hub) : null, old: String(c?.old ?? ""), new: String(c?.new ?? ""), add: String(c?.add ?? "") }));
  const ctx = await context(flags);
  const file = path.join(ctx.memDir, INDEX);
  const indexText = fs.readFileSync(file, "utf8");
  const folder = indexFolder(ctx.memDir);
  const { ok, refused } = checkIndexChanges(list, { indexText, folder });
  if (refused.length) throw new Error(`Nothing changed. ${refused.map((c) => `"${c.old.slice(0, 60)}": ${c.why}`).join("; ")}`);
  const next = applyChanges(indexText, new Map(), ok, folder.textOf);
  ensureRepo(ctx.memDir);
  commitAll(ctx.memDir, "sleep: snapshot before tightening MEMORY.md");
  fs.writeFileSync(file, next.indexText);
  for (const [hub, text] of next.hubTexts) fs.writeFileSync(path.join(ctx.memDir, hub), text);
  record(ctx, "index", { index: { changes: ok.length } });
  const label = `tightened MEMORY.md (${ok.length} change${ok.length === 1 ? "" : "s"})`;
  const hash = commitAll(ctx.memDir, `sleep: ${label}`);
  addStep(ctx, flags, { commit: hash, label, movesBefore: snapshot(ctx.moves) });
  const p = loadProposal(ctx.state);
  if (p) fs.rmSync(proposalFile(ctx.state), { force: true });
  console.log(`Changed ${ok.length} line(s) in MEMORY.md. Undo with: sleep undo`);
}

// One entry in undo.json per commit a step makes. --run groups the commits of one Apply from the page.
function addStep(ctx, flags, { commit, label, movesBefore, draft = null }) {
  if (!commit) return;
  const steps = loadSteps(ctx.state);
  steps.push({ commit, label, run: String(flags.run || `${Date.now()}-${process.pid}`), at: new Date().toISOString(), moves: movesDiff(movesBefore, ctx.moves), ...(draft ? { draft } : {}) });
  saveSteps(ctx.state, steps);
}

// sleep undo: reverts the newest run's commits in one commit, then puts moves.json and any used-up draft back.
function undo(flags) {
  const { memDir, state } = locate(flags);
  const steps = loadSteps(state);
  if (flags.list) {
    const open = steps.filter((s) => !s.undone).reverse();
    if (flags.json) { process.stdout.write(JSON.stringify(open, null, 2) + "\n"); return; }
    if (!open.length) { console.log("Nothing sleep did is left to undo."); return; }
    console.log("Newest first; sleep undo takes back the first group:");
    let last = null;
    for (const s of open) { console.log(`${s.run === last ? "  " : ""}${s.at.slice(0, 16).replace("T", " ")}  ${s.commit}  ${s.label}`); last = s.run; }
    return;
  }
  const group = nextGroup(steps);
  if (!group.length) throw new Error("Nothing sleep did is left to undo.");
  for (const s of group) if (!inHistory(memDir, s.commit)) throw new Error(`Nothing was undone: ${s.commit} (${s.label}) is no longer in the memory folder's history.`);
  ensureRepo(memDir);
  commitAll(memDir, "sleep: snapshot before undoing");
  // git writes reverted files afresh, which would make each one look new and keep it from moving for weeks.
  const dates = datesOf(memDir);
  const movesFile = path.join(state, "moves.json");
  let moves = loadMoves(movesFile);
  revertAll(memDir, group.map((s) => s.commit));
  putDatesBack(memDir, dates, movedBy(moves.slice(group.at(-1).moves.len)));
  for (const s of group) moves = rewindMoves(moves, s.moves);
  saveMoves(movesFile, moves);
  for (const s of group) {
    if (!s.draft || !DRAFT_NAME.test(s.draft.name)) continue;
    fs.mkdirSync(path.join(state, "drafts"), { recursive: true });
    fs.writeFileSync(path.join(state, "drafts", s.draft.name), s.draft.text);
    if (s.draft.meta) { const meta = loadMeta(state); meta[s.draft.name] = s.draft.meta; saveMeta(state, meta); }
    if (s.draft.note) saveNote(state, s.draft.name, s.draft.note);
  }
  pruneEmpty(memDir);
  // A long Apply is summed up: its merges counted, any other step named.
  const merges = group.filter((s) => s.label.startsWith("merged ")).length, others = group.filter((s) => !s.label.startsWith("merged ")).map((s) => s.label).reverse();
  const label = group.length === 1 ? group[0].label : `${group.length} steps: ${[...others, merges ? `${merges} merge${merges === 1 ? "" : "s"}` : ""].filter(Boolean).join("; ")}`;
  const hash = commitAll(memDir, `sleep: undid ${label}`);
  const at = new Date().toISOString();
  for (const s of group) Object.assign(s, { undone: at, undoneBy: hash });
  saveSteps(state, steps);
  if (flags.json) process.stdout.write(JSON.stringify({ undid: group.map((s) => s.label), commit: hash }, null, 2) + "\n");
  else console.log(`Undid: ${label}. Commit ${hash}.`);
}

async function main() {
  const { cmd, args, flags } = parse(process.argv.slice(2));
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h" || flags.help) { process.stdout.write(HELP); return; }
  if (!["restore", "merged"].includes(cmd) && args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  if (cmd === "report") return report(flags);
  if (cmd === "archive") return archive(flags);
  if (cmd === "restore") return restore(flags, args);
  if (cmd === "queue") return queue(flags);
  if (cmd === "stats") return stats(flags);
  if (cmd === "review") return review(flags);
  if (cmd === "schedule") return schedule(flags);
  if (cmd === "merged") return merged(flags, args);
  if (cmd === "index-apply") return indexApply(flags);
  if (cmd === "undo") return undo(flags);
  if (cmd === "projects") return projects(flags);
  if (cmd === "open") return openPage(flags);
  throw new Error(`Unknown command: ${cmd}. Try: sleep help`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
