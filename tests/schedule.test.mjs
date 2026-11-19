// Tests for `sleep schedule` and config.json. launchctl is never called: SLEEP_LAUNCH_AGENTS points the plist at a
// temp folder and SLEEP_NO_LAUNCHCTL skips loading it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, standard, key, CLI, BETA, DELTA } from "./helpers.mjs";

function setup() {
  const fx = fixture(); standard(fx);
  const agents = path.join(fx.claude, "LaunchAgents");
  const env = { SLEEP_LAUNCH_AGENTS: agents, SLEEP_NO_LAUNCHCTL: "1", SLEEP_PLATFORM: "darwin" };
  const run = (args, extra = {}) => fx.run([...args, "--project", fx.project, "--state", fx.state], { ...env, ...extra });
  const plist = () => path.join(agents, `com.claude-sleep.${key(fx.project).replace(/^-+/, "")}.plist`);
  const config = () => JSON.parse(fs.readFileSync(path.join(fx.state, "config.json"), "utf8"));
  return { fx, run, plist, config, agents };
}

test("schedule installs a weekly report-only job by default and records it in config.json", () => {
  const { fx, run, plist, config } = setup();
  const r = run(["schedule", "--every", "weekly"]);
  assert.equal(r.status, 0, r.stderr);
  const p = fs.readFileSync(plist(), "utf8");
  // Absolute node and script, the report command, this project, this state folder.
  for (const s of [CLI, "<string>report</string>", fx.project, fx.state]) assert.ok(p.includes(s), s);
  // The node it runs is this node, by a path that survives a node upgrade where there is one.
  const node = /<array>\s*<string>([^<]+)<\/string>/.exec(p)[1];
  assert.equal(fs.realpathSync(node), fs.realpathSync(process.execPath));
  assert.ok(!node.includes("/Cellar/"), node);
  assert.ok(!p.includes("--apply"), "report-only by default");
  assert.match(p, /<key>Weekday<\/key>\s*<integer>1<\/integer>/);
  assert.match(p, /<key>Hour<\/key>\s*<integer>9<\/integer>/);
  assert.match(p, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.ok(p.includes(path.join(fx.state, "schedule.log")));
  assert.deepEqual(config().schedule, { every: "weekly", day: "mon", at: "09:00", mode: "report" });
});

test("schedule takes a day, a time and archive mode", () => {
  const { run, plist, config } = setup();
  assert.equal(run(["schedule", "--every", "weekly", "--day", "fri", "--at", "18:30", "--mode", "archive"]).status, 0);
  const p = fs.readFileSync(plist(), "utf8");
  assert.ok(p.includes("<string>archive</string>") && p.includes("<string>--apply</string>"));
  assert.match(p, /<key>Weekday<\/key>\s*<integer>5<\/integer>/);
  assert.match(p, /<key>Hour<\/key>\s*<integer>18<\/integer>/);
  assert.match(p, /<key>Minute<\/key>\s*<integer>30<\/integer>/);
  assert.equal(config().schedule.mode, "archive");
  assert.equal(run(["schedule", "--every", "daily", "--at", "07:05"]).status, 0);
  assert.ok(!/<key>Weekday<\/key>/.test(fs.readFileSync(plist(), "utf8")), "daily has no weekday");
});

test("schedule refuses values it cannot run", () => {
  const { run, plist } = setup();
  for (const args of [["--every", "hourly"], ["--every", "weekly", "--day", "someday"], ["--every", "daily", "--at", "25:00"], ["--every", "weekly", "--mode", "consolidate"]]) {
    const r = run(["schedule", ...args]);
    assert.notEqual(r.status, 0, args.join(" "));
  }
  assert.ok(!fs.existsSync(plist()));
});

test("schedule --off removes the job; schedule alone shows what is set", () => {
  const { run, plist, config } = setup();
  run(["schedule", "--every", "weekly"]);
  assert.match(run(["schedule"]).stdout, /weekly on mon at 09:00, report only/);
  assert.equal(run(["schedule", "--off"]).status, 0);
  assert.ok(!fs.existsSync(plist()));
  assert.equal(config().schedule, null);
  assert.match(run(["schedule"]).stdout, /No schedule/);
});

test("on Linux it prints a crontab line instead of installing anything", () => {
  const { run, agents } = setup();
  const r = run(["schedule", "--every", "weekly", "--day", "wed", "--at", "06:15"], { SLEEP_PLATFORM: "linux" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^15 6 \* \* 3 .*sleep\.mjs" "report" "--project" /m);
  assert.ok(!fs.existsSync(agents));
});

test("report and archive take the window and purge settings from config.json", () => {
  const { fx, run } = setup();
  fx.session([{ tool: "Bash", input: { command: "cat beta.md" }, result: BETA }], { ageDays: 40 });
  fx.session([{ tool: "Bash", input: { command: "cat delta.md" }, result: DELTA }], { ageDays: 3 });
  // With the default 60-day window, 40 days of history moves nothing; config sets 30.
  assert.equal(JSON.parse(run(["report", "--json"]).stdout).candidates.length, 0);
  fs.writeFileSync(path.join(fx.state, "config.json"), JSON.stringify({ days: 30 }));
  const names = JSON.parse(run(["report", "--json"]).stdout).candidates.map((c) => c.name).sort();
  assert.deepEqual(names, ["beta.md", "eps.md", "gamma.md"]);
  // A flag still wins over the file.
  assert.equal(JSON.parse(run(["report", "--json", "--days", "60"]).stdout).candidates.length, 0);
});

const jobArgs = (p) => [.../<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(p)[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);

// A plugin install lives in a folder named by its version, and an update installs a new folder beside it. A job
// that names the old folder would keep running the old version, so a job set from a plugin runs a launcher that
// finds the installed version each time.
test("a schedule set from a plugin install follows plugin updates", () => {
  const { fx, plist, agents } = setup();
  const cache = path.join(fx.claude, "plugins", "cache", "claude-sleep", "sleep");
  const installAt = (v) => {
    const dir = path.join(cache, v);
    for (const f of ["sleep.mjs", "lib", "vendor", "package.json"]) fs.cpSync(path.join(path.dirname(CLI), f), path.join(dir, f), { recursive: true });
    fs.writeFileSync(path.join(fx.claude, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "sleep@claude-sleep": [{ scope: "user", installPath: dir, version: v }] } }));
    return path.join(dir, "sleep.mjs");
  };
  const old = installAt("0.1.0");
  const env = { SLEEP_LAUNCH_AGENTS: agents, SLEEP_NO_LAUNCHCTL: "1", SLEEP_PLATFORM: "darwin", CLAUDE_CONFIG_DIR: fx.claude };
  const r = spawnSync(process.execPath, [old, "schedule", "--every", "weekly", "--project", fx.project, "--state", fx.state], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  const args = jobArgs(fs.readFileSync(plist(), "utf8"));
  assert.ok(!args.some((a) => a.includes("/plugins/cache/")), "the job does not name the versioned folder");
  const launcher = args[1];
  assert.equal(fs.realpathSync(path.dirname(launcher)), fs.realpathSync(fx.state));
  // After an update, the launcher runs the new version; the job itself is unchanged.
  const fresh = installAt("0.2.0");
  fs.writeFileSync(fresh, fs.readFileSync(fresh, "utf8").replace("const HELP = `sleep: memory upkeep", "const HELP = `sleep 0.2.0: memory upkeep"));
  const run = spawnSync(args[0], [launcher, "help"], { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: fx.claude } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^sleep 0\.2\.0: memory upkeep/);
  // With the record gone, it falls back to the version that set the schedule.
  fs.rmSync(path.join(fx.claude, "plugins", "installed_plugins.json"));
  assert.match(spawnSync(args[0], [launcher, "help"], { encoding: "utf8" }).stdout, /^sleep: memory upkeep/);
});

test("a schedule set from a checkout runs that checkout directly", () => {
  const { run, plist, fx } = setup();
  assert.equal(run(["schedule", "--every", "weekly"]).status, 0);
  const args = jobArgs(fs.readFileSync(plist(), "utf8"));
  assert.equal(args[1], CLI);
  assert.ok(!fs.existsSync(path.join(fx.state, "run-sleep.mjs")));
});
