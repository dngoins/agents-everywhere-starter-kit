import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Orchestrator } from "../src/orchestrator/service.ts";
import { createApp } from "../src/http/app.ts";
import { readConfig } from "../src/config.ts";
import { createHttpMediaProvider } from "../src/providers/media.ts";
import { MediaService } from "../../MoviePart/src/media-service/service.ts";
import { createMediaHttpServer } from "../../MoviePart/src/media-service/http.ts";
import { createLiveExecutor } from "../../MoviePart/src/media-service/executor.ts";
import { validateMp4 } from "../../MoviePart/src/media-service/render.ts";
import { OrchestratorClient } from "../../MoviePart/integration/orchestrator-client.ts";

const movieRoot = new URL("../../MoviePart/", import.meta.url);
const sample = await readFile(new URL("sample-fixtures/dwight-synthetic-sample.mp4", movieRoot));
const png = await readFile(new URL("../fixtures/media/sample.png", import.meta.url));
const uiOrigin = "http://127.0.0.1:3200";

async function listening(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function closeHttp(server) {
  const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

async function until(action, predicate, message, limitMs = 10_000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const value = await action();
    if (predicate(value)) return value;
    await delay(25);
  }
  assert.fail(message);
}

async function integration(t, mode = "synthetic") {
  const directory = await mkdtemp(join(tmpdir(), "magicpitch-integration-"));
  const rendererDirectory = join(directory, "renderer");
  const receiptDirectory = join(directory, "client-receipts");
  const serviceToken = randomBytes(32).toString("base64url");
  const deviceToken = randomBytes(32).toString("base64url");
  let executions = 0;
  let aborted = false;
  const executor = mode === "unconfigured" ? createLiveExecutor({}) : {
    ready: async () => true,
    execute: async (context) => {
      executions++;
      if (mode === "waiting") {
        await new Promise((resolve, reject) => {
          const abort = () => { aborted = true; reject(context.signal.reason); };
          if (context.signal.aborted) abort();
          else context.signal.addEventListener("abort", abort, { once: true });
        });
      } else {
        assert.equal(context.brief.productId, "demo-car");
        assert.equal(context.brief.durationSeconds, 6);
        await copyFile(new URL("sample-fixtures/dwight-synthetic-sample.mp4", movieRoot), context.output);
      }
    },
  };
  const service = new MediaService({ directory: rendererDirectory, executor });
  await service.start();
  const mediaServer = createMediaHttpServer(service, serviceToken);
  const mediaBase = await listening(mediaServer);
  const provider = createHttpMediaProvider(mediaBase, serviceToken, 20 * 1024 * 1024, receiptDirectory);
  const core = new Orchestrator({ mediaProvider: provider, sessionTtlMs: 90_000, jobTimeoutMs: 30_000 });
  const app = createApp({
    orchestrator: core, config: readConfig({ ALLOWED_ORIGINS: uiOrigin }),
    deviceToken, log() {},
  });
  const apiServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!apiServer.listening) await new Promise((resolve, reject) => {
    apiServer.once("listening", resolve); apiServer.once("error", reject);
  });
  const address = apiServer.address();
  assert.ok(address && typeof address !== "string");
  const apiBase = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    core.dispose();
    await closeHttp(apiServer);
    await service.close();
    await closeHttp(mediaServer);
    await rm(directory, { recursive: true, force: true });
  });
  const browserFetch = async (url, options = {}) => {
    const headers = new Headers(options.headers);
    headers.set("Origin", uiOrigin);
    const response = await fetch(url, { ...options, headers });
    assert.equal(response.headers.get("access-control-allow-origin"), uiOrigin, "Kiosk must receive readable success and error responses.");
    return response;
  };
  const client = new OrchestratorClient(apiBase, { fetch: browserFetch });
  const capability = await client.pair(deviceToken);
  client.join(capability);
  const event = (type, payload) => client.event({ schemaVersion: 1, eventId: randomUUID(), type, payload });
  async function prepare() {
    await event("customer_detected", {});
    await event("consent_recorded", { personalization: true, capture: true, enrichment: false });
    await client.identify("demo-alex");
    await event("context_updated", { preferences: ["Beach road trips"] });
    const snapshot = await client.snapshot();
    await client.uploadImage(new Blob([png], { type: "image/png" }), snapshot);
    return client.createBrief();
  }
  return {
    service, client, capability, event, prepare, core, apiBase, mediaBase, rendererDirectory, receiptDirectory,
    executions: () => executions, aborted: () => aborted,
  };
}

