# Design principles

These are the rules for sleep's review page, and for any UI sleep adds later.

1. **The page decides, the command line acts, Claude drafts.** The page records choices. Only the command line moves files. Claude only drafts merges, and rewrites a draft when you leave it a note. When the page asks Claude, Claude gets no tools: it answers with text, and the server checks each draft (a safe new name, sources from the batch it chose) before writing it.
2. **Nothing happens until you apply it, and the page says so.** A change takes two clicks. Every applied run is committed to the memory folder's own git history, and the page shows how to undo it.
3. **Every decision has its evidence beside it:** why the file was picked, when it was created, when it was last used, and in how many sessions.
4. **Decide in bulk, inspect in detail.** Groups have Move all and Keep all buttons, and any row opens to show the file or the change.
5. **Show changes as before and after.** Link edits are shown as removed and added lines, and each draft sits beside its sources.
6. **Private and local.** The page runs on 127.0.0.1 only and loads nothing from outside: the 3D map's library is a vendored copy (`vendor/graph3d.mjs`, see `vendor/LICENSES.md`) served from the same address. The address carries a private key, and the server checks every request against its own plan, whatever the page sends. The project picker offers only projects the server found on disk, and every action names its project, so a tab left open on one project never acts on another. Memory text is always escaped.
7. **Sister to harness-map:** same palette, same type, same serve model, dark first, and the same 3D library and version (3d-force-graph 1.77.0, three 0.180.0), so the two can merge into one tool.
8. **Plain words.** Say what will happen, never that it "is being done". No em dashes.
9. **Text decides, the map shows.** Every decision is a tick in the text. The 3D map beside it is a view of those ticks, never a second control: it draws each step from `lib/steps.mjs`, the same code the server uses. So the Applied step always matches what Apply will do, and its counts match the Apply button.
10. **One selection across both halves.** Hovering or focusing a row lights its sphere, and a topic lights its cluster. Clicking a sphere opens and flashes its row; a file with no row shows a small card in the pane. The step follows the section being read, and a step button holds until the section changes.
11. **The map is optional.** The page works whole without it: the 3D loads only when shown, and if it cannot start, the pane says so and Apply still works. Below 900px there is no split; Map opens over the page. Reduced motion turns off Play and camera easing.

The file version (`sleep review`) only shows: it has no scripts. The served version (`sleep review --serve`) runs its page script and the map module, each tagged by the server with a fresh nonce on every load. The module loads two more modules (`/lib/mapview.mjs`, `/lib/steps.mjs`) and the vendored 3D library, all from the same address.
