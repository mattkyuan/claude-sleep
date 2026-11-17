# Merge rules

How a merged memory is written, whether by `/sleep consolidate` in a session or by Draft with Claude on the review page.

1. Group the memories that state the same rule or lesson. Write one merged memory per group, not one per topic. A memory that fits no group stays queued; don't force it.
2. Keep every distinct rule, number, date and named example. Drop only repetition.
3. Keep the **Why:** and **How to apply:** lines. Where sources disagree, follow the newest and note the older view in one line.
4. Start with frontmatter like the sources: `name` (matching the file name without `.md`), a `description` of 150 characters or fewer using the words someone would search for, and `metadata.type: feedback`.
5. Add one line naming the sources: `sleep_sources: a.md, b.md`. Name only memories from the batch, and each in one draft at most.
6. Use a file name of letters, digits, dots, dashes and underscores, ending in `.md`, that no memory already has.
7. Write plain words. No em dashes.
