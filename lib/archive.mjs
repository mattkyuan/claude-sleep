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

// A path sleep may touch: a .md file at the top of the memory folder or at the top of one of its two subfolders.
// Anything else in moves.json (a hand edit, a corrupt file) is ignored, so sleep never writes outside memory.
const SAFE = new RegExp(`^(?:(?:${ARCHIVE}|${QUEUE})/)?[^/\\\\]+\\.md$`);
export const safeRel = (rel) => typeof rel === "string" && SAFE.test(rel) && !rel.split("/").includes("..");
const safeMove = (m) => m && safeRel(m.from) && safeRel(m.to) && (m.into == null || safeRel(m.into));

export function loadMoves(file) {
  try { const m = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(m) ? m.filter(safeMove) : []; } catch { return []; }
}
export function saveMoves(file, moves) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(moves, null, 2));
}
export const activeArchived = (moves) => moves.filter((m) => m.status === "active" && (m.kind === "archive" || m.kind === "merged")).map((m) => m.to);

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

// The [text](file.md) links in a text, with the path each names when read from `dir`. Absolute paths and URLs are
// skipped. [[slug]] links name a file, not a path.
const LINK = /(\]\()([^)\s]+?\.md)((?:#[^)]*)?\))/g;
const target = (href, dir) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/")) return null;
  let dec; try { dec = decodeURIComponent(href); } catch { dec = href; }
  return { dec, abs: path.resolve(dir, dec) };
};

// Rewrites links for files that moved, from a file that may itself have moved. Links to things that do not exist
// are left alone, and so are links to the paths in `keep` (see heldLinks).
export function relink(text, oldDir, newDir, moveMap, keep = null) {
  return text.replace(LINK, (all, pre, href, post) => {
    const t = target(href, oldDir);
    if (!t) return all;
    const oldAbs = t.abs;
    if (keep && keep.has(oldAbs)) return all;
    const newAbs = moveMap.get(oldAbs) || oldAbs;
    if (newAbs === oldAbs && newDir === oldDir) return all;
    if (!moveMap.has(oldAbs) && !fs.existsSync(oldAbs)) return all;
    return pre + path.relative(newDir, newAbs).split(path.sep).join("/") + post;
  });
}

// Links a set of moves completes by chance: a link that named nothing before (no file there)
// and that names a file once the moves land. Keyed by the move's destination, valued by the files (where they sit
// after the moves) holding such a link. The move records keep them as `held`, so a restore leaves those links as
// they were rather than "fixing" a link that never worked.
export function heldLinks(memDir, moves) {
  const moveMap = new Map(moves.map((m) => [path.join(memDir, m.from), path.join(memDir, m.to)]));
  const dest = new Map(moves.map((m) => [path.join(memDir, m.to), m.to]));
  const held = new Map();
  for (const f of linkingFiles(memDir)) {
    const nf = moveMap.get(f) || f;
    for (const [, , href] of fs.readFileSync(f, "utf8").matchAll(LINK)) {
      const before = target(href, path.dirname(f));
      if (!before || fs.existsSync(before.abs)) continue;
      const to = dest.get(path.resolve(path.dirname(nf), before.dec));
      if (to) (held.get(to) || held.set(to, new Set()).get(to)).add(path.relative(memDir, nf).split(path.sep).join("/"));
    }
  }
  return new Map([...held].map(([k, v]) => [k, [...v].sort()]));
}

// Works out every file write a set of moves needs, without writing: each new text comes from the current layout,
// so the result never depends on the order of the moves. `redirect` ({from, to}) points links somewhere other
// than where the file went: links to a merged source go to the merged file. `keep` maps a file (absolute) to the
// link targets (absolute) to leave alone in it.
export function planWrites(memDir, moves, redirect = [], keep = new Map()) {
  for (const m of [...moves, ...redirect]) if (!safeMove(m)) throw new Error(`Refusing a move outside the memory folder: ${m.from} -> ${m.to}`);
  const moveMap = new Map(moves.map((m) => [path.join(memDir, m.from), path.join(memDir, m.to)]));
  const linkMap = new Map([...moveMap, ...redirect.map((m) => [path.join(memDir, m.from), path.join(memDir, m.to)])]);
  const writes = [];
  for (const f of linkingFiles(memDir)) {
    const nf = moveMap.get(f) || f;
    const text = fs.readFileSync(f, "utf8");
    const next = relink(text, path.dirname(f), path.dirname(nf), linkMap, keep.get(f));
    if (nf !== f || next !== text) writes.push({ from: f, to: nf, before: text, text: next });
  }
  return writes;
}

// fresh: the moved files count as new (a restore: you wanted the file back, so it gets a full window before it can
// move again); otherwise they keep their dates.
export function applyMoves(memDir, moves, redirect = [], { fresh = false, keep } = {}) {
  for (const w of planWrites(memDir, moves, redirect, keep)) {
    fs.mkdirSync(path.dirname(w.to), { recursive: true });
    // A file whose links changed in place keeps its dates too; fresh applies to the moved files only.
    const st = w.to === w.from || !fresh ? fs.statSync(w.from) : null;
    fs.writeFileSync(w.to, w.text);
    if (st) keepDates(w.to, st);
    if (w.to !== w.from) fs.unlinkSync(w.from);
  }
}

// A file's age is its creation date, so a moved or rewritten file keeps the dates it had: setting a time earlier
// than the creation date moves the creation date back (macOS), so the creation date goes first, then the edit date.
export function keepDates(file, st) {
  const born = st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
  fs.utimesSync(file, new Date(born), new Date(born));
  fs.utimesSync(file, st.atime, st.mtime);
}

// The lines a set of moves would change, for showing before anything is applied. Link rewrites never add or
// remove lines, so lines pair up by position.
export function linkEdits(memDir, moves, redirect = []) {
  const out = [];
  for (const w of planWrites(memDir, moves, redirect)) {
    if (w.text === w.before) continue;
    const a = w.before.split("\n"), b = w.text.split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push({ file: path.relative(memDir, w.from), line: i + 1, before: a[i] ?? "", after: b[i] ?? "" });
  }
  return out;
}

// Whether MEMORY.md has sleep's search-order line yet.
export function hasHint(memDir) {
  try { return fs.readFileSync(path.join(memDir, INDEX), "utf8").includes(MARK); } catch { return false; }
}

// [[slug]] links name a memory, not a path, so a move leaves them alone; a merge points them at the merged memory.
// `map` is old slug -> new slug. A label after | or an anchor after # is kept. Like a moved file, a rewritten one keeps
// its dates: sleep's own link edit must not make it look new (on Linux, age falls back to the last edit).
export function redirectSlugs(memDir, map) {
  for (const f of linkingFiles(memDir)) {
    const text = fs.readFileSync(f, "utf8");
    const next = text.replace(/\[\[([^\]|#]+)((?:[|#][^\]]*)?)\]\]/g, (all, slug, rest) => (map.has(slug.trim()) ? `[[${map.get(slug.trim())}${rest}]]` : all));
    if (next !== text) { const st = fs.statSync(f); fs.writeFileSync(f, next); keepDates(f, st); }
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
// nothing sleep moved is left. Like any edit sleep makes for its own bookkeeping, it keeps the index's dates.
export function setHint(memDir, on) {
  const f = path.join(memDir, INDEX);
  let text; try { text = fs.readFileSync(f, "utf8"); } catch { return; }
  const lines = text.split("\n");
  const has = lines.findIndex((l) => l.includes(MARK));
  if (on && has < 0) lines.splice(lines.length > 1 ? 1 : 0, 0, HINT);
  else if (!on && has >= 0) lines.splice(has, 1);
  else return;
  const st = fs.statSync(f);
  fs.writeFileSync(f, lines.join("\n"));
  keepDates(f, st);
}
