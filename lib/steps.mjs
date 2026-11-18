// Where every memory sits at each of the map's four steps, from the plan and what is ticked. Pure, with no imports:
// it runs on the server (lib/graph.mjs) and in the page (served at /lib/steps.mjs), so the map shows what Apply
// will do, not a second guess at it.
//
// The rules are copied from Apply (/apply-all and merged in sleep.mjs):
//   - the files that move are the ticked moves plus every source of a ticked draft (Apply passes both to
//     archive --apply --only), so a draft carries its planned source even when that source's row is unticked;
//   - ticked drafts merge one by one, in page order; each merges only when every source sits in Consolidate after
//     the moves, none changed since Claude read it, and no earlier merge already took it.
//
// G: { nodes, drafts }. File nodes: { id, now, plan, hub } (plan: "archive", "consolidate" or null). Draft nodes:
// { id, draft: true }. G.drafts: [{ id, topic, ok, sources: [{ name, changed }] }], in page order.
// ticks: { moves: [names], drafts: [names] }; left out, the page's defaults (every move, every draft with no warning).
// Floors: index, memory (Keep), queue (Consolidate), archive. Steps: 0 now, 1 moves, 2 drafts, 3 applied.

export const defaultTicks = (G) => ({ moves: G.nodes.filter((n) => n.plan).map((n) => n.id), drafts: G.drafts.filter((d) => d.ok).map((d) => d.id) });

export function applySteps(G, ticks = defaultTicks(G)) {
  const files = new Map(G.nodes.filter((n) => !n.draft && n.id !== "MEMORY.md").map((n) => [n.id, n]));
  const draftOn = new Set(ticks.drafts || []);
  const moving = new Set(ticks.moves || []);
  for (const d of G.drafts) if (draftOn.has(d.id)) for (const s of d.sources) moving.add(s.name);
  const moved = (n) => (n.plan && moving.has(n.id) ? (n.plan === "archive" ? "archive" : "queue") : n.now);
  const into = new Map(), applied = new Set();
  for (const d of G.drafts) {
    if (!draftOn.has(d.id) || !d.sources.length) continue;
    const ok = d.sources.every((s) => { const n = files.get(s.name); return n && moved(n) === "queue" && !s.changed && !into.has(s.name); });
    if (!ok) continue;
    applied.add(d.id);
    for (const s of d.sources) into.set(s.name, d.id);
  }
  const topicOf = new Map();
  for (const d of G.drafts) for (const s of d.sources) if (!topicOf.has(s.name)) topicOf.set(s.name, d.topic);
  for (const n of G.nodes) {
    if (n.id === "MEMORY.md") { n.at = ["index", "index", "index", "index"]; n.status = "stays"; }
    else if (n.draft) {
      const on = applied.has(n.id);
      n.at = [null, null, "queue", on ? "memory" : null];
      n.status = on ? "new" : "held";
    } else {
      const m = moved(n), to = into.get(n.id) || null;
      n.at = [n.now, m, m, to ? "archive" : m];
      n.status = to ? "merged" : m === n.now ? "stays" : m;
      if (to) n.into = to; else delete n.into;
      const t = m === "queue" ? topicOf.get(n.id) || n.hub : null;
      if (t) n.topic = t; else delete n.topic;
    }
    n.before = n.at[0]; n.after = n.at[3];
  }
  return G;
}

// How many memories sit on each floor at a step.
export function floorCounts(G, step) {
  const c = { memory: 0, queue: 0, archive: 0 };
  for (const n of G.nodes) { const f = n.at[step]; if (f && f !== "index") c[f]++; }
  return c;
}

// The map step a page section shows: the moves lists show the planned moves, the drafts show Claude consolidating,
// the Apply bar shows the folder once applied. Other sections leave the step as it is (null).
const SECTION_STEP = { "moves-archive": 1, "moves-queue": 1, drafts: 2, apply: 3 };
export const stepForSection = (id) => SECTION_STEP[id] ?? null;
