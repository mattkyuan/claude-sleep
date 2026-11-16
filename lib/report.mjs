// The run report: one markdown file to read and one json file for tools, written side by side.
import fs from "node:fs";
import path from "node:path";

const n = (x) => x.toLocaleString("en-US");
// Text from memory files goes into table cells: a pipe or a line break would split the row.
const cell = (s) => String(s ?? "").replace(/\r?\n/g, " ").slice(0, 300).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/`/g, "'");
const ICON = { pass: "pass", warn: "WARN", fail: "FAIL", info: "info" };

export function toMarkdown(r) {
  const L = [];
  L.push(`# Memory report, ${r.generatedAt.slice(0, 10)}`, "");
  L.push(`Mode: ${r.mode}. Folder: \`${r.memDir}\`.`, "");
  if (r.moves) {
    L.push("## This run", "");
    if (!r.moves.length && !r.purged.length) L.push("Nothing to move.", "");
    if (r.moves.length) {
      L.push(`| ${r.applied ? "Moved" : "Would move"} | To | Why |`, "|---|---|---|");
      for (const m of r.moves) L.push(`| \`${cell(m.from)}\` | \`${cell(m.to)}\` | ${m.kind === "archive" ? "unused project memory" : "unused feedback memory, to be merged"} |`);
      L.push("");
    }
    if (r.purged.length) L.push(`${r.applied ? "Purged" : "Would purge"}: ${r.purged.map((p) => `\`${cell(p)}\``).join(", ")}`, "");
    if (r.applied && (r.commits.before || r.commits.after)) {
      L.push(`Git, in the memory folder: snapshot ${r.commits.before || "(none needed)"}, then ${r.commits.after || "(no change)"}. Undo one file with \`sleep restore <file>\`, or the whole run with \`git -C <memory folder> revert ${r.commits.after || "<commit>"}\`.`, "");
    } else if (!r.applied && r.moves.length) L.push("Dry run: nothing was moved. Run `sleep archive --apply` to do it.", "");
  }
  L.push("## Summary", "");
  const used = r.files.filter((f) => f.usage.status === "used").length;
  const unused = r.files.filter((f) => f.usage.status === "unused").length;
  const blind = r.files.filter((f) => f.usage.status === "no data").length;
  L.push("| | |", "|---|---|");
  L.push(`| Topic files | ${n(r.files.length)} (${n(Math.round(r.files.reduce((a, f) => a + f.bytes, 0) / 1024))} KB) |`);
  L.push(`| MEMORY.md, loaded every turn | ${n(r.index.lines)} lines, about ${n(r.index.tokens)} tokens${r.index.truncatedLines ? `, ${n(r.index.truncatedLines)} lines past the cap` : ""} |`);
  L.push(`| Usage on record | ${r.usage.coverageDays} days (since ${r.usage.coverageFrom || "never"}), ${n(r.usage.sessions)} sessions, ${n(r.usage.upkeepSessions)} upkeep sessions left out |`);
  L.push(`| Files used / unused / unknown | ${n(used)} / ${n(unused)} / ${n(blind)} |`);
  L.push(`| Archive candidates | ${n(r.candidates.length)} |`, "");
  L.push("## Checks", "");
  L.push("| Status | Check | Detail |", "|---|---|---|");
  for (const c of r.checks) L.push(`| ${ICON[c.status]} | ${cell(c.title)} | ${cell(c.detail)} |`);
  for (const c of r.checks.filter((c) => c.files.length && c.status !== "pass")) {
    L.push("", `**${c.title}:** ${c.files.slice(0, 30).map((f) => `\`${f}\``).join(", ")}${c.files.length > 30 ? `, and ${c.files.length - 30} more` : ""}`);
  }
  L.push("", "## Usage", "");
  L.push("A file counts as used in a session when one of its lines came back in a tool result, whatever command fetched it. Sessions that wrote to the memory folder are upkeep and are left out. A file with no recognizable line is unknown, never unused.", "");
  const top = r.files.filter((f) => f.usage.sessions).sort((a, b) => b.usage.sessions - a.usage.sessions).slice(0, 15);
  if (top.length) {
    L.push("Most used:", "", "| File | Sessions | Last used |", "|---|---|---|");
    for (const f of top) L.push(`| \`${f.name}\` | ${f.usage.sessions} | ${f.usage.lastUsed} |`);
    L.push("");
  }
  L.push("## Archive candidates", "");
  L.push(r.candidatesNote, "");
  const table = (rows) => {
    L.push("| File | Type | Created | Last used | Why |", "|---|---|---|---|---|");
    for (const c of rows) L.push(`| \`${cell(c.name)}\` | ${cell(c.type)} | ${c.created} | ${c.lastUsed || "never"} | ${cell(c.why)} |`);
    L.push("");
  };
  if (r.candidates.length) table(r.candidates);
  L.push("Candidates are expirable memories (project by default), not linked from MEMORY.md or from a protected memory, created before the window and not used within it.", "");
  L.push("## Consolidation queue", "");
  L.push("Protected memories (feedback by default) are never archived. When one goes unused for the window it is queued here instead, to be merged with related memories into fewer, sharper ones.", "");
  if (r.consolidate.length) table(r.consolidate);
  else L.push("Nothing queued.", "");
  if (!r.moves) L.push("Report only: nothing was moved.", "");
  return L.join("\n");
}

export function writeReport(r, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = r.generatedAt.replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  const md = path.join(outDir, `${stamp}.md`), json = path.join(outDir, `${stamp}.json`);
  fs.writeFileSync(md, toMarkdown(r));
  fs.writeFileSync(json, JSON.stringify(r, null, 2));
  return { md, json };
}
