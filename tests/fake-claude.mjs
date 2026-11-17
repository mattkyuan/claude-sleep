#!/usr/bin/env node
// Stands in for `claude -p` in tests. Logs its arguments, folder and input to FAKE_LOG (and, with FAKE_LOGDIR, one file
// per call with start and end times), then answers as FAKE_MODE says.
import fs from "node:fs";
import path from "node:path";

const input = fs.readFileSync(0, "utf8");
const start = Date.now();
if (process.env.FAKE_LOG) fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input }));
const batch = [...input.matchAll(/^### (\S+\.md)$/gm)].map((m) => m[1]);
const draft = (name, sources, body = "Merged rule.") =>
  `<<<DRAFT ${name}>>>\n---\nname: ${name.replace(/\.md$/, "")}\ndescription: Merged\nsleep_sources: ${sources.join(", ")}\nmetadata:\n  type: feedback\n---\n\n${body}\n<<<END>>>`;
const mode = process.env.FAKE_MODE || "good";
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
let out;
if (process.env.FAKE_DELAY) await wait(Number(process.env.FAKE_DELAY));
if (process.env.FAKE_FAIL_IF && batch.includes(process.env.FAKE_FAIL_IF)) { process.stderr.write("Rate limited.\n"); process.exit(1); }
if (process.env.FAKE_NONE_IF && batch.includes(process.env.FAKE_NONE_IF)) out = "Nothing here says the same thing.\n<<<NONE>>>";
else if (mode === "good") out = `Here are the drafts.\n${draft("merged_rules.md", batch.slice(0, 2))}`;
else if (mode === "keep") {
  const text = (name) => (input.split(`### ${name}\n\n`)[1] || "").split(/\n### \S+\.md\n/)[0].replace(/^---[\s\S]*?---\n/, "").trim();
  out = batch.length >= 2 ? draft(`${batch[0].replace(/\.md$/, "")}_merged.md`, batch.slice(0, 2), batch.slice(0, 2).map(text).join("\n\n")) : "<<<NONE>>>";
}
else if (mode === "single") out = draft("merged_rules.md", batch.slice(0, 1));
else if (mode === "all") out = draft("merged_rules.md", batch);
else if (mode === "redo") out = draft(process.env.FAKE_NAME, batch, "Redone after the note.");
else if (mode === "outside") out = draft("merged_rules.md", [batch[0], "delta.md"]);
else if (mode === "escape") out = draft("../escaped.md", batch.slice(0, 1));
else if (mode === "clash") out = draft("delta.md", batch.slice(0, 1));
else if (mode === "slow") { await wait(Number(process.env.FAKE_MS || 1500)); out = draft("merged_rules.md", batch.slice(0, 2)); }
else if (mode === "index") {
  // One change from FAKE_KIND, FAKE_OLD (a line of MEMORY.md; FAKE_OLD_MATCH picks it from the input instead),
  // FAKE_NEW, FAKE_HUB and FAKE_ADD.
  const e = process.env, old = e.FAKE_OLD_MATCH ? input.split("\n").find((l) => l.includes(e.FAKE_OLD_MATCH)) : e.FAKE_OLD;
  out = `<<<CHANGE ${e.FAKE_KIND || "shorten"}>>>\nreason: ${e.FAKE_REASON ?? "Closed topic."}\n${e.FAKE_HUB ? `hub: ${e.FAKE_HUB}\n` : ""}old: ${old}\nnew: ${e.FAKE_NEW ?? ""}\n${e.FAKE_ADD ? `add: ${e.FAKE_ADD}\n` : ""}<<<END>>>`;
}
else if (mode === "fail") { process.stderr.write("Not logged in.\n"); process.exit(1); }
if (process.env.FAKE_LOGDIR) fs.writeFileSync(path.join(process.env.FAKE_LOGDIR, `${process.pid}.json`), JSON.stringify({ start, end: Date.now(), batch }));
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: out }));
