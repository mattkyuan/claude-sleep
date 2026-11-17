// The memory map: a 3D view of the memory folder, sister to harness-map's. Floors are where a file lives, from
// MEMORY.md at the top (loaded every turn), then Keep, Consolidate and Archive. Before shows the folder now; After shows it once the
// plan and the merge drafts are applied, and the files move between floors. Served only, from 127.0.0.1: the 3D
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
table{border-collapse:collapse;font-variant-numeric:tabular-nums}td{padding:1px 10px 1px 0}td.n{text-align:right}td.d{color:var(--muted)}
.tip{font:12px/1.45 ui-sans-serif,system-ui,sans-serif;max-width:300px;white-space:normal}.tip b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (max-width:640px){.panel{bottom:8px;left:8px;right:8px;max-width:none}.top{left:8px;right:8px}}
`;

const SCRIPT = (token, project) => `
import { ForceGraph3D, THREE } from "/vendor/graph3d.mjs";
const G = JSON.parse(document.getElementById("graph").textContent);
const P = ${JSON.stringify(project)};
const FLOORS = ["index", "memory", "queue", "archive"];
const FLOOR_Y = { index: 160, memory: 55, queue: -55, archive: -160 };
const FLOOR_NAME = { index: "MEMORY.md, every turn", memory: "Keep", queue: "Consolidate", archive: "Archive" };
// Okabe-Ito based, as in harness-map's compare colors; archive and queue keep sleep's own colors.
const COLOR = { stays: "#5d6577", archive: "#c9785a", queue: "#b48ce8", merged: "#56b4e9", new: "#cc79a7" };
const STATUS = { stays: "stays in Keep", archive: "moves to Archive", queue: "moves to Consolidate", merged: "merges into ", new: "new merged memory" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n = (x) => Number(x || 0).toLocaleString("en-US");
let mode = "before";
const floorOf = (d) => d[mode];
const count = (m) => Object.fromEntries(FLOORS.map((f) => [f, G.nodes.filter((d) => d[m] === f).length]));
const radius = (f) => 18 + 6 * Math.sqrt(Math.max(1, count(mode)[f]));

// Each node is pulled to its floor's height and kept inside its floor's disc.
function floors(alpha) {
  for (const d of G.nodes) {
    const f = floorOf(d) ?? d.after, R = radius(f), r = Math.hypot(d.x || 0, d.z || 0) || 1;
    d.vy += (FLOOR_Y[f] - d.y) * alpha * 0.6;
    if (r > R) { const k = ((r - R) / r) * alpha * 0.6; d.vx -= d.x * k; d.vz -= d.z * k; }
  }
}
const el = document.getElementById("scene");
const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#0d0f14";
const color = (d) => (d.id === "MEMORY.md" ? "#f2a65a" : COLOR[d.status] || COLOR.stays);
const graph = ForceGraph3D({ controlType: "orbit" })(el)
  .backgroundColor(bg).showNavInfo(false)
  .graphData(G)
  .nodeId("id").nodeRelSize(1.7).nodeVal((d) => (d.id === "MEMORY.md" ? 160 : 1 + Math.sqrt(d.bytes || 0) / 10)).nodeColor(color).nodeOpacity(0.92).nodeResolution(10)
  .nodeVisibility((d) => floorOf(d) != null)
  .linkVisibility((l) => floorOf(l.source) != null && floorOf(l.target) != null && (l.kind !== "merge" || mode === "after"))
  .linkColor((l) => (l.kind === "merge" ? COLOR.merged : "#8a93a8")).linkOpacity(0.18).linkWidth((l) => (l.kind === "merge" ? 0.8 : 0))
  .nodeLabel((d) => '<div class="tip"><b>' + esc(d.id) + "</b><br>" + (d.description ? esc(d.description) + "<br>" : "") +
    esc(d.status === "merged" ? STATUS.merged + d.into : STATUS[d.status] || "") + " · " + n(d.bytes) + " bytes</div>")
  .warmupTicks(60).cooldownTicks(300);
graph.d3Force("center", null);
graph.d3Force("charge").strength(-14);
graph.d3Force("link").distance(28).strength(0.04);
graph.d3Force("floors", floors);
graph.cameraPosition({ x: 0, y: 160, z: Math.max(560, 900 * 700 / Math.max(innerWidth, 400)) }, { x: 0, y: 0, z: 0 });

// Floor plates with their names, sized to the floor.
function label(text) {
  const c = document.createElement("canvas"), g = c.getContext("2d"), fs = 30;
  g.font = "600 " + fs + "px ui-sans-serif, system-ui, sans-serif";
  c.width = Math.ceil(g.measureText(text).width) + 16; c.height = fs + 16;
  g.font = "600 " + fs + "px ui-sans-serif, system-ui, sans-serif"; g.fillStyle = "#a3abbd"; g.textBaseline = "middle"; g.fillText(text, 8, c.height / 2);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  s.scale.set(c.width / 4, c.height / 4, 1);
  return s;
}
const plates = {};
function drawFloors() {
  const scene = graph.scene(), c = count(mode);
  for (const f of FLOORS) {
    if (plates[f]) scene.remove(plates[f]);
    const grp = new THREE.Group(), R = radius(f);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 64), new THREE.MeshBasicMaterial({ color: 0x8a93a8, transparent: true, opacity: c[f] ? 0.06 : 0.025, side: THREE.DoubleSide, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2;
    const rim = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 96 }, (_, i) => new THREE.Vector3(Math.cos((i / 96) * 2 * Math.PI) * R, 0, Math.sin((i / 96) * 2 * Math.PI) * R))), new THREE.LineBasicMaterial({ color: 0x2a3040 }));
    const sign = label(FLOOR_NAME[f] + " · " + n(c[f]));
    sign.position.set(R + sign.scale.x / 2 + 6, 0, 0);
    grp.add(disc, rim, sign);
    grp.position.y = FLOOR_Y[f];
    scene.add(grp); plates[f] = grp;
  }
}

