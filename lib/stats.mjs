// Effectiveness tracking. Every command appends one line to stats.jsonl with the folder's shape after it ran,
// and `sleep stats` turns the moves and the lines into an error rate and a trend.
//
// Sleep's mistakes, as far as the data can show them: a file it archived that the user restored, and a file it
// archived that the agent went and read anyway. Neither says whether the agent works better; that needs a
// separate check (do recorded mistakes recur?).
import fs from "node:fs";
import path from "node:path";
import { INDEX, tok } from "./memory.mjs";
import { ARCHIVE, QUEUE } from "./archive.mjs";

const mdIn = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => path.join(d, e.name)); } catch { return []; } };
const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

export function record(ctx, cmd, extra = {}) {
  const main = mdIn(ctx.memDir).filter((f) => path.basename(f) !== INDEX);
  const queue = mdIn(path.join(ctx.memDir, QUEUE));
  const archived = ctx.moves.filter((m) => m.status === "active" && (m.kind === "archive" || m.kind === "merged") && fs.existsSync(path.join(ctx.memDir, m.to)));
  let index = ""; try { index = fs.readFileSync(path.join(ctx.memDir, INDEX), "utf8"); } catch {}
  const live = ctx.live.files;
  const line = {
    at: new Date().toISOString(), cmd,
    files: { main: main.length, consolidate: queue.length, archive: archived.length },
    liveBytes: [...main, ...queue].reduce((a, f) => a + size(f), 0), indexTokens: tok(index.length),
    used: live.filter((f) => ctx.use.status(f) === "used").length, unused: live.filter((f) => ctx.use.status(f) === "unused").length,
    unknown: live.filter((f) => ctx.use.status(f) === "no data").length, coverageDays: ctx.u.summary.coverageDays,
    ...extra,
  };
  fs.mkdirSync(ctx.state, { recursive: true });
  fs.appendFileSync(path.join(ctx.state, "stats.jsonl"), JSON.stringify(line) + "\n");
  return line;
}

export function summarize(ctx) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(ctx.state, "stats.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const moves = ctx.moves;
  const archivedMoves = moves.filter((m) => m.kind === "archive");
  const restored = archivedMoves.filter((m) => m.status === "restored");
  // Read again: still archived, and its text came back in a session after the day it moved.
  const readAgain = moves.filter((m) => m.status === "active" && (m.kind === "archive" || m.kind === "merged")).flatMap((m) => {
    const f = ctx.mem.files.find((x) => x.rel === m.to);
    const last = f ? ctx.use.of(f).last : 0;
    return last > Date.parse(m.at) ? [{ name: m.name, to: m.to, movedAt: m.at.slice(0, 10), lastRead: new Date(last).toISOString().slice(0, 10) }] : [];
  });
  const merges = new Map();
  for (const m of moves.filter((x) => x.kind === "merged")) merges.set(m.into, (merges.get(m.into) || 0) + 1);
  const mergedOutputs = [...merges].map(([into, sources]) => {
    const f = ctx.mem.files.find((x) => x.name === into);
    return { into, sources, sessions: f ? ctx.use.of(f).sessions : 0 };
  });
  const sized = lines.filter((l) => l.files);
  const first = sized[0], last = sized.at(-1);
  const shape = (l) => l && { at: l.at.slice(0, 10), files: l.files, liveBytes: l.liveBytes, indexTokens: l.indexTokens };
  return {
    runs: lines.length,
    archived: archivedMoves.length, restored: restored.length,
    queued: moves.filter((m) => m.kind === "consolidate").length,
    restoredFromQueue: moves.filter((m) => m.kind === "consolidate" && m.status === "restored").length,
    readAgain,
    mistakeRate: archivedMoves.length ? (restored.length + readAgain.filter((r) => !restored.some((x) => x.name === r.name)).length) / archivedMoves.length : null,
    merged: { sources: moves.filter((m) => m.kind === "merged").length, outputs: mergedOutputs.length, outputs_used: mergedOutputs },
    purged: moves.filter((m) => m.status === "purged").length,
    first: shape(first), last: shape(last),
  };
}
