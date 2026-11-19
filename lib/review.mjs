// The review page: everything a run would change, on one local page, before you approve it.
// Two modes. The file (sleep review) only shows: no scripts, a policy that forbids them. Served (sleep review --serve)
// it is where you decide: pick moves, approve merges, leave Claude notes. Even then the page only records choices and
// asks the local server to run the command line; it never moves a file itself. Every piece of memory text is escaped,
// because memory files can hold anything (code, HTML, pasted output).
import os from "node:os";
import { PANE_CSS, PAGE_MODULE, mapCsp, paneHtml, safeJson, viewSwitch } from "./map.mjs";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const n = (x) => Number(x || 0).toLocaleString("en-US");
const plural = (k, one, many = one + "s") => `${n(k)} ${k === 1 ? one : many}`;
const tilde = (p) => (p && p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : p);
const slug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "x";
const kb = (b) => (b >= 1024 ? `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB` : `${n(b)} B`);
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
// Why a draft starts unticked: a source changed since Claude read it, a source is not headed for Consolidate (merge
// would refuse it), or the fact check found a number, date, version or path missing from the draft.
export function draftWarning(d) {
  if (d.stale?.length) return `${d.stale.join(", ")} changed since Claude read ${d.stale.length === 1 ? "it" : "them"}: redo first`;
  const lost = d.sources.filter((s) => !s.queued && !s.planned).map((s) => s.name);
  if (lost.length) return `${lost.join(", ")} not in Consolidate`;
  if (d.facts?.missing?.length) return `${plural(d.facts.missing.length, "fact")} dropped: check`;
  return "";
}
const preview = (body, lines = 14) => {
  const all = String(body || "").replace(/^\s+/, "").split("\n");
  return all.slice(0, lines).join("\n") + (all.length > lines ? `\n… ${all.length - lines} more lines` : "");
};

