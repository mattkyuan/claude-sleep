// Which memory files the agent actually saw, from Claude Code's session logs.
//
// A file counts as used in a session when one of its own lines comes back in a tool result, whatever command
// produced it (Read, cat, grep, more, a script, a subagent). File names alone (an ls) do not count. Sessions that
// write to the memory folder are upkeep and count for nothing. Results are kept per session in a ledger, because
// Claude Code deletes logs after 30 days by default and the window sleep judges by can be longer.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const MIN_LINE = 30; // shorter lines ("**Why:**", "- see above") are too common to identify a file
const MIN_WORDS = 6; // a line must read like prose: a memory that quotes tool output ("1 error in 175s") would
                     // otherwise match every time the tool prints it
const norm = (s) => s.replace(/\s+/g, " ").trim();
// Whole words between spaces, so a path like tests/smoke_test.py::test_x counts as none.
const words = (s) => s.split(" ").filter((t) => /^[("'`*]*[A-Za-z][a-z'-]*[)"'`*,.;:!?]*$/.test(t)).length;

// Every body line long enough to be distinctive, mapped to the files it appears in. Lines that are also in
// MEMORY.md are left out: the index is loaded every session, so seeing them says nothing about the file.
export function fingerprints(mem) {
  const inIndex = new Set(mem.index.text.split("\n").map(norm));
  const map = new Map();
  const per = new Map();
  for (const f of mem.files) {
    let n = 0;
    for (const raw of f.body.split("\n")) {
      const l = norm(raw);
      if (l.length < MIN_LINE || words(l) < MIN_WORDS || inIndex.has(l)) continue;
      if (!map.has(l)) map.set(l, new Set());
      map.get(l).add(f.name);
      n++;
    }
    per.set(f.name, n);
  }
  return { map, per };
}

// Strip what a tool adds in front of a line: Read's "12\t" or "12→", grep's "path:12:" or "path-12-" or "path:".
function stripPrefix(line) {
  return line
    .replace(/^\s*\d+(\t|→)/, "")
    .replace(/^[^\s:]*\.md[:-]\d+[:-]/, "")
    .replace(/^[^\s:]*\.md:/, "");
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((x) => (typeof x?.text === "string" ? x.text : typeof x === "string" ? x : "")).join("\n");
  return "";
}

// Every string inside an attachment, whatever its shape: the harness can inject memory text under any key.
// Each session's own copy of MEMORY.md (in the "instructions" attachment) is skipped: it loads every session,
// and an older copy can hold lines that have since moved into topic files.
function strings(v, out, depth = 0) {
  if (depth > 8) return;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (v && typeof v === "object") {
    if (typeof v.path === "string" && /(^|\/)MEMORY\.md$/.test(v.path)) return;
    for (const x of Object.values(v)) strings(x, out, depth + 1);
  }
}

// A command that changes the memory folder: in-place edits, moves, deletes, git writes; or a redirect or tee whose
// target is in the memory folder (cat memory/x.md > /tmp/y only reads it).
const WRITE = /\bsed\s+-i|\bperl\s+-[a-z]*i|\bmv\b|\brm\b|\bcp\b|\btouch\b|\bgit\s+(-C\s+\S+\s+)?(commit|mv|rm|add|checkout|restore)\b/;
const TARGETS = /(?:(?:^|[^<>&\d])>>?\s*|\btee\s+(?:-a\s+)?)(["']?)([^\s;|&"']+)\1/g;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function writesInto(cmd, memDirs) {
  const cdMem = memDirs.some((d) => new RegExp(`\\bcd\\s+["']?${reEsc(d)}`).test(cmd));
  // Shell variables set to the memory folder in the same command (M=~/.claude/.../memory; ... > $M/x.md).
  const vars = new Set();
  for (const m of cmd.matchAll(/\b([A-Za-z_]\w*)=(["']?)([^\s;"']+)\2/g)) if (memDirs.some((d) => m[3].startsWith(d))) vars.add(m[1]);
  for (const m of cmd.matchAll(TARGETS)) {
    const t = m[2];
    if (memDirs.some((d) => t.includes(d))) return true;
    const v = /^\$\{?([A-Za-z_]\w*)/.exec(t);
    if (v && vars.has(v[1])) return true;
    if (cdMem && !/^[/~$]/.test(t)) return true; // relative target after cd into the memory folder
  }
  return false;
}
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function isUpkeep(block, memDirs) {
  if (block?.type !== "tool_use") return false;
  const input = block.input || {};
  if (EDIT_TOOLS.has(block.name)) {
    const p = String(input.file_path || input.notebook_path || "");
    return memDirs.some((d) => p.startsWith(d + "/"));
  }
  if (block.name === "Bash") {
    const cmd = String(input.command || "");
    if (!memDirs.some((d) => cmd.includes(d))) return false;
    const clean = cmd.replace(/\d*>&?\s*\/dev\/null/g, "").replace(/\d>&\d/g, "");
    return WRITE.test(clean) || writesInto(clean, memDirs);
  }
  return false;
}

// The project's log folders: its own, and its worktrees' (".claude/worktrees/x" encodes as "--claude-worktrees-x").
export function logFiles(claudeDir, projectKey) {
  const root = path.join(claudeDir, "projects");
  const out = [];
  let projects; try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { projects = []; }
  for (const e of projects) {
    if (!e.isDirectory() || !(e.name === projectKey || e.name.startsWith(projectKey + "--claude-worktrees-"))) continue;
    const pdir = path.join(root, e.name);
    for (const s of fs.readdirSync(pdir, { withFileTypes: true })) {
      const p = path.join(pdir, s.name);
      if (s.isFile() && s.name.endsWith(".jsonl")) { const st = fs.statSync(p); out.push({ path: p, sid: `${e.name}/${s.name.slice(0, -6)}`, mtimeMs: st.mtimeMs, size: st.size }); }
      else if (s.isDirectory()) walkSession(p, `${e.name}/${s.name}`, out);
    }
  }
  return out;
}

// A session's own folder holds its subagents' logs; they belong to that session.
function walkSession(d, sid, out) {
  let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkSession(p, sid, out);
    else if (e.name.endsWith(".jsonl")) { const st = fs.statSync(p); out.push({ path: p, sid, mtimeMs: st.mtimeMs, size: st.size }); }
  }
}

// Which files one tool result (or attachment) shows. A single matching line is not enough on its own: memories
// often quote an error message or log line, and the tool printing that line is not a read of the memory. So a file
// needs two of its lines in the same result, or one line when the call or output names the file (grep x file.md,
// "file.md:12:" prefixes), or one line when the file has only one recognizable line.
function filesIn(text, context, fp) {
  const seen = new Map(); // file -> { lines: Set, named }
  for (const raw of text.split("\n")) {
    const l = norm(stripPrefix(raw));
    if (l.length < MIN_LINE) continue;
    const names = fp.map.get(l);
    if (!names) continue;
    for (const nm of names) {
      const s = seen.get(nm) || seen.set(nm, { lines: new Set(), named: false }).get(nm);
      s.lines.add(l);
      if (raw.includes(nm)) s.named = true;
    }
  }
  const out = [];
  for (const [nm, s] of seen) {
    if (s.lines.size >= 2 || s.named || context.includes(nm) || fp.per.get(nm) === 1) out.push(nm);
  }
  return out;
}

async function scanSession(files, fp, memDirs) {
  const hits = {};
  let upkeep = false, first = Infinity, last = 0;
  for (const f of files) {
    const inputs = new Map(); // tool_use id -> its input as text, to see whether the call named a file
    const rl = readline.createInterface({ input: fs.createReadStream(f.path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      const useful = line.includes('"tool_result"') || line.includes('"tool_use"') || line.includes('"attachment"');
      let m = null;
      if (useful || line.includes('"timestamp"')) { try { m = JSON.parse(line); } catch { continue; } }
      if (!m) continue;
      const t = Date.parse(m.timestamp) || 0;
      if (t) { first = Math.min(first, t); last = Math.max(last, t); }
      if (!useful) continue;
      const texts = []; // [text, context]
      const content = m.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "tool_use") {
            if (!upkeep && isUpkeep(b, memDirs)) upkeep = true;
            inputs.set(b.id, JSON.stringify(b.input || {}));
          } else if (b?.type === "tool_result") {
            texts.push([textOf(b.content), inputs.get(b.tool_use_id) || ""]);
            inputs.delete(b.tool_use_id);
          }
        }
      }
      if (m.attachment) { const parts = []; strings(m.attachment, parts); texts.push([parts.join("\n"), parts.join("\n")]); }
      for (const [text, context] of texts) {
        for (const nm of filesIn(text, context, fp)) hits[nm] = Math.max(hits[nm] || 0, t || last);
      }
    }
  }
  return { first: first === Infinity ? last : first, last, upkeep, hits: upkeep ? {} : hits };
}

export function loadLedger(file) {
  try {
    const l = JSON.parse(fs.readFileSync(file, "utf8"));
    if (l && l.version === 1) return l;
  } catch {}
  return { version: 1, logs: {}, sessions: {} };
}

export function saveLedger(file, ledger) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(ledger));
  fs.renameSync(tmp, file);
}

// Rescan sessions whose logs changed, keep the rest from the ledger, and total it all up per file.
export async function usage({ mem, claudeDir, projectKey, memDirs, ledger, progress = () => {} }) {
  const fp = fingerprints(mem);
  const logs = logFiles(claudeDir, projectKey);
  const bySid = new Map();
  for (const l of logs) { if (!bySid.has(l.sid)) bySid.set(l.sid, []); bySid.get(l.sid).push(l); }
  const changed = [...bySid].filter(([, fs_]) => fs_.some((f) => { const o = ledger.logs[f.path]; return !o || o.mtimeMs !== f.mtimeMs || o.size !== f.size; }));
  let done = 0;
  for (const [sid, files] of changed) {
    if (done++ % 25 === 0) progress(`reading session logs (${done} of ${changed.length})`);
    ledger.sessions[sid] = await scanSession(files, fp, memDirs);
    for (const f of files) ledger.logs[f.path] = { mtimeMs: f.mtimeMs, size: f.size };
  }
  const present = new Set(logs.map((l) => l.path));
  for (const p of Object.keys(ledger.logs)) if (!present.has(p)) delete ledger.logs[p];

  const per = new Map(mem.files.map((f) => [f.name, { sessions: 0, last: 0 }]));
  let oldest = Infinity, upkeepSessions = 0, sessions = 0;
  for (const s of Object.values(ledger.sessions)) {
    if (s.first) oldest = Math.min(oldest, s.first);
    if (s.upkeep) { upkeepSessions++; continue; }
    sessions++;
    for (const [nm, t] of Object.entries(s.hits)) {
      const u = per.get(nm);
      if (!u) continue;
      u.sessions++; u.last = Math.max(u.last, t);
    }
  }
  const now = Date.now();
  const coverageDays = oldest === Infinity ? 0 : Math.floor((now - oldest) / 864e5);
  return {
    per, fingerprintLines: fp.per,
    summary: { logs: logs.length, rescanned: changed.length, sessions, upkeepSessions, coverageFrom: oldest === Infinity ? null : new Date(oldest).toISOString().slice(0, 10), coverageDays },
  };
}
