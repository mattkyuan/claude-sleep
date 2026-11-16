# claude-sleep

Memory upkeep for Claude Code. It shows which memory files the agent actually uses, checks the folder against [best practices](docs/best-practices.md), and moves what goes unused out of the way: project memories to an archive, feedback memories to a queue where they can be merged. Every run writes a report, and every change is a git commit you can undo.

Early: the command line and the `/sleep` skill work. Scheduling is next.

## Install

In Claude Code:

```
/plugin install sleep --marketplace mattkyuan/claude-sleep
```

Then run `/sleep` in any project. Requires Node 18 or later and git.

## Use the skill

| Ask | What happens |
|---|---|
| `/sleep` | A report: what's used, what fails a check, what could move |
| `/sleep archive` | Shows the moves, then moves them once you agree |
| `/sleep consolidate` | Merges queued lessons one topic at a time; you approve each merged memory |
| `/sleep restore <file>` | Puts a moved file back |
| `/sleep stats` | How well sleep is doing over time |

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
| `restore <file>` | Puts a moved file back where it was, links and all. `--all` undoes every move. |
| `queue` | The consolidation queue, grouped by the hub that links to each memory |
| `merged --into <file> <queued>...` | Records a merge the skill wrote: archives the sources and points their links at the merged file |
| `stats` | Memory size over time, and sleep's error rate: files restored after archiving, or read again from the archive |

| Flag | What it does |
|---|---|
| `--project DIR` | The project whose memory to read (default: the current folder) |
| `--days N` | How long a file must go unused before it moves (default 60) |
| `--apply` | Actually move files |
| `--purge-after N` | Delete archived files that nothing has read for N days since they were archived (default: never) |
| `--out DIR`, `--state DIR` | Where reports and sleep's own records go (default: `sleep/` next to the memory folder) |
| `--json` | Print the result as json instead of writing a report |

## What moves where

| Memory | Unused for the window | Where it goes |
|---|---|---|
| `project` | Yes, and nothing protected links to it | `memory/memory-archive/` |
| `feedback` | Yes | `memory/consolidate/`, to be merged; never archived or purged |
| `user`, anything MEMORY.md links to | Never moves | |

- Links to a moved file are rewritten, not deleted, so a line that lists several memories keeps its context.
- One line in MEMORY.md tells the agent to look in the archive and the queue only after the main files turn up nothing.
- Before changing anything, sleep commits the memory folder to its own git history, then commits again after.

## What counts as use

A file is used in a session when its text comes back in a tool result, whatever command fetched it (Read, cat, grep, a script). A single quoted error line doesn't count unless the command named the file. Sessions that edit memory are left out. Claude Code deletes session logs after 30 days, so sleep keeps its own ledger, and nothing moves until that ledger covers the full window.

## How well it works

Every command appends a line to `sleep/stats.jsonl`. `sleep stats` turns that into a trend and an error rate: a file sleep archived and you restored, or one the agent read again from the archive, counts as a mistake. It can't tell whether the agent got better; only fewer repeated mistakes would show that.

Everything stays on your machine. No dependencies.

## License

MIT
