import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createFixtureHandler } from "../src/fixtures.js";
import { revisionOf, startApp } from "../src/server.js";

let app;
let port;
before(async () => {
  app = await startApp();
  port = new URL(app.url).port;
});
after(async () => { await app.close(); });

// The status code of a hand-written HTTP request, for cases the HTTP client would "fix" (a missing or empty Host).
function rawStatus(requestText) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(port) }, () => socket.write(requestText));
    let data = "";
    socket.on("data", chunk => { data += chunk; });
    socket.on("end", () => resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1])));
    socket.on("error", reject);
  });
}

// Raw request so the Host header and the encoded path are exactly what the test says.
function request(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the redirect endpoint only ever redirects to a path on this server", async () => {
  const fallback = "/fixtures/nav-b.html";
  const hostile = [
    "/%5Cevil.example",          // /\evil.example: browsers read the backslash as a slash
    "/%09/evil.example",         // a tab inside //: browsers strip it
    "//evil.example/x",
    "https://evil.example/",
    "%5C%5Cevil.example",
    "javascript:alert(1)",
  ];
  for (const to of hostile) {
    const response = await request(`/api/redirect?to=${to}`);
    assert.equal(response.status, 302, to);
    assert.equal(response.headers.location, fallback, `to=${to}`);
  }
  // Dot segments can turn "/./" + "/host" into the path "//host". The emitted Location must still start with one slash.
  const sneaky = [
    "/.//evil.example",
    "/%2e//evil.example",
    "/./%5Cevil.example",
    "/a/..//evil.example",
    "/a/../%5Cevil.example",
    "/././/evil.example",
    "/fixtures/..//evil.example",
  ];
  for (const to of sneaky) {
    const response = await request(`/api/redirect?to=${to}`);
    assert.equal(response.status, 302, to);
    assert.ok(/^\/(?!\/)/.test(response.headers.location), `to=${to} gave Location ${response.headers.location}`);
  }
  // CR and LF inside the target are stripped by URL parsing, so they never reach the header and the target stays on this server.
  const injected = await request("/api/redirect?to=/%0d%0aSet-Cookie:%20x=1");
  assert.equal(injected.status, 302);
  assert.doesNotMatch(injected.headers.location, /[\r\n]/);
  assert.ok(injected.headers.location.startsWith("/") && !injected.headers.location.startsWith("//"));
  assert.equal(injected.headers["set-cookie"], undefined);
  const good = await request("/api/redirect?to=/fixtures/forms.html?x=1");
  assert.equal(good.status, 302);
  assert.equal(good.headers.location, "/fixtures/forms.html?x=1");
  const none = await request("/api/redirect");
  assert.equal(none.headers.location, fallback);
});

test("fixture names: reserved device names, traversal and odd shapes are all 404", async () => {
  for (const name of ["con.html", "nul.txt", "com1.json", "lpt9.css", "aux.js", "prn.html", "CON.html", "FORMS.html", ".hidden.html", "sub/forms.html", "..%2Fserver.js", "%2e%2e/server.js", "forms.html%00", "forms.html%20", "forms.exe", "forms"]) {
    const response = await request(`/fixtures/${name}`);
    assert.equal(response.status, 404, name);
  }
  const real = await request("/fixtures/forms.html");
  assert.equal(real.status, 200);
  assert.match(real.body, /<meta name="app-revision" content="[0-9a-f]{12}">/);
  assert.match(real.headers["content-type"], /^text\/html/);
});

test("only this machine's own host names are served (DNS rebinding)", async () => {
  assert.equal((await request("/", { headers: { host: "evil.example" } })).status, 421);
  assert.equal((await request("/", { headers: { host: "evil.example:80" } })).status, 421);
  assert.equal((await request("/fixtures/forms.html", { headers: { host: "127.0.0.1.evil.example" } })).status, 421);
  // Node's HTTP client swaps an empty Host for the real one, so a missing or empty Host goes over a raw socket.
  const noHost = await rawStatus("GET / HTTP/1.1\r\nConnection: close\r\n\r\n");
  const emptyHost = await rawStatus("GET / HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n");
  assert.ok([400, 421].includes(noHost), `no Host header: ${noHost}`);
  assert.ok([400, 421].includes(emptyHost), `empty Host header: ${emptyHost}`);
  assert.equal((await request("/", { headers: { host: `localhost:${port}` } })).status, 200);
  assert.equal((await request("/", { headers: { host: `127.0.0.1:${port}` } })).status, 200);
  assert.equal((await request("/", { headers: { host: "localhost" } })).status, 200);
});