// The harness-map palette, so the two tools read as one family.
const CSS = `
:root{color-scheme:dark;--bg:#0d0f14;--panel:#161a22;--panel2:#1b2029;--text:#e6e8ee;--muted:#a3abbd;--faint:#7b8396;--line:#2a3040;
--archive:#c9785a;--queue:#b48ce8;--accent:#f2a65a;--accentInk:#1a1206;--add:#6cc4a1;--addBg:#6cc4a11a;--del:#e8857a;--delBg:#e8857a1a;--chip:#ffffff0d}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f6f5f2;--panel:#fff;--panel2:#faf9f6;--text:#1d1f24;--muted:#5d6472;--faint:#868d9a;--line:#e3e1db;
--archive:#a8573a;--queue:#7b52c4;--accent:#c97a2c;--accentInk:#fff;--add:#1f7a55;--addBg:#1f7a5514;--del:#b23b30;--delBg:#b23b3012;--chip:#0000000a}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
code,.mono,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.wrap{max-width:1180px;margin:0 auto;padding:22px 16px 120px}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px}
.top h1{font-size:18px;font-weight:650;margin:0;letter-spacing:.1px}.top h1 span{color:var(--muted);font-weight:500}
.picker{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;color:var(--muted)}
.picker select{font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text);background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:4px 8px;min-width:0;max-width:100%}
.pill{font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:3px 8px;overflow-wrap:anywhere}
.when{color:var(--faint);margin-left:auto}
.lede{margin:12px 0 16px;color:var(--muted);max-width:780px}.lede b{color:var(--text)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.tile small{display:block;color:var(--muted);font-size:12px}.tile b{font-size:22px;font-weight:650}.tile i{font-style:normal;color:var(--faint);margin-left:4px}
.tile.archive b{color:var(--archive)}.tile.queue b{color:var(--queue)}
.layout{display:grid;grid-template-columns:190px minmax(0,1fr);gap:22px;margin-top:20px}
.rail{position:sticky;top:14px;align-self:start;display:flex;flex-direction:column;gap:2px}
.rail a{display:flex;justify-content:space-between;gap:8px;color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:8px}
.rail a:hover{background:var(--chip);color:var(--text)}.rail a span{color:var(--faint);font-variant-numeric:tabular-nums}
section{scroll-margin-top:14px}section+section{margin-top:30px}
h2{font-size:15px;font-weight:650;margin:0 0 4px;display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}.dot.archive{background:var(--archive)}.dot.queue{background:var(--queue)}.dot.draft{background:var(--accent)}.dot.edit{background:var(--add)}
.note{color:var(--muted);margin:0 0 10px;max-width:780px}.empty{color:var(--faint)}
.list{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.row{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start;border-top:1px solid var(--line)}.row:first-child{border-top:0}
.row>.pick{padding:11px 0 0 12px}.row>details{min-width:0}
.pick input{width:15px;height:15px;accent-color:var(--accent);cursor:pointer;margin:0}
.static .row{grid-template-columns:minmax(0,1fr)}
summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
.row summary{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px;padding:9px 12px}
.row summary:hover{background:var(--chip)}
.name{font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;min-width:0}
.dest{color:var(--faint);font:12px ui-monospace,monospace;overflow-wrap:anywhere;min-width:0}
.meta{color:var(--muted);font-size:12px;margin-left:auto;white-space:nowrap}
.body{padding:0 12px 12px}.why{margin:0 0 6px}.desc{color:var(--muted);margin:0 0 8px}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.45;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;max-height:340px;overflow:auto}
details.group{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin:8px 0;overflow:hidden}
details.group>summary{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:10px 12px}
details.group>summary::before{content:"›";color:var(--faint);display:inline-block;transition:transform .15s}details.group[open]>summary::before{transform:rotate(90deg)}
details.group>.list{border:0;border-top:1px solid var(--line);border-radius:0}
.count{color:var(--faint);font-variant-numeric:tabular-nums}
.btn{font:inherit;font-size:12px;color:var(--text);background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:4px 10px;cursor:pointer}
.row.topic{display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:1px solid var(--line)}.row.topic:first-child{border-top:0}.row.topic .grow{margin-left:auto}
#job{color:var(--queue)}#job.err{color:var(--del)}
.btn:disabled{opacity:.5;cursor:default}
.kept{color:var(--add)}
.btn:hover{border-color:var(--faint)}.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accentInk);font-weight:650}
.btn:disabled{opacity:.5;cursor:default}.grow{margin-left:auto;display:flex;gap:6px}
.draft{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin:10px 0;overflow:hidden}
.draft>header{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;padding:10px 12px;border-bottom:1px solid var(--line)}
.shrink{color:var(--add);font-size:12px}.flag{color:var(--del);font-size:12px;font-weight:600}
.pair{display:grid;grid-template-columns:minmax(0,1fr) 28px minmax(0,1fr);gap:0;padding:12px}
.arrow{display:flex;align-items:center;justify-content:center;color:var(--faint);font-size:16px}
.col h4{margin:0 0 6px;font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.src{margin-bottom:8px}.src summary{font:600 12.5px ui-monospace,monospace;padding:4px 0;overflow-wrap:anywhere}.src summary::before{content:"› ";color:var(--faint)}.src[open] summary::before{content:"⌄ "}
.mine{border-color:var(--accent)}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;padding:0 12px 12px}
textarea{flex:1 1 260px;min-height:38px;font:13px/1.4 ui-sans-serif,system-ui,sans-serif;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;resize:vertical}
.saved{color:var(--add);font-size:12px}.hint{color:var(--muted);font-size:12px;margin:0;padding:0 12px 12px;overflow-wrap:anywhere}
.edit{border-top:1px solid var(--line)}.edit:first-child{border-top:0}.edit .f{padding:6px 12px;color:var(--faint);font:12px ui-monospace,monospace}
.edit .d,.edit .a{padding:3px 12px;font:12px/1.45 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}
.edit .d{background:var(--delBg);color:var(--del)}.edit .a{background:var(--addBg);color:var(--add)}.edit .a:last-child{padding-bottom:8px}
.bar{position:fixed;left:0;right:0;bottom:0;background:color-mix(in srgb,var(--panel) 92%,transparent);backdrop-filter:blur(8px);border-top:1px solid var(--line)}
.bar .in{max-width:1180px;margin:0 auto;padding:10px 16px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px}
.bar b{font-variant-numeric:tabular-nums}.bar small{color:var(--muted)}.bar .grow .btn{font-size:13px;padding:7px 14px}
#status{color:var(--muted)}#status.err{color:var(--del)}
.start{display:grid;grid-template-columns:minmax(0,1fr);background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 14px}
.start h2{font-size:17px}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 12px}.chips span{background:var(--chip);border:1px solid var(--line);border-radius:999px;padding:3px 10px;color:var(--muted)}.chips b{color:var(--text)}
.go{display:flex;flex-wrap:wrap;gap:8px}.go .btn{font-size:13px;padding:7px 14px;text-decoration:none}.start .fine{color:var(--faint);font-size:12px;margin:8px 0 0}
.run{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:0 0 14px}
.rhead{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline}.rhead .left{margin-left:auto;color:var(--muted)}
.track{height:6px;background:var(--chip);border-radius:99px;margin:10px 0 12px;overflow:hidden}.fill{height:100%;background:linear-gradient(90deg,var(--queue),#4ea8de);transition:width .4s}
.stats{display:flex;flex-wrap:wrap;gap:8px 28px;margin-bottom:12px}.stats small{display:block;color:var(--faint);font-size:11.5px}.stats b{font-size:22px}.stats i{font-style:normal;color:var(--muted);margin-left:4px}
.tchips{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px}.tchip{display:flex;gap:8px;align-items:center;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:5px 9px;font:12px ui-monospace,monospace;min-width:0}
.tchip .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.tchip .s{color:var(--faint)}.tchip.done .m{color:var(--add)}.tchip.busy .m{color:var(--accent)}.tchip.fail .m{color:var(--del)}
.totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin:6px 0 8px}
.big{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.big small{display:block;color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.5px}
.big b{font-size:26px;font-weight:700;color:#4ea8de}.big b s{color:var(--faint);font-weight:600}.big b.ok{color:var(--add)}.big b.warn{color:var(--accent)}.big i{display:block;font-style:normal;color:var(--muted);font-size:12px}
.bars{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-bottom:8px}.bars div{display:grid;grid-template-columns:52px minmax(0,1fr) 70px;gap:10px;align-items:center;margin:3px 0}
.bars i{display:block;height:9px;border-radius:99px;background:var(--queue)}.bars div+div i{background:#4ea8de}.bars span{color:var(--muted)}.bars b{font-weight:500;text-align:right}
.trow{display:grid;grid-template-columns:auto minmax(0,1fr);border-top:1px solid var(--line)}.trow:first-child{border-top:0}.trow>.pick{padding:11px 0 0 12px}.trow>details{min-width:0;container-type:inline-size}.static .trow{grid-template-columns:minmax(0,1fr)}
.trow>details>summary{display:grid;grid-template-columns:minmax(0,1fr) 90px 130px 130px;gap:4px 12px;align-items:baseline;padding:9px 12px}.trow>details>summary:hover{background:var(--chip)}
.num{font-variant-numeric:tabular-nums;color:var(--muted)}.badge{font-size:11.5px;color:var(--faint);border:1px solid var(--line);border-radius:99px;padding:1px 8px;justify-self:end}.badge.warn{color:var(--accent);border-color:var(--accent)}
.cards{padding:0 12px 4px}.inc{display:flex;align-items:center;gap:6px;color:var(--muted);margin-left:auto}.inc input{accent-color:var(--accent);width:15px;height:15px}
.checks{color:var(--add);font-size:12.5px;margin:0 0 8px}.change{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin:8px 0;overflow:hidden}
.change>header{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:9px 12px;border-bottom:1px solid var(--line)}.change .why{color:var(--muted)}
.tag{font:600 11px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.5px;padding:2px 8px;border-radius:99px;background:var(--chip)}.tag.graduate{color:var(--queue)}.tag.shorten{color:var(--accent)}
/* The topic table folds by its own width, not the window's: in Split it is narrow on a wide screen. */
@container (max-width:520px){.trow>details>summary{grid-template-columns:minmax(0,1fr) auto}.trow>details>summary .num{grid-column:1}}
@media (max-width:760px){.layout{grid-template-columns:1fr;gap:12px}.rail{position:static;flex-direction:row;overflow-x:auto;gap:6px}
.rail a{border:1px solid var(--line);white-space:nowrap;padding:4px 10px}.meta{margin-left:0;white-space:normal}
.pair{grid-template-columns:1fr}.arrow{transform:rotate(90deg);padding:6px 0}.when{margin-left:0;width:100%}}
`;

