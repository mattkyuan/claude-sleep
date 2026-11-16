// Reads a Claude Code memory folder: the index, every topic file's frontmatter, and the links between them.
import fs from "node:fs";
import path from "node:path";

export const INDEX = "MEMORY.md";
// Claude Code loads MEMORY.md up to the first 200 lines or 25KB, whichever comes first.
export const CAP_LINES = 200;
export const CAP_BYTES = 25_000;
export const tok = (chars) => Math.round(chars / 4);

// The frontmatter is a small YAML subset: "key: value" lines, and one nested level (metadata: / type:).
export function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  let parent = null;
  for (const line of m[1].split("\n")) {
    const kv = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, indent, k, raw] = kv;
    const v = raw.replace(/^["']|["']$/g, "").trim();
    if (indent && parent) { fm[parent] = typeof fm[parent] === "object" ? fm[parent] : {}; fm[parent][k] = v; }
    else { fm[k] = v === "" ? {} : v; parent = v === "" ? k : null; }
  }
  return { fm, body: text.slice(m[0].length) };
}

const typeOf = (fm) => (typeof fm.type === "string" ? fm.type : typeof fm.metadata?.type === "string" ? fm.metadata.type : "");

// [text](file.md) and [[slug]] links, as file names in this folder.
function linksIn(text, names, bySlug) {
  const out = [];
  for (const m of text.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
    let nm; try { nm = path.basename(decodeURIComponent(m[1])); } catch { nm = path.basename(m[1]); }
    if (!out.includes(nm)) out.push(nm);
  }
  for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const slug = m[1].trim();
    const nm = bySlug.get(slug) || `${slug}.md`;
    if (!out.includes(nm)) out.push(nm);
  }
  return out.map((nm) => ({ name: nm, exists: names.has(nm) }));
}

export function readMemory(memDir) {
  const indexPath = path.join(memDir, INDEX);
  let indexText = "";
  try { indexText = fs.readFileSync(indexPath, "utf8"); } catch {}
  const entries = (() => { try { return fs.readdirSync(memDir, { withFileTypes: true }); } catch { return []; } })();
  const files = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md") || e.name === INDEX) continue;
    const p = path.join(memDir, e.name);
    const text = fs.readFileSync(p, "utf8");
    const st = fs.statSync(p);
    const { fm, body } = frontmatter(text);
    files.push({
      // Creation time where the filesystem keeps one (macOS), so a tidy-up that edits every file does not make
      // them all look new. Elsewhere it falls back to the last edit.
      name: e.name, path: p, bytes: st.size, tokens: tok(text.length), mtimeMs: st.mtimeMs,
      createdMs: st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs,
      slug: typeof fm.name === "string" ? fm.name : "", description: typeof fm.description === "string" ? fm.description : "", type: typeOf(fm),
      body, text, links: [], linkedFrom: [],
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set(files.map((f) => f.name));
  const bySlug = new Map();
  for (const f of files) { bySlug.set(f.name.slice(0, -3), f.name); if (f.slug) bySlug.set(f.slug, f.name); }
  const byName = new Map(files.map((f) => [f.name, f]));
  const indexLinks = linksIn(indexText, names, bySlug);
  for (const l of indexLinks) if (l.exists) byName.get(l.name).linkedFrom.push(INDEX);
  for (const f of files) {
    f.links = linksIn(f.body, names, bySlug).filter((l) => l.name !== f.name);
    for (const l of f.links) if (l.exists) byName.get(l.name).linkedFrom.push(f.name);
  }
  // What actually loads: lines up to the line cap, stopping early if the byte cap is reached first.
  const lines = indexText ? indexText.replace(/\n$/, "").split("\n") : [];
  let bytes = 0, loaded = 0;
  for (const line of lines) {
    const b = Buffer.byteLength(line) + 1;
    if (loaded >= CAP_LINES || bytes + b > CAP_BYTES) break;
    bytes += b; loaded++;
  }
  const index = {
    path: indexPath, exists: !!indexText, lines: lines.length, bytes: Buffer.byteLength(indexText), tokens: tok(indexText.length),
    loadedLines: loaded, truncatedLines: lines.length - loaded, links: indexLinks, text: indexText,
  };
  return { memDir, index, files, byName };
}
