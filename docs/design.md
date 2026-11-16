# Design principles

These are the rules for sleep's review page, and for any UI sleep adds later.

1. **The page decides, the command line acts, Claude writes.** The page records choices. Only the command line moves files. Claude only drafts merges, and rewrites a draft when you leave it a note.
2. **Nothing happens until you apply it, and the page says so.** A change takes two clicks. Every applied run is committed to the memory folder's own git history, and the page shows how to undo it.
3. **Every decision has its evidence beside it:** why the file was picked, when it was created, when it was last used, and in how many sessions.
4. **Decide in bulk, inspect in detail.** Groups have Move all and Keep all buttons, and any row opens to show the file or the change.
5. **Show changes as before and after.** Link edits are shown as removed and added lines, and each draft sits beside its sources.
6. **Private and local.** The page runs on 127.0.0.1 only and loads nothing from outside. The address carries a private key, and the server checks every request against its own plan, whatever the page sends. Memory text is always escaped.
7. **Sister to harness-map:** same palette, same type, same serve model, dark first.
8. **Plain words.** Say what will happen, never that it "is being done". No em dashes.

The file version (`sleep review`) only shows: it has no scripts. The served version (`sleep review --serve`) runs one script, which the server tags with a fresh nonce on every load.
