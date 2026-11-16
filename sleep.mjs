#!/usr/bin/env node
// sleep: memory upkeep for Claude Code. This file is the command line; the work is in lib/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMemory } from "./lib/memory.mjs";
import { usage, loadLedger, saveLedger } from "./lib/usage.mjs";
import { DEFAULTS, checks, candidates } from "./lib/checks.mjs";
import { writeReport } from "./lib/report.mjs";

const HELP = `sleep: memory upkeep for Claude Code

Usage:
  sleep report [options]   inventory, usage, checks and archive candidates; changes nothing in memory

Options:
  --project DIR   the project whose memory to read (default: the current folder)
  --days N        a file must go unused this many days before it can be archived (default ${DEFAULTS.days})
  --out DIR       where to write the report (default: <project memory>/../memory-archive/reports)
  --state DIR     where the usage ledger lives (default: <project memory>/../memory-archive/.sleep)
  --json          print the report as json instead of writing files
  --help          show this
`;

function parse(argv) {
  const o = { cmd: argv[0], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    const k = a.slice(2);
    if (["json", "help"].includes(k)) o.flags[k] = true;
    else { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); o.flags[k] = argv[++i]; }
  }
  return o;
}

const untilde = (p) => (p && p.startsWith("~") ? os.homedir() + p.slice(1) : p);
const projectKey = (p) => p.replace(/[^A-Za-z0-9]/g, "-");

async function report(flags) {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const project = path.resolve(untilde(flags.project || process.cwd()));
  const key = projectKey(project);
  const pdir = path.join(claudeDir, "projects", key);
  const memDir = path.join(pdir, "memory");
  if (!fs.existsSync(memDir)) throw new Error(`No memory folder at ${memDir}`);
  const days = flags.days ? Number(flags.days) : DEFAULTS.days;
  if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a whole number of days");
  const opt = { ...DEFAULTS, days };
  const state = path.resolve(untilde(flags.state || path.join(pdir, "memory-archive", ".sleep")));
  const ledgerFile = path.join(state, "ledger.json");

  const mem = readMemory(memDir);
  // The same folder as commands may spell it: as is, resolved through symlinks, and with ~.
  const memDirs = [...new Set([memDir, fs.realpathSync(memDir), memDir.replace(os.homedir(), "~")])];
  const ledger = loadLedger(ledgerFile);
  const progress = (msg) => { if (process.stderr.isTTY) process.stderr.write(`\r${msg}   `); };
  const u = await usage({ mem, claudeDir, projectKey: key, memDirs, ledger, progress });
  if (process.stderr.isTTY) process.stderr.write("\r" + " ".repeat(60) + "\r");
  saveLedger(ledgerFile, ledger);

  const of = (f) => u.per.get(f.name) || { sessions: 0, last: 0 };
  const status = (f) => (of(f).sessions ? "used" : u.fingerprintLines.get(f.name) ? "unused" : "no data");
  const use = { of, status };
  const cand = candidates(mem, use, opt, u.summary.coverageDays);
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : null);
  const r = {
    version: 1, generatedAt: new Date().toISOString(), mode: "report", project, memDir,
    options: { days: opt.days, expirable: opt.expirable, protectedTypes: opt.protectedTypes, consolidateTypes: opt.consolidateTypes },
    index: { lines: mem.index.lines, bytes: mem.index.bytes, tokens: mem.index.tokens, loadedLines: mem.index.loadedLines, truncatedLines: mem.index.truncatedLines },
    usage: u.summary,
    files: mem.files.map((f) => ({
      name: f.name, type: f.type, description: f.description, bytes: f.bytes, tokens: f.tokens, created: day(f.createdMs), edited: day(f.mtimeMs), linkedFrom: f.linkedFrom,
      usage: { status: status(f), sessions: of(f).sessions, lastUsed: day(of(f).last) },
    })),
    checks: checks(mem, use, opt),
    candidates: cand.list, consolidate: cand.consolidate, candidatesNote: cand.note,
  };
  if (flags.json) { process.stdout.write(JSON.stringify(r, null, 2) + "\n"); return; }
  const out = path.resolve(untilde(flags.out || path.join(pdir, "memory-archive", "reports")));
  const { md } = writeReport(r, out);
  const failed = r.checks.filter((c) => c.status === "fail" || c.status === "warn").length;
  console.log(`${r.files.length} memory files; ${u.summary.coverageDays} days of usage on record; ${failed} check(s) need attention; ${r.candidates.length} archive candidate(s); ${r.consolidate.length} queued for consolidation.`);
  console.log(`Report: ${md}`);
}

async function main() {
  const { cmd, flags } = parse(process.argv.slice(2));
  if (!cmd || cmd === "help" || flags.help) { process.stdout.write(HELP); return; }
  if (cmd === "report") return report(flags);
  throw new Error(`Unknown command: ${cmd}. Try: sleep report`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
