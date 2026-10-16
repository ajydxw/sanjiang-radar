import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createRadarServer } from "./serve-radar.mjs";

const inlineScript = 'self.__next_f.push([1,"fixture"]);';
const html = `<html><head><style>body{color:black}</style></head><body><script>${inlineScript}</script><script src="/_next/static/test.js"></script></body></html>`;

async function fixture(t, options = {}) {
  const folder = await mkdtemp(join(tmpdir(), "radar-security-"));
  const root = join(folder, "out");
  await mkdir(join(root, "_next", "static"), { recursive: true });
  await mkdir(join(root, ".sites-runtime"));
  await mkdir(join(folder, "private"));
  await writeFile(join(root, "index.html"), html);
  await writeFile(join(root, "data.json"), '{"items":[]}');
  await writeFile(join(root, "_next", "static", "test.js"), "console.log('fixture');");
  await writeFile(join(root, ".env"), "private-fixture");
  await writeFile(join(root, ".sites-runtime", "private.txt"), "private-fixture");
  await writeFile(join(root, "private.dat"), "private-fixture");
  await writeFile(join(folder, "private", "private.txt"), "private-fixture");
  const entries = [];
  const server = await createRadarServer({ root, log: (entry) => entries.push(entry), ...options });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(async () => {
    if (server.listening) await new Promise((done) => server.close(done));
    assert.equal(dirname(folder), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith("radar-security-"));
    await rm(folder, { recursive: true, force: true });
  });
  return { server, folder, root, entries };
}

function request(server, path = "/", options = {}) {
  return new Promise((resolveResponse, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path, agent: false, ...options }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolveResponse({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

test("public files get Helmet protections, exact inline-script hashes, HEAD and safe revalidation", async (t) => {
  const { server } = await fixture(t);
  const response = await request(server);
  assert.equal(response.status, 200);
  assert.equal(response.body, html);
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["strict-transport-security"], undefined);
  const policy = response.headers["content-security-policy"];
  const scriptRule = policy.split(";").find((rule) => rule.startsWith("script-src "));
  assert.ok(scriptRule.includes(`'sha256-${createHash("sha256").update(inlineScript).digest("base64")}'`));
  assert.ok(!scriptRule.includes("unsafe-inline") && !scriptRule.includes("unsafe-eval"));
  assert.ok(policy.includes("frame-ancestors 'none'") && !policy.includes("upgrade-insecure-requests"));
  assert.ok(policy.includes("style-src 'self' 'unsafe-inline'"));
  const head = await request(server, "/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(Number(head.headers["content-length"]), Buffer.byteLength(html));
  const cached = await request(server, "/", { headers: { "If-None-Match": response.headers.etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.body, "");
  assert.equal((await request(server, "/data.json")).status, 200);
  assert.equal((await request(server, "/_next/static/test.js")).headers["cache-control"], "public, max-age=31536000, immutable");
});

test("methods, bodies, private paths, malformed paths and Windows path tricks are rejected", async (t) => {
  const { server } = await fixture(t);
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const response = await request(server, "/", { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, "GET, HEAD");
  }
  assert.equal((await request(server, "/", { method: "GET", headers: { "Content-Length": "1" }, body: "x" })).status, 413);
  const headers = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`X-Test-${index}`, "x"]));
  headers["Content-Length"] = "1";
  assert.equal((await request(server, "/", { headers, body: "x" })).status, 431);
  for (const path of ["/../private/private.txt", "/%2e%2e/private/private.txt", "/.env", "/%2eenv", "/.sites-runtime/private.txt", "/%5c../private.txt", "/index.html:stream", "/%00", "/private.dat"]) {
    assert.equal((await request(server, path)).status, 403, path);
  }
  assert.equal((await request(server, "/%zz")).status, 400);
  assert.equal((await request(server, "http://example.com/")).status, 400);
  assert.equal((await request(server, `/${"x".repeat(2048)}`)).status, 414);
  assert.equal((await request(server, "/not-there.json")).status, 404);
});

test("realpath boundary also blocks directory links to outside or hidden export directories", async (t) => {
  const { server, folder, root } = await fixture(t);
  try {
    await symlink(join(folder, "private"), join(root, "escape"), "junction");
    await symlink(join(root, ".sites-runtime"), join(root, "hidden-alias"), "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("Directory links unavailable on this machine"); return; }
    throw error;
  }
  assert.equal((await request(server, "/escape/private.txt")).status, 403);
  assert.equal((await request(server, "/hidden-alias/private.txt")).status, 403);
});

test("request budget ignores forged proxy identities and logs only bounded event counters", async (t) => {
  const { server, entries } = await fixture(t, { limits: { burst: 3, requestsPerMinute: 1 } });
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await request(server, "/", { headers: { "X-Forwarded-For": `192.0.2.${index}`, "X-Real-IP": `192.0.2.${index}` } })).status, 200);
  }
  for (let index = 0; index < 8; index += 1) {
    const response = await request(server, `/private-person-${index}`, { headers: { "X-Forwarded-For": `198.51.100.${index}` } });
    assert.equal(response.status, 429);
    assert.equal(response.headers["retry-after"], "60");
  }
  await new Promise((done) => server.close(done));
  assert.deepEqual(entries, [{ event: "radar-security", counts: { rate_limit: 8 } }]);
  assert.equal(server.headersTimeout, 5000);
  assert.equal(server.requestTimeout, 10000);
  assert.equal(server.maxConnections, 256);
});

test("concurrent requests and oversized exported files have explicit resource limits", async (t) => {
  const { server, root } = await fixture(t, { limits: { concurrency: 1, fileBytes: 1024 } });
  await writeFile(join(root, "large.txt"), "x".repeat(1025));
  assert.equal((await request(server, "/large.txt")).status, 413);
  const response = await new Promise((done, reject) => {
    const socket = net.connect(server.address().port, "127.0.0.1", () => {
      socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\nGET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    });
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => done(data));
    socket.on("error", reject);
  });
  assert.ok(response.includes("HTTP/1.1 200 OK"));
  assert.ok(response.includes("HTTP/1.1 503 Service Unavailable"));
});
