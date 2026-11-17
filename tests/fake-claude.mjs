#!/usr/bin/env node
// Stands in for `claude -p` in tests. Logs its arguments, folder and input to FAKE_LOG, then answers as FAKE_MODE says.
import fs from "node:fs";

const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input }));
const batch = [...input.matchAll(/^### (\S+\.md)$/gm)].map((m) => m[1]);
const draft = (name, sources, body = "Merged rule.") =>
  `<<<DRAFT ${name}>>>\n---\nname: ${name.replace(/\.md$/, "")}\ndescription: Merged\nsleep_sources: ${sources.join(", ")}\nmetadata:\n  type: feedback\n---\n\n${body}\n<<<END>>>`;
const mode = process.env.FAKE_MODE || "good";
let out;
if (mode === "good") out = `Here are the drafts.\n${draft("merged_rules.md", batch.slice(0, 2))}`;
else if (mode === "redo") out = draft(process.env.FAKE_NAME, batch, "Redone after the note.");
else if (mode === "outside") out = draft("merged_rules.md", [batch[0], "delta.md"]);
else if (mode === "escape") out = draft("../escaped.md", batch.slice(0, 1));
else if (mode === "clash") out = draft("delta.md", batch.slice(0, 1));
else if (mode === "slow") { await new Promise((ok) => setTimeout(ok, 1500)); out = draft("merged_rules.md", batch.slice(0, 1)); }
else if (mode === "fail") { process.stderr.write("Not logged in.\n"); process.exit(1); }
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: out }));
