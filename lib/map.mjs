// The memory map: a 3D view of the memory folder, sister to harness-map's. Floors are where a file lives, from
// MEMORY.md at the top (loaded every turn), then Keep, Consolidate and Archive. Four steps: the folder now, the planned
// moves, Claude's drafts beside the files they replace, and the folder once it is all applied. Served only, from 127.0.0.1: the 3D
// library is the vendored copy in vendor/graph3d.mjs, and the page loads nothing from anywhere else.
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// JSON inside a <script> block: escape anything that could close it or start markup.
const safeJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

// The header carries frame-ancestors; a <meta> policy cannot, so the page copy leaves it out.
export const mapCsp = (nonce, meta = false) => `default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'${meta ? "" : "; frame-ancestors 'none'"}`;

const CSS = `
:root{color-scheme:dark;--bg:#0d0f14;--panel:#161a22e6;--text:#e6e8ee;--muted:#a3abbd;--faint:#7b8396;--line:#2a3040;--chip:#ffffff0d;--accent:#f2a65a;--accentInk:#1a1206}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:13px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
#scene{position:fixed;inset:0}
.top{position:fixed;top:12px;left:16px;right:16px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;pointer-events:none}
.top>*{pointer-events:auto}
h1{font-size:17px;font-weight:650;margin:0}h1 span{color:var(--muted);font-weight:500}
a.btn,.seg button,select{font:inherit;font-size:12px;color:var(--text);background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:4px 10px;text-decoration:none;cursor:pointer}
select{font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace;max-width:min(60vw,360px)}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}.seg button{border:0;border-radius:0;background:transparent}
.seg button[aria-pressed="true"]{background:var(--accent);color:var(--accentInk);font-weight:650}
.panel{position:fixed;left:16px;bottom:16px;max-width:min(420px,calc(100vw - 32px));background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.panel h2{font-size:12px;font-weight:650;margin:0 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px}.legend span{display:inline-flex;align-items:center;gap:6px;color:var(--muted)}
.legend i{width:9px;height:9px;border-radius:50%;display:inline-block}
table{border-collapse:collapse;font-variant-numeric:tabular-nums;margin-top:6px}td{padding:1px 10px 1px 0}td.n{text-align:right;color:var(--faint)}td.n.on{color:var(--text);font-weight:650}
.say{margin:0;color:var(--muted)}
.tip{font:12px/1.45 ui-sans-serif,system-ui,sans-serif;max-width:300px;white-space:normal}.tip b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (max-width:640px){.panel{bottom:8px;left:8px;right:8px;max-width:none}.top{left:8px;right:8px}}
`;

