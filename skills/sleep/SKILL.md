---
name: sleep
description: Memory upkeep for Claude Code's auto memory. Shows which memory files the agent actually uses, checks the folder against best practices, archives memories that go unused, and merges unused feedback memories into fewer, sharper ones. Use when the user asks to tidy, clean up, audit, consolidate or "sleep" their memory, or asks which memories are used.
argument-hint: "[report | open | archive | consolidate [topic] | restore <file> | schedule | stats]"
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/sleep.mjs" *)
  - Read
  - Glob
  - Grep
  - Write
  - Edit
  - AskUserQuestion
---

# Sleep

A bundled command line does everything that has a right answer: counting use, checking, moving files, rewriting links, committing to git. You do the parts that need judgment: explaining, and merging memories. Run it as:

```
node "${CLAUDE_PLUGIN_ROOT}/sleep.mjs" <command>
```

It reads the memory of the project in the current folder (a worktree maps to its main checkout). Memory is per project: if the user names another project, or the current folder has no memory, run `projects` to list every project with memory, and pass `--project <folder>` (or `--key <key>` when the folder is unknown) to each command. The user asked for: $ARGUMENTS

Pick the flow from the arguments. With none, run **report**, then offer archive or consolidate if there is anything to do.

## Hard rules

- Never move, rename or delete a memory file yourself (no `mv`, `rm`, `git`). Only the command line moves files, so every move is recorded, committed and reversible.
- Ask before every change: `archive --apply`, each merge, `restore`. Use AskUserQuestion.
- Memory is the user's private data. Don't send it anywhere. In chat, show excerpts and proposed text, not whole folders.
- If the command line reports an error, tell the user what it said. Don't work around it.
- Write is for merge drafts in the drafts folder (**consolidate**), and nothing else. Never write or edit inside the memory folder, except collapsing hub links in **consolidate** step 7 after the user agrees; the command line moves an approved draft in. Don't fix failing checks, frontmatter or descriptions yourself; list them for the user, who can ask for a fix separately.
- Say only what has happened. Never describe a change as done, under way or planned ("I'm archiving...", "after fixing...") before the user has approved it and the command line has run it. Offer changes as questions.
- No em dashes in anything you write.

## report

1. Run `report`. It prints the path of a markdown report; Read it.
2. Show the user this table, filled from the report, before anything else:

   | | |
   |---|---|
   | Memory files | |
   | MEMORY.md, loaded every turn | lines, about N tokens |
   | Usage on record | days, sessions |
   | Used / unused / unknown | |
   | Checks needing attention | names |
   | Archive candidates | |
   | Waiting to be queued for merging | |
   | Already in the merge queue | count of files in `consolidate/` |

3. If usage history is shorter than the window, say nothing will move until it covers the window, and when that will be.
4. For each failing check, give a one-line fix as a suggestion. The reasoning behind each check is in `${CLAUDE_PLUGIN_ROOT}/docs/best-practices.md`; read it only if the user asks why.
5. Offer only what can run now. Merging works on files already in the merge queue (`consolidate/`); if it is empty, `archive --apply` has to run first, so offer archive, not consolidate.

## archive

1. Run `archive` (a dry run). It prints `Review: <path>`, a local page with every move, its evidence and every link edit. Give the user that path, and summarize: how many go to the archive, how many to the merge queue, a few example names. To pick moves one by one, offer the served page: run `open`, which starts it in the background (or reuses it), opens it in the browser and stops by itself after 2 hours unused. It has Move and Keep boxes, an Apply button, a picker for the user's other projects, and a 3D map showing the folder before and after the plan.
2. Ask before running `archive --apply`, unless the user applied from the served page.
3. After it runs, give the commit hashes from the report, and how to undo: `restore <file>`, or `restore --all` for the whole run.

## consolidate

Merging is the one place where you write memory. Work on one topic per run unless the user asks for more.

1. Run `queue --json`. It returns `memDir`, the `drafts` folder, `notes` (what the user asked you to change in a draft, left on the review page), and the queued memories grouped by the file that links to them (usually a hub). If `notes` has entries, redo those drafts first: read the note, rewrite the draft in the drafts folder to follow it, and say what changed. Otherwise show the topics with their counts, and ask which one to merge, largest first. With more than about 12 files in a topic, take them in batches of about 10.
2. Read every memory in the batch (`<memDir>/<rel>`) and the hub that links to them.
3. Group the memories that state the same rule or lesson. Draft one merged memory per group, not one per topic. A memory that fits no group stays queued; don't force it.
4. Write each merged memory by the rules in `${CLAUDE_PLUGIN_ROOT}/docs/merge-rules.md` (read it first). The served page's Draft with Claude button follows the same file.
5. Write each draft to the `drafts` folder as `<name>.md`, with one extra frontmatter line naming its sources: `sleep_sources: a.md, b.md`. Then run `review`; it prints `Review: <path>`, a page showing each draft beside its sources. Give the user that path. On the served page (`open`) they can approve a merge, leave a note, or have Claude draft or redo merges there without this session.
6. Ask about each draft: approve, change, or skip. To change one, edit the draft and run `review` again. For each approved draft, run `merged --into <name>.md <source.md> ...`. It moves the draft into memory without the `sleep_sources` line, archives the sources, points every link at the merged memory, and commits. Delete nothing yourself; a skipped draft can stay in the drafts folder.
7. If a hub line now links to the same merged file several times, offer to collapse those links into one, and Edit the hub only if the user agrees.
8. Finish with: the merges made, how many memories became how many, the commit hashes, and how to undo a merge (`git -C <memDir> revert <hash>`).

## open

Run `open`. It starts the review page in the background, or reuses one already running, and opens it in the browser. It never prints the page's private address. Tell the user it stops by itself after 2 hours unused, or with `open --stop`. From the page they can apply moves, draft merges with Claude, approve them, and switch projects.

## restore

Confirm with the user, then run `restore <file>`, or `restore --all` to undo every move still in place.

## schedule

1. Run `schedule` to see what is set.
2. Ask how often (daily, weekly or monthly), and when. Suggest weekly, Monday 09:00, report only.
3. Report only is the default and changes nothing. Offer `--mode archive` (moves files with `archive --apply` on each run) only if the user asks for it, and say what it does before running it. Merging never runs on a schedule.
4. Run `schedule --every <daily|weekly|monthly> [--day D] [--at HH:MM] [--mode report|archive]`, and tell the user where the job and its log are. To stop it: `schedule --off`.

## stats

Run `stats` and summarize the trend: memory size over time, how often archived memories were restored or read again (sleep's error rate), and how merged memories are used.
