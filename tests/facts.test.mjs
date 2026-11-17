// Tests for the fact check: which numbers, dates, versions and paths in a draft's sources the draft kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { factsOf, checkFacts } from "../lib/draft.mjs";
import { mem, fixture, standard } from "./helpers.mjs";

test("factsOf finds PR and issue numbers, ISO dates, versions, and file names and paths", () => {
  const f = factsOf("Seen in PR #193 and #1382 on 2026-08-19. Local ruff 0.15.21 vs v0.16.3. Edit scripts/hooks/ruff_fix.sh and `requirements.txt`.");
  assert.deepEqual([...f].sort(), ["#1382", "#193", "0.15.21", "0.16.3", "2026-08-19", "requirements.txt", "scripts/hooks/ruff_fix.sh"].sort());
});

test("factsOf ignores what is not a fact it can check: plain decimals, bare years, prose", () => {
  assert.deepEqual([...factsOf("LOEUF 0.49 in 2026, about 1.5x faster, see the docs.")], []);
});

test("checkFacts counts the facts the draft kept and names the ones it dropped", () => {
  const sources = ["Run ruff before #193 and #309.", "CI ruff 0.16.3 differs (2026-08-14)."];
  const kept = checkFacts("Run ruff (#193, #309); CI uses 0.16.3 since 2026-08-14.", sources);
  assert.deepEqual(kept, { total: 4, kept: 4, missing: [] });
  const dropped = checkFacts("Run ruff (#193). CI differs.", sources);
  assert.equal(dropped.kept, 1);
  assert.deepEqual(dropped.missing.sort(), ["#309", "0.16.3", "2026-08-14"].sort());
});

test("a fact counts as kept only as a whole token, not inside a longer one", () => {
  assert.deepEqual(checkFacts("See #1930 and 2026-08-190.", ["See #193 on 2026-08-19."]).missing.sort(), ["#193", "2026-08-19"]);
});

test("each draft on the review page says which counted facts it kept or dropped", () => {
  const fx = fixture(); standard(fx);
  fx.write("theta.md", mem("theta", "feedback", "Slow suite", "Run the slow suite on the merge queue, since PR #193 on 2026-08-19."));
  fx.write("iota.md", mem("iota", "feedback", "Retry once", "Retry a flaky test once (ruff 0.16.3)."));
  fx.session([{ tool: "Bash", input: { command: "ls" }, result: "x" }], { ageDays: 70 });
  const flags = ["--project", fx.project, "--state", fx.state, "--days", "60"];
  assert.equal(fx.run(["archive", "--apply", ...flags]).status, 0);
  const drafts = path.join(fx.state, "drafts");
  fs.mkdirSync(drafts, { recursive: true });
  const draft = (name, body) => fs.writeFileSync(path.join(drafts, name), `---\nname: ${name.slice(0, -3)}\ndescription: x\nsleep_sources: theta.md, iota.md\nmetadata:\n  type: feedback\n---\n\n${body}\n`);
  draft("good.md", "Slow suite on the merge queue since #193 (2026-08-19); retry once (ruff 0.16.3).");
  draft("lossy.md", "Slow suite on the merge queue; retry once.");
  const html = fs.readFileSync(fx.run(["review", ...flags]).stdout.match(/Review: (\S+)/)[1], "utf8");
  assert.match(html, /data-draft="good\.md"[\s\S]*?kept all 3 numbers, dates, versions and paths/);
  assert.match(html, /data-draft="lossy\.md"[\s\S]*?dropped 3 of 3: [^<]*#193/);
});
