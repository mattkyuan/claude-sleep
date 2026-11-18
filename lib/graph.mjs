// The memory map's data: every memory file as a node, with the floor it is on now and the move the plan holds for
// it, the links between files, and Claude's drafts with their sources. Names, descriptions and sizes only: no memory
// text goes into the page.
//
// Floors, top to bottom: index (MEMORY.md, loaded every turn), memory (Keep), queue (Consolidate), archive.
// Where each node sits at each of the four steps (at[s], before, after, status, into, topic) comes from
// lib/steps.mjs, the same code the page runs when ticks change, here with the page's default ticks.
// Status says what happens to a node: stays, archive, queue, merged (a source an applied draft replaces), new (a
// draft that applies), held (a draft that does not apply as ticked).
import { draftWarning } from "./review.mjs";
import { applySteps } from "./steps.mjs";

const FLOOR = { main: "memory", consolidate: "queue", archive: "archive" };
const hubOf = (f) => (f.linkedFrom || []).filter((x) => x !== "MEMORY.md").sort()[0] || "unfiled";

export function memoryGraph({ mem, planned, drafts }) {
  const nodes = [{ id: "MEMORY.md", type: "index", description: "The index, loaded every turn", bytes: mem.index.bytes }];
  const plan = new Map(planned.map((m) => [m.name, m.kind]));
  for (const f of mem.files) nodes.push({ id: f.name, type: f.type || "", description: f.description || "", bytes: f.bytes, now: FLOOR[f.area], plan: plan.get(f.name) || null, hub: hubOf(f) });
  const ids = new Set(nodes.map((n) => n.id));
  const links = [];
  for (const f of mem.files) for (const from of f.linkedFrom) if (ids.has(from)) links.push({ source: from, target: f.name, kind: "link" });
  const list = [];
  for (const d of drafts) {
    if (ids.has(d.name)) continue;
    const pooled = d.sources.filter((s) => s.queued || s.planned).map((s) => s.name).filter((s) => ids.has(s));
    nodes.push({ id: d.name, draft: true, type: "feedback", description: d.description || "", bytes: d.afterBytes, topic: d.topic, sources: pooled });
    for (const s of pooled) links.push({ source: s, target: d.name, kind: "merge" });
    list.push({ id: d.name, topic: d.topic, ok: !draftWarning(d), sources: d.sources.map((s) => ({ name: s.name, changed: !!s.changed })) });
  }
  return applySteps({ nodes, links, drafts: list });
}
