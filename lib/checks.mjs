// Best-practice checks and archive candidates. Each check is one rule from docs/best-practices.md.
import { CAP_BYTES, CAP_LINES, INDEX } from "./memory.mjs";

export const DEFAULTS = {
  days: 60, // untouched this long before a file can be archived
  descriptionMax: 150,
  indexBudget: 3000, // tokens: MEMORY.md is paid on every turn
  expirable: ["project"], // memory types that can age out
  protectedTypes: ["user", "feedback"], // never archived, and what they link to is kept too
  consolidateTypes: ["feedback"], // protected, but set aside to be merged when unused for the window
};

export function checks(mem, use, opt) {
  const out = [];
  const add = (id, status, title, detail, files = []) => out.push({ id, status, title, detail, files });
  const ix = mem.index;
  add("index-cap", ix.truncatedLines ? "fail" : "pass", "MEMORY.md fits what Claude Code loads",
    ix.truncatedLines ? `${ix.truncatedLines} of ${ix.lines} lines are past the ${CAP_LINES}-line or ${CAP_BYTES.toLocaleString("en-US")}-byte cap and never load.` : `${ix.lines} lines, ${ix.bytes.toLocaleString("en-US")} bytes.`);
  add("index-budget", ix.tokens > opt.indexBudget ? "warn" : "pass", "MEMORY.md stays lean",
    `About ${ix.tokens.toLocaleString("en-US")} tokens on every turn (budget ${opt.indexBudget.toLocaleString("en-US")}).`);
  const broken = ix.links.filter((l) => !l.exists).map((l) => l.name);
  add("index-links", broken.length ? "fail" : "pass", "Every index link points at a file",
    broken.length ? `${broken.length} link(s) in ${INDEX} point at files that do not exist.` : `${ix.links.length} links, all present.`, broken);
  const noFm = mem.files.filter((f) => !f.description || !f.type).map((f) => f.name);
  add("frontmatter", noFm.length ? "warn" : "pass", "Every file has a description and a type",
    noFm.length ? `${noFm.length} file(s) are missing a description or a type.` : "All files have both.", noFm);
  const long = mem.files.filter((f) => f.description.length > opt.descriptionMax).map((f) => f.name);
  add("description-length", long.length ? "warn" : "pass", `Descriptions are ${opt.descriptionMax} characters or fewer`,
    long.length ? `${long.length} description(s) run longer; a short line with the words someone would grep for works best.` : "All within the limit.", long);
  const orphans = mem.files.filter((f) => !f.linkedFrom.length).map((f) => f.name);
  add("orphans", "info", "Files nothing links to",
    `${orphans.length} file(s) are reachable only by grep. That is fine when their names and text use the words someone would search for.`, orphans);
  const blind = mem.files.filter((f) => use.status(f) === "no data").map((f) => f.name);
  add("trackable", blind.length ? "info" : "pass", "Usage can be measured for every file",
    blind.length ? `${blind.length} file(s) have no line long enough to recognize in a log, so their use is unknown and they are never archived.` : "Every file has recognizable lines.", blind);
  return out;
}

// Two lists from the same rules. Archive candidates: expirable types, unused for the window. The consolidation
// queue: protected types (feedback) unused for the window, which are never archived but are set aside to be merged.
export function candidates(mem, use, opt, coverageDays) {
  if (coverageDays < opt.days) {
    return { list: [], consolidate: [], note: `Usage history covers ${coverageDays} days; a file must be unused for ${opt.days}, so nothing is a candidate yet.` };
  }
  const cutoff = Date.now() - opt.days * 864e5;
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const unusedSince = (f) => {
    if (f.createdMs > cutoff || use.status(f) === "no data") return null;
    const u = use.of(f);
    if (u.sessions > 0 && !u.last) return null; // used, but the log had no time: treat as recent
    if (u.last && u.last > cutoff) return null;
    return u;
  };
  const entry = (f, u) => ({
    name: f.name, type: f.type, description: f.description, bytes: f.bytes,
    lastUsed: u.last ? day(u.last) : null, sessions: u.sessions, created: day(f.createdMs), linkedFrom: f.linkedFrom,
    why: u.last ? `Last seen in a session on ${day(u.last)}, over ${opt.days} days ago.` : `Not seen in any session in the ${coverageDays} days on record.`,
  });
  const protectedNames = new Set();
  for (const f of mem.files) {
    if (f.linkedFrom.includes(INDEX) || opt.protectedTypes.includes(f.type)) protectedNames.add(f.name);
  }
  for (const f of mem.files) {
    if (opt.protectedTypes.includes(f.type)) for (const l of f.links) if (l.exists) protectedNames.add(l.name);
  }
  const list = [], consolidate = [];
  for (const f of mem.files) {
    if (f.linkedFrom.includes(INDEX)) continue;
    const u = unusedSince(f);
    if (!u) continue;
    if (opt.consolidateTypes.includes(f.type)) consolidate.push(entry(f, u));
    else if (opt.expirable.includes(f.type) && !protectedNames.has(f.name)) list.push(entry(f, u));
  }
  return { list, consolidate, note: `${list.length} file(s) meet every rule for archiving; ${consolidate.length} protected file(s) are queued for consolidation.` };
}