function summary() {
  const b = count("before"), a = count("after");
  document.getElementById("counts").innerHTML = FLOORS.filter((f) => f !== "index").map((f) =>
    "<tr><td>" + esc(FLOOR_NAME[f]) + '</td><td class="n">' + n(b[f]) + '</td><td class="d">→</td><td class="n">' + n(a[f]) + "</td></tr>").join("");
}
function setMode(m) {
  mode = m;
  for (const b of document.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === m));
  graph.nodeVisibility(graph.nodeVisibility()).linkVisibility(graph.linkVisibility());
  drawFloors();
  graph.d3ReheatSimulation();
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) setMode(b.dataset.mode); });
document.addEventListener("change", (e) => { if (e.target.matches("[data-project]")) location.href = "/map?project=" + encodeURIComponent(e.target.value); });
addEventListener("resize", () => graph.width(innerWidth).height(innerHeight));
summary();
drawFloors();
`;

// g: memoryGraph(). serve: { nonce, token, project, projects }. pickerHtml: the project picker from the review page.
export function mapHtml(g, { nonce, token, project, pickerHtml, memDir }) {
  const safeNonce = String(nonce).replace(/[^A-Za-z0-9+/=_-]/g, "");
  const back = `/${project ? `?project=${encodeURIComponent(project)}` : ""}`;
  const legend = [["stays", "Keep: read as usual"], ["queue", "to Consolidate: to be merged"], ["archive", "to Archive: retained, not typically accessed"], ["merged", "merged by a draft"], ["new", "new merged memory"]]
    .map(([k, t]) => `<span><i style="background:${{ stays: "#5d6577", archive: "#c9785a", queue: "#b48ce8", merged: "#56b4e9", new: "#cc79a7" }[k]}"></i>${t}</span>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${mapCsp(safeNonce, true)}">
<title>Sleep: memory map</title><style>${CSS}</style></head><body>
<div id="scene" role="img" aria-label="3D map of the memory folder ${esc(memDir)}"></div>
<header class="top"><h1>Sleep <span>memory map</span></h1>${pickerHtml}
<span class="seg" role="group" aria-label="Show"><button data-mode="before" aria-pressed="true">Before</button><button data-mode="after" aria-pressed="false">After</button></span>
<a class="btn" href="${esc(back)}">Back to the review</a></header>
<div class="panel"><h2>Before → after</h2><table id="counts"></table><div class="legend">${legend}</div>
<div class="legend"><span>Nothing moves until you apply it on the review page. Drag to turn, scroll to zoom.</span></div></div>
<script type="application/json" id="graph">${safeJson(g)}</script>
<script type="module" nonce="${safeNonce}">${SCRIPT(token, project ?? null)}</script>
</body></html>
`;
}
