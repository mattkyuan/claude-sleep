# claude-sleep

Memory upkeep for Claude Code. It shows which memory files the agent actually uses, checks the folder against [best practices](docs/best-practices.md), and moves what goes unused out of the way. Every run writes a report, and every change is a git commit you can undo.

Every memory file is in one of three places:

- **Keep:** memory Claude reads as usual.
- **Consolidate:** unused feedback, still searchable, waiting to be merged into fewer, sharper memories.
- **Archive:** retained, but not typically accessed. Unused project memories go here, and any file can be restored.

Early: the command line, the `/sleep` skill and scheduling work.

## Install

In Claude Code:

```
/plugin install sleep --marketplace mattkyuan/claude-sleep
```

Then run `/sleep` in any project. Requires Node 18 or later and git. Tested on macOS and Linux; Windows is untested (the memory folder names and scheduling there are unverified). On Linux a file's age is its creation time where the filesystem records one, and its last edit otherwise.

## Use the skill

| Ask | What happens |
|---|---|
| `/sleep` | A report: what's used, what fails a check, what could move |
| `/sleep archive` | Shows the moves, then moves them once you agree |
| `/sleep consolidate` | Merges queued lessons one topic at a time; you approve each merged memory |
| `/sleep restore <file>` | Puts a moved file back |
| `/sleep undo` | Takes back sleep's last step |
| `/sleep schedule` | Runs sleep on its own, weekly by default and report only |
| `/sleep stats` | How well sleep is doing over time |

## Consolidate with Claude

On the served page (`sleep open`), **Consolidate everything** runs `claude -p` with no tools, no MCP servers and nothing saved, in an empty folder, on every memory headed for Consolidate: batches of up to 10 per topic, 3 at a time, on your Claude plan. The page shows progress per topic and a Stop button, and you can close the tab. Claude reads a memory once: a later run sends only memories it has not read, or that changed since.

The server checks every draft before writing it: a safe name, at least 2 sources from the batch, and a count of the PR and issue numbers, dates, versions and paths its sources hold that it kept. The result shows memories and size before and after, then one row per topic to tick. A draft starts unticked when it dropped one of those facts, or when a source changed since Claude read it. Nothing changes until Apply: it moves the ticked files, then merges each ticked draft, and commits.

**Tighten MEMORY.md** asks Claude for line changes to the index: move a closed topic's line to a hub MEMORY.md links, or shorten a line. The server refuses a change unless the old line is in MEMORY.md exactly, every file MEMORY.md links stays reachable from it or a hub it links, it adds no em dash, and the index stays within 200 lines and 25 KB. The page says which files lose the index's protection from archiving. Apply runs `index-apply`, one commit.

**Undo last step** on the page, or `sleep undo`, takes back the last thing sleep did; one Apply counts as one step, moves and merges together. It reverts those commits in the memory folder and puts sleep's own records back (the moves list, and a draft a merge used up, ready to apply again), so a later run sees the folder as it was. If you edited the same lines since, it refuses and changes nothing.

## Run the command line directly

```bash
node sleep.mjs report --project ~/code/my-project
```

```bash
node sleep.mjs archive --project ~/code/my-project
```

```bash
node sleep.mjs archive --apply --project ~/code/my-project
```

