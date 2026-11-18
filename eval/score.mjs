#!/usr/bin/env node
// Scores the eval's answers.
//
//   node eval/score.mjs bundle --dir out/eval
//       Writes judge/bundle.md for blind judging: every answer to a probe with a judge line, shuffled, under an opaque
//       id, with every path or name that could say which arm it came from replaced. judge/key.json maps ids back.
//       Judges write judge/verdicts.json: { "<id>": { "pass": true|false, "note": "..." } }.
//   node eval/score.mjs report --dir out/eval [--base A] [--test C] [--moves C=<sleep state>/moves.json]
//       Mechanical checks, then verdicts, then the four bars from the plan, for --test against --base.
//
// A probe's group comes from where its source file sits in the test arm (kept, graduated, queued, merged, archived),
// read from the arm's folder and sleep's moves.json, never from a hand label. Rules and destructive warnings are
// their own group wherever their file went.
// Plan: docs/plans/2026-11-17-eval.md.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CRITICAL, keyOf, loadProbes, manifestFile, parseFlags, readJSON, runFile, writeJSON } from "./lib.mjs";
import { tok } from "../lib/memory.mjs";

const judgeDir = (dir) => path.join(dir, "judge");

function load(dir) {
  const probes = loadProbes(dir);
  const state = readJSON(manifestFile(dir), null);
  if (!state) throw new Error(`No arms.json in ${dir}: nothing has run.`);
  const runs = [];
  for (const a of state.arms) for (const p of probes) for (let rep = 1; ; rep++) {
    const r = readJSON(runFile(dir, a.label, p.id, rep), null);
    if (!r) break;
    runs.push(r);
  }
  return { probes, state, runs };
}

// Everything that names an arm or where its copy lives: config and work folders, each arm's folders, ids and keys,
// and the sleep folder a file sat in.
function scrubber(state) {
  const subs = [[state.config, "<config>"], [state.work, "<work>"]];
  for (const a of state.arms) subs.push([a.memDir, "<memory>"], [a.cwd, "<work>"], [keyOf(a.cwd), "<project>"], [a.id, "<arm>"], [a.source, "<memory>"]);
  subs.sort((x, y) => y[0].length - x[0].length);
  // Which folder inside the copy a file sat in says where sleep put it, so it would tell the judge the arm too.
  // Claude quotes it in any form ("memory/memory-archive/x.md", "the memory-archive folder"), so it goes everywhere.
  const scrub = (s) => subs.reduce((t, [from, to]) => t.split(from).join(to), s).replace(/memory-archive[\\/]?|consolidate[\\/]/gi, "");
  return scrub;
}

function bundle(dir) {
  const { probes, state, runs } = load(dir);
  const j = judgeDir(dir);
  if (fs.existsSync(path.join(j, "verdicts.json"))) throw new Error("judge/verdicts.json exists: the bundle it judged stays as it is.");
  const byId = new Map(probes.map((p) => [p.id, p]));
  const scrub = scrubber(state);
  const items = runs.filter((r) => r.status === "ok" && byId.get(r.probe).judge).map((r) => ({ id: crypto.randomBytes(4).toString("hex"), r }));
  for (let i = items.length - 1; i > 0; i--) { const k = crypto.randomInt(i + 1); [items[i], items[k]] = [items[k], items[i]]; }
  const rubric = (() => { try { return fs.readFileSync(path.join(dir, "rubric.md"), "utf8").trim(); } catch { return ""; } })();
  const md = [
    "# Judge bundle", "",
    "Each item is one answer to a task. Judge it only against its pass line. You do not know, and should not guess, which setup produced it.",
    "Some answers say a memory was archived or where it was found. That is not part of any pass line: ignore it.",
    "Write judge/verdicts.json as { \"<id>\": { \"pass\": true or false, \"note\": \"one sentence\" } } for every item.", "",
    ...(rubric ? ["## Rubric", "", rubric, ""] : []),
    ...items.flatMap(({ id, r }) => { const p = byId.get(r.probe); return [`## Item ${id}`, "", `Task: ${scrub(p.prompt)}`, "", `Pass when: ${scrub(p.judge)}`, "", "Answer:", "", "~~~~", scrub(r.answer), "~~~~", ""]; }),
  ].join("\n");
  fs.mkdirSync(j, { recursive: true });
  fs.writeFileSync(path.join(j, "bundle.md"), md);
  writeJSON(path.join(j, "key.json"), Object.fromEntries(items.map(({ id, r }) => [id, { arm: r.arm, probe: r.probe, rep: r.rep }])));
  console.log(`${items.length} item(s) in ${path.join(j, "bundle.md")}`);
}

