// The review page: everything a run would change, on one local page, before you approve it.
// It is inert by design. No scripts, a content security policy that forbids them, and every piece of memory text
// escaped, because memory files can hold anything (code, HTML, pasted output).
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const n = (x) => Number(x || 0).toLocaleString("en-US");
const preview = (body, lines = 14) => {
  const all = String(body || "").replace(/^\s+/, "").split("\n");
  return all.slice(0, lines).join("\n") + (all.length > lines ? `\n… ${all.length - lines} more lines` : "");
};

const CSS = `
:root{--bg:#fbfaf7;--card:#fff;--ink:#1d1d1b;--mute:#6b6a65;--line:#e7e4dc;--add:#e7f5ea;--addInk:#17602b;--del:#fbeaea;--delInk:#8a1f1f;--accent:#5b4bc4;--warn:#9a5b00}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1c1c1a;--ink:#ecebe6;--mute:#9b9a94;--line:#2f2e2b;--add:#13301b;--addInk:#8fd6a0;--del:#3a1717;--delInk:#f0a3a3;--accent:#a99cf2;--warn:#e0a84a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1080px;margin:0 auto;padding:28px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 10px}
.sub{color:var(--mute);margin:0 0 20px;overflow-wrap:anywhere}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card b{display:block;font-size:22px}.card span{color:var(--mute);font-size:13px}
.note{color:var(--mute);font-size:14px;margin:6px 0 12px}details{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:8px 0}
summary{cursor:pointer;padding:10px 14px;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline}summary::marker{color:var(--mute)}
.name{overflow-wrap:anywhere;min-width:0;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px}.to{overflow-wrap:anywhere;min-width:0;color:var(--mute);font-family:ui-monospace,monospace;font-size:13px}
.tag{font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);color:var(--mute)}.tag.archive{color:var(--warn);border-color:var(--warn)}.tag.consolidate{color:var(--accent);border-color:var(--accent)}
.body{padding:0 14px 14px}.why{margin:0 0 8px}pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px}
.edit{border:1px solid var(--line);border-radius:8px;overflow:hidden;margin:8px 0;background:var(--card)}.edit .f{padding:6px 10px;color:var(--mute);font:12.5px ui-monospace,monospace;border-bottom:1px solid var(--line)}
.edit .d,.edit .a{padding:6px 10px;font:12.5px/1.45 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}.edit .d{background:var(--del);color:var(--delInk)}.edit .a{background:var(--add);color:var(--addInk)}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:760px){.pair{grid-template-columns:1fr}}
nav{display:flex;flex-wrap:wrap;gap:6px 16px;margin:14px 0 4px}nav a{color:var(--accent);text-decoration:none;font-size:14px}nav a:hover{text-decoration:underline}
details.group>.body{padding-top:4px}.src h4{margin:10px 0 4px;font:600 13px ui-monospace,monospace}.bad{color:var(--delInk);font-weight:600}.empty{color:var(--mute)}
`;

function moveItem(m) {
  return `<details><summary><span class="name">${esc(m.from)}</span><span class="to">→ ${esc(m.to)}</span><span class="tag ${esc(m.kind)}">${m.kind === "archive" ? "archive" : "merge queue"}</span><span class="tag">${esc(m.type || "no type")}</span></summary>
<div class="body"><p class="why">${esc(m.why)} Created ${esc(m.created)}; used in ${n(m.sessions)} session(s) on record.</p>
${m.description ? `<p class="note">${esc(m.description)}</p>` : ""}<pre>${esc(preview(m.body))}</pre></div></details>`;
}

function draftItem(d) {
  const srcs = d.sources.map((s) => `<div class="src"><h4>${esc(s.name)}${s.queued ? "" : ` <span class="bad">not in the merge queue</span>`}</h4>${s.description ? `<p class="note">${esc(s.description)}</p>` : ""}${s.body != null ? `<pre>${esc(preview(s.body, 40))}</pre>` : ""}</div>`).join("");
  return `<details open><summary><span class="name">${esc(d.name)}</span><span class="tag consolidate">draft from ${n(d.sources.length)} memories</span><span class="to">${n(d.beforeBytes)} → ${n(d.afterBytes)} bytes</span></summary>
<div class="body"><div class="pair"><div><h4 class="name">Draft</h4>${d.description ? `<p class="note">${esc(d.description)}</p>` : ""}<pre>${esc(d.body)}</pre></div><div>${srcs}</div></div></div></details>`;
}

