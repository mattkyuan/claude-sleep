# Plan: Consolidate with Claude, see the difference, apply (2026-11-17)

Status: built 2026-11-17 (S1 to S6), local only; verified with the fake claude on scratch copies, not yet against a real Claude run. Mocks: `out/mock-consolidate.html`, `out/mock-3d-flow.html`, `out/mock-memory-md.html` (local, not committed).

One flow on the served page: look, ask Claude to consolidate, see what changed (numbers, side by side, 3D), apply what you like, then tighten MEMORY.md. Claude always runs with no tools; the server checks every answer and only the command line changes files.

## Slices

1. **Fact check.** Every draft gets a deterministic count of the facts its sources hold that it kept: PR and issue numbers, ISO dates, version numbers, file names and paths. It does not check rules or meaning, and says so. A draft missing any is flagged and starts unticked.
2. **One flow.** Claude can consolidate files the plan would move to Consolidate, not only files already there. Apply runs the picked moves first (`archive --apply --only`), then `merged --into` for each picked draft, so nothing is applied twice.
3. **Consolidate everything.** One job works through every topic in batches of up to 10, three batches at a time, with progress (batches, memories read, merged memories so far) and Stop. A topic's batches never share a source.
4. **Screens.** Start card (counts, time estimate, runs on your plan), running panel, result screen (memories and size before and after, facts kept, topic table with tick boxes, each draft beside its sources, Apply).
5. **3D map stages.** Now, Planned moves, Consolidated (drafts clustered by topic), Applied, drawn from the real plan and drafts.
6. **Tighten MEMORY.md.** Claude proposes line changes (graduate a closed line to its hub, or shorten) with a reason each. The server refuses a proposal unless: each old line exists exactly, every file linked today stays reachable (from MEMORY.md or a hub it links), the index stays under 200 lines and 25 KB, and there are no em dashes. Applied by a command (`index-apply`) and committed.

## Rules from review (2026-11-17)

- A draft records a hash of each source when written; merging refuses if a source changed since (offer Redo).
- Apply is a background job: moves, then each merge, with a result per draft. A draft whose sources no longer move is skipped with its reason; the rest go ahead.
- A batch may answer "no merges" (explicit marker). A new draft needs at least 2 sources. A name clash gets a suffix, not a failure. Sources an existing draft names are skipped, so a stopped run can resume.
- Every running child is tracked: Stop, exit and timeouts kill all of them. One failed batch does not fail the run.
- The result screen renders from disk (drafts plus a sidecar), not from the job in memory.
- The fact check is labelled for what it counts (numbers, dates, versions, paths), and highlights only those tokens.
- No "follow a merge" index change: index-linked files are never queued, and merges already rewrite links. Graduating a line shows that the file loses its index protection.
- Index changes apply as exact line replacements; caps and em dashes are checked on changed lines only.
- Verification uses the fake claude and scratch copies. A real run of everything needs Matt's OK.

## Changed while building (2026-11-17)

- Claude reads a memory once: `read.json` records what each finished batch read, with a hash, so a memory left unmerged is sent again only after it changes. Without it, every run re-sent every unmerged memory and the start card never cleared.
- A source's hash leaves out link targets, both `[text](path)` and `[[slug]]`. Merges in the same Apply rewrite slugs in other drafts' sources; before this, 16 of 77 fake merges on a copy of the real folder were skipped as changed.
- Each merge is its own commit, not one commit for the whole Apply. The page lists every merge commit for `git revert`.
- Undo gap, found on a scratch copy: `restore --all` after a merge undoes only half of it (the merged file and redirected links stay), and a `git revert` of a merge leaves `moves.json` saying it happened. The page now names `git revert` for merges and `restore --all` for moves only. A `sleep undo` that does both is not built.
- Not built: the start card's time estimate (no measured rate yet), and highlighting fact tokens inside drafts (the badge lists them instead).
- Apply cannot be stopped; Stop applies to Claude jobs only.

## Not in this plan

A local-model drafter (parked by Matt, 2026-11-17). Undo for an applied run is `sleep restore --all` for moves and `git revert` for merges and index edits; the page shows the commands after applying.