const moveMeta = (m) => [m.lastUsed ? `last used ${m.lastUsed}` : "never used on record", m.sessions ? plural(m.sessions, "session") : null, m.created && `created ${m.created}`].filter(Boolean).join(" · ");

function moveRow(m, serve) {
  const pick = serve ? `<label class="pick" title="Move this file"><input type="checkbox" data-pick value="${esc(m.name)}" data-kind="${esc(m.kind)}" checked></label>` : "";
  return `<div class="row" data-node="${esc(m.name)}">${pick}<details><summary><span class="name">${esc(m.from)}</span><span class="dest">→ ${esc(m.to)}</span><span class="meta">${esc(moveMeta(m))}</span></summary>
<div class="body"><p class="why">${esc(m.why)}</p>${m.description ? `<p class="desc">${esc(m.description)}</p>` : ""}<pre>${esc(preview(m.body))}</pre></div></details></div>`;
}

const groupButtons = (id, serve) => (serve ? `<span class="grow"><button class="btn" data-all="1" data-scope="${id}">Move all</button><button class="btn" data-all="0" data-scope="${id}">Keep all</button></span>` : "");

// Served page only: the queued topics Claude can draft from, a batch of up to 10 memories per run.
function waiting(topics) {
  if (!topics.length) return "";
  return `<details class="group" id="pick"><summary><span class="name">Pick topics</span><span class="count">${plural(topics.reduce((a, t) => a + t.count, 0), "memory", "memories")} in ${plural(topics.length, "topic")}</span></summary><div class="list">${topics.map((t) => `<div class="row topic"><span class="name">${esc(t.topic)}</span><span class="count">${n(t.count)}</span><span class="grow"><button class="btn" data-claude-topic="${esc(t.topic)}">Consolidate this topic</button></span></div>`).join("")}</div></details>`;
}

// Tighten MEMORY.md: Claude's checked proposal, read from disk, one tick per change.
function indexPanel(p, serve) {
  const ask = serve ? `<div class="actions" style="padding:0"><textarea data-index-note placeholder="Optional note for Claude, for example: keep the WHO lines"></textarea><button class="btn" data-index>${p ? "Ask Claude again" : "Ask Claude to tighten MEMORY.md"}</button></div>` : "";
  if (!p) return `<p class="note">Every line of MEMORY.md is paid for on every turn. Claude can propose a shorter index: it moves a closed topic's line to a hub MEMORY.md links, or shortens wording, and each change shows why. ${serve ? "The server refuses any change that loses a link." : "Run <code>sleep review --serve</code> to ask."}</p>${ask}`;
  const saved = p.before.bytes - p.after.bytes;
  const tiles = `<div class="totals"><div class="big"><small>Lines</small><b><s>${n(p.before.lines)}</s> → ${n(p.after.lines)}</b><i>limit 200</i></div><div class="big"><small>Size</small><b><s>${kb(p.before.bytes)}</s> → ${kb(p.after.bytes)}</b><i>limit 25 KB</i></div><div class="big"><small>Every turn</small><b class="ok">${saved > 0 ? "−" : ""}${n(Math.round(Math.abs(saved) / 4))} tokens</b><i>about, with every change applied</i></div></div>`;
  const checks = `<p class="checks">✓ every file MEMORY.md links today stays reachable, from it or a hub it links · ✓ under 200 lines and 25 KB, or no bigger · ✓ no em dashes added · ✓ the search-order line untouched</p>`;
  const stale = p.stale ? `<p class="flag" data-index-stale>MEMORY.md changed since Claude read it. Ask Claude again before applying.</p>` : "";
  const card = (c) => `<article class="change"><header><span class="tag ${esc(c.kind)}">${c.kind === "graduate" ? "Graduate to its hub" : "Shorten"}</span><span class="why">${esc(c.reason)}</span>${serve ? `<label class="inc"><input type="checkbox" data-index-pick value="${esc(c.id)}"${p.stale ? " disabled" : " checked"}> apply</label>` : ""}</header>
<div class="edit"><div class="f">MEMORY.md</div><div class="d">− ${esc(c.old)}</div>${c.new ? `<div class="a">+ ${esc(c.new)}</div>` : ""}</div>${c.kind === "graduate" ? `<div class="edit"><div class="f">${esc(c.hub)}, added at the end</div><div class="a">+ ${esc(c.add)}</div></div>` : ""}${c.unprotects?.length ? `<p class="hint" style="padding-top:8px">${c.unprotects.map((x) => `<code>${esc(x)}</code>`).join(", ")} ${c.unprotects.length === 1 ? "loses" : "lose"} MEMORY.md's protection: if unused, sleep may later move ${c.unprotects.length === 1 ? "it" : "them"} to Consolidate or Archive.</p>` : ""}</article>`;
  const refused = p.refused?.length ? `<details class="group"><summary><span class="name">Refused by the checks</span><span class="count">${n(p.refused.length)}</span></summary><div class="list">${p.refused.map((c) => `<div class="edit"><div class="f">${esc(c.why)}</div><div class="d">− ${esc(c.old)}</div></div>`).join("")}</div></details>` : "";
  const apply = serve && p.changes.length ? `<div class="go" style="margin-top:8px"><button class="btn primary" data-index-apply${p.stale ? " disabled" : ""}>Apply ${plural(p.changes.length, "change")}</button><small class="count">One commit to the memory folder; the undo command shows after applying.</small></div>` : "";
  return `${tiles}${checks}${stale}${p.changes.length ? p.changes.map(card).join("") : `<p class="empty">Claude proposed no change that passed the checks.</p>`}${refused}${apply}<div style="margin-top:12px">${ask}</div>`;
}

