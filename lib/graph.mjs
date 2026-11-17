// The memory map's data: every memory file as a node, with the floor it is on at each of four steps, and the links
// between files. Names, descriptions and sizes only: no memory text goes into the page.
//
// Floors, top to bottom: index (MEMORY.md, loaded every turn), memory (Keep), queue (Consolidate), archive.
// Steps: 0 now, 1 the planned moves, 2 Claude's drafts (each beside its sources, clustered by topic, nothing moved on
// disk), 3 applied (drafts that would start ticked on the review page rise to Keep, their sources sink to Archive).
// at[s] is a node's floor at step s, null where it does not exist yet. before and after are at[0] and at[3].
// Status says what happens to a node: stays, archive, queue, merged (a source an applied draft replaces), new (a
// draft that applies), held (a draft that starts unticked, so it does not apply by default).
import { draftWarning } from "./review.mjs";

const FLOOR = { main: "memory", consolidate: "queue", archive: "archive" };
const hubOf = (f) => (f.linkedFrom || []).filter((x) => x !== "MEMORY.md").sort()[0] || "unfiled";

export function memoryGraph({ mem, planned, drafts }) {
  const nodes = [{ id: "MEMORY.md", type: "index", description: "The index, loaded every turn", bytes: mem.index.bytes, at: ["index", "index", "index", "index"], status: "stays" }];
  const plan = new Map(planned.map((m) => [m.name, m.kind]));
  const ok = drafts.filter((d) => !draftWarning(d));
  const pool = (s) => s.queued || s.planned;
  const mergedInto = new Map(), topicOf = new Map();
  for (const d of ok) for (const s of d.sources) if (pool(s)) mergedInto.set(s.name, d.name);
  for (const d of drafts) for (const s of d.sources) if (pool(s) && !topicOf.has(s.name)) topicOf.set(s.name, d.topic);
  for (const f of mem.files) {
    const now = FLOOR[f.area];
    const moved = plan.get(f.name) === "archive" ? "archive" : plan.get(f.name) === "consolidate" ? "queue" : now;
    const into = mergedInto.get(f.name) || null;
    const status = into ? "merged" : moved === now ? "stays" : moved;
    const at = [now, moved, moved, into ? "archive" : moved];
    const topic = at[2] === "queue" ? topicOf.get(f.name) || hubOf(f) : null;
    nodes.push({ id: f.name, type: f.type || "", description: f.description || "", bytes: f.bytes, at, status, ...(into ? { into } : {}), ...(topic ? { topic } : {}) });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const links = [];
  for (const f of mem.files) for (const from of f.linkedFrom) if (ids.has(from)) links.push({ source: from, target: f.name, kind: "link" });
  for (const d of drafts) {
    if (ids.has(d.name)) continue;
    const sources = d.sources.filter(pool).map((s) => s.name).filter((s) => ids.has(s));
    const applies = ok.includes(d);
    nodes.push({ id: d.name, type: "feedback", description: d.description || "", bytes: d.afterBytes, at: [null, null, "queue", applies ? "memory" : null], status: applies ? "new" : "held", topic: d.topic, sources });
    for (const s of sources) links.push({ source: s, target: d.name, kind: "merge" });
  }
  for (const n of nodes) { n.before = n.at[0]; n.after = n.at[3]; }
  return { nodes, links };
}
