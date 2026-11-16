---
name: sleep
description: Memory upkeep for Claude Code's auto memory. Shows which memory files the agent actually uses, checks the folder against best practices, archives memories that go unused, and merges unused feedback memories into fewer, sharper ones. Use when the user asks to tidy, clean up, audit, consolidate or "sleep" their memory, or asks which memories are used.
argument-hint: "[report | archive | consolidate [topic] | restore <file> | stats]"
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

It reads the memory of the project in the current folder (a worktree maps to its main checkout). The user asked for: $ARGUMENTS

Pick the flow from the arguments. With none, run **report**, then offer archive or consolidate if there is anything to do.

## Hard rules

- Never move, rename or delete a memory file yourself (no `mv`, `rm`, `git`). Only the command line moves files, so every move is recorded, committed and reversible.
- Ask before every change: `archive --apply`, each merge, `restore`. Use AskUserQuestion.
- Memory is the user's private data. Don't send it anywhere. In chat, show excerpts and proposed text, not whole folders.
- If the command line reports an error, tell the user what it said. Don't work around it.
- Write and Edit are for merged memories in **consolidate**, and nothing else. Don't fix failing checks, frontmatter or descriptions yourself; list them for the user, who can ask for a fix separately.
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

1. Run `archive` (a dry run). Summarize the moves: how many go to the archive, how many to the consolidation queue, and a few example names.
2. Ask before running `archive --apply`.
3. After it runs, give the commit hashes from the report, and how to undo: `restore <file>`, or `restore --all` for the whole run.

## consolidate

Merging is the one place where you write memory. Work on one topic per run unless the user asks for more.

1. Run `queue --json`. It returns `memDir` and the queued memories grouped by the file that links to them (usually a hub). Show the topics with their counts, and ask which one to merge, largest first. With more than about 12 files in a topic, take them in batches of about 10.
2. Read every memory in the batch (`<memDir>/<rel>`) and the hub that links to them.
3. Group the memories that state the same rule or lesson. Draft one merged memory per group, not one per topic. A memory that fits no group stays queued; don't force it.
4. Write each merged memory so that it:
   - keeps every distinct rule, number, date and named example, dropping only repetition;
   - keeps the **Why:** and **How to apply:** lines; where sources disagree, follows the newest and notes the older view in one line;
   - starts with frontmatter like the sources: `name` (matching the file name), a `description` of 150 characters or fewer using the words someone would search for, and `metadata.type: feedback`;
   - has a file name not already used in the memory folder or its `memory-archive/` folder.
5. For each proposed merge, show the user the full new text and the list of sources, and ask: approve, change, or skip.
6. For each approved merge, Write the new file at the top of the memory folder (`<memDir>/<name>.md`). Then run `merged --into <name>.md <source.md> ...`. This archives the sources, points every link at the new file, and commits. Never edit or remove the sources yourself.
7. If a hub line now links to the same merged file several times, offer to collapse those links into one, and Edit the hub only if the user agrees.
8. Finish with: the merges made, how many memories became how many, the commit hashes, and how to undo a merge (`git -C <memDir> revert <hash>`).

## restore

Confirm with the user, then run `restore <file>`, or `restore --all` to undo every move still in place.

## stats

Run `stats` and summarize the trend: memory size over time, how often archived memories were restored or read again (sleep's error rate), and how merged memories are used.