// Top of the served page: what Consolidate everything would read, and the button that starts it.
function startCard(r, serve) {
  const p = r.pool;
  if (!serve || !p?.batches) return "";
  return `<section class="start" id="start"><div><h2>Consolidate with Claude</h2>
<p class="note">Claude reads the memories headed for Consolidate and merges the ones that say the same thing into fewer, sharper ones. You see every merge before anything changes.</p>
<div class="chips"><span><b>${n(p.memories)}</b> memories</span><span><b>${n(p.topics)}</b> ${p.topics === 1 ? "topic" : "topics"}</span><span><b>${n(p.batches)}</b> ${p.batches === 1 ? "batch" : "batches"} of up to 10, 3 at a time</span><span>runs on your Claude plan</span></div>
<div class="go"><button class="btn primary" data-consolidate>Consolidate everything</button><a class="btn" href="#pick" data-open-pick>Pick topics</a></div>
<p class="fine">Nothing changes until you apply. Claude gets no tools: it only writes drafts.</p></div></section>`;
}

// The payoff: before and after for every draft, then one row per topic to tick. A draft with a warning starts unticked.
function results(drafts, serve) {
  const src = new Map();
  for (const d of drafts) for (const s of d.sources) src.set(s.name, s.bytes || 0);
  const before = src.size, after = drafts.length;
  const bBytes = [...src.values()].reduce((a, x) => a + x, 0), aBytes = drafts.reduce((a, d) => a + d.afterBytes, 0);
  const total = drafts.reduce((a, d) => a + (d.facts?.total || 0), 0), lost = drafts.reduce((a, d) => a + (d.facts?.missing?.length || 0), 0);
  const factsTile = total
    ? `<b class="${lost ? "warn" : "ok"}">${pct(total - lost, total)}%</b><i>${lost ? `${plural(lost, "number, date, version or path", "numbers, dates, versions and paths")} dropped; those drafts start unticked` : "every PR number, date, version and path is in a merged memory"}</i>`
    : `<b class="ok">n/a</b><i>no numbers, dates, versions or paths to check</i>`;
  const topics = new Map();
  for (const d of drafts) { if (!topics.has(d.topic)) topics.set(d.topic, []); topics.get(d.topic).push(d); }
  const rows = [...topics].sort((a, b) => b[1].length - a[1].length).map(([topic, list]) => {
    const names = new Set(list.flatMap((d) => d.sources.map((s) => s.name)));
    const tb = list.flatMap((d) => d.sources).reduce((m, s) => m.set(s.name, s.bytes || 0), new Map());
    const warned = list.filter((d) => draftWarning(d)).length;
    const badge = warned ? `<span class="badge warn">${plural(warned, "draft")} to check</span>` : `<span class="badge">${plural(list.length, "merge")}</span>`;
    const on = list.some((d) => !draftWarning(d));
    return `<div class="trow" data-topic="${esc(topic)}">${serve ? `<label class="pick" title="Include this topic"><input type="checkbox" data-topic-pick${on ? " checked" : ""}></label>` : ""}<details><summary><span class="name">${esc(topic)}</span><span class="num">${n(names.size)} → ${n(list.length)}</span><span class="num">${kb([...tb.values()].reduce((a, x) => a + x, 0))} → ${kb(list.reduce((a, d) => a + d.afterBytes, 0))}</span>${badge}</summary><div class="cards">${list.map((d) => draftCard(d, serve)).join("")}</div></details></div>`;
  }).join("");
  const w = (x) => Math.max(2, pct(x, Math.max(bBytes, aBytes, 1)));
  return `<div class="totals"><div class="big"><small>Memories</small><b><s>${n(before)}</s> → ${n(after)}</b><i>${plural(Math.max(0, before - after), "fewer file", "fewer files")} to search</i></div>
<div class="big"><small>Size</small><b><s>${kb(bBytes)}</s> → ${kb(aBytes)}</b><i>${pct(Math.max(0, bBytes - aBytes), bBytes)}% smaller</i></div>
<div class="big"><small>Facts kept</small>${factsTile}</div></div>
<div class="bars"><div><span>Before</span><i style="width:${w(bBytes)}%"></i><b>${kb(bBytes)}</b></div><div><span>After</span><i style="width:${w(aBytes)}%"></i><b>${kb(aBytes)}</b></div></div>
<div class="list" id="topics">${rows}</div>`;
}

