// Running sleep on a schedule. On macOS: a launchd agent in ~/Library/LaunchAgents. Elsewhere: a crontab line to
// add by hand. Only the command line runs on a schedule (report, or archive --apply); merging needs a person.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const EVERY = ["daily", "weekly", "monthly"];
export const MODES = ["report", "archive"];
const which = (bin) => { const r = spawnSync("/usr/bin/which", [bin], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// Validates the flags into the schedule stored in config.json.
export function parseSchedule(flags) {
  const every = flags.every;
  if (!EVERY.includes(every)) throw new Error(`--every must be one of: ${EVERY.join(", ")}`);
  const mode = flags.mode || "report";
  if (!MODES.includes(mode)) throw new Error(`--mode must be report or archive (merging needs you, so it never runs on a schedule)`);
  const at = flags.at || "09:00";
  const t = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (!t || +t[1] > 23 || +t[2] > 59) throw new Error("--at must be a time like 09:00");
  const s = { every, at: `${t[1].padStart(2, "0")}:${t[2]}`, mode };
  if (every === "weekly") {
    const day = String(flags.day || "mon").toLowerCase().slice(0, 3);
    if (!(day in DAYS)) throw new Error("--day must be a weekday: mon, tue, wed, thu, fri, sat or sun");
    return { every, day, at: s.at, mode };
  }
  if (every === "monthly") {
    const day = Number(flags.day || 1);
    if (!Number.isInteger(day) || day < 1 || day > 28) throw new Error("--day must be a day of the month from 1 to 28");
    return { every, day, at: s.at, mode };
  }
  return s;
}

export const describe = (s) => `${s.every}${s.every === "weekly" ? ` on ${s.day}` : s.every === "monthly" ? ` on day ${s.day}` : ""} at ${s.at}, ${s.mode === "archive" ? "archive --apply" : "report only"}`;

function calendar(s) {
  const [h, m] = s.at.split(":").map(Number);
  const c = { Hour: h, Minute: m };
  if (s.every === "weekly") c.Weekday = DAYS[s.day];
  if (s.every === "monthly") c.Day = s.day;
  return c;
}

// What the job runs: absolute paths only, because launchd and cron start with almost nothing on PATH. Node is the
// stable link on PATH (/opt/homebrew/bin/node) when it is this same node, not the versioned folder it resolves to,
// which a node upgrade deletes.
export function nodePath() {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const onPath = which("node");
  return onPath && real(onPath) === real(process.execPath) ? onPath : process.execPath;
}
export function command(s, { cli, project, state }) {
  return [nodePath(), cli, s.mode, ...(s.mode === "archive" ? ["--apply"] : []), "--project", project, "--state", state];
}

const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(label, args, s, log) {
  const dirs = [path.dirname(nodePath()), which("git") && path.dirname(which("git")), "/usr/bin", "/bin"].filter(Boolean);
  const env = { PATH: [...new Set(dirs)].join(":"), ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}) };
  const dict = (o) => Object.entries(o).map(([k, v]) => `    <key>${esc(k)}</key>\n    ${typeof v === "number" ? `<integer>${v}</integer>` : `<string>${esc(v)}</string>`}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
${dict(calendar(s))}
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
${dict(env)}
  </dict>
  <key>StandardOutPath</key>
  <string>${esc(log)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(log)}</string>
</dict>
</plist>
`;
}

export function cronLine(s, args, log) {
  const [h, m] = s.at.split(":").map(Number);
  const dom = s.every === "monthly" ? s.day : "*", dow = s.every === "weekly" ? DAYS[s.day] : "*";
  return `${m} ${h} ${dom} * ${dow} ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ")} >> "${log}" 2>&1`;
}

export const agentsDir = () => process.env.SLEEP_LAUNCH_AGENTS || path.join(os.homedir(), "Library", "LaunchAgents");
export const labelFor = (projectKey) => `com.claude-sleep.${projectKey.replace(/^-+/, "")}`;

function launchctl(...args) {
  if (process.env.SLEEP_NO_LAUNCHCTL) return;
  spawnSync("launchctl", args, { encoding: "utf8" });
}

export function install(label, text) {
  const dir = agentsDir(), file = path.join(dir, `${label}.plist`);
  fs.mkdirSync(dir, { recursive: true });
  const uid = os.userInfo().uid;
  launchctl("bootout", `gui/${uid}`, file); // replace a job already loaded under this label
  fs.writeFileSync(file, text);
  launchctl("bootstrap", `gui/${uid}`, file);
  return file;
}

export function remove(label) {
  const file = path.join(agentsDir(), `${label}.plist`);
  if (!fs.existsSync(file)) return null;
  launchctl("bootout", `gui/${os.userInfo().uid}`, file);
  fs.unlinkSync(file);
  return file;
}