const linked = (index, file) => index.includes(`(${file})`) || index.includes(`[[${file.slice(0, -3)}]]`) || index.includes(`[[${file.slice(0, -3)}|`);
const indexOf = (arm) => { try { return fs.readFileSync(path.join(arm.source, "MEMORY.md"), "utf8"); } catch { return ""; } };

// Where a probe's source file sits in an arm, against the base arm.
export function placement(arm, base, file, moves) {
  if (!file) return "none";
  if (fs.existsSync(path.join(arm.source, file))) return linked(indexOf(base), file) && !linked(indexOf(arm), file) ? "graduated" : "kept";
  if (fs.existsSync(path.join(arm.source, "consolidate", file))) return "queued";
  const m = moves.filter((x) => x.name === file && x.status !== "restored").at(-1);
  if (m?.kind === "merged") return "merged";
  if (fs.existsSync(path.join(arm.source, "memory-archive", file))) return "archived";
  return "missing";
}

function verdictOf(dir) {
  const key = readJSON(path.join(judgeDir(dir), "key.json"), {}), v = readJSON(path.join(judgeDir(dir), "verdicts.json"), {});
  const out = new Map();
  for (const [id, k] of Object.entries(key)) if (v[id] && typeof v[id].pass === "boolean") out.set(`${k.arm}/${k.probe}/${k.rep}`, v[id].pass);
  return out;
}

// One answer: "pass", "fail", "pending" (a judge line with no verdict yet), or its status when not ok.
export function outcome(r, p, verdicts) {
  if (r.status !== "ok") return r.status;
  for (const re of p.must || []) if (!new RegExp(re, "u").test(r.answer)) return "fail";
  for (const re of p.mustNot || []) if (new RegExp(re, "u").test(r.answer)) return "fail";
  if (!p.judge) return "pass";
  const v = verdicts.get(`${r.arm}/${r.probe}/${r.rep}`);
  return v == null ? "pending" : v ? "pass" : "fail";
}

// The four bars from the plan. "Worse" for a probe is fewer passing repeats: 3 of 3 to 2 of 3 is worse.
export function bars({ probes, tally, groupOf, base, test, indexTokens }) {
  const passes = (arm, id) => tally[arm]?.[id]?.pass ?? 0;
  const out = [];
  const critical = probes.filter((p) => CRITICAL.has(p.kind));
  const worse = critical.filter((p) => passes(test, p.id) < passes(base, p.id)).map((p) => p.id);
  out.push({ bar: 1, name: "No rule or destructive warning does worse", ok: !worse.length, detail: worse.length ? `worse: ${worse.join(", ")}` : `${critical.length} probe(s) held` });
  const groups = {};
  for (const p of probes.filter((p) => !CRITICAL.has(p.kind))) (groups[groupOf(p)] ||= []).push(p);
  const slack = (g) => (g === "archived" ? 2 : 1);
  const lost = Object.entries(groups).filter(([g, ps]) => ps.reduce((s, p) => s + passes(test, p.id), 0) < ps.reduce((s, p) => s + passes(base, p.id), 0) - slack(g)).map(([g]) => g);
  out.push({ bar: 2, name: "Each group within 1 pass (archived: 2)", ok: !lost.length, detail: lost.length ? `below: ${lost.join(", ")}` : Object.keys(groups).join(", ") || "no groups" });
  const merged = groups.merged || [];
  const dropped = merged.filter((p) => passes(test, p.id) < passes(base, p.id)).map((p) => p.id);
  out.push({ bar: 3, name: "No fact lost in a merge", ok: !dropped.length, detail: dropped.length ? `lost: ${dropped.join(", ")}` : `${merged.length} merged probe(s)` });
  // Every tool call counts, not only Reads: Claude often finds a memory with a content Grep, and searching the
  // project in vain for a file sleep moved is cost too.
  const perPass = (arm) => { const t = Object.values(tally[arm] || {}); const p = t.reduce((s, x) => s + x.pass, 0); return p ? t.reduce((s, x) => s + x.calls, 0) / p : Infinity; };
  const callsOk = perPass(test) <= perPass(base), indexOk = indexTokens[test] < indexTokens[base];
  out.push({ bar: 4, name: "Tool calls per pass do not rise; MEMORY.md tokens fall", ok: callsOk && indexOk, detail: `tool calls per pass ${perPass(base).toFixed(2)} to ${perPass(test).toFixed(2)}; MEMORY.md ${indexTokens[base]} to ${indexTokens[test]} tokens` });
  return out;
}