test("Tiya's real kiosk client and HTTP media service complete a synthetic protocol rehearsal", { timeout: 30_000 }, async (t) => {
  const f = await integration(t);
  const preflight = await fetch(`${f.apiBase}/v1/sessions`, {
    method: "OPTIONS", headers: { Origin: uiOrigin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), uiOrigin);
  await assert.rejects(f.client.createBrief(), /CONSENT_REQUIRED/);
  const brief = await f.prepare();
  const key = randomUUID();
  const job = await f.client.startMedia(brief.id, key);
  assert.equal((await f.client.startMedia(brief.id, key)).jobId, job.jobId);
  const snapshot = await until(() => f.client.snapshot(), value => value.jobs[0]?.status === "ready", "Media should finish");
  const result = snapshot.jobs[0].result;
  assert.ok(result);
  assert.equal(result.durationSeconds, 6);
  const video = await f.client.downloadMovie(result);
  assert.deepEqual(Buffer.from(await video.arrayBuffer()), sample);
  assert.equal(await validateMp4(fileURLToPath(new URL("sample-fixtures/dwight-synthetic-sample.mp4", movieRoot)), 6), 6);
  assert.equal(f.executions(), 1);
  assert.deepEqual(await readdir(join(f.rendererDirectory, "work")), []);
  assert.deepEqual(await readdir(f.receiptDirectory), []);
  const acknowledged = await f.event("media_revealed", { jobId: job.jobId });
  assert.equal(acknowledged.state, "revealed");
  await f.client.revoke();
  await assert.rejects(f.client.snapshot(), /SESSION_EXPIRED/);
  // The injected executor is strictly test-only: no fixture success mode is added to the live server.
});

test("revoking the kiosk session cancels and deletes Tiya's active renderer work", { timeout: 30_000 }, async (t) => {
  const f = await integration(t, "waiting");
  const brief = await f.prepare();
  const job = await f.client.startMedia(brief.id, randomUUID());
  await until(async () => f.executions(), value => value === 1, "Renderer should start");
  await f.client.revoke();
  await until(async () => f.aborted(), Boolean, "Renderer should observe cancellation");
  await until(() => readdir(join(f.rendererDirectory, "work")), files => files.length === 0, "Private renderer inputs should be removed");
  await until(() => readdir(f.receiptDirectory), files => files.length === 0, "Cleanup must be acknowledged");
  await assert.rejects(f.service.submit({
    schemaVersion: 1, jobId: job.jobId, idempotencyKey: job.jobId, brief,
    image: { mimeType: "image/png", base64: png.toString("base64") },
  }), { code: "JOB_CANCELLED" });
});

test("an unconfigured live MoviePart renderer receives no participant upload", { timeout: 30_000 }, async (t) => {
  const f = await integration(t, "unconfigured");
  const brief = await f.prepare();
  await f.client.startMedia(brief.id, randomUUID());
  const snapshot = await until(() => f.client.snapshot(), value => value.jobs[0]?.status === "failed", "Unconfigured media should fail explicitly");
  assert.equal(snapshot.jobs[0].result, undefined);
  assert.deepEqual(await readdir(join(f.rendererDirectory, "work")), []);
  assert.deepEqual(await readdir(join(f.rendererDirectory, "receipts")), []);
  assert.equal(f.executions(), 0);
});