| Command | What it does |
|---|---|
| `report` | Inventory, usage, checks, and what could move. Changes nothing. |
| `archive` | Shows what would move. With `--apply`, moves it. |
| `restore <file>` | Puts a moved file back where it was, links and all. `--all` restores every moved file; to take back a merge, use `undo`. |
| `undo [--list]` | Takes back sleep's last step (one Apply from the page is one step): reverts its commits and puts the moves list and any used-up draft back. `--list` shows the steps, newest first. |
| `queue` | What is in Consolidate, grouped by the hub that links to each memory |
| `merged --into <file> <queued>...` | Records a merge the skill wrote: archives the sources and points their links at the merged file |
| `index-apply --changes <file.json>` | Applies line changes to MEMORY.md (and lines added to its hubs) that the served page proposed, after checking them again, in one commit |
| `review --serve [--port N]` | The same page on 127.0.0.1, where you decide: tick or untick each move and each merge draft, Move all or Keep all per hub, then one Apply moves the files and merges the ticked drafts; leave Claude a note to redo a draft. A picker at the top switches to any other project with memory. The address carries a private key; every action is checked against sleep's own plan and runs the command line, so it is committed and can be undone. |
| `open [--stop]` | Start the served page in the background, or reuse it, and open it in your browser. It stops by itself after 2 hours unused. See "Consolidate with Claude" below. |
| 3D map | On the served page, the map sits beside the text (Split), or fills the window (Map). It draws every memory file on its floor (MEMORY.md, Keep, Consolidate, Archive) with its links, in four steps: the folder now, the moves, Claude's drafts clustered by topic beside the files they replace, and the folder once applied. It follows your ticks, so Applied shows what Apply will do. Hover a row to find its sphere; click a sphere to open its row. The step follows the section you are reading. Read only. |
| `projects [--json]` | Every project with memory, with its folder and file count. Memory is per project, so this is the way to find the others. |
| `review [--open]` | A local page with every proposed move, its evidence, each link edit as before and after, and merge drafts beside their sources. Changes nothing. An `archive` dry run writes one too. |
| `stats` | Memory size over time, and sleep's error rate: files restored after archiving, or read again from the archive |

| Flag | What it does |
|---|---|
| `--project DIR` | The project whose memory to read (default: the current folder) |
| `--key KEY` | The same, by its folder name under `~/.claude/projects`, as `projects` lists it |
| `--days N` | How long a file must go unused before it moves (default 60) |
| `--apply` | Actually move files |
| `--purge-after N` | Delete archived files that nothing has read for N days since they were archived (default: never) |
| `--only FILE` | archive: move only the planned files named in FILE, a JSON list (what the served page sends); no purge |
| `--out DIR`, `--state DIR` | Where reports and sleep's own records go (default: `sleep/` next to the memory folder) |
| `--json` | Print the result as json instead of writing a report |

## What moves where

| Memory | Unused for the window | Where it goes |
|---|---|---|
| `project` | Yes, and nothing protected links to it | `memory/memory-archive/` |
| `feedback` | Yes | `memory/consolidate/`, to be merged; never archived or purged |
| `user`, anything MEMORY.md links to | Never moves | |

- Links to a moved file are rewritten, not deleted, so a line that lists several memories keeps its context.
- One line in MEMORY.md tells the agent to look in Archive and Consolidate only after the main files turn up nothing.
- Before changing anything, sleep commits the memory folder to its own git history, then commits again after.

## Schedule it

```bash
node sleep.mjs schedule --every weekly --day mon --at 09:00
```

- `--every` is `daily`, `weekly` or `monthly`; `--day` is a weekday, or a day of the month from 1 to 28.
- `--mode report` (the default) changes nothing. `--mode archive` runs `archive --apply` each time. Merging never runs on a schedule.
- On macOS this installs a launchd job; elsewhere it prints a crontab line to add. `schedule` alone shows what is set, and `schedule --off` removes it.
- Settings live in `sleep/config.json` next to the memory folder. `days` (the window) and `purgeAfterDays` there apply to every run; a flag on the command line wins.

## What counts as use

A file is used in a session when its text comes back in a tool result, whatever command fetched it (Read, cat, grep, a script). A single quoted error line doesn't count unless the command named the file. Sessions that edit memory are left out. Claude Code deletes session logs after 30 days, so sleep keeps its own ledger, and nothing moves until that ledger covers the full window.

## How well it works

Every command appends a line to `sleep/stats.jsonl`. `sleep stats` turns that into a trend and an error rate: a file sleep archived and you restored, or one the agent read again from the archive, counts as a mistake. It can't tell whether the agent got better; only fewer repeated mistakes would show that.

To check whether Claude still applies its memory after a run, `eval/` holds a before-and-after harness: task prompts run with `claude -p` on your subscription against scratch copies of the memory folder, scored against bars fixed in advance. See [docs/plans/2026-11-17-eval.md](docs/plans/2026-11-17-eval.md). Probes hold memory content, so keep them in `out/eval/`, which git ignores.

Everything stays on your machine. No dependencies.

## License

MIT
