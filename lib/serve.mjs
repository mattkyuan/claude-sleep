// sleep review --serve: the review page on a local address, where you decide. Listens on 127.0.0.1 only. The printed
// address carries a random key once; it becomes a cookie that only opens the page, and every action needs the key in a
// header, which another site cannot send. Actions run one at a time. The page never touches files: each action
// is a command line run the server makes after checking the request against its own plan.
import http from "node:http";
import crypto from "node:crypto";

const same = (a, b) => {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cookieOf = (req, name) => (req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1];
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > limit) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// render(nonce, token, url) returns the page; actions maps a path (/apply, /merge, /note) to async (body) => { message }.
export function startServer({ port, render, actions }) {
  const token = crypto.randomBytes(24).toString("base64url");
  let running = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    try { await handle(req, res); } catch (e) {
      if (!res.headersSent) { res.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); res.end("Bad request."); }
    }
  });
  async function handle(req, res) {
    const addr = server.address();
    const hosts = [`127.0.0.1:${addr.port}`, `localhost:${addr.port}`];
    const base = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" };
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { ...base, "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Content-Type": type, ...extra }); res.end(body); };
    const json = (code, obj) => send(code, "application/json", JSON.stringify(obj));
    if (!hosts.includes(req.headers.host)) return send(403, "text/plain", "Wrong host.");
    const url = new URL(req.url.replace(/^\/+/, "/"), `http://${req.headers.host}`);
    const cookieName = `sleep_review_${addr.port}`;
    if (req.method === "GET" && url.pathname === "/") {
      if (url.searchParams.has("token")) {
        if (!same(url.searchParams.get("token"), token)) return send(403, "text/plain", "Open the address printed in the terminal.");
        res.writeHead(303, { ...base, Location: "/", "Set-Cookie": `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/` });
        return res.end();
      }
      if (!same(cookieOf(req, cookieName), token)) return send(403, "text/plain", "Open the address printed in the terminal.");
      const nonce = crypto.randomBytes(16).toString("base64");
      const html = await render(nonce, token, url);
      const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
      return send(200, "text/html; charset=utf-8", html, { "Content-Security-Policy": csp });
    }
    if (!same(req.headers["x-sleep-token"], token)) return json(403, { error: "Bad key. Reload the page from the address in the terminal." });
    if (req.headers.origin && !hosts.map((h) => `http://${h}`).includes(req.headers.origin)) return json(403, { error: "Wrong origin." });
    const act = req.method === "POST" && Object.hasOwn(actions, url.pathname) ? actions[url.pathname] : null;
    if (!act) return json(404, { error: "Not found." });
    let body;
    try { body = JSON.parse(await readBody(req, 512 * 1024)); } catch { return json(400, { error: "Send JSON." }); }
    const job = running.then(() => act(body));
    running = job.catch(() => {});
    try { return json(200, await job); } catch (e) { return json(400, { error: String(e?.message || e) }); }
  }
  return new Promise((resolve, reject) => {
    const listen = (p) => {
      server.once("error", (e) => (e.code === "EADDRINUSE" && p !== 0 ? listen(0) : reject(e)));
      server.listen(p, "127.0.0.1", () => resolve({ server, token, url: `http://127.0.0.1:${server.address().port}/?token=${token}` }));
    };
    listen(port);
  });
}