function report(dir, flags) {
  const { probes, state, runs } = load(dir);
  const labels = state.arms.map((a) => a.label);
  const base = flags.base || labels[0], test = flags.test || labels.at(-1);
  for (const l of [base, test]) if (!labels.includes(l)) throw new Error(`No arm ${l}; arms are ${labels.join(", ")}`);
  const arm = (l) => state.arms.find((a) => a.label === l);
  const moves = {};
  for (const m of flags.moves) { const [l, f] = m.split(/=(.*)/); moves[l] = readJSON(f, null) ?? (() => { throw new Error(`Cannot read moves ${f}`); })(); }
  const verdicts = verdictOf(dir);
  const byId = new Map(probes.map((p) => [p.id, p]));
  const tally = {}, counts = {};
  for (const r of runs) {
    const o = outcome(r, byId.get(r.probe), verdicts);
    const t = ((tally[r.arm] ||= {})[r.probe] ||= { pass: 0, calls: 0, n: 0 });
    t.n++; t.calls += r.tools.length; if (o === "pass") t.pass++;
    ((counts[r.arm] ||= {})[o] = (counts[r.arm][o] || 0) + 1);
  }
  const groupOf = (p) => (CRITICAL.has(p.kind) ? p.kind : p.kind === "negative" ? "negative" : placement(arm(test), arm(base), p.source, moves[test] || []));
  const indexTokens = Object.fromEntries(state.arms.map((a) => [a.label, tok(indexOf(a).length)]));
  const result = bars({ probes, tally, groupOf, base, test, indexTokens });
  const blocked = [...new Set([base, test])].flatMap((l) => ["pending", "void", "invalid"].filter((k) => counts[l]?.[k]).map((k) => `${counts[l][k]} ${k} on ${l}`));
  const verdict = blocked.length ? "UNDECIDED" : result.every((b) => b.ok) ? "PASS" : "FAIL";
  const rows = probes.map((p) => `| ${p.id} | ${groupOf(p)} | ${labels.map((l) => `${tally[l]?.[p.id]?.pass ?? 0}/${tally[l]?.[p.id]?.n ?? 0}`).join(" | ")} |`);
  const md = [
    `# Eval report: ${test} against ${base}`, "", `Verdict: **${verdict}**${blocked.length ? ` (${blocked.join("; ")})` : ""}. Model: ${state.model ?? "unknown"}.`, "",
    "| Bar | Holds | Detail |", "|---|---|---|", ...result.map((b) => `| ${b.bar}. ${b.name} | ${b.ok ? "yes" : "no"} | ${b.detail} |`), "",
    `| Probe | Group in ${test} | ${labels.join(" | ")} |`, `|---|---|${labels.map(() => "---").join("|")}|`, ...rows, "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "report.md"), md);
  writeJSON(path.join(dir, "report.json"), { verdict, blocked, base, test, model: state.model, bars: result, tally, counts });
  console.log(md);
}

const [cmd, ...rest] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const flags = parseFlags(rest);
    const dir = path.resolve(flags.dir || "out/eval");
    if (cmd === "bundle") bundle(dir);
    else if (cmd === "report") report(dir, flags);
    else throw new Error("Usage: node eval/score.mjs bundle|report --dir <eval folder> ...");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