// Consolidate can be hundreds of files: group it by the file that links to each memory (usually a hub).
function queueGroups(queue, serve) {
  const groups = new Map();
  for (const m of queue) {
    const topic = (m.linkedFrom || []).filter((x) => x !== "MEMORY.md").sort()[0] || "unfiled";
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(m);
  }
  return [...groups].sort((a, b) => (a[0] === "unfiled") - (b[0] === "unfiled") || b[1].length - a[1].length)
    .map(([topic, list]) => {
      const id = `q-${slug(topic)}`;
      return `<details class="group" id="${id}"><summary><span class="name">${esc(topic)}</span><span class="count" data-count>${n(list.length)}</span>${groupButtons(id, serve)}</summary><div class="list">${list.map((m) => moveRow(m, serve)).join("")}</div></details>`;
    }).join("");
}

// What the fact check found: it counts PR and issue numbers, dates, versions and paths, not rules or meaning.
function factsBadge(f) {
  if (!f || !f.total) return `<span class="count">no numbers, dates, versions or paths to check</span>`;
  if (!f.missing.length) return `<span class="kept">kept all ${plural(f.total, "number, date, version or path", "numbers, dates, versions and paths")}</span>`;
  return `<span class="flag" data-dropped>dropped ${n(f.missing.length)} of ${n(f.total)}: ${f.missing.slice(0, 6).map(esc).join(", ")}${f.missing.length > 6 ? ", ..." : ""}</span>`;
}

function draftCard(d, serve) {
  const srcs = d.sources.map((s) => `<details class="src" open data-node="${esc(s.name)}"><summary>${esc(s.name)}${s.queued || s.planned ? "" : ` <span class="flag">not in Consolidate</span>`}${s.changed ? ` <span class="flag">changed since Claude read it</span>` : ""}</summary>${s.description ? `<p class="desc">${esc(s.description)}</p>` : ""}${s.body != null ? `<pre>${esc(preview(s.body, 40))}</pre>` : ""}</details>`).join("");
  const warn = draftWarning(d);
  const actions = serve
    ? `<div class="actions"><textarea data-note-text placeholder="Tell Claude what to change, for example: keep the 2026-08 date">${esc(d.note || "")}</textarea><button class="btn" data-note>Save note for Claude</button><button class="btn" data-claude-redo>Redo with Claude</button><label class="inc"><input type="checkbox" data-include value="${esc(d.name)}"${warn ? "" : " checked"}> include</label></div>`
    : `<p class="hint">Approve in <code>/sleep</code>, or run <code>sleep merged --into ${esc(d.name)} ${d.sources.map((s) => esc(s.name)).join(" ")}</code></p>`;
  return `<article class="draft" data-draft="${esc(d.name)}" data-node="${esc(d.name)}"><header><span class="name">${esc(d.name)}</span><span class="count">from ${plural(d.sources.length, "memory", "memories")}</span><span class="shrink">${n(d.beforeBytes)} → ${n(d.afterBytes)} bytes</span>${factsBadge(d.facts)}${d.stale?.length ? `<span class="flag" data-stale>${esc(warn)}</span>` : ""}${d.note ? (d.noteOpen ? `<span class="saved">note for Claude saved</span>` : `<span class="count">redone after your note</span>`) : ""}</header>
<div class="pair"><div class="col"><h4>Sources</h4>${srcs || `<p class="empty">No sources named.</p>`}</div><div class="arrow">→</div><div class="col"><h4>Merged draft</h4>${d.description ? `<p class="desc">${esc(d.description)}</p>` : ""}<pre class="mine">${esc(d.body)}</pre></div></div>${actions}</article>`;
}

function linkEdits(edits) {
  const byFile = new Map();
  for (const e of edits) { if (!byFile.has(e.file)) byFile.set(e.file, []); byFile.get(e.file).push(e); }
  return [...byFile].sort((a, b) => b[1].length - a[1].length).map(([file, list]) => `<details class="group"><summary><span class="name">${esc(file)}</span><span class="count">${plural(list.length, "line")}</span></summary><div class="list">${list.map((e) => `<div class="edit"><div class="f">line ${e.line}</div><div class="d">− ${esc(e.before)}</div><div class="a">+ ${esc(e.after)}</div></div>`).join("")}</div></details>`).join("");
}