const SCRIPT = (token, project) => `
import { ForceGraph3D, THREE } from "/vendor/graph3d.mjs";
const G = JSON.parse(document.getElementById("graph").textContent);
const P = ${JSON.stringify(project)};
const FLOORS = ["index", "memory", "queue", "archive"];
const FLOOR_Y = { index: 160, memory: 55, queue: -55, archive: -160 };
const FLOOR_NAME = { index: "MEMORY.md", memory: "Keep", queue: "Consolidate", archive: "Archive" };
// Okabe-Ito based, as in harness-map's compare colors; archive and queue keep sleep's own colors.
const COLOR = { stays: "#5d6577", archive: "#c9785a", queue: "#b48ce8", merged: "#b48ce8", new: "#56b4e9", held: "#e69f00", gone: "#3a4150" };
const STATUS = { stays: "stays in Keep", archive: "moves to Archive", queue: "moves to Consolidate", merged: "merges into ", new: "a merged memory Claude drafted", held: "a draft that starts unticked: check it on the review page" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n = (x) => Number(x || 0).toLocaleString("en-US");
const byId = new Map(G.nodes.map((d) => [d.id, d]));
const drafts = G.nodes.filter((d) => d.status === "new" || d.status === "held");
const topics = [...new Set(G.nodes.filter((d) => d.topic).map((d) => d.topic))];
const tIndex = new Map(topics.map((t, i) => [t, i]));
const q = new URLSearchParams(location.search);
let step = Math.min(3, Math.max(0, Number(q.get("step")) || 0));
const floorOf = (d, s = step) => d.at[s];
const count = (s) => { const c = { memory: 0, queue: 0, archive: 0 }; for (const d of G.nodes) { const f = d.at[s]; if (f && f !== "index") c[f]++; } return c; };
const radius = (f, s = step) => 18 + 6 * Math.sqrt(Math.max(1, count(s)[f] || 1));
// Topic centres spread over the whole floor (a sunflower pattern), so many topics still read as separate clusters.
const cluster = (t) => { const i = tIndex.get(t), a = i * 2.39996, r = radius("queue", 2) * 0.88 * Math.sqrt((i + 0.5) / Math.max(1, topics.length)); return [Math.cos(a) * r, Math.sin(a) * r]; };

// Each node is pulled to its floor's height and kept inside its floor's disc; while Claude drafts, each topic gathers.
function floors(alpha) {
  for (const d of G.nodes) {
    const f = floorOf(d) ?? "queue";
    const clustered = step === 2 && d.topic && f === "queue";
    d.vy += (FLOOR_Y[f] - d.y) * alpha * (clustered ? 2.5 : 0.7);
    if (clustered) {
      const [cx, cz] = cluster(d.topic), k = d.sources ? 1.4 : 1;
      d.vx += (cx - d.x) * alpha * k; d.vz += (cz - d.z) * alpha * k;
    } else {
      const R = radius(f), r = Math.hypot(d.x || 0, d.z || 0) || 1;
      if (r > R) { const k = ((r - R) / r) * alpha * 0.6; d.vx -= d.x * k; d.vz -= d.z * k; }
    }
  }
}
const end = (x) => (typeof x === "object" ? x : byId.get(x));
// A merge line shows only while Claude drafts; a file link shows when both ends are on a floor and neither is archived
// by the merge.
const linkOn = (l) => l.kind === "merge" ? step === 2 : step !== 2 && [l.source, l.target].every((x) => { const d = end(x); return d && floorOf(d) != null && !(step === 3 && d.status === "merged"); });
const color = (d) => (d.id === "MEMORY.md" ? "#f2a65a" : step === 3 && d.status === "merged" ? COLOR.gone : step === 0 && d.at[0] !== "archive" && (d.status === "archive" || d.status === "queue" || d.status === "merged") ? COLOR[d.status === "merged" ? "queue" : d.status] : COLOR[d.status] || COLOR.stays);
const el = document.getElementById("scene");
const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#0d0f14";
const graph = ForceGraph3D({ controlType: "orbit" })(el)
  .backgroundColor(bg).showNavInfo(false)
  .graphData(G)
  .nodeId("id").nodeRelSize(1.7).nodeVal((d) => (d.id === "MEMORY.md" ? 160 : d.sources ? 4 + Math.sqrt(d.bytes || 0) / 6 : 1 + Math.sqrt(d.bytes || 0) / 10)).nodeColor(color).nodeOpacity(0.92).nodeResolution(10)
  .nodeVisibility((d) => floorOf(d) != null).linkVisibility(linkOn)
  .linkColor((l) => (l.kind === "merge" ? COLOR.new : "#8a93a8")).linkOpacity(0.22).linkWidth((l) => (l.kind === "merge" ? 0.6 : 0))
  .nodeLabel((d) => '<div class="tip"><b>' + esc(d.id) + "</b><br>" + (d.description ? esc(d.description) + "<br>" : "") +
    esc(d.status === "merged" ? STATUS.merged + d.into : d.sources ? STATUS[d.status] + ", from " + d.sources.length + " memories" : STATUS[d.status] || "") + " · " + n(d.bytes) + " bytes</div>")
  .warmupTicks(q.has("still") ? 400 : 40).cooldownTicks(260);
graph.d3Force("center", null);
graph.d3Force("charge").strength(-12);
// Fresh functions each time: the graph ignores a setter given the function it already holds, and a hidden link
// must not pull.
const linkPull = () => graph.d3Force("link").distance(26).strength((l) => (linkOn(l) ? (l.kind === "merge" ? 0.25 : 0.03) : 0));
linkPull();
graph.d3Force("floors", floors);
graph.cameraPosition({ x: 0, y: 170, z: Math.max(600, 900 * 700 / Math.max(innerWidth, 400)) }, { x: 0, y: -10, z: 0 });

function label(text) {
  const c = document.createElement("canvas"), g = c.getContext("2d"), fs = 30;
  g.font = "600 " + fs + "px ui-sans-serif, system-ui, sans-serif";
  c.width = Math.ceil(g.measureText(text).width) + 16; c.height = fs + 16;
  g.font = "600 " + fs + "px ui-sans-serif, system-ui, sans-serif"; g.fillStyle = "#a3abbd"; g.textBaseline = "middle"; g.fillText(text, 8, c.height / 2);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  sp.scale.set(c.width / 4, c.height / 4, 1);
  return sp;
}
const plates = {};
function drawFloors() {
  const scene = graph.scene(), c = count(step);
  for (const f of FLOORS) {
    if (plates[f]) scene.remove(plates[f]);
    const grp = new THREE.Group(), R = f === "index" ? 14 : radius(f);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 64), new THREE.MeshBasicMaterial({ color: 0x8a93a8, transparent: true, opacity: f === "index" || c[f] ? 0.06 : 0.025, side: THREE.DoubleSide, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2;
    const rim = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 96 }, (_, i) => new THREE.Vector3(Math.cos((i / 96) * 2 * Math.PI) * R, 0, Math.sin((i / 96) * 2 * Math.PI) * R))), new THREE.LineBasicMaterial({ color: 0x2a3040 }));
    const sign = label(f === "index" ? FLOOR_NAME[f] : FLOOR_NAME[f] + " · " + n(c[f]));
    sign.position.set(R + sign.scale.x / 2 + 6, 0, 0);
    grp.add(disc, rim, sign);
    grp.position.y = FLOOR_Y[f];
    scene.add(grp); plates[f] = grp;
  }
}

// What each step says, from this folder's own numbers.
const plan = { archive: G.nodes.filter((d) => d.status === "archive").length, queue: G.nodes.filter((d) => d.at[1] === "queue" && d.at[0] !== "queue").length };
const ok = drafts.filter((d) => d.status === "new"), held = drafts.length - ok.length, merged = G.nodes.filter((d) => d.status === "merged").length;
const TEXT = [
  ["Now", "Your memory as it is: " + n(count(0).memory) + " files in Keep. Coloured ones are planned to move: purple to Consolidate, orange to Archive."],
  ["Planned moves", n(plan.queue) + " unused feedback memories drop to Consolidate, still searchable. " + n(plan.archive) + " unused project notes go to Archive: retained, not typically accessed. MEMORY.md and what it links to stay."],
  ["Claude consolidates", drafts.length ? "Each cluster is a topic; each blue sphere is a merged memory Claude drafted, joined to the files it replaces. " + n(drafts.length) + " drafts" + (held ? ", " + n(held) + " flagged to check (yellow)" : "") + ". Nothing has changed on disk." : "No drafts yet. Run Consolidate with Claude on the review page, then come back."],
  ["Applied", ok.length ? n(ok.length) + " merged memories rise to Keep; the " + n(merged) + " files they replace sink to Archive, links rewritten. " + (held ? n(held) + " flagged drafts are left out, as on the review page. " : "") + "Each merge is its own commit; the review page shows the undo commands after applying." : "With no drafts ticked, applying moves files only."],
];
function summary() {
  const c = [0, 1, 2, 3].map(count);
  document.getElementById("counts").innerHTML = "<tr><td></td>" + ["Now", "Moves", "Drafts", "Applied"].map((h, i) => '<td class="n' + (i === step ? " on" : "") + '">' + h + "</td>").join("") + "</tr>" +
    ["memory", "queue", "archive"].map((f) => "<tr><td>" + esc(FLOOR_NAME[f]) + "</td>" + c.map((x, i) => '<td class="n' + (i === step ? " on" : "") + '">' + n(x[f]) + "</td>").join("") + "</tr>").join("");
}
function setStep(sv) {
  step = sv;
  for (const b of document.querySelectorAll("[data-s]")) b.setAttribute("aria-pressed", String(+b.dataset.s === sv));
  document.getElementById("t").textContent = sv + 1 + " · " + TEXT[sv][0];
  document.getElementById("d").textContent = TEXT[sv][1];
  graph.nodeColor((d) => color(d)).nodeVisibility((d) => floorOf(d) != null).linkVisibility((l) => linkOn(l));
  linkPull();
  summary(); drawFloors(); graph.d3ReheatSimulation();
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-s]"); if (b) { stopPlay(); setStep(+b.dataset.s); } });
let timer = null;
const play = document.getElementById("play");
function stopPlay() { if (timer) { clearInterval(timer); timer = null; play.textContent = "▶ Play"; } }
play.addEventListener("click", (e) => {
  e.preventDefault();
  if (timer) return stopPlay();
  setStep(0); play.textContent = "■ Stop";
  timer = setInterval(() => { if (step >= 3) return stopPlay(); setStep(step + 1); }, 4500);
});
document.addEventListener("change", (e) => { if (e.target.matches("[data-project]")) location.href = "/map?project=" + encodeURIComponent(e.target.value); });
addEventListener("resize", () => graph.width(innerWidth).height(innerHeight));
setStep(step);
`;