// The merge queue can be hundreds of files: group it by the file that links to each memory (usually a hub).
function queueGroups(queue) {
  const groups = new Map();
  for (const m of queue) {
    const topic = (m.linkedFrom || []).filter((x) => x !== "MEMORY.md").sort()[0] || "unfiled";
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(m);
  }
  return [...groups].sort((a, b) => (a[0] === "unfiled") - (b[0] === "unfiled") || b[1].length - a[1].length)
    .map(([topic, list]) => `<details class="group"><summary><span class="name">${esc(topic)}</span><span class="tag consolidate">${n(list.length)} to the merge queue</span></summary><div class="body">${list.map(moveItem).join("")}</div></details>`).join("");
}

export function reviewHtml(r) {
  const archive = r.moves.filter((m) => m.kind === "archive"), queue = r.moves.filter((m) => m.kind === "consolidate");
  const byFile = new Map();
  for (const e of r.edits) { if (!byFile.has(e.file)) byFile.set(e.file, []); byFile.get(e.file).push(e); }
  const edits = [...byFile].map(([file, list]) => list.map((e) => `<div class="edit"><div class="f">${esc(file)}, line ${e.line}</div><div class="d">− ${esc(e.before)}</div><div class="a">+ ${esc(e.after)}</div></div>`).join("")).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Memory review</title><style>${CSS}</style></head><body><main>
<h1>Memory review</h1>
<p class="sub">${esc(r.generatedAt.slice(0, 16).replace("T", " "))} · ${esc(r.memDir)}</p>
<div class="cards">
<div class="card"><b>${n(archive.length)}</b><span>to the archive</span></div>
<div class="card"><b>${n(queue.length)}</b><span>to the merge queue</span></div>
<div class="card"><b>${n(r.edits.length)}</b><span>link edits</span></div>
<div class="card"><b>${n(r.drafts.length)}</b><span>merge drafts</span></div>
<div class="card"><b>${n(r.usage.coverageDays)} days</b><span>of usage on record</span></div>
</div>
<nav><a href="#moves">Moves</a><a href="#links">Link edits</a><a href="#index">MEMORY.md</a><a href="#drafts">Merge drafts</a></nav>
<p class="note">Nothing here has happened yet. ${r.moves.length ? "Approve the moves with <code>sleep archive --apply</code> or in <code>/sleep</code>. " : ""}${r.drafts.length ? "Approve a draft in <code>/sleep</code>, or with <code>sleep merged --into &lt;draft&gt; &lt;sources&gt;</code>." : ""}</p>

<h2 id="moves">Moves</h2>
${r.moves.length ? `<p class="note">Project memories nobody used in ${n(r.days)} days go to the archive. Feedback memories nobody used go to the merge queue, grouped below by the file that links to them; they are never archived or deleted.</p>${archive.map(moveItem).join("")}${queueGroups(queue)}` : `<p class="empty">Nothing would move. ${esc(r.candidatesNote || "")}</p>`}
${r.purged.length ? `<h2>Purge</h2><p class="note">Archived files nothing has read since they were archived, past the purge window: ${r.purged.map((p) => `<code>${esc(p)}</code>`).join(", ")}</p>` : ""}

<h2 id="links">Link edits</h2>
<p class="note">Links to a moved file are rewritten, not deleted. Only the link changes; the rest of each line stays.</p>
${edits || `<p class="empty">No links change.</p>`}

<h2 id="index">MEMORY.md</h2>
${r.hint.add ? `<p class="note">One line is added after the first line, so the agent knows where moved memories went:</p><div class="edit"><div class="a">+ ${esc(r.hint.line)}</div></div>` : `<p class="empty">No change${r.hint.present ? "; the search-order line is already there" : ""}.</p>`}

<h2 id="drafts">Merge drafts</h2>
${r.drafts.length ? r.drafts.map(draftItem).join("") : `<p class="empty">No drafts. ${r.queued ? `${n(r.queued)} memories wait in the merge queue; <code>/sleep consolidate</code> drafts merges for one topic at a time.` : ""}</p>`}
</main></body></html>
`;
}