// What the served page runs. It reads its choices from the page and posts them to the local server with the key;
// the server checks every name against its own plan, so the page cannot ask for anything the plan did not offer.
const SCRIPT = (token, project) => `(() => {
const T = ${JSON.stringify(token)}, P = ${JSON.stringify(project)};
const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
const picks = $$("input[data-pick]"), incs = $$("input[data-include]"), status = $("#status"), apply = $("#apply");
const fmt = (k, one, many) => k.toLocaleString("en-US") + " " + (k === 1 ? one : many);
function update() {
  for (const row of $$("[data-topic]")) { const t = $("[data-topic-pick]", row); if (t) t.checked = $$("input[data-include]", row).some((x) => x.checked); }
  if (!apply) return;
  const on = picks.filter((p) => p.checked).length, m = incs.filter((p) => p.checked).length;
  $("#sel").textContent = fmt(on, "move", "moves") + " and " + fmt(m, "merge", "merges") + " selected";
  apply.disabled = !on && !m;
  apply.textContent = on || m ? "Apply " + [on ? fmt(on, "move", "moves") : "", m ? fmt(m, "merge", "merges") : ""].filter(Boolean).join(" and ") : "Nothing selected";
  for (const g of $$("details.group[id]")) { const all = $$("input[data-pick]", g), c = all.filter((p) => p.checked).length; const el = $("[data-count]", g); if (el) el.textContent = c === all.length ? String(all.length) : c + " of " + all.length; }
}
// A change takes two clicks: the first arms the button and says what will happen, the second does it.
function armed(btn, text) {
  if (btn.dataset.armed) { delete btn.dataset.armed; if (btn !== apply) btn.textContent = btn.dataset.label; return true; }
  btn.dataset.armed = "1"; btn.dataset.label = btn.dataset.label || btn.textContent; btn.textContent = "Click again to confirm"; say(text);
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; if (btn === apply) update(); say(""); } }, 5000);
  return false;
}
function say(text, bad) { status.textContent = text; status.className = bad ? "err" : ""; }
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Sleep-Token": T }, body: JSON.stringify({ ...body, project: P }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
document.addEventListener("change", (e) => {
  if (e.target.matches("[data-pick], [data-include]")) update();
  if (e.target.matches("[data-topic-pick]")) { $$("input[data-include]", e.target.closest("[data-topic]")).forEach((x) => (x.checked = e.target.checked)); update(); }
  if (e.target.matches("[data-project]")) location.href = "/?project=" + encodeURIComponent(e.target.value);
});
document.addEventListener("click", async (e) => {
  const all = e.target.closest("[data-all]");
  if (all) { e.preventDefault(); $$("input[data-pick]", document.getElementById(all.dataset.scope)).forEach((p) => (p.checked = all.dataset.all === "1")); update(); return; }
  const card = e.target.closest("[data-draft]");
  if (card && e.target.closest("[data-note]")) {
    try { await post("/note", { draft: card.dataset.draft, note: $("[data-note-text]", card).value }); say("Note saved. Redo with Claude to apply it."); } catch (err) { say(err.message, true); }
    return;
  }
  const ix = e.target.closest("[data-index], [data-index-apply]");
  if (ix) {
    if (ix.matches("[data-index]")) {
      if (!armed(ix, "Runs Claude Code in the background on your plan, with no tools: it reads MEMORY.md, the names, descriptions and use of the files it links, and its hubs, then proposes changes here. Nothing changes until you apply.")) return;
      try { const nt = $("[data-index-note]"); await post("/index", { note: nt ? nt.value : "" }); say(""); watch(); } catch (err) { say(err.message, true); }
      return;
    }
    const ids = $$("input[data-index-pick]").filter((x) => x.checked).map((x) => x.value);
    if (!ids.length) { say("Pick at least one change.", true); return; }
    if (!armed(ix, "Changes " + ids.length + " line(s) in MEMORY.md and its hubs, in one commit. Undo last step takes it back.")) return;
    ix.disabled = true;
    try { const j = await post("/index-apply", { ids }); say(j.message); ix.textContent = "Applied"; $$("input[data-index-pick]").forEach((x) => (x.disabled = true)); } catch (err) { say(err.message, true); ix.disabled = false; }
    return;
  }
  if (e.target.closest("[data-open-pick]")) { const g = $("#pick"); if (g) g.open = true; return; }
  const un = e.target.closest("[data-undo]");
  if (un) {
    if (!armed(un, "Takes back the last step: " + un.dataset.undoLabel + ". Its files, links and sleep's records go back as they were.")) return;
    un.disabled = true;
    try { say((await post("/undo", {})).message); setTimeout(() => location.reload(), 1500); } catch (err) { say(err.message, true); un.disabled = false; }
    return;
  }
  if (e.target.closest("[data-stop]")) { try { say((await post("/stop-job", {})).message); } catch (err) { say(err.message, true); } return; }
  const claude = e.target.closest("[data-claude-topic], [data-claude-redo], [data-consolidate]");
  if (claude) {
    const topic = claude.dataset.claudeTopic, redo = card && claude.matches("[data-claude-redo]") ? card.dataset.draft : null;
    const what = redo ? redo + ", its sources and your note" : topic ? "every memory headed for Consolidate in " + topic + ", up to 10 at a time" : "every memory headed for Consolidate, up to 10 at a time, 3 batches at once";
    if (!armed(claude, "Runs Claude Code in the background on your plan, with no tools: it reads " + what + " and writes drafts here. Nothing merges until you apply.")) return;
    try {
      if (redo) { await post("/note", { draft: redo, note: $("[data-note-text]", card).value }); await post("/draft", { redo }); }
      else await post("/consolidate", topic ? { topics: [topic] } : {});
      say(""); watch();
    } catch (err) { say(err.message, true); }
  }
});
if (apply) apply.addEventListener("click", async () => {
  const moves = picks.filter((p) => p.checked).map((p) => p.value), drafts = incs.filter((p) => p.checked).map((p) => p.value);
  if ((!moves.length && !drafts.length) || !armed(apply, "Moves " + moves.length + " file(s), then merges " + drafts.length + " draft(s): each merge archives its sources and points their links at it, in its own commit. The undo commands show when it is done.")) return;
  apply.disabled = true; say("Applying...");
  try { await post("/apply-all", { moves, drafts }); watch(); } catch (err) { say(err.message, true); apply.disabled = false; }
});
// The live panel for Consolidate everything: built from the job's numbers with DOM calls, never from HTML strings.
function el(tag, cls, text) { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }
function stat(label, value, unit) { const d = el("div"); d.append(el("small", null, label), el("b", null, value.toLocaleString("en-US")), el("i", null, unit)); return d; }
function runPanel(j) {
  const box = $("#run"), p = j.progress; if (!box || !p) return;
  box.hidden = false; box.replaceChildren();
  const head = el("div", "rhead"), mins = (Date.now() - Date.parse(j.started)) / 60000;
  head.append(el("b", null, "Claude is consolidating · " + p.done + " of " + p.total + " batches"));
  const left = el("span", "left", p.done ? (() => { const m = Math.round((mins / p.done) * (p.total - p.done)); return m < 1 ? "under a minute left · " : "about " + m + " min left · "; })() : "started · ");
  const stop = el("button", "btn", "Stop"); stop.dataset.stop = "1"; left.append(stop); head.append(left);
  const track = el("div", "track"), fill = el("div", "fill"); fill.style.width = (p.total ? (100 * p.done) / p.total : 0) + "%"; track.append(fill);
  const stats = el("div", "stats");
  stats.append(stat("Read so far", p.read, "memories"), stat("Became", p.became, "merged memories"));
  if (p.failed) stats.append(stat("Failed", p.failed, p.failed === 1 ? "batch" : "batches"));
  const chips = el("div", "tchips"), list = Object.entries(p.topics || {});
  for (const [t, s] of list.slice(0, 11)) {
    const done = s.done === s.batches, c = el("div", "tchip " + (s.failed ? "fail" : done ? "done" : s.running ? "busy" : ""));
    c.append(el("span", "m", s.failed ? "!" : done ? "✓" : s.running ? "●" : "○"), el("span", "t", t), el("span", "s", done ? s.memories + " → " + s.became : s.running ? "batch " + (s.done + 1) + " of " + s.batches : String(s.memories)));
    chips.append(c);
  }
  if (list.length > 11) chips.append(el("div", "tchip", "+ " + (list.length - 11) + " more topics"));
  box.append(head, track, stats, chips);
}
// While Claude drafts, the bar shows it and the Claude buttons wait; when it ends, the page reloads with the drafts.
let watching = false;
async function watch() {
  if (watching) return; watching = true;
  const box = $("#job");
  for (;;) {
    let j; try { j = (await post("/job", {})).job; } catch { break; }
    const busy = j && j.state === "running";
    $$("[data-claude-topic], [data-claude-redo], [data-consolidate], [data-index]").forEach((b) => (b.disabled = busy));
    if (apply && busy) apply.disabled = true;
    if (!j) break;
    box.hidden = false;
    if (busy) {
      if (j.kind === "consolidate") { runPanel(j); const st = $("#start"); if (st) st.hidden = true; box.textContent = "You can close this tab; it keeps going."; }
      else box.textContent = (j.kind === "apply" ? "Applying " : j.kind === "index" ? "Claude is reading " : "Claude is drafting ") + j.label + ", started " + Math.max(0, Math.round((Date.now() - Date.parse(j.started)) / 1000)) + "s ago.";
      await new Promise((ok) => setTimeout(ok, 1500)); continue;
    }
    const run = $("#run"); if (run) run.hidden = true;
    box.textContent = j.message; box.className = j.state === "failed" ? "err" : "";
    let seen = null; try { seen = sessionStorage.getItem("sleepJob"); } catch {}
    // Reload once per finished job (done, stopped or failed), so drafts already written show; without storage, never
    // reload on our own (it would loop).
    if (seen !== j.started) { try { sessionStorage.setItem("sleepJob", j.started); setTimeout(() => location.reload(), 1200); } catch {} }
    break;
  }
  watching = false;
}
update();
watch();
})();`;

