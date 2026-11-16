// The memory folder's own git history: a snapshot before sleep changes anything and a commit after, so every
// run can be undone with git as well as with `sleep restore`. Commits are made as "sleep", with hooks and
// signing off, so they never pick up the user's identity or run the user's commit hooks.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ID = ["-c", "user.name=sleep", "-c", "user.email=sleep@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

export function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...ID, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed in ${dir}: ${(r.stderr || "").trim()}`);
  return r.stdout.trim();
}

export function ensureRepo(dir) {
  if (!fs.existsSync(path.join(dir, ".git"))) git(dir, ["init", "-q"]);
}

// Commits everything in the folder; returns the short hash, or null when there was nothing to commit.
// `leave` names files to keep out of this commit (a merged memory waits for the commit that archives its sources).
export function commitAll(dir, message, leave = []) {
  git(dir, ["add", "-A", "--", ".", ...leave.map((p) => `:(exclude)${p}`)]);
  if (!git(dir, ["diff", "--cached", "--name-only"])) return null;
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "--short", "HEAD"]);
}
