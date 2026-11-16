# claude-sleep

Memory upkeep for Claude Code. It shows which memory files the agent actually uses, checks the folder against [best practices](docs/best-practices.md), and lists what could be archived. Every run writes a report.

Early: `sleep report` works today. Archiving, the `/sleep` skill and scheduling are next.

## Run it

```bash
node sleep.mjs report --project ~/code/my-project
```

It reads `~/.claude/projects/<project>/memory/` and that project's session logs, and writes a report to `memory-archive/reports/` next to the memory folder. It never changes the memory folder.

| Flag | What it does |
|---|---|
| `--project DIR` | The project whose memory to read (default: the current folder) |
| `--days N` | How long a file must go unused before it can be archived (default 60) |
| `--out DIR` | Where to write the report |
| `--state DIR` | Where the usage ledger lives |
| `--json` | Print the report as json instead of writing files |

## What it counts as use

A file is used in a session when one of its lines comes back in a tool result, whatever command fetched it. Sessions that edit memory are left out. Because Claude Code deletes logs after 30 days, sleep keeps its own ledger, and nothing becomes an archive candidate until that ledger covers the full window.

Everything stays on your machine. Requires Node 18 or later; no dependencies.

## License

MIT
