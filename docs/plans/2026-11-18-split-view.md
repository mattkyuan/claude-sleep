# Plan: one page, text and 3D together (2026-11-18)

Status: built 2026-11-18 (S1 to S6), checked in a browser on a scratch copy of a real memory folder. Written before building; changes while building are marked. Decided with Matt on 2026-11-18: split view with shared selection.

## Why

The review page (text) and the memory map (3D) are separate pages joined by a button:
- **No shared selection.** A row cannot show where its file sits, and a node cannot open its row.
- **The map ignores your ticks.** It always draws the default plan, so its Applied step can disagree with what Apply will do.

## What changes

One served page with a sticky 3D pane beside the text. The text page still works whole without it: the file version (`sleep review`) stays script-free, and the text stays the source of every decision.

### S1. Step logic shared by server and page
- **New `lib/steps.mjs`, pure, no Node imports:** `stepsFor(data, { moves, drafts })` returns each node's floor at the four steps, plus its status.
  - `data` is what `lib/graph.mjs` builds.
  - `moves` and `drafts` are the ticked names.
  - With no ticks given, it uses the page's defaults: every move ticked, every draft without a warning ticked.
- **Applied step rules, copied from `/apply-all` and `merged` in `sleep.mjs`, not restated:**
  - **Files that move:** the ticked moves plus every source of a ticked draft (Apply passes both to `archive --apply --only`). A draft's planned source therefore moves even when its own row is unticked.
  - **A ticked draft merges** only when every source is in Consolidate after those moves and none changed since Claude read it. Otherwise `merged` refuses it and Apply skips it, with its sources left where the moves put them.
  - **An unticked draft** stays a draft, and its sources go only where their own ticks send them.
- **Parity test:** run a real Apply on a fixture with chosen ticks, through `/apply-all`, and check the folder against `stepsFor`'s Applied step. Without that test, the map is a second implementation that can drift.
- **`/map` stays green through S1:** `memoryGraph` computes today's output through `stepsFor` with default ticks, and the five map tests pass unedited.
- **`lib/graph.mjs`** emits plain data instead of fixed floors:
  - each node's current floor, its planned move kind, its links;
  - each draft's sources, topic and default tick.
- **Node ids stay file names.** Names are unique across the folders sleep reads (`readMemory` lists only the files sleep moved into `memory-archive/`), and the page's tick values and the server's checks already use names.
- **Served:** the page loads `lib/steps.mjs` from `/lib/steps.mjs`, through the server's exact-path `files` map, as it does `vendor/graph3d.mjs`.

### S2. Split layout

- **CSP:** the policy lives in two places, the `<meta>` in `reviewHtml` and the header at `lib/serve.mjs:53`, and both apply. Start from `mapCsp`, which already runs the 3D. Check the browser console for violations, since a test of the policy string cannot see a blank canvas.
- **Keep the map's guarantees on the page:** no eval, the graph JSON escaped, nothing from another origin. Each has a test. `serve.test.mjs:36` pins the old policy and will change.
- **Size from the pane, not the window.** Mount only once the pane has a size. A WebGL or import failure shows a note in the pane and never breaks Apply.
- **`lib/map.mjs`:** its script becomes a module, `lib/mapview.mjs`, served at `/lib/mapview.mjs`. It exports `mountMap(el, data, hooks)` and returns `{ setStep, setTicks, highlight, focus, resize }`.
- **The review page** gets a right pane, sticky and full height, holding the mount. It shows the step buttons, the floor counts and the legend.
  - The 3D loads only once the pane is visible: on a wide screen at load, on a phone when the strip opens.
- **View switch in the header:** Text, Split and Map. The choice is remembered in `localStorage`, wrapped in try/catch.
  - Map hides the text column.
  - `/map` redirects to `/?view=map`, so there is one page and one script.
- **Phone width:** changed while building. There is no split below 900px: Text is the default, and Map opens the pane over the page, from the same view switch. A strip was not needed.
- **CSP:** the served page adds `'self'` to `script-src` for the two served modules. Nothing loads from outside 127.0.0.1.

### S3. Shared selection
- **Markup:** every move row, draft card, draft source and topic row carries `data-node="<id>"`.
- **Text to 3D:**
  - hovering a row lights its node and links and dims the rest;
  - hovering a topic lights its cluster;
  - focusing a row by keyboard does the same.
- **3D to text:** clicking a node scrolls to its row, opens its `<details>` and flashes it.
  - A node with no row (a file that stays in Keep) shows a small card in the pane: name, description, last used, links.
- **Hover tooltips** in the 3D stay as they are.

### S4. Ticks drive the map
- Every change to a move, draft or topic tick calls `setTicks`. The Planned and Applied steps redraw from `stepsFor`.
- **Floor labels and pane counts** come from the same `stepsFor` result as the Apply button's counts, so the numbers always agree.

### S5. The step follows the reading

The step follows the section you are reading, in whatever order the page shows them. When drafts exist the order is Drafts, Archive, Consolidate, so scrolling down goes from step 3 back to step 2. That is intended: the map shows what you are reading. A change waits 250 ms (debounced), since each step change reheats the layout.

- **Section in view sets the step** (IntersectionObserver). The section-to-step table is a pure function in `steps.mjs`, tested in node:
  - Archive or Consolidate: Planned moves;
  - Merge drafts: Claude consolidates;
  - pointing at or focusing Apply: Applied. Changed while building: the bar is fixed, so it is always in view.
- **Override:** a step button holds its step until the next scroll that changes the section.
- **Reduced motion** (`prefers-reduced-motion`): no Play, no eased camera, steps snap.

### S6. Docs
- `docs/design.md` gains the shared-selection principles: text is the source of decisions, 3D is a view of them, and the two never disagree.
- README gets a split-view screenshot from the demo folder (step F).

## Tests (each fails on broken code)
- **`stepsFor`:**
  - default ticks reproduce today's four steps on the map test fixture;
  - an unticked move stays;
  - an unticked draft keeps its sources in Consolidate;
  - a ticked draft carries its planned source even when that move is unticked;
  - a draft with a changed source, or one planned for Archive, does not merge;
  - the parity test: a real Apply with the same ticks leaves the folder as Applied says.
- **Served page:**
  - the pane, view switch, `data-node` on rows, and the module script tags;
  - `/map` redirects;
  - the CSP allows `'self'` scripts and still no outside origin;
  - the file version has no scripts.
- **Server data:** the graph JSON holds no memory body text, only names, descriptions and sizes, as today.
- **Browser check, by hand on a scratch copy:**
  - hover and click both ways;
  - unticking a draft changes Applied;
  - scrolling changes the step;
  - the phone strip works.

## Not in this plan
- A search box that filters both halves.
- Undo history as a timeline.
- Per-node "why" evidence in the pane, beyond the small card.