test("a request target the URL parser rejects is a 400 and the server stays up", async () => {
  for (const target of ["//[", "http://[", "//%", "/\u0000"]) {
    const status = await rawStatus(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    assert.ok([400, 404].includes(status), `${JSON.stringify(target)} gave ${status}`);
  }
  assert.equal((await request("/")).status, 200, "the server must still answer");
});

test("the counter needs the guard header to move", async () => {
  const before = JSON.parse((await request("/api/count")).body).count;
  const refused = await request("/api/count", { method: "POST" });
  assert.equal(refused.status, 403);
  assert.equal(JSON.parse((await request("/api/count")).body).count, before);
  const accepted = await request("/api/count", { method: "POST", headers: { "x-proof-lab": "1" } });
  assert.equal(accepted.status, 200);
  assert.equal(JSON.parse(accepted.body).count, before + 1);
});

test("an oversized request body is refused with its own status, not read without limit", async () => {
  const { handle } = createFixtureHandler({ revisionOf });
  const req = {
    method: "POST",
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.alloc(70 * 1024); },
  };
  await assert.rejects(handle(req, { writeHead() {}, end() {} }, new URL("http://localhost/api/echo")), error => error.status === 413);
});

test("echo returns what was sent; slow and status endpoints behave", async () => {
  const echo = await request("/api/echo?a=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: "world" }) });
  assert.deepEqual(JSON.parse(echo.body), { method: "POST", query: { a: "1" }, contentType: "application/json", body: { hello: "world" } });
  const text = await request("/api/echo", { method: "POST", body: "not json" });
  assert.equal(JSON.parse(text.body).body, "not json");

  const slow = await request("/api/slow?ms=abc");
  assert.equal(JSON.parse(slow.body).waited, 0);
  assert.equal(JSON.parse((await request("/api/slow?ms=-5")).body).waited, 0);

  assert.equal((await request("/api/status/404")).status, 404);
  assert.equal((await request("/api/status/500")).status, 500);
  const empty = await request("/api/status/204");
  assert.equal(empty.status, 204);
  assert.equal(empty.body, "");
  assert.equal((await request("/api/status/199")).status, 404);
  assert.equal((await request("/api/status/600")).status, 404);
});

test("the cookie endpoint accepts a plain token only and the download is an attachment", async () => {
  const ok = await request("/api/cookie?value=abc_1");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.headers["set-cookie"], ["spec_cookie=abc_1; Path=/; HttpOnly; SameSite=Lax"]);
  for (const value of ["a%3Bb", "a%0D%0Ab", "a%20b", "x".repeat(33)]) {
    const bad = await request(`/api/cookie?value=${value}`);
    assert.equal(bad.status, 400, value);
    assert.equal(bad.headers["set-cookie"], undefined);
  }
  const download = await request("/download/hello.txt");
  assert.equal(download.status, 200);
  assert.match(download.headers["content-disposition"], /^attachment; filename="hello\.txt"$/);
  assert.equal(download.body, "hello from proof-lab\n");
});

test("the app and every fixture page say their revision in a header; API answers do not", async () => {
  const appPage = await request("/");
  assert.match(appPage.headers["x-app-revision"], /^[0-9a-f]{12}$/);
  assert.equal(appPage.headers["x-app-revision"], JSON.parse((await request("/__revision")).body).revision);
  const forms = await request("/fixtures/forms.html");
  assert.equal(forms.headers["x-app-revision"], /content="([0-9a-f]{12})"/.exec(forms.body)[1]);
  assert.equal((await request("/api/items")).headers["x-app-revision"], undefined);
  assert.equal((await request("/download/hello.txt")).headers["x-app-revision"], undefined);
});

test("the revision endpoint answers for the app and for fixture pages only", async () => {
  const appRevision = JSON.parse((await request("/__revision")).body).revision;
  assert.match(appRevision, /^[0-9a-f]{12}$/);
  const page = await request("/fixtures/forms.html");
  const inPage = /content="([0-9a-f]{12})"/.exec(page.body)[1];
  assert.equal(JSON.parse((await request("/__revision?path=/fixtures/forms.html")).body).revision, inPage);
  assert.equal((await request("/__revision?path=/fixtures/none.html")).status, 404);
  assert.equal((await request("/__revision?path=/")).status, 404);
  assert.equal((await request("/__revision?path=/fixtures/con.html")).status, 404);
});

test("unknown paths are 404 with a fixed body", async () => {
  assert.equal((await request("/nope")).status, 404);
  assert.equal((await request("/api/nope")).status, 404);
  const response = await request("/fixtures/forms.html/");
  assert.equal(response.status, 404);
  assert.equal(response.body, "Not found");
});
