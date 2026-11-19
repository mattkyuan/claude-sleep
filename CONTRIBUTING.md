# Contributing

- **Tests:** `npm test` (Node 18 or later, and git). CI runs it on macOS and Linux with Node 18 and 22. A fix comes with a test that fails without it.
- **No dependencies.** Node's standard library only. The 3D view's bundled library lives in `vendor/` with its license.
- **Never touch real memory in tests.** Tests build a fake `~/.claude` in a temp folder (`tests/helpers.mjs`) and stand in for Claude with `tests/fake-claude.mjs`. To try a change by hand, use `node examples/demo.mjs`.
- **Fixtures are made up.** No real memory files, session logs, names or paths in the repo. Eval probes hold memory content, so they stay in `out/`, which git ignores.
- **UI changes** follow [docs/design.md](docs/design.md).
- **Writing:** plain words, short sentences, no em dashes, in code comments, docs and UI copy alike.
- **Plans** go in `docs/plans/`, dated, with a status line near the top. They record why, at the time; the README and `docs/*.md` say how things work now.
