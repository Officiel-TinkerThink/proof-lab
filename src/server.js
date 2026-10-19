import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createFixtureHandler } from "./fixtures.js";

// Known defects for experiments. Each `find` must match the source exactly once.
export const BUGS = {
  "no-persist": {
    find: 'localStorage.setItem(KEY, JSON.stringify(record));',
    replace: "void record; // not saved",
  },
  "lost-confirmation": {
    find: "confirmationEl.textContent = record ? CONFIRMATION : \"\";",
    replace: "confirmationEl.textContent = \"\";",
  },
};

const APP_FILE = fileURLToPath(new URL("./app/index.html", import.meta.url));
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function applyBug(html, bug) {
  if (!bug) return html;
  const entry = BUGS[bug];
  if (!entry) throw new Error(`Unknown bug "${bug}". Known: ${Object.keys(BUGS).join(", ")}`);
  if (html.split(entry.find).length !== 2) {
    throw new Error(`Bug "${bug}" no longer matches the app source exactly once`);
  }
  return html.replace(entry.find, () => entry.replace);
}

export function revisionOf(html) {
  return createHash("sha256").update(html).digest("hex").slice(0, 12);
}

// Reads the source on every request so an edit shows up on the next reload.
export async function render({ bug } = {}) {
  const source = await readFile(APP_FILE, "utf8");
  const html = applyBug(source, bug);
  const revision = revisionOf(html);
  const tagged = html.replace(
    "<head>",
    `<head>\n<meta name="app-revision" content="${revision}">`,
  );
  return { revision, html: tagged };
}

export async function startApp({ bug, port = 0 } = {}) {
  await render({ bug }); // fail at startup, not on the first request
  const fixtures = createFixtureHandler({ revisionOf });
  const server = createServer(async (req, res) => {
    // Only this machine's own names are served: a rebinding page reaches 127.0.0.1 under its own host name.
    if (!ALLOWED_HOSTS.has((req.headers.host ?? "").replace(/:\d+$/, ""))) {
      res.writeHead(421, { "Content-Type": "text/plain" });
      res.end("Misdirected request");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (path === "/") {
        const { html } = await render({ bug });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
      } else if (path === "/__revision") {
        // ?path=/fixtures/<page> asks for that fixture's revision; no query means the app itself.
        const target = url.searchParams.get("path");
        const revision = target ? await fixtures.revisionFor(target) : (await render({ bug })).revision;
        if (revision === null) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
        } else {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ revision }));
        }
      } else if (!(await fixtures.handle(req, res, url))) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    } catch (error) {
      // Only an error that carries its own status (a 413 for a large body) shows its message. Anything else could
      // carry a file path from the operating system, so the client gets a fixed text.
      const status = error?.status ?? 500;
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end(error?.status && error instanceof Error ? error.message : "Internal error");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}

// CLI: node src/server.js [--bug <name>] [--port <n>]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const app = await startApp({ bug: flag("--bug"), port: Number(flag("--port") ?? 4173) });
  console.log(`serving ${app.url}${flag("--bug") ? ` (bug: ${flag("--bug")})` : ""}`);
}
