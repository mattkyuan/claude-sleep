// The review page: everything a run would change, on one local page, before you approve it.
// Two modes. The file (sleep review) only shows: no scripts, a policy that forbids them. Served (sleep review --serve)
// it is where you decide: pick moves, approve merges, leave Claude notes. Even then the page only records choices and
// asks the local server to run the command line; it never moves a file itself. Every piece of memory text is escaped,
// because memory files can hold anything (code, HTML, pasted output).
import os from "node:os";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const n = (x) => Number(x || 0).toLocaleString("en-US");
const plural = (k, one, many = one + "s") => `${n(k)} ${k === 1 ? one : many}`;
const tilde = (p) => (p && p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : p);
const slug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "x";
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
@media (max-width:760px){.layout{grid-template-columns:1fr;gap:12px}.rail{position:static;flex-direction:row;overflow-x:auto;gap:6px}
.rail a{border:1px solid var(--line);white-space:nowrap;padding:4px 10px}.meta{margin-left:0;white-space:normal}
.pair{grid-template-columns:1fr}.arrow{transform:rotate(90deg);padding:6px 0}.when{margin-left:0;width:100%}}
`;

const moveMeta = (m) => [m.lastUsed ? `last used ${m.lastUsed}` : "never used on record", m.sessions ? plural(m.sessions, "session") : null, m.created && `created ${m.created}`].filter(Boolean).join(" · ");

function moveRow(m, serve) {
  const pick = serve ? `<label class="pick" title="Move this file"><input type="checkbox" data-pick value="${esc(m.name)}" data-kind="${esc(m.kind)}" checked></label>` : "";
  return `<div class="row">${pick}<details><summary><span class="name">${esc(m.from)}</span><span class="dest">→ ${esc(m.to)}</span><span class="meta">${esc(moveMeta(m))}</span></summary>
