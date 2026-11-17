// The memory map's data: every memory file as a node on the floor it is on now (before) and the floor it would be on
// once the plan and the merge drafts are applied (after), with the links between files. Names, descriptions and sizes
// only: no memory text goes into the page.
//
// Floors, top to bottom: index (MEMORY.md, loaded every turn), memory, queue (consolidate/), archive.
// Status says what happens to a node: stays, archive, queue, merged (a source a draft replaces), new (a draft).
const FLOOR = { main: "memory", consolidate: "queue", archive: "archive" };

export function memoryGraph({ mem, planned, drafts }) {
  const nodes = [{ id: "MEMORY.md", type: "index", description: "The index, loaded every turn", bytes: mem.index.bytes, before: "index", after: "index", status: "stays" }];
  const plan = new Map(planned.map((m) => [m.name, m.kind]));
  const mergedInto = new Map();
  for (const d of drafts) for (const s of d.sources) if (s.queued) mergedInto.set(s.name, d.name);
  for (const f of mem.files) {
    const before = FLOOR[f.area];
    let after = before, status = "stays", into = null;
    if (mergedInto.has(f.name)) { after = "archive"; status = "merged"; into = mergedInto.get(f.name); }
    else if (plan.get(f.name) === "archive") { after = "archive"; status = "archive"; }
    else if (plan.get(f.name) === "consolidate") { after = "queue"; status = "queue"; }
    nodes.push({ id: f.name, type: f.type || "", description: f.description || "", bytes: f.bytes, before, after, status, ...(into ? { into } : {}) });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const links = [];
  for (const f of mem.files) for (const from of f.linkedFrom) if (ids.has(from)) links.push({ source: from, target: f.name, kind: "link" });
  for (const d of drafts) {
    if (ids.has(d.name)) continue;
    const sources = d.sources.filter((s) => s.queued).map((s) => s.name);
    nodes.push({ id: d.name, type: "feedback", description: d.description || "", bytes: d.afterBytes, before: null, after: "memory", status: "new", sources });
    for (const s of sources) links.push({ source: s, target: d.name, kind: "merge" });
  }
  return { nodes, links };
}
