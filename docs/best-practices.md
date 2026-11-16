# What good Claude Code memory looks like

These rules come from measuring one large memory folder (833 files) against 30 days of session logs. Each rule is also a check in `sleep report`.

## How memory reaches the agent

- **MEMORY.md is the only memory file loaded on its own.** It loads at the start of every session, up to the first 200 lines or 25KB. Lines past that never load.
- **Every other file stays on disk** until the agent greps or reads it. An unused file costs no tokens. What it costs is attention: a stale file the agent does read can mislead it.
- **The agent mostly greps.** In the measured folder, `grep` and `rg` calls outnumbered full-file reads. Grep finds a file by its words, not by where it sits in a hierarchy.

## The rules

1. **Keep MEMORY.md lean** (check: `index-cap`, `index-budget`). Every line costs tokens on every turn. Keep only lines that change what the agent does: standing rules, warnings about destructive actions, and pointers to areas it should know exist.
2. **Every index link points at a file** (check: `index-links`). A broken link sends the agent looking for something that isn't there.
3. **Every file has a short description and a type** (checks: `frontmatter`, `description-length`). The description is a one-line summary that grep can surface cheaply (`grep -h '^description:' *.md`). Keep it to 150 characters, using the words someone would search for.
4. **Write files that grep can find** (checks: `orphans`, `trackable`). A file nothing links to is fine if its name and text use the words someone would search for. Give each file at least one full sentence, so its use can be measured too.
5. **Protect what must never expire, but keep it sharp.** User and feedback memories, and anything they link to, are never archived. Neither is anything MEMORY.md links to directly. A feedback memory that goes unused for the window is queued for consolidation instead: merged with related lessons into fewer, sharper files. Age is measured from when a file was created, so a tidy-up that edits every file doesn't reset it.
6. **Hubs are optional.** A hub file that lists related memories keeps MEMORY.md short. It does not guarantee the agent finds those memories; grep goes around it.
7. **Archive, don't delete, and search the archive last.** Archived files move to `memory-archive/`, next to `memory/` rather than inside it, so ordinary searches don't hit them. One line in MEMORY.md tells the agent to look there only after `memory/` turns up nothing.

## How sleep measures use

- A file counts as used in a session when one of its own lines comes back in a tool result, whatever command fetched it. File names alone, as in an `ls`, don't count.
- Sessions that write to the memory folder are upkeep, not use, and are left out.
- A file with no line long enough to recognize is "unknown" and is never archived.
- Claude Code deletes session logs after 30 days by default, so sleep keeps its own ledger of what each session used. Nothing becomes an archive candidate until that ledger covers the whole window (60 days by default).
