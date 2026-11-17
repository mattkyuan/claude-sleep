// Tests for `sleep open`: it starts the review server in the background (or reuses a running one), never prints the
// private key, and stops it through the server itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fixture, standard, CLI } from "./helpers.mjs";

function setup(t, env = {}) {
  const fx = fixture(); standard(fx);
  const record = path.join(fx.claude, "sleep", "server.json");
  const run = (args) => spawnSync(process.execPath, [CLI, ...args, "--project", fx.project], { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: fx.claude, SLEEP_NO_BROWSER: "1", ...env } });
  const read = () => JSON.parse(fs.readFileSync(record, "utf8"));
  t.after(() => {
    run(["open", "--stop"]);
    try { const { pid } = read(); if (pid !== process.pid) process.kill(pid); } catch {}
  });
  return { fx, record, run, read };
}

const get = (url, headers = {}) => new Promise((resolve, reject) => {
  const u = new URL(url);
  http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }).on("error", reject);
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("open starts the server in the background, keeps the key out of its output, and reuses it the second time", async (t) => {
  const { record, run, read } = setup(t);
  const first = run(["open"]);
  assert.equal(first.status, 0, first.stderr);
  const rec = read();
  assert.ok(!first.stdout.includes(new URL(rec.url).searchParams.get("token")), "the key is not printed");
  assert.equal((fs.statSync(record).mode & 0o777).toString(8), "600", "only you can read the record");
  assert.equal(await get(rec.url), 303, "the recorded address opens the page");
  const second = run(["open"]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(read().pid, rec.pid, "the running server is reused");
  assert.match(second.stdout, /already running/);
});

test("open --stop stops the server through its own stop action and removes the record", async (t) => {
  const { record, run, read } = setup(t);
  assert.equal(run(["open"]).status, 0);
  const { pid } = read();
  const r = run(["open", "--stop"]);
  assert.equal(r.status, 0, r.stderr);
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.ok(!alive(pid), "server stopped");
  assert.ok(!fs.existsSync(record), "record removed");
});

test("a record that does not answer with its key is not trusted: open starts a fresh server", async (t) => {
  const { record, run, read } = setup(t);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  // A live pid (this test runner) on a port nothing serves: open must not believe it.
  fs.writeFileSync(record, JSON.stringify({ pid: process.pid, port: 1, url: "http://127.0.0.1:1/?token=stale" }));
  const r = run(["open"]);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(read().pid, process.pid);
  assert.equal(await get(read().url), 303);
});

test("a launched server stops by itself once nobody has used it for the idle time", async (t) => {
  const { record, run, read } = setup(t, { SLEEP_IDLE_MS: "600" });
  assert.equal(run(["open"]).status, 0);
  const { pid } = read();
  for (let i = 0; i < 60 && alive(pid); i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.ok(!alive(pid), "server exited when idle");
  assert.ok(!fs.existsSync(record), "and removed its record");
});
