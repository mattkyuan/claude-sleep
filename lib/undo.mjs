// sleep undo. Every sleep step that commits a change to the memory folder (archive --apply, restore, merged,
// index-apply) writes one entry to <state>/undo.json: its commit, a label, the run it belongs to, and how it changed
// sleep's own records, which live outside the folder's git history (moves.json, a draft a merge used up). Undo
// reverts the newest run's commits together and puts those records back, so moves.json always matches the folder.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { keepDates } from "./archive.mjs";

const file = (state) => path.join(state, "undo.json");

export function loadSteps(state) {
  try { const v = JSON.parse(fs.readFileSync(file(state), "utf8")); return Array.isArray(v) ? v.filter((s) => s && typeof s.commit === "string" && /^[0-9a-f]{4,40}$/.test(s.commit)) : []; } catch { return []; }
}
export function saveSteps(state, steps) {
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(file(state), JSON.stringify(steps, null, 2) + "\n");
}

// The move list before a step, as text, so later in-place edits to its entries do not change it.
export const snapshot = (moves) => moves.map((m) => JSON.stringify(m));

// How a step changed the move list: its length before, and every entry that was there and changed.
export function movesDiff(before, after) {
  const prev = {};
  for (const [i, s] of before.entries()) if (JSON.stringify(after[i]) !== s) prev[i] = JSON.parse(s);
  return { len: before.length, prev };
}

// The move list as it was before a step.
export function rewindMoves(moves, diff) {
  const out = moves.slice(0, diff.len);
  for (const [i, m] of Object.entries(diff.prev)) out[Number(i)] = m;
  return out;
}

// The steps the next undo takes back: the newest step not yet undone, and every step before it in the same run.
export function nextGroup(steps) {
  const open = steps.filter((s) => !s.undone);
  const group = [];
  for (let i = open.length - 1; i >= 0 && open[i].run === open.at(-1).run; i--) group.push(open[i]);
  return group;
}

const ID = ["-c", "user.name=sleep", "-c", "user.email=sleep@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
const run = (dir, args) => spawnSync("git", ["-C", dir, ...ID, ...args], { encoding: "utf8" });

// The dates of every file in the folder, by path, so files a revert writes afresh can get their dates back.
export function datesOf(dir) {
  const byRel = new Map();
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.isFile()) byRel.set(path.relative(dir, f), fs.statSync(f));
  } };
  walk(dir);
  return byRel;
}

// Where each file the undone steps moved sits now, by the place the undo puts it back: the moves the steps added,
// followed in order (a file queued, then merged, is in the archive now and goes back to the main folder).
export function movedBy(added) {
  const origOf = new Map();
  for (const m of added) { const orig = origOf.get(m.from) ?? m.from; origOf.delete(m.from); origOf.set(m.to, orig); }
  return new Map([...origOf].map(([now, orig]) => [orig, now]));
}

// Gives every file the dates it had before the revert: at the same path, or where it was moved to.
export function putDatesBack(dir, before, moved) {
  for (const [rel] of datesOf(dir)) { const st = before.get(moved.get(rel) ?? rel); if (st) keepDates(path.join(dir, rel), st); }
}

export const inHistory = (dir, commit) => run(dir, ["merge-base", "--is-ancestor", commit, "HEAD"]).status === 0;

// Reverts the commits, newest first, into the working tree without committing. On a conflict nothing is left
// changed and the error names the files a later edit touched.
export function revertAll(dir, commits) {
  const r = run(dir, ["revert", "--no-commit", ...commits]);
  if (r.status === 0) return;
  const clash = run(dir, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim().split("\n").filter(Boolean);
  // The caller committed a snapshot just before, so this drops only what the failed revert left behind, and ends
  // the revert git started.
  run(dir, ["reset", "-q", "--hard", "HEAD"]);
  throw new Error(`Nothing was undone: a later edit changed the same lines${clash.length ? ` in ${clash.join(", ")}` : ""}. Undo that edit first, or leave this step in place.${clash.length ? "" : ` (${(r.stderr || "").trim().split("\n").pop()})`}`);
}
