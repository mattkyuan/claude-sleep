# Plan: sleep against Claude Code's auto-dream (2026-11-19)

Status: parked after step 0 (2026-11-19). Auto-dream is server-gated off for the account that would run it, so arm D could only be a replica. See "Step 0 result" below. Nothing after step 0 has run, and no arm D answer exists. If the plan resumes, its bars and frozen inputs stand as written. It reuses run 1's frozen probes (sha256 `1c0a1bb9…`) and rubric (`466905b6…`) unchanged. Harness: `eval/run.mjs`, `eval/score.mjs`, as in `2026-11-17-eval.md`.

## Question

Claude Code 2.1.328 ships auto-dream, a background pass that reads recent sessions and rewrites the memory folder. Does memory after one auto-dream pass keep what Claude needs as well as memory after a sleep run?

This measures memory quality only. Review before change, usage evidence and undo are not measured; the README lists them as differences, not results.

## What auto-dream appears to be

Read from strings in the 2.1.328 binary on 2026-11-19. Step 0 confirms each point by watching a pass.

- The setting `autoDreamEnabled` overrides a server default; it is off while auto memory is off.
- Gates: 24 hours since the last pass and 5 sessions touched since then (`minHours`, `minSessions`, both server-overridable). A forced path skips the gates; whether a user can reach it (a `/dream` command) is unknown.
- It takes a lock, reads sessions touched since the last pass, and writes memory directly. No file undo was found; the "rollback" in its code resets the run timer.
- It can stop early when capped, and settles writes from a partial pass.

## Arms

| Arm | Folder |
|---|---|
| A | before: run 1's arm A copy, frozen 2026-11-18 |
| C | after a full sleep run: run 1's arm C copy |
| D | after one auto-dream pass on a copy of A, built in step 1 |

- A and C moved to `~/Dev/claude-sleep-private` after run 1. Before anything runs, their hashes must match run 1's `arms.json`, or the plan stops.
- Same probes, rubric, model (Sonnet, pinned and recorded), flags and harness as run 1.
- A and C are run again rather than reused, so model drift since 2026-11-18 hits all arms alike.
- D is one pass of a stochastic process. The result says so, and does not generalise to auto-dream as a whole.

## Steps

### 0. Can a pass run in a scratch config? (needs OK: one pass on the made-up demo folder)

Use a new signed-in config folder made for this, not `~/.claude` and not `~/.claude-ablation`; the latter is shared with other evals, so its settings stay untouched. Run it on `examples/demo.mjs` output.

1. Look for a manual trigger (`/dream`) in an interactive session.
2. If there is none:
   - set `autoDreamEnabled: true`;
   - age the last-pass marker past 24 hours;
   - give it 5 or more demo sessions, with their mtimes inside the window;
   - start one interactive session and wait.
3. Record:
   - whether it fires and which sessions it reads;
   - every path it writes, memory files or otherwise (lock, marker, task or storage files);
   - whether the writes land as plain files in the scratch memory folder;
   - which model it uses, how long it takes, and whether the pass was capped.

If no pass can be made to fire (server gate, sign-in), arm D becomes a replica: the dream prompt run with `claude -p` and Read, Write and Edit on the arm. The result then opens with "replica, not the shipped feature".

#### Step 0 result (2026-11-19): no pass can fire, plan parked

Run in the existing eval config rather than a new one, with the user's OK. Its settings file was not changed: the setting was passed with `--settings`.

- **No manual trigger.** The forced path in the binary always returns false, so there is no `/dream`.
- **Server-gated off.** The pass is enabled only when a server flag is on. The setting `autoDreamEnabled` is read only after that check, so it cannot turn the pass on by itself. The flag cached in both the user's config and the eval config reads `{"enabled": false, "minHours": 24, "minSessions": 3, "remoteEnabled": false}`.
- **Gates differ from the published write-ups.** The server sets `minSessions` to 3; the binary's default is 5.
- **Observed.** One clean interactive session on the demo folder, with the setting on and 9 demo sessions in the window, finished its turn. It wrote no dream log and no lock file.
- **Real memory untouched.** A sha256 snapshot of all 960 files matched before and after. The demo project was deleted afterwards. The eval config now has first-run setup done and the demo folder trusted.

