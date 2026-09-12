import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readConfig } from "../src/config.js";
import { createApp } from "../src/http/app.js";
import { Orchestrator } from "../src/orchestrator/service.js";
import { SessionCreatedSchema, SessionSnapshotSchema, ApiErrorResponseSchema } from "../src/contracts/transport.js";

const deviceToken = "test-device-credential-with-enough-entropy";

async function setup() {
  const media = await readFile(new URL("../fixtures/media/mock-preview.mp4", import.meta.url));
  const core = new Orchestrator({
    mediaProvider: {
      name: "mock",
      async generate() {
        return { bytes: media, mimeType: "video/mp4", provenance: "mock_fixture", durationSeconds: 1 };
      },
    },
  });
  const app = createApp({ orchestrator: core, config: readConfig({}), deviceToken, log() {} });
  const request = (path: string, options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    app.request(`http://127.0.0.1:3101${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  const create = async () => {
    const response = await request("/v1/sessions", { method: "POST", token: deviceToken });
    assert.equal(response.status, 201);
    return SessionCreatedSchema.parse(await response.json());
  };
  return { core, app, request, create };
}

test("config is explicit, offline by default and rejects unsafe exposure", () => {
  const config = readConfig({});
  assert.equal(config.MEDIA_PROVIDER, "mock");
  assert.equal(config.HOST, "127.0.0.1");
  assert.throws(() => readConfig({ JOB_PROVIDER: "trigger" }), /JOB_PROVIDER/);
  assert.throws(() => readConfig({ FOLLOWUP_PROVIDER: "ambiguous" }), /FOLLOWUP_PROVIDER/);
  assert.throws(() => readConfig({ BRIEF_PROVIDER: "openai" }), /OPENAI_API_KEY/);
  assert.throws(() => readConfig({ MOCK_ONLY: "true", MEDIA_PROVIDER: "http" }), /MOCK_ONLY/);
  assert.throws(() => readConfig({ HOST: "0.0.0.0" }), /LAN access/);
  assert.throws(() => readConfig({ ALLOWED_ORIGINS: "*" }), /ALLOWED_ORIGINS/);
  assert.throws(() => readConfig({ ALLOWED_HOSTS: "*.example.com" }), /ALLOWED_HOSTS/);
  assert.throws(() => readConfig({
    MEDIA_PROVIDER: "http", MEDIA_SERVICE_URL: "http://example.com", MEDIA_SERVICE_TOKEN: "test",
  }), /HTTPS/);
});

test("device/session authorization, origin and host boundaries are enforced", async (t) => {
  const { core, request, create } = await setup();
  t.after(() => core.dispose());
  assert.equal((await request("/v1/sessions", { method: "POST" })).status, 401);
  assert.equal((await request("/healthz", { headers: { host: "attacker.example" } })).status, 403);
  assert.equal((await request("/healthz", { headers: { origin: "https://attacker.example" } })).status, 403);
  const one = await create();
  const two = await create();
  const path = `/v1/sessions/${one.sessionId}`;
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, { token: two.sessionToken })).status, 401);
  const snapshot = await request(path, { token: one.sessionToken });
  assert.equal(snapshot.status, 200);
  SessionSnapshotSchema.parse(await snapshot.json());
  assert.equal((await request(`${path}?afterRevision=-1`, { token: one.sessionToken })).status, 400);
  const wrongOrigin = await request(`${path}/events`, {
    method: "POST", token: one.sessionToken, body: {},
    headers: { origin: "http://different.local" },
  });
  assert.equal(wrongOrigin.status, 403);
});

test("oversized/malformed inputs fail without leaking internal data", async (t) => {
  const { core, request, create } = await setup();
  t.after(() => core.dispose());
  const session = await create();
  const path = `/v1/sessions/${session.sessionId}`;
  const oversized = await request(`${path}/events`, {
    method: "POST", token: session.sessionToken, body: { data: "x".repeat(17_000) },
  });
  assert.equal(oversized.status, 413);
  const invalid = await request(`${path}/events`, {
    method: "POST", token: session.sessionToken, body: { arbitrary: "payload" },
  });
  assert.equal(invalid.status, 400);
  const error = await invalid.json();
  ApiErrorResponseSchema.parse(error);
  assert.equal(typeof error.error.requestId, "string");
  assert.equal(JSON.stringify(error).includes(session.sessionToken), false);
  assert.equal((await request(`${path}/commands/unknown`, {
    method: "POST", token: session.sessionToken, body: {},
  })).status, 400);
  assert.equal((await request(`${path}/commands/schedule_followup`, {
    method: "POST", token: session.sessionToken, body: {},
  })).status, 503);
});

test("consent gates uploads and revoked sessions cannot fetch media", async (t) => {
  const { core, app, request, create } = await setup();
  t.after(() => core.dispose());
  const session = await create();
  const path = `/v1/sessions/${session.sessionId}`;
  const png = await readFile(new URL("../fixtures/media/sample.png", import.meta.url));
  const upload = () => app.request(`http://127.0.0.1:3101${path}/assets`, {
    method: "POST", headers: { authorization: `Bearer ${session.sessionToken}`, "content-type": "image/png" },
    body: png,
  });
  assert.equal((await upload()).status, 403);
  await request(`${path}/events`, {
    method: "POST", token: session.sessionToken,
    body: { schemaVersion: 1, eventId: randomUUID(), type: "consent_recorded", payload: { capture: true, personalization: true, enrichment: false } },
  });
  const identified = await request(`${path}/commands/identify_customer`, {
    method: "POST", token: session.sessionToken, body: { customerId: "demo-alex", method: "manual" },
  });
  assert.equal(identified.status, 200);
  const uploaded = await upload();
  assert.equal(uploaded.status, 201);
  const { assetId } = await uploaded.json();
  const fetched = await request(`${path}/assets/${assetId}`, { token: session.sessionToken });
  assert.equal(fetched.status, 200);
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), png);
  const partial = await request(`${path}/assets/${assetId}`, {
    token: session.sessionToken, headers: { range: "bytes=0-7" },
  });
  assert.equal(partial.status, 206);
  assert.equal((await partial.arrayBuffer()).byteLength, 8);
  const suffix = await request(`${path}/assets/${assetId}`, {
    token: session.sessionToken, headers: { range: "bytes=-8" },
  });
  assert.equal(suffix.status, 206);
  const invalid = await request(`${path}/assets/${assetId}`, {
    token: session.sessionToken, headers: { range: "bytes=999999-" },
  });
  assert.equal(invalid.status, 416);
  assert.equal((await request(path, { method: "DELETE", token: session.sessionToken })).status, 204);
  assert.ok([401, 404, 410].includes((await request(`${path}/assets/${assetId}`, { token: session.sessionToken })).status));
});
