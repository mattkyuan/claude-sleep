// The map pane of the served review page: its markup, its styles, and the module script that mounts the 3D view
// (lib/mapview.mjs) beside the text and keeps the two in step. Sister to harness-map's map. Served only, from
// 127.0.0.1: the 3D library is the vendored copy in vendor/graph3d.mjs, and the page loads nothing from anywhere else.
// The text is the source of every decision; the map shows them. The page works whole without it.
// JSON inside a <script> block: escape anything that could close it or start markup.
export const safeJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

// The served page's policy: its own nonce-tagged scripts, and modules from this address only. The header carries
// frame-ancestors; a <meta> policy cannot, so the page copy leaves it out.
export const mapCsp = (nonce, meta = false) => `default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'${meta ? "" : "; frame-ancestors 'none'"}`;

const LEGEND = [["#5d6577", "Keep: read as usual"], ["#b48ce8", "Consolidate: to be merged"], ["#c9785a", "Archive: retained, not typically accessed"], ["#56b4e9", "merged memory Claude drafted"], ["#e69f00", "draft left out as ticked"]];

// Split: text on the left, the map pane on the right. Map: the pane fills the window. Text: no pane. Below 900px
// there is no split; the map opens over the page.
export const PANE_CSS = `
:root{--pane:min(46vw,760px);--barh:58px}
.views{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}
.views button{font:inherit;font-size:12px;color:var(--text);background:transparent;border:0;padding:4px 10px;cursor:pointer}
.views button[aria-pressed="true"]{background:var(--accent);color:var(--accentInk);font-weight:650}
.pane{display:none;position:fixed;top:0;right:0;bottom:var(--barh);width:var(--pane);flex-direction:column;z-index:5;
color-scheme:dark;--bg:#0d0f14;--panel:#161a22e6;--text:#e6e8ee;--muted:#a3abbd;--faint:#7b8396;--line:#2a3040;--chip:#ffffff0d;--accent:#f2a65a;--accentInk:#1a1206;
background:var(--bg);color:var(--text);border-left:1px solid var(--line)}
body.split .pane,body.mapview .pane{display:flex}
body.split .wrap{max-width:none;margin:0;width:calc(100% - var(--pane))}
body.split .bar .in{max-width:none}
body.mapview .pane{left:0;width:auto}
.phead{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;padding:8px 10px;border-bottom:1px solid var(--line)}
.phead .seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}
.phead .seg button,.phead .btn{font:inherit;font-size:12px;color:var(--text);background:transparent;border:0;padding:4px 9px;cursor:pointer}
.phead .btn{border:1px solid var(--line);border-radius:8px;background:var(--chip)}
.phead .seg button[aria-pressed="true"]{background:var(--accent);color:var(--accentInk);font-weight:650}
.phead .views{margin-left:auto}
.scene{position:relative;flex:1;min-height:0}
.pinfo{border-top:1px solid var(--line);padding:8px 12px 10px;max-height:40%;overflow:auto}
.pinfo b{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}.pinfo p{margin:4px 0;color:var(--muted)}
.pinfo table{border-collapse:collapse;font-variant-numeric:tabular-nums}.pinfo td{padding:1px 10px 1px 0}.pinfo td.n{text-align:right;color:var(--faint)}.pinfo td.n.on{color:var(--text);font-weight:650}
.legend{display:flex;flex-wrap:wrap;gap:2px 12px;margin-top:6px;color:var(--muted)}.legend span{display:inline-flex;align-items:center;gap:6px}.legend i{width:9px;height:9px;border-radius:50%;display:inline-block}
.card{margin-top:6px;padding:6px 8px;border:1px solid var(--line);border-radius:8px}.card code{color:var(--text)}
.pfail{padding:16px;color:var(--muted)}
.tip{font:12px/1.45 ui-sans-serif,system-ui,sans-serif;max-width:300px;white-space:normal}.tip b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
[data-node].flash,.trow.flash{outline:2px solid var(--accent);outline-offset:-2px}
@media (max-width:899px){body.split .wrap{width:auto}.pane{bottom:0}}
`;

export const viewSwitch = () => `<span class="views" role="group" aria-label="View"><button data-view="text">Text</button><button data-view="split">Split</button><button data-view="map">Map</button></span>`;

export const paneHtml = () => `<aside class="pane" id="pane" aria-label="3D memory map">
<div class="phead"><span class="seg" role="group" aria-label="Step"><button data-s="0">1 Now</button><button data-s="1">2 Moves</button><button data-s="2">3 Drafts</button><button data-s="3">4 Applied</button></span><button class="btn" data-play>Play</button>${viewSwitch()}</div>
<div class="scene" data-scene role="img" aria-label="Memory files on four floors: MEMORY.md, Keep, Consolidate, Archive"></div>
<div class="pinfo"><b data-title></b><p data-say></p><table data-counts></table><div class="legend">${LEGEND.map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join("")}</div><div data-card></div>
<p class="legend">Hover a row to find it here; click a sphere to open its row. Drag to turn, scroll to zoom. Nothing moves until you apply.</p></div>
</aside>`;

