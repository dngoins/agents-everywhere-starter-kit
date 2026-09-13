import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { integrationEnvironments, launchOptions } from "../../FinalProject/scripts/kiosk-config.mjs";

const movieRoot = fileURLToPath(new URL("..", import.meta.url));
const publicOrigin = "https://kiosk.example.test";
const nextServer = `
  import next from "next";
  import { createServer } from "node:http";
  const app = next({ dev: false, hostname: "127.0.0.1", port: 0, dir: process.cwd() });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = createServer((request, response) => handle(request, response));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  process.send({ port: server.address().port });
  process.on("message", async message => {
    if (message?.type !== "shutdown") return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await app.close();
    process.disconnect();
  });
`;

async function launchNext(env) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", nextServer], {
    cwd: movieRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let diagnostics = "";
  for (const output of [child.stdout, child.stderr]) {
    output.on("data", (bytes) => { diagnostics = (diagnostics + bytes.toString()).slice(-8_192); });
  }
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send({ type: "shutdown" });
    const timer = setTimeout(() => child.kill(), 10_000);
    try { await stopped; } finally { clearTimeout(timer); }
  };
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Next HTTP test server timed out.\n${diagnostics}`)), 90_000);
      const finish = (error, value) => {
        clearTimeout(timeout);
        if (error) reject(error); else resolve(value);
      };
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => finish(new Error(`Next HTTP test server exited ${code}.\n${diagnostics}`)));
      child.once("message", (message) => {
        if (!Number.isInteger(message.port)) finish(new Error("Next did not report a bound ephemeral port."));
        else finish(undefined, message.port);
      });
    });
    return { base: `http://127.0.0.1:${port}`, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

test("built Next serves the bounded same-origin gateway over real loopback HTTP", { timeout: 120_000 }, async () => {
  await access(new URL("../.next/BUILD_ID", import.meta.url));
  const received = [];
  const film = Buffer.from([0, 1, 2, 128, 255, 3]);
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(chunks) });
    if (request.url.endsWith("/assets/film-1")) {
      response.writeHead(206, {
        "Content-Type": "video/mp4", "Content-Length": "3", "Content-Range": "bytes 2-4/6",
        "Accept-Ranges": "bytes", "Set-Cookie": "must-not-forward=1",
      });
      response.end(film.subarray(2, 5));
      return;
    }
    response.writeHead(request.url === "/v1/kiosk/pair" ? 201 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ fixture: true, revision: 1 }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let gateway;
  try {
    const options = launchOptions(["--api-port", String(upstream.address().port), "--public-origin", publicOrigin]);
    const env = integrationEnvironments({ options, deviceToken: "test-device", mediaToken: "test-media" });
    gateway = await launchNext({ ...env.ui, NODE_ENV: "production" });
    const headers = { Origin: publicOrigin, Authorization: "Bearer test-session" };
    const snapshot = `${gateway.base}/api/showroom/v1/sessions/session-1/showroom`;
    const response = await fetch(snapshot, {
      headers: { ...headers, Cookie: "must-not-forward=1", "X-Forwarded-Host": "evil.example.test", "X-Api-Key": "fake-secret" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { fixture: true, revision: 1 });
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(received[0].path, "/v1/sessions/session-1/showroom");
    assert.equal(received[0].headers.authorization, "Bearer test-session");
    assert.equal(received[0].headers.origin, publicOrigin);
    assert.equal(received[0].headers.cookie, undefined);
    assert.equal(received[0].headers["x-forwarded-host"], undefined);
    assert.equal(received[0].headers["x-api-key"], undefined);

    const paired = await fetch(`${gateway.base}/api/showroom/v1/kiosk/pair`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: '{"pairingCode":"ABCD1234"}',
    });
    assert.equal(paired.status, 201);
    await paired.arrayBuffer();
    assert.equal(received[1].headers.authorization, undefined);
    assert.equal(received[1].body.toString(), '{"pairingCode":"ABCD1234"}');

    const asset = await fetch(`${gateway.base}/api/showroom/v1/sessions/session-1/assets/film-1`, {
      headers: { ...headers, Range: "bytes=2-4" },
    });
    assert.equal(asset.status, 206);
    assert.equal(asset.headers.get("content-range"), "bytes 2-4/6");
    assert.equal(asset.headers.get("set-cookie"), null);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), film.subarray(2, 5));

    const before = received.length;
    const denied = await fetch(`${gateway.base}/api/showroom/v1/operator/kiosk-pairings`, { method: "POST", headers });
    assert.equal(denied.status, 404);
    await denied.arrayBuffer();
    const badOrigin = await fetch(snapshot, { headers: { ...headers, Origin: "https://evil.example.test" } });
    assert.equal(badOrigin.status, 403);
    await badOrigin.arrayBuffer();
    const query = await fetch(`${snapshot}?token=must-not-forward`, { headers });
    assert.equal(query.status, 400);
    await query.arrayBuffer();
    assert.equal(received.length, before);
  } finally {
    await gateway?.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