<div class="body"><p class="why">${esc(m.why)}</p>${m.description ? `<p class="desc">${esc(m.description)}</p>` : ""}<pre>${esc(preview(m.body))}</pre></div></details></div>`;
}

const groupButtons = (id, serve) => (serve ? `<span class="grow"><button class="btn" data-all="1" data-scope="${id}">Move all</button><button class="btn" data-all="0" data-scope="${id}">Keep all</button></span>` : "");

// Served page only: the queued topics Claude can draft from, a batch of up to 10 memories per run.
function waiting(topics) {
  if (!topics.length) return "";
  return `<details class="group" open><summary><span class="name">In Consolidate</span><span class="count">${plural(topics.reduce((a, t) => a + t.count, 0), "memory", "memories")} in ${plural(topics.length, "topic")}</span></summary><div class="list">${topics.map((t) => `<div class="row topic"><span class="name">${esc(t.topic)}</span><span class="count">${n(t.count)}</span><span class="grow"><button class="btn" data-claude-topic="${esc(t.topic)}">Draft with Claude</button></span></div>`).join("")}</div></details>`;
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

function draftCard(d, serve) {
  const srcs = d.sources.map((s) => `<details class="src" open><summary>${esc(s.name)}${s.queued ? "" : ` <span class="flag">not in Consolidate</span>`}</summary>${s.description ? `<p class="desc">${esc(s.description)}</p>` : ""}${s.body != null ? `<pre>${esc(preview(s.body, 40))}</pre>` : ""}</details>`).join("");
  const ready = d.sources.length > 0 && d.sources.every((s) => s.queued);
  const actions = serve
    ? `<div class="actions"><textarea data-note-text placeholder="Tell Claude what to change, for example: keep the 2026-08 date">${esc(d.note || "")}</textarea><button class="btn" data-note>Save note for Claude</button><button class="btn" data-claude-redo>Redo with Claude</button><button class="btn primary" data-merge ${ready ? "" : "disabled"}>Approve and merge</button></div>`
    : `<p class="hint">Approve in <code>/sleep</code>, or run <code>sleep merged --into ${esc(d.name)} ${d.sources.map((s) => esc(s.name)).join(" ")}</code></p>`;
  return `<article class="draft" data-draft="${esc(d.name)}"><header><span class="name">${esc(d.name)}</span><span class="count">from ${plural(d.sources.length, "memory", "memories")}</span><span class="shrink">${n(d.beforeBytes)} → ${n(d.afterBytes)} bytes</span>${d.note ? (d.noteOpen ? `<span class="saved">note for Claude saved</span>` : `<span class="count">redone after your note</span>`) : ""}</header>
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
const picks = $$("input[data-pick]"), status = $("#status"), apply = $("#apply");
function update() {
  if (!apply) return;
  const on = picks.filter((p) => p.checked).length;
  $("#picked").textContent = on.toLocaleString("en-US");
  apply.disabled = !on;
  apply.textContent = on ? "Apply " + on.toLocaleString("en-US") + (on === 1 ? " move" : " moves") : "Nothing selected";
  for (const g of $$("details.group[id]")) { const all = $$("input[data-pick]", g), c = all.filter((p) => p.checked).length; const el = $("[data-count]", g); if (el) el.textContent = c === all.length ? String(all.length) : c + " of " + all.length; }
}
// A change takes two clicks: the first arms the button and says what will happen, the second does it.
function armed(btn, text) {
  if (btn.dataset.armed) { delete btn.dataset.armed; return true; }
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
  if (e.target.matches("[data-pick]")) update();
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
  const claude = e.target.closest("[data-claude-topic], [data-claude-redo]");
  if (claude) {
    const topic = claude.dataset.claudeTopic, redo = card && claude.matches("[data-claude-redo]") ? card.dataset.draft : null;
    if (!armed(claude, "Runs Claude Code in the background on your plan, with no tools: it reads " + (redo ? redo + ", its sources and your note" : "up to 10 queued memories from " + topic) + " and writes drafts here. Nothing merges until you approve.")) return;
    try {
      if (redo) await post("/note", { draft: redo, note: $("[data-note-text]", card).value });
      await post("/draft", redo ? { redo } : { topic }); say(""); watch();
    } catch (err) { say(err.message, true); }
    return;
  }
  if (card && e.target.closest("[data-merge]")) {
    const btn = e.target.closest("[data-merge]");
    if (!armed(btn, "Merging " + card.dataset.draft + " archives its sources and points their links at it. Undo with git revert.")) return;
    btn.disabled = true;
    try { const j = await post("/merge", { draft: card.dataset.draft }); say(j.message); setTimeout(() => location.reload(), 900); } catch (err) { say(err.message, true); btn.disabled = false; }
  }
});
if (apply) apply.addEventListener("click", async () => {
  const names = picks.filter((p) => p.checked).map((p) => p.value);
  if (!names.length || !armed(apply, "Moving " + names.length + " file(s): links follow them, and the memory folder is committed before and after. Undo with sleep restore --all.")) return;
  apply.disabled = true; say("Moving...");
  try { const j = await post("/apply", { moves: names }); say(j.message); setTimeout(() => location.reload(), 900); } catch (err) { say(err.message, true); apply.disabled = false; }
});
// While Claude drafts, the bar shows it and the Claude buttons wait; when it ends, the page reloads with the drafts.
let watching = false;
async function watch() {
  if (watching) return; watching = true;
  const box = $("#job");
  for (;;) {
    let j; try { j = (await post("/job", {})).job; } catch { break; }
    const busy = j && j.state === "running";
    $$("[data-claude-topic], [data-claude-redo]").forEach((b) => (b.disabled = busy));
    if (!j) break;
    box.hidden = false;
    if (busy) { box.textContent = "Claude is drafting " + j.label + ", started " + Math.max(0, Math.round((Date.now() - Date.parse(j.started)) / 1000)) + "s ago."; await new Promise((ok) => setTimeout(ok, 2000)); continue; }
    box.textContent = j.message; box.className = j.state === "failed" ? "err" : "";
    let seen = null; try { seen = sessionStorage.getItem("sleepJob"); } catch {}
    // Reload once per finished job; without storage, never reload on our own (it would loop).
    if (j.state === "done" && seen !== j.started) { try { sessionStorage.setItem("sleepJob", j.started); setTimeout(() => location.reload(), 1200); } catch {} }
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
  const csp = serve ? `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'` : "default-src 'none'; style-src 'unsafe-inline'";
  const rail = [["moves-archive", "Archive", archive.length], ["moves-queue", "Consolidate", queue.length], ["drafts", "Merge drafts", r.drafts.length], ["links", "Link edits", r.edits.length], ["index", "MEMORY.md", r.hint.add ? 1 : 0]];
  const lede = serve
    ? `<b>Nothing here has happened yet.</b> Untick anything you want to keep, then apply. Every run is committed to the memory folder's own git history; <code>sleep restore --all</code> undoes it.`
    : `<b>Nothing here has happened yet.</b> This file only shows. To choose moves one by one and approve merges here, run <code>sleep review --serve</code>. To apply everything: <code>sleep archive --apply</code>.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Sleep: memory review</title><style>${CSS}</style></head><body class="${serve ? "served" : "static"}"><div class="wrap">
<header class="top"><h1>Sleep <span>memory review</span></h1>${pickerHtml(r, serve)}${serve ? `<a class="btn" href="/map?project=${encodeURIComponent(serve.project || "")}">3D map</a>` : ""}<span class="when">${esc(r.generatedAt.slice(0, 16).replace("T", " "))} · ${n(r.usage.coverageDays)} days of usage on record</span></header>
<p class="lede">${lede}</p>
<div class="tiles">
<div class="tile archive"><small>To Archive</small><b>${n(archive.length)}</b><i>retained, not typically accessed</i></div>
<div class="tile queue"><small>To Consolidate</small><b>${n(queue.length)}</b><i>to be merged</i></div>
<div class="tile"><small>Merge drafts</small><b>${n(r.drafts.length)}</b></div>
<div class="tile"><small>Link edits</small><b>${n(r.edits.length)}</b></div>
</div>
<div class="layout"><nav class="rail">${rail.map(([id, label, k]) => `<a href="#${id}">${label}<span>${n(k)}</span></a>`).join("")}</nav><main>

<section id="moves-archive"><h2><span class="dot archive"></span>Archive</h2>
<p class="note">Retained, but not typically accessed. Project memories nobody used in ${n(r.days)} days move to <code>memory-archive/</code>, which Claude searches only when nothing else turns up.</p>
${archive.length ? `<div class="list" id="archive-list">${archive.map((m) => moveRow(m, serve)).join("")}</div>${serve ? `<p class="note" style="margin-top:6px">${groupButtons("archive-list", serve)}</p>` : ""}` : `<p class="empty">Nothing to archive. ${esc(r.candidatesNote || "")}</p>`}
${r.purged.length && !serve ? `<p class="note">Also deleted, past the purge window and unread since archiving: ${r.purged.map((p) => `<code>${esc(p)}</code>`).join(", ")}</p>` : ""}
</section>

<section id="moves-queue"><h2><span class="dot queue"></span>Consolidate</h2>
<p class="note">To be merged. Feedback memories nobody used in ${n(r.days)} days move to <code>consolidate/</code>, where Claude still finds them, until they are merged into fewer, sharper memories. Never deleted. Grouped by the file that links to them.</p>
${queue.length ? queueGroups(queue, serve) : `<p class="empty">Nothing new to queue.${r.queued ? ` ${plural(r.queued, "memory already waits", "memories already wait")} in <code>consolidate/</code>.` : ""}</p>`}
</section>

<section id="drafts"><h2><span class="dot draft"></span>Merge drafts</h2>
<p class="note">Claude's proposed merges, each beside the memories it replaces. ${serve ? "Approve one to merge it, or leave a note and redo it with Claude." : ""}</p>
${r.drafts.length ? r.drafts.map((d) => draftCard(d, serve)).join("") : `<p class="empty">No drafts. ${r.queued ? `${plural(r.queued, "memory waits", "memories wait")} in Consolidate; <code>/sleep consolidate</code> drafts merges one topic at a time.` : ""}</p>`}
${serve ? waiting(r.topics || []) : ""}
</section>

<section id="links"><h2><span class="dot edit"></span>Link edits</h2>
<p class="note">Links to a moved file are rewritten, never deleted; the rest of each line stays.${serve ? " Only the moves you apply change links." : ""}</p>
${r.edits.length ? linkEdits(r.edits) : `<p class="empty">No links change.</p>`}
</section>

<section id="index"><h2>MEMORY.md</h2>
${r.hint.add ? `<p class="note">One line is added after the first, so the agent knows where moved memories went:</p><div class="list"><div class="edit"><div class="a">+ ${esc(r.hint.line)}</div></div></div>` : `<p class="empty">No change${r.hint.present ? "; the search-order line is already there" : ""}.</p>`}
</section>
</main></div></div>
${serve ? `<div class="bar"><div class="in">${r.moves.length ? `<span><b id="picked">${n(r.moves.length)}</b> of ${n(r.moves.length)} moves selected</span><small>Committed before and after. Undo: <code>sleep restore --all</code></small>` : `<small>No moves planned.</small>`}<span id="status" role="status"></span><span id="job" role="status" hidden></span>${r.moves.length ? `<span class="grow"><button id="apply" class="btn primary">Apply</button></span>` : ""}</div></div>
<script nonce="${nonce}">${SCRIPT(serve.token, serve.project ?? null)}</script>` : ""}
</body></html>
`;
}
