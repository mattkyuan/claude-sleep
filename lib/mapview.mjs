// The 3D memory map, as a browser module the served review page mounts in its map pane (served at /lib/mapview.mjs).
// Floors are where a file lives: MEMORY.md at the top (loaded every turn), then Keep, Consolidate and Archive. Four
// steps: the folder now, the moves, Claude's drafts beside the files they replace, and the folder once applied.
// Where each node sits at each step comes from lib/steps.mjs with the page's current ticks, the same code the
// server uses, so the map shows what Apply will do. The text is the source of every decision; this only shows it.
// Nothing here writes HTML from data: labels go through esc(), and the panel is built with DOM calls.
import { ForceGraph3D, THREE } from "/vendor/graph3d.mjs";
import { applySteps, floorCounts } from "/lib/steps.mjs";

const FLOORS = ["index", "memory", "queue", "archive"];
const FLOOR_Y = { index: 160, memory: 55, queue: -55, archive: -160 };
export const FLOOR_NAME = { index: "MEMORY.md", memory: "Keep", queue: "Consolidate", archive: "Archive" };
// Okabe-Ito based, as in harness-map's compare colors; archive and queue keep sleep's own colors.
export const COLOR = { stays: "#5d6577", archive: "#c9785a", queue: "#b48ce8", merged: "#b48ce8", new: "#56b4e9", held: "#e69f00", gone: "#3a4150", dim: "#262b36" };
const STATUS = { stays: "stays in Keep", archive: "moves to Archive", queue: "moves to Consolidate", merged: "merges into ", new: "a merged memory Claude drafted", held: "a draft left out as ticked" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n = (x) => Number(x || 0).toLocaleString("en-US");
export const STEP_NAME = ["Now", "Planned moves", "Claude consolidates", "Applied"];

// What each step says, from this folder's own numbers at the current ticks.
function stepText(G, s) {
  const drafts = G.nodes.filter((d) => d.draft), on = drafts.filter((d) => d.status === "new").length, held = drafts.length - on;
  const toQueue = G.nodes.filter((d) => d.at[1] === "queue" && d.at[0] !== "queue").length, toArchive = G.nodes.filter((d) => d.at[1] === "archive" && d.at[0] !== "archive").length;
  const merged = G.nodes.filter((d) => d.status === "merged").length;
  return [
    "Your memory as it is: " + n(floorCounts(G, 0).memory) + " files in Keep. Coloured ones are ticked to move: purple to Consolidate, orange to Archive.",
    n(toQueue) + " unused feedback memories drop to Consolidate, still searchable. " + n(toArchive) + " unused project notes go to Archive: retained, not typically accessed. MEMORY.md and what it links to stay.",
    drafts.length ? "Each cluster is a topic; each blue sphere is a merged memory Claude drafted, joined to the files it replaces. " + n(drafts.length) + " drafts" + (held ? ", " + n(held) + " left out as ticked (yellow)" : "") + ". Nothing has changed on disk." : "No drafts yet. Consolidate with Claude drafts them.",
    on ? n(on) + " merged memories rise to Keep; the " + n(merged) + " files they replace sink to Archive, links rewritten." + (held ? " " + n(held) + " drafts are left out." : "") : "With no draft that can merge ticked, applying moves files only.",
  ][s];
}

// root: the pane. It holds [data-scene], [data-s] step buttons, [data-play], [data-title], [data-say], [data-counts].
// hooks.onPick(id): a node was clicked. Returns the controls the page drives.
export function mountMap(root, G, hooks = {}) {
  const $ = (s) => root.querySelector(s);
  const el = $("[data-scene]");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  applySteps(G);
  const byId = new Map(G.nodes.map((d) => [d.id, d]));
  let step = 0, lit = null;
  const floorOf = (d, s = step) => d.at[s];
  const topicsOf = () => [...new Set(G.nodes.filter((d) => d.topic).map((d) => d.topic))];
  let topics = topicsOf(), tIndex = new Map(topics.map((t, i) => [t, i]));
  const radius = (f, s = step) => 18 + 6 * Math.sqrt(Math.max(1, floorCounts(G, s)[f] || 1));
  // Topic centres spread over the whole floor (a sunflower pattern), so many topics still read as separate clusters.
  const cluster = (t) => { const i = tIndex.get(t) ?? 0, a = i * 2.39996, r = radius("queue", 2) * 0.88 * Math.sqrt((i + 0.5) / Math.max(1, topics.length)); return [Math.cos(a) * r, Math.sin(a) * r]; };
  // Each node is pulled to its floor's height and kept inside its floor's disc; while Claude drafts, each topic gathers.
  function floors(alpha) {
    for (const d of G.nodes) {
      const f = floorOf(d) ?? "queue";
      const clustered = step === 2 && d.topic && f === "queue";
      d.vy += (FLOOR_Y[f] - d.y) * alpha * (clustered ? 2.5 : 0.7);
      if (clustered) {
        const [cx, cz] = cluster(d.topic), k = d.draft ? 1.4 : 1;
        d.vx += (cx - d.x) * alpha * k; d.vz += (cz - d.z) * alpha * k;
      } else {
        const R = radius(f), r = Math.hypot(d.x || 0, d.z || 0) || 1;
        if (r > R) { const k = ((r - R) / r) * alpha * 0.6; d.vx -= d.x * k; d.vz -= d.z * k; }
      }
    }
  }
  const end = (x) => (typeof x === "object" ? x : byId.get(x));
  // A merge line shows only while Claude drafts; a file link shows when both ends are on a floor and neither is
  // archived by the merge.
  const linkOn = (l) => l.kind === "merge" ? step === 2 : step !== 2 && [l.source, l.target].every((x) => { const d = end(x); return d && floorOf(d) != null && !(step === 3 && d.status === "merged"); });
  const baseColor = (d) => (d.id === "MEMORY.md" ? "#f2a65a" : step === 3 && d.status === "merged" ? COLOR.gone : step === 0 && d.at[0] !== "archive" && (d.status === "archive" || d.status === "queue" || d.status === "merged") ? COLOR[d.status === "merged" ? "queue" : d.status] : COLOR[d.status] || COLOR.stays);
  const color = (d) => (lit && !lit.has(d.id) ? COLOR.dim : baseColor(d));
  const touches = (l) => lit && (lit.has(end(l.source)?.id) || lit.has(end(l.target)?.id));
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim() || "#0d0f14";
  const graph = ForceGraph3D({ controlType: "orbit" })(el)
    .width(el.clientWidth).height(el.clientHeight)
    .backgroundColor(bg).showNavInfo(false)
    .graphData(G)
    .nodeId("id").nodeRelSize(1.7).nodeVal((d) => (d.id === "MEMORY.md" ? 160 : d.draft ? 4 + Math.sqrt(d.bytes || 0) / 6 : 1 + Math.sqrt(d.bytes || 0) / 10)).nodeColor(color).nodeOpacity(0.92).nodeResolution(10)
    .nodeVisibility((d) => floorOf(d) != null).linkVisibility(linkOn)
    .linkColor((l) => (touches(l) ? "#e6e8ee" : l.kind === "merge" ? COLOR.new : "#8a93a8")).linkOpacity(0.22).linkWidth((l) => (touches(l) ? 0.8 : l.kind === "merge" ? 0.6 : 0))
    .nodeLabel((d) => '<div class="tip"><b>' + esc(d.id) + "</b><br>" + (d.description ? esc(d.description) + "<br>" : "") +
      esc(d.status === "merged" ? STATUS.merged + d.into : d.draft ? STATUS[d.status] + ", from " + (d.sources || []).length + " memories" : STATUS[d.status] || "") + " · " + n(d.bytes) + " bytes</div>")
    .onNodeClick((d) => hooks.onPick?.(d.id))
    .warmupTicks(still ? 400 : 40).cooldownTicks(260);
  graph.d3Force("center", null);
  graph.d3Force("charge").strength(-12);
  // Fresh functions each time: the graph ignores a setter given the function it already holds, and a hidden link
  // must not pull.
  const linkPull = () => graph.d3Force("link").distance(26).strength((l) => (linkOn(l) ? (l.kind === "merge" ? 0.25 : 0.03) : 0));
  linkPull();
  graph.d3Force("floors", floors);
  // Far enough back to show every floor in the pane, whatever its shape.
  const home = () => { const fit = Math.min(el.clientWidth, el.clientHeight * 1.3) || 600; graph.cameraPosition({ x: 0, y: 150, z: Math.min(1400, Math.max(420, 330000 / fit)) }, { x: 0, y: -10, z: 0 }, still ? 0 : 600); };
  home();
  new ResizeObserver(() => graph.width(el.clientWidth).height(el.clientHeight)).observe(el);

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
    const scene = graph.scene(), c = floorCounts(G, step);
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
  // The panel: step title, what it means, and the floor counts at every step, built with DOM calls.
  function panel() {
    const t = $("[data-title]"), d = $("[data-say]"), tb = $("[data-counts]");
    if (t) t.textContent = step + 1 + " · " + STEP_NAME[step];
    if (d) d.textContent = stepText(G, step);
    if (tb) {
      const c = [0, 1, 2, 3].map((s) => floorCounts(G, s));
      const row = (cells, head) => { const tr = document.createElement("tr"); cells.forEach((x, i) => { const td = document.createElement("td"); td.textContent = x; if (i) td.className = "n" + (i - 1 === step ? " on" : ""); tr.append(td); }); return tr; };
      tb.replaceChildren(row(["", "Now", "Moves", "Drafts", "Applied"]), ...["memory", "queue", "archive"].map((f) => row([FLOOR_NAME[f], ...c.map((x) => n(x[f]))])));
    }
    for (const b of root.querySelectorAll("[data-s]")) b.setAttribute("aria-pressed", String(+b.dataset.s === step));
  }
  function redraw() {
    graph.nodeColor((d) => color(d)).nodeVisibility((d) => floorOf(d) != null).linkVisibility((l) => linkOn(l))
      .linkColor((l) => (touches(l) ? "#e6e8ee" : l.kind === "merge" ? COLOR.new : "#8a93a8")).linkWidth((l) => (touches(l) ? 0.8 : l.kind === "merge" ? 0.6 : 0));
  }
  function setStep(s) {
    if (s === step && plates.memory) return;
    step = s; linkPull(); redraw(); panel(); drawFloors(); graph.d3ReheatSimulation();
    hooks.onStep?.(step);
  }
  let timer = null;
  const play = $("[data-play]");
  const stopPlay = () => { if (timer) { clearInterval(timer); timer = null; if (play) play.textContent = "Play"; } };
  if (play) {
    if (still) play.hidden = true;
    play.addEventListener("click", (e) => {
      e.preventDefault();
      if (timer) return stopPlay();
      setStep(0); play.textContent = "Stop";
      timer = setInterval(() => { if (step >= 3) return stopPlay(); setStep(step + 1); }, 4500);
    });
  }
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-s]"); if (b && root.contains(b)) { stopPlay(); setStep(+b.dataset.s); hooks.onUserStep?.(step); } });
  step = -1; setStep(0);
  return {
    setStep: (s) => { stopPlay(); setStep(s); },
    // New ticks: recompute every step, then redraw this one.
    setTicks(ticks) {
      applySteps(G, ticks);
      topics = topicsOf(); tIndex = new Map(topics.map((t, i) => [t, i]));
      linkPull(); redraw(); panel(); drawFloors(); graph.d3ReheatSimulation();
    },
    // Lights these nodes and their links and dims the rest; null clears it.
    highlight(ids) { lit = ids && ids.length ? new Set(ids) : null; redraw(); },
    // Turns the camera toward one node.
    focus(id) {
      const d = byId.get(id); if (!d || d.x == null) return;
      const k = 1 + 160 / Math.max(40, Math.hypot(d.x, d.y, d.z));
      graph.cameraPosition({ x: d.x * k, y: d.y * k + 40, z: d.z * k + 120 }, d, still ? 0 : 700);
    },
    home,
    // As if the node was clicked.
    pick: (id) => hooks.onPick?.(id),
    // For checks: the step shown and the floor counts at every step.
    state: () => ({ step, counts: [0, 1, 2, 3].map((s) => floorCounts(G, s)), lit: lit ? [...lit] : [] }),
  };
}