// The served page with more than one project gets a picker in place of the path. Each option is a key the server
// listed itself; choosing one reloads the page for that project.
export function pickerHtml(r, serve) {
  const list = serve?.projects || [];
  if (list.length < 2) return `<span class="pill">${esc(tilde(r.memDir))}</span>`;
  const opts = list.map((p) => `<option value="${esc(p.key)}"${p.key === serve.project ? " selected" : ""}>${esc(p.path ? tilde(p.path) : p.key)} · ${n(p.files)} files</option>`).join("");
  return `<label class="picker"><span>Project</span><select data-project aria-label="Project">${opts}</select></label>`;
}

// r: what would change. serve: { nonce, token, project, projects } when the page is served, absent for the file.
export function reviewHtml(r, serve = null) {
  const archive = r.moves.filter((m) => m.kind === "archive"), queue = r.moves.filter((m) => m.kind === "consolidate");
  const nonce = serve && String(serve.nonce).replace(/[^A-Za-z0-9+/=_-]/g, "");
  const csp = serve ? mapCsp(nonce, true) : "default-src 'none'; style-src 'unsafe-inline'";
  const railMoves = [["moves-archive", "Archive", archive.length], ["moves-queue", "Consolidate", queue.length]], railDrafts = [["drafts", "Merge drafts", r.drafts.length]];
  const rail = [...(r.drafts.length ? [...railDrafts, ...railMoves] : [...railMoves, ...railDrafts]), ["links", "Link edits", r.edits.length], ["index", "MEMORY.md", (r.hint.add ? 1 : 0) + (r.indexProposal?.changes.length || 0)]];
  const lede = serve
    ? `<b>Nothing here has happened yet.</b> Untick anything you want to keep, then apply. Every step is committed to the memory folder's own git history, and <b>Undo last step</b> (or <code>sleep undo</code>) takes back a whole Apply: files, links and sleep's records.`
    : `<b>Nothing here has happened yet.</b> This file only shows. To choose moves one by one and approve merges here, run <code>sleep review --serve</code>. To apply everything: <code>sleep archive --apply</code>.`;
  const secArchive = `<section id="moves-archive"><h2><span class="dot archive"></span>Archive</h2>
<p class="note">Retained, but not typically accessed. Project memories nobody used in ${n(r.days)} days move to <code>memory-archive/</code>, which Claude searches only when nothing else turns up.</p>
${archive.length ? `<div class="list" id="archive-list">${archive.map((m) => moveRow(m, serve)).join("")}</div>${serve ? `<p class="note" style="margin-top:6px">${groupButtons("archive-list", serve)}</p>` : ""}` : `<p class="empty">Nothing to archive. ${esc(r.candidatesNote || "")}</p>`}
${r.purged.length && !serve ? `<p class="note">Also deleted, past the purge window and unread since archiving: ${r.purged.map((p) => `<code>${esc(p)}</code>`).join(", ")}</p>` : ""}
</section>`;
  const secQueue = `<section id="moves-queue"><h2><span class="dot queue"></span>Consolidate</h2>
<p class="note">To be merged. Feedback memories nobody used in ${n(r.days)} days move to <code>consolidate/</code>, where Claude still finds them, until they are merged into fewer, sharper memories. Never deleted. Grouped by the file that links to them.</p>
${queue.length ? queueGroups(queue, serve) : `<p class="empty">Nothing new to queue.${r.queued ? ` ${plural(r.queued, "memory already waits", "memories already wait")} in <code>consolidate/</code>.` : ""}</p>`}
</section>`;
  const secDrafts = `<section id="drafts"><h2><span class="dot draft"></span>Merge drafts</h2>
<p class="note">Claude's proposed merges by topic, each beside the memories it replaces. ${serve ? "Untick anything you do not want, or leave a note and redo it with Claude. Apply merges the ticked ones." : ""}</p>
${r.drafts.length ? results(r.drafts, serve) : `<p class="empty">No drafts. ${r.queued ? `${plural(r.queued, "memory waits", "memories wait")} in Consolidate; <code>/sleep consolidate</code> drafts merges one topic at a time.` : ""}</p>`}
${serve ? waiting(r.topics || []) : ""}
</section>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Sleep: memory review</title><style>${CSS}${serve ? PANE_CSS : ""}</style></head><body class="${serve ? "served" : "static"}"><div class="wrap">
<header class="top"><h1>Sleep <span>memory review</span></h1>${pickerHtml(r, serve)}${serve ? viewSwitch() : ""}<span class="when">${esc(r.generatedAt.slice(0, 16).replace("T", " "))} · ${n(r.usage.coverageDays)} days of usage on record</span></header>
<p class="lede">${lede}</p>
${serve ? `<section class="run" id="run" hidden></section>` : ""}${startCard(r, serve)}
<div class="tiles">
<div class="tile"><small>Keep</small><b>${n(r.keep)}</b><i>read as usual</i></div>
<div class="tile archive"><small>To Archive</small><b>${n(archive.length)}</b><i>retained, not typically accessed</i></div>
<div class="tile queue"><small>To Consolidate</small><b>${n(queue.length)}</b><i>to be merged</i></div>
<div class="tile"><small>Link edits</small><b>${n(r.edits.length)}</b></div>
</div>
<div class="layout"><nav class="rail">${rail.map(([id, label, k]) => `<a href="#${id}">${label}<span>${n(k)}</span></a>`).join("")}</nav><main>

${(r.drafts.length ? [secDrafts, secArchive, secQueue] : [secArchive, secQueue, secDrafts]).join("\n\n")}

<section id="links"><h2><span class="dot edit"></span>Link edits</h2>
<p class="note">Links to a moved file are rewritten, never deleted; the rest of each line stays.${serve ? " Only the moves you apply change links." : ""}</p>
${r.edits.length ? linkEdits(r.edits) : `<p class="empty">No links change.</p>`}
</section>

<section id="index"><h2>MEMORY.md</h2>
${r.hint.add ? `<p class="note">Applying moves adds one line after the first, so the agent knows where moved memories went:</p><div class="list"><div class="edit"><div class="a">+ ${esc(r.hint.line)}</div></div></div>` : ""}
<h2 style="margin-top:14px">Tighten MEMORY.md <span class="count">loaded on every turn</span></h2>
${indexPanel(r.indexProposal || null, serve)}
</section>
</main></div></div>
${serve ? `<div class="bar"><div class="in">${r.moves.length || r.drafts.length ? `<span id="sel">${plural(r.moves.length, "move")} selected</span><small>Committed step by step; one Apply undoes as one step.</small>` : `<small>Nothing to apply.</small>`}<span id="status" role="status"></span><span id="job" role="status" hidden></span>${r.undo || r.moves.length || r.drafts.length ? `<span class="grow">${r.undo ? `<button class="btn" data-undo data-undo-label="${esc(r.undo.label)}" title="Last step: ${esc(r.undo.label)}">Undo last step</button> ` : ""}${r.moves.length || r.drafts.length ? `<button id="apply" class="btn primary">Apply</button>` : ""}</span>` : ""}</div></div>
<script nonce="${nonce}">${SCRIPT(serve.token, serve.project ?? null)}</script>
${serve.graph ? `${paneHtml()}
<script type="application/json" id="graph">${safeJson(serve.graph)}</script>
<script type="module" nonce="${nonce}">${PAGE_MODULE}</script>` : ""}` : ""}
</body></html>
`;
}
