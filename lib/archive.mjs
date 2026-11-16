// Moving memories out of the way and back: archive candidates go to memory-archive/, unused feedback goes to
// consolidate/. Links are rewritten, never deleted, so a dense hub line keeps its context and a restore undoes
// a move exactly. Every move is recorded in moves.json.
import fs from "node:fs";
import path from "node:path";
import { INDEX } from "./memory.mjs";

export const ARCHIVE = "memory-archive";
export const QUEUE = "consolidate";
const MARK = "(added by sleep)";
export const HINT = `- Search order: retired memories are in ${ARCHIVE}/ and lessons waiting to be merged are in ${QUEUE}/. Look there only after the main files turn up nothing. ${MARK}`;

export function loadMoves(file) {
  try { const m = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(m) ? m : []; } catch { return []; }
}
export function saveMoves(file, moves) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(moves, null, 2));
}
export const activeArchived = (moves) => moves.filter((m) => m.status === "active" && m.kind === "archive").map((m) => m.to);

// Where each candidate goes. A name already taken gets the date, then a counter, so nothing is overwritten.
export function planMoves(memDir, archive, queue) {
  const taken = new Set();
  const today = new Date().toISOString().slice(0, 10);
  const target = (dir, name) => {
    const base = name.slice(0, -3);
    const free = (rel) => !taken.has(rel) && !fs.existsSync(path.join(memDir, rel));
    let rel = `${dir}/${name}`;
    if (!free(rel)) rel = `${dir}/${base}.${today}.md`;
    for (let i = 2; !free(rel); i++) rel = `${dir}/${base}.${today}-${i}.md`;
    taken.add(rel);
    return rel;
  };
  return [
    ...archive.map((c) => ({ kind: "archive", name: c.name, from: c.rel || c.name, to: target(ARCHIVE, c.name) })),
    ...queue.map((c) => ({ kind: "consolidate", name: c.name, from: c.rel || c.name, to: target(QUEUE, c.name) })),
  ];
}

// The files whose links sleep keeps right: the index, top-level memories, and the top level of both subfolders.
function linkingFiles(memDir) {
  const out = [];
  const add = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) if (e.isFile() && e.name.endsWith(".md")) out.push(path.join(d, e.name)); };
  add(memDir); add(path.join(memDir, ARCHIVE)); add(path.join(memDir, QUEUE));
  return out;
}

// Rewrites [text](file.md) links for files that moved, from a file that may itself have moved.
// Links to things that do not exist, absolute paths and URLs are left alone. [[slug]] links name a file, not a path.
export function relink(text, oldDir, newDir, moveMap) {
  return text.replace(/(\]\()([^)\s]+?\.md)((?:#[^)]*)?\))/g, (all, pre, href, post) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/")) return all;
    let dec; try { dec = decodeURIComponent(href); } catch { dec = href; }
    const oldAbs = path.resolve(oldDir, dec);
    const newAbs = moveMap.get(oldAbs) || oldAbs;
    if (newAbs === oldAbs && newDir === oldDir) return all;
    if (!moveMap.has(oldAbs) && !fs.existsSync(oldAbs)) return all;
    return pre + path.relative(newDir, newAbs).split(path.sep).join("/") + post;
  });
}

// Applies moves ({from, to} relative to the memory folder): every new text is worked out first from the current
// layout, then written, so the result never depends on the order of the moves.
export function applyMoves(memDir, moves) {
  const moveMap = new Map(moves.map((m) => [path.join(memDir, m.from), path.join(memDir, m.to)]));
  const writes = [];
  for (const f of linkingFiles(memDir)) {
    const nf = moveMap.get(f) || f;
    const text = fs.readFileSync(f, "utf8");
    const next = relink(text, path.dirname(f), path.dirname(nf), moveMap);
    if (nf !== f || next !== text) writes.push({ from: f, to: nf, text: next });
  }
  for (const w of writes) {
    fs.mkdirSync(path.dirname(w.to), { recursive: true });
    fs.writeFileSync(w.to, w.text);
    if (w.to !== w.from) fs.unlinkSync(w.from);
  }
}

// Removes the archive or queue folder when nothing is left in it, so undoing every move leaves no trace.
export function pruneEmpty(memDir) {
  for (const d of [QUEUE, ARCHIVE]) {
    const p = path.join(memDir, d);
    try { if (!fs.readdirSync(p).length) fs.rmdirSync(p); } catch {}
  }
}

// One line in MEMORY.md, after the first line, so it loads even when the index is long. Added once, removed when
// nothing sleep moved is left.
export function setHint(memDir, on) {
  const f = path.join(memDir, INDEX);
  let text; try { text = fs.readFileSync(f, "utf8"); } catch { return; }
  const lines = text.split("\n");
  const has = lines.findIndex((l) => l.includes(MARK));
  if (on && has < 0) lines.splice(lines.length > 1 ? 1 : 0, 0, HINT);
  else if (!on && has >= 0) lines.splice(has, 1);
  else return;
  fs.writeFileSync(f, lines.join("\n"));
}
