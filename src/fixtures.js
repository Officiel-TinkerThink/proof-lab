// Fixture pages and test endpoints served next to the app, so every spec op has something real to run against.
// Local use only: the server binds 127.0.0.1. Nothing here writes to disk.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("./app/fixtures/", import.meta.url));
const TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
};
const NAME = /^[a-z0-9][a-z0-9._-]*\.(html|js|css|txt|json)$/;
// Windows resolves these names, with any extension, to devices (a read of con.html can block on the console).
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/;
// State-changing test endpoints need this header. A page on another origin cannot send it without a CORS preflight,
// and this server answers none, so another page cannot move the counters a spec reads.
const GUARD_HEADER = "x-proof-lab";
const FALLBACK_REDIRECT = "/fixtures/nav-b.html";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DELAY_MS = 5000;
const NO_STORE = { "Cache-Control": "no-store" };

const sendJson = (res, status, value, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...NO_STORE, ...headers });
  res.end(JSON.stringify(value));
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const parseBody = text => {
  if (text === "") return null;
  try { return JSON.parse(text); } catch { return text; }
};

// Returns { handle, revisionFor }. revisionOf and the head tag come from server.js so the revision rule stays in one place.
export function createFixtureHandler({ revisionOf }) {
  let count = 0; // per server instance, for "no duplicate submit" specs

  async function loadFixture(name) {
    if (!NAME.test(name) || RESERVED_NAME.test(name)) return null;
    let source;
    try {
      source = await readFile(join(DIR, name), "utf8"); // NAME has no path separators, so no traversal
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const revision = revisionOf(source);
    const ext = name.split(".").pop();
    const body = ext === "html"
      ? source.replace("<head>", `<head>\n<meta name="app-revision" content="${revision}">`)
      : source;
    return { revision, body, type: TYPES[ext] };
  }

  // Revision of a fixture page by its URL path, or null when the path is not a fixture.
  async function revisionFor(pathname) {
    if (!pathname.startsWith("/fixtures/")) return null;
    return (await loadFixture(pathname.slice("/fixtures/".length)))?.revision ?? null;
  }

  // Handles one request. Returns false when the path is not a fixture route, so the caller can 404.
  async function handle(req, res, url) {
    const path = url.pathname;

    if (path.startsWith("/fixtures/")) {
      const fixture = await loadFixture(path.slice("/fixtures/".length));
      if (!fixture) return notFound(res);
      res.writeHead(200, { "Content-Type": fixture.type, ...NO_STORE, "X-App-Revision": fixture.revision });
      res.end(fixture.body);
      return true;
    }

    if (path === "/api/echo") {
      const text = await readBody(req);
      sendJson(res, 200, {
        method: req.method,
        query: Object.fromEntries(url.searchParams),
        contentType: req.headers["content-type"] ?? null,
        body: parseBody(text),
      });
      return true;
    }

    if (path === "/api/slow") {
      const ms = Math.min(Math.max(Number(url.searchParams.get("ms")) || 0, 0), MAX_DELAY_MS);
      await new Promise(resolve => setTimeout(resolve, ms));
      sendJson(res, 200, { ok: true, waited: ms });
      return true;
    }

    const status = /^\/api\/status\/(\d{3})$/.exec(path)?.[1];
    if (status) {
      const code = Number(status);
      if (code < 200 || code > 599) return notFound(res);
      if (code === 204 || code === 304) {
        res.writeHead(code, NO_STORE);
        res.end();
      } else {
        sendJson(res, code, { status: code });
      }
      return true;
    }

    if (path === "/api/redirect") {
      // Same-origin paths only: never redirect to another host. The target is parsed the way a browser parses it
      // (a backslash or a tab inside "/\evil.com" would otherwise slip past a string check), and only the parsed
      // path, query and hash are sent back.
      const base = "http://localhost";
      let location = FALLBACK_REDIRECT;
      try {
        const target = new URL(url.searchParams.get("to") ?? FALLBACK_REDIRECT, base);
        if (target.origin === base) {
          // "/.//evil.example" parses to the path "//evil.example", which a browser would read as another host,
          // so the emitted path always starts with exactly one slash.
          location = `${target.pathname.replace(/^\/+/, "/")}${target.search}${target.hash}`;
        }
      } catch { /* an unparseable target keeps the fallback */ }
      res.writeHead(302, { Location: location, ...NO_STORE });
      res.end();
      return true;
    }

    if (path === "/api/cookie") {
      const value = url.searchParams.get("value") ?? "1";
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) {
        sendJson(res, 400, { error: "bad value" });
      } else {
        sendJson(res, 200, { set: value }, { "Set-Cookie": `spec_cookie=${value}; Path=/; HttpOnly; SameSite=Lax` });
      }
      return true;
    }

    if (path === "/api/count") {
      if (req.method === "POST") {
        if (req.headers[GUARD_HEADER] === undefined) {
          sendJson(res, 403, { error: `POST needs the ${GUARD_HEADER} header` });
          return true;
        }
        count += 1;
      }
      sendJson(res, 200, { count });
      return true;
    }

    if (path === "/api/items") {
      sendJson(res, 200, [{ id: 1, name: "alpha" }, { id: 2, name: "beta" }, { id: 3, name: "gamma" }]);
      return true;
    }

    if (path === "/download/hello.txt") {
      res.writeHead(200, {
        "Content-Type": TYPES.txt,
        "Content-Disposition": 'attachment; filename="hello.txt"',
        ...NO_STORE,
      });
      res.end("hello from proof-lab\n");
      return true;
    }

    return false;
  }

  return { handle, revisionFor };
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
  return true;
}
