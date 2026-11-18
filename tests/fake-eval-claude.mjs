#!/usr/bin/env node
// Stands in for `claude -p --output-format stream-json` in the eval tests, with the event shapes a real subscription
// run printed (init, assistant tool_use, result). It finds its memory folder the way Claude Code does, reads the
// memory file whose name the prompt mentions, and answers with that file's body and its path.
// FAKE_LOG: append one line per call (argv, cwd, the env it got). Misbehaviour on demand: FAKE_APIKEY, FAKE_TOOLS,
// FAKE_MCP, FAKE_MEMPATH, FAKE_MODEL, FAKE_READ (an extra path to read), FAKE_WRITE (change a memory file),
// FAKE_ANSWER (the answer instead), FAKE_FAIL (exit with no result), FAKE_IS_ERROR (an error result, exit FAKE_EXIT).
import fs from "node:fs";
import path from "node:path";

const e = process.env;
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1];
const cwd = fs.realpathSync(process.cwd());
const memDir = path.join(e.CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), "memory");
if (e.FAKE_LOG) fs.appendFileSync(e.FAKE_LOG, JSON.stringify({ argv, cwd, env: { ANTHROPIC_API_KEY: e.ANTHROPIC_API_KEY ?? null, CLAUDE_CONFIG_DIR: e.CLAUDE_CONFIG_DIR, ENABLE_CLAUDEAI_MCP_SERVERS: e.ENABLE_CLAUDEAI_MCP_SERVERS } }) + "\n");
if (e.FAKE_FAIL && prompt.includes(e.FAKE_FAIL)) { process.stderr.write("Rate limited.\n"); process.exit(1); }
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out({ type: "system", subtype: "init", cwd, tools: e.FAKE_TOOLS ? e.FAKE_TOOLS.split(",") : ["Glob", "Grep", "Read"], mcp_servers: e.FAKE_MCP ? [{ name: e.FAKE_MCP }] : [], model: e.FAKE_MODEL || "claude-test-1", apiKeySource: e.FAKE_APIKEY || "none", memory_paths: { auto: (e.FAKE_MEMPATH || memDir) + "/" } });
const files = [];
const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, x.name); if (x.isDirectory() && x.name !== ".git") walk(f); else if (x.isFile()) files.push(f); } };
walk(memDir);
const hit = files.find((f) => path.basename(f) !== "MEMORY.md" && prompt.includes(path.basename(f, ".md")));
const reads = [hit, e.FAKE_READ].filter(Boolean);
for (const [i, f] of reads.entries()) out({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: f } }] } });
// FAKE_GLOB: a Glob with this pattern, searched from the project folder. FAKE_GREP_GLOB: a Grep limited by this glob.
if (e.FAKE_GLOB) out({ type: "assistant", message: { content: [{ type: "tool_use", id: "g1", name: "Glob", input: { pattern: e.FAKE_GLOB } }] } });
if (e.FAKE_TOOL_USE) out({ type: "assistant", message: { content: [{ type: "tool_use", id: "x1", name: e.FAKE_TOOL_USE, input: { command: "ls" } }] } });
if (e.FAKE_GREP_GLOB) out({ type: "assistant", message: { content: [{ type: "tool_use", id: "g2", name: "Grep", input: { pattern: "x", glob: e.FAKE_GREP_GLOB } }] } });
if (e.FAKE_WRITE) fs.appendFileSync(path.join(memDir, e.FAKE_WRITE), "\nchanged\n");
const body = hit ? fs.readFileSync(hit, "utf8").replace(/^---[\s\S]*?---\n/, "").trim() : "Nothing in memory covers that.";
if (e.FAKE_IS_ERROR) { out({ type: "result", subtype: "success", is_error: true, result: e.FAKE_IS_ERROR }); process.exit(Number(e.FAKE_EXIT ?? 1)); }
out({ type: "result", subtype: "success", is_error: false, result: e.FAKE_ANSWER ?? `${body} (from ${hit ?? memDir})`, usage: { input_tokens: 10, output_tokens: 5 } });
if (e.FAKE_EXIT) process.exit(Number(e.FAKE_EXIT));