Learned on the way, for whoever resumes this:
- Claude Code will not trust a folder laid out like a session scratchpad (`claude/<project>/<session>/scratchpad`), so the demo has to live elsewhere.
- A session started from inside a desktop Claude Code session inherits its `CLAUDE_*` and `ANTHROPIC_*` variables, including the child-session marker (which turns transcript saving off), `CLAUDE_CODE_SIMPLE` and the app's `ANTHROPIC_BASE_URL`. Start it with `env -i`.
- `eval/run.mjs` passes `process.env` through, so runs 1 and 2 likely ran with those variables set. Every arm got the same environment, so their comparisons hold, but the harness should start calls from a clean environment before the next run.

The replica arm was not built. It would test the dream prompt, not the shipped feature, and resume when the flag is on for this account or a replica result is wanted. If the flag turns on, the G-phase risk returns: auto-dream could rewrite files sleep has queued.

### 1. Build arm D (needs OK: one pass on a copy of the real project's memory)

- Copy arm A, with its dates kept (`dates.mjs`), into the scratch config's project memory.
- **Session window.** Copy the real project's session logs from the 30 days before 2026-11-17 next to it, keeping their mtimes.
  - Leave out every session from 2026-11-17 on: that is when the probes, rubric and arms were written, so those logs hold the answers.
  - Also leave out any earlier session whose log mentions sleep's own files.
  - The window used, and the session count, go in the result.
  - Sleep's usage counts read logs up to 2026-11-18, so the two arms saw slightly different history. The result says so.
- **Real-memory guard.** The copied logs name the real memory folder by absolute path, and the pass has write tools.
  - Take a sorted stat and sha snapshot of the real folder before and after steps 0 and 1. Any difference stops everything.
  - Block writes to the real folder with a deny rule in the scratch config.
- **Freeze.**
  - Hash D. Record files added, removed and edited, MEMORY.md lines, and total size.
  - Remove auto-dream's own lock and marker files from the arm (they would name the arm to the answering model), and log what was removed.
- Everything stays under `~/Dev/claude-sleep-private`.

### 2. Each probe's fate per arm (no Claude calls)

Every probe names its `source` file. For C, `moves-C.json` gives each source's fate: kept, archived or merged. For D, the diff from step 1 gives it: kept as is, edited, merged into another file, or deleted.

Then check fact survival:
- for each probe, is its judge line's fact or rule still stated somewhere in the arm?
- run a grep for the judge line's key terms first, then read every miss by hand.

The rubric judges an answer against the judge line only, so no rule depends on sleep's folders. A fact that sits only in C's archive counts as surviving in C, because Claude can still read it there.

### 3. Harness changes (tests first, each mutation-checked)

- `run.mjs` refuses to start unless the eval config has `autoDreamEnabled: false`, so no pass fires during probes. Setting it is a deliberate one-line change to the shared config, made with the user's OK. The existing per-call hash check still catches any write.
- `score.mjs` scrubs whatever names step 0 finds auto-dream writes, and `bundle` refuses if one is left.

### 4. Run (needs OK: subscription calls)

- Run 1's 40 probes, arms A, C and D, 3 repeats each: 360 calls, interleaved as before.
- Judging is unchanged: blind judge subagents, then `score.mjs report`, with every fail read by hand.

## Bars (frozen with this file)

**Primary: fact survival (step 2).** Count the probes whose fact survives in D but not in C, and the reverse.

| Result | Reading |
|---|---|
| D loses at least 3 more than C | auto-dream drops facts sleep keeps |
| C loses at least 3 more than D | the reverse |
| Otherwise | no difference found |

Every lost fact is listed by probe id and kind.

**Descriptive only: pass rate.**
- Report D minus C and D minus A, with 95% intervals from a bootstrap that resamples probes, not single answers.
- At 40 probes the interval will be wide, so the only claim allowed is "worse", made when the whole interval lies below 0. Otherwise the result is reported as the numbers alone.
- Also reported: tokens per answer and MEMORY.md size.
- Void answers are counted and named, never dropped.
- Run 2's 12 probes were chosen from what sleep merged, so they are not run here and never pooled with these.

## What the result changes

- The README gets a short section on sleep and auto-dream, written from the result either way, saying whether to run both.
- If both are on, sleep's report should warn that auto-dream may rewrite files sleep has queued.
- If D keeps facts as well as C does, the README leads with what sleep adds: usage evidence, review before change, and undo.

## Privacy

Memory copies, session logs, answers and verdicts stay in `~/Dev/claude-sleep-private`. This file and the published result carry counts, probe ids, kinds and intervals only, with no memory names or content and no name for the real project.