// The page's module: mounts the map when it is first shown, and keeps text and map in step. Built from the page,
// never from HTML strings: the card is DOM calls and textContent.
export const PAGE_MODULE = `
const G = JSON.parse(document.getElementById("graph").textContent);
const pane = document.getElementById("pane");
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const wide = matchMedia("(min-width: 900px)"), still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = { get() { try { return localStorage.getItem("sleep.view"); } catch { return null; } }, set(v) { try { localStorage.setItem("sleep.view", v); } catch {} } };
const ticks = () => ({ moves: $$("input[data-pick]").filter((x) => x.checked).map((x) => x.value), drafts: $$("input[data-include]").filter((x) => x.checked).map((x) => x.value) });
let map = null, mounting = null, steps = null, hold = false;
async function ensure() {
  if (map || mounting) return mounting;
  mounting = (async () => {
    try {
      const [{ mountMap }, s] = await Promise.all([import("/lib/mapview.mjs"), import("/lib/steps.mjs")]);
      steps = s;
      map = mountMap(pane, G, { onPick: pick, onUserStep: () => (hold = true) });
      map.setTicks(ticks());
      // Show the step for the section in view now, whatever signals came before the map was ready.
      current = inView();
      const s0 = current && steps.stepForSection(current);
      if (s0 != null) map.setStep(s0);
      window.sleepMap = map;
    } catch (e) {
      const p = document.createElement("p"); p.className = "pfail";
      p.textContent = "The 3D map could not start here (" + (e && e.message || e) + "). Everything else on this page works.";
      pane.querySelector("[data-scene]").replaceChildren(p);
    }
  })();
  return mounting;
}
function view(v, save) {
  if (!["text", "split", "map"].includes(v)) v = wide.matches ? "split" : "text";
  if (v === "split" && !wide.matches) v = "text";
  document.body.classList.toggle("split", v === "split");
  document.body.classList.toggle("mapview", v === "map");
  for (const b of $$("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === v));
  if (save) store.set(v);
  if (v !== "text") ensure();
  return v;
}
const asked = new URLSearchParams(location.search).get("view");
view(asked || store.get());
wide.addEventListener("change", () => view(document.body.classList.contains("mapview") ? "map" : store.get()));
document.addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) view(b.dataset.view, true); });

// Text to map: hovering or focusing a row lights its node; a topic lights its whole cluster.
const idsOf = (el) => (el.matches("[data-node]") && !el.matches("article") ? [el.dataset.node] : $$("[data-node]", el).map((x) => x.dataset.node).concat(el.dataset.node ? [el.dataset.node] : []));
function lightFrom(target) {
  if (!map) return;
  const el = target.closest && target.closest("[data-node], .trow");
  map.highlight(el ? idsOf(el) : null);
}
document.addEventListener("pointerover", (e) => { if (!pane.contains(e.target)) lightFrom(e.target); });
document.addEventListener("focusin", (e) => { if (!pane.contains(e.target)) lightFrom(e.target); });

// Map to text: a clicked node opens its row; a node with no row shows a card in the pane.
function pick(id) {
  const el = $$("[data-node]").find((x) => x.dataset.node === id);
  const card = pane.querySelector("[data-card]");
  card.replaceChildren();
  if (!el) {
    const d = G.nodes.find((x) => x.id === id); if (!d) return;
    const box = document.createElement("div"); box.className = "card";
    const name = document.createElement("code"); name.textContent = d.id;
    const what = document.createElement("p"); what.textContent = (d.description || "No description.") + " Stays where it is: nothing in this plan moves it.";
    box.append(name, what); card.append(box);
    return;
  }
  if (document.body.classList.contains("mapview")) view(wide.matches ? "split" : "text");
  for (let p = el; p; p = p.parentElement) if (p.tagName === "DETAILS") p.open = true;
  const det = el.querySelector("details"); if (det) det.open = true;
  el.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600);
}

// Ticks drive the map: every change redraws the moves and the Applied step from lib/steps.mjs.
const retick = () => map && map.setTicks(ticks());
document.addEventListener("change", (e) => { if (e.target.matches("[data-pick], [data-include], [data-topic-pick]")) retick(); });
document.addEventListener("click", (e) => { if (e.target.closest("[data-all]")) setTimeout(retick, 0); });

// The step follows the section being read; a step button holds until the section changes. Apply shows Applied.
let current = null, timer = null;
// The first section crossing the reading band, a strip from 15% to 40% of the window's height.
function inView() { const a = innerHeight * 0.15, b = innerHeight * 0.4; const s = $$("main > section").find((x) => { const r = x.getBoundingClientRect(); return r.top < b && r.bottom > a; }); return s ? s.id : null; }
const io = new IntersectionObserver(() => {
  const top = inView();
  if (!top || top === current) return;
  current = top; hold = false;
  clearTimeout(timer);
  timer = setTimeout(() => { const s = steps && steps.stepForSection(current); if (map && s != null && !hold) map.setStep(s); }, 250);
}, { rootMargin: "-15% 0px -60% 0px" });
for (const s of $$("main > section")) io.observe(s);
const apply = document.getElementById("apply");
if (apply) for (const ev of ["pointerenter", "focus"]) apply.addEventListener(ev, () => { if (map) { hold = true; map.setStep(3); } });
`;
