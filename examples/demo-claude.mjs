#!/usr/bin/env node
// A canned stand-in for `claude -p`, for the demo only: it merges each batch's memories in pairs by joining their
// text, so the served page's Consolidate and Tighten flows run offline. Real merges come from Claude.
import fs from "node:fs";

const input = fs.readFileSync(0, "utf8");
const names = [...input.matchAll(/^### (\S+\.md)$/gm)].map((m) => m[1]);
const body = (name) => (input.split(`### ${name}\n\n`)[1] || "").split(/\n### \S+\.md\n/)[0].replace(/^---[\s\S]*?---\n/, "").trim();
const draft = (pair) => {
  const name = `${pair[0].replace(/\.md$/, "")}_merged.md`;
  return `<<<DRAFT ${name}>>>\n---\nname: ${name.slice(0, -3)}\ndescription: Merged from ${pair.join(" and ")}\nsleep_sources: ${pair.join(", ")}\nmetadata:\n  type: feedback\n---\n\n${pair.map(body).join("\n\n")}\n<<<END>>>`;
};
let out;
if (/<<<CHANGE/.test(input) || !names.length) out = "No changes to suggest.\n<<<NONE>>>";
else {
  const drafts = [];
  for (let i = 0; i + 1 < names.length; i += 2) drafts.push(draft(names.slice(i, i + 2)));
  out = drafts.length ? `Drafts:\n${drafts.join("\n")}` : "<<<NONE>>>";
}
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: out }));