// g: memoryGraph(). serve: { nonce, token, project, projects }. pickerHtml: the project picker from the review page.
export function mapHtml(g, { nonce, token, project, pickerHtml, memDir }) {
  const safeNonce = String(nonce).replace(/[^A-Za-z0-9+/=_-]/g, "");
  const back = `/${project ? `?project=${encodeURIComponent(project)}` : ""}`;
  const legend = [["stays", "Keep: read as usual"], ["queue", "Consolidate: to be merged"], ["archive", "Archive: retained, not typically accessed"], ["new", "merged memory Claude drafted"], ["held", "draft flagged to check"]]
    .map(([k, t]) => `<span><i style="background:${{ stays: "#5d6577", archive: "#c9785a", queue: "#b48ce8", new: "#56b4e9", held: "#e69f00" }[k]}"></i>${t}</span>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${mapCsp(safeNonce, true)}">
<title>Sleep: memory map</title><style>${CSS}</style></head><body>
<div id="scene" role="img" aria-label="3D map of the memory folder ${esc(memDir)}"></div>
<header class="top"><h1>Sleep <span>memory map</span></h1>${pickerHtml}
<span class="seg" role="group" aria-label="Step"><button data-s="0" aria-pressed="true">1 Now</button><button data-s="1">2 Planned moves</button><button data-s="2">3 Claude consolidates</button><button data-s="3">4 Applied</button></span><a class="btn" id="play" href="#" role="button">▶ Play</a>
<a class="btn" href="${esc(back)}">Back to the review</a></header>
<div class="panel"><h2 id="t">1 · Now</h2><p id="d" class="say"></p><table id="counts"></table><div class="legend">${legend}</div>
<div class="legend"><span>Nothing moves until you apply it on the review page. Drag to turn, scroll to zoom.</span></div></div>
<script type="application/json" id="graph">${safeJson(g)}</script>
<script type="module" nonce="${safeNonce}">${SCRIPT(token, project ?? null)}</script>
</body></html>
`;
}
