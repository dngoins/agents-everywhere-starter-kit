import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AdBrief, MediaJob, MediaResult, SessionCreated, SessionSnapshot } from "../integration/dwight/types";
import {
  clampRevision, DEFAULT_ORCHESTRATOR_URL, MAX_MOVIE_BYTES, mayProcessMedia,
  normalizeOrchestratorUrl, OrchestratorClient, OrchestratorError, parseApiErrorResponse,
} from "../integration/orchestrator-client";

const sessionId = "11111111-1111-4111-8111-111111111111";
const briefId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const assetId = "55555555-5555-4555-8555-555555555555";
const capability: SessionCreated = { sessionId, serverInstanceId: "66666666-6666-4666-8666-666666666666", sessionToken: "test-session-capability-1234567890" };
const brief: AdBrief = {
  schemaVersion: 1, id: briefId, sessionId, customerId: "demo-alex", productId: "demo-car", contextRevision: 1,
  objective: "A synthetic concept", audiencePreferences: ["Beach road trips"], scenes: [{ durationSeconds: 6, visual: "Demo car", onScreenText: "A synthetic demo" }],
  callToAction: "Ask the team.", templateId: "demo-car-v1", durationSeconds: 6, provenance: "mock",
};
function snapshot(): SessionSnapshot {
  return {
    sessionId, serverInstanceId: capability.serverInstanceId, revision: 4, state: "brief_ready", expiresAt: Date.now() + 60000,
    consent: { personalization: true, capture: true, enrichment: false, consentId: eventId, policyVersion: 1, recordedAt: Date.now() },
    customer: { customerId: "demo-alex", displayName: "Alex", synthetic: true, method: "manual" },
    context: { preferences: ["Beach road trips"], revision: 1, source: "conversation" }, brief, jobs: [], events: [],
  };
}
function job(): MediaJob {
  return { jobId, briefId, status: "queued", stage: "accepted", createdAt: 100, updatedAt: 100, deadline: Date.now() + 60000, attempts: 0, warnings: [] };
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
function fixture(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new OrchestratorClient(DEFAULT_ORCHESTRATOR_URL, { fetch: async (url, init) => {
    calls.push({ url: String(url), init: init! }); return handler(String(url), init!);
  } });
  client.join(capability);
  return { client, calls };
}

test("origins are explicit, HTTPS except loopback, with no credential/query/path redirects", () => {
  assert.equal(normalizeOrchestratorUrl(DEFAULT_ORCHESTRATOR_URL), DEFAULT_ORCHESTRATOR_URL);
  assert.equal(normalizeOrchestratorUrl("https://showroom.example/"), "https://showroom.example");
  assert.equal(normalizeOrchestratorUrl("http://[::1]:3101"), "http://[::1]:3101");
  for (const url of ["http://192.168.1.2:3101", "http://localhost.evil.test", "https://a.test/api", "https://user:pass@a.test", "https://a.test?token=x", "https://a.test#secret", "file:///C:/keys"]) {
    assert.throws(() => normalizeOrchestratorUrl(url));
  }
});

test("device pairing has no invented body; session requests use only the session capability", async () => {
  const { client, calls } = fixture(url => url.endsWith("/v1/sessions") ? json(capability, 201) : json(snapshot()));
  const deviceToken = "test-device-token-123456789012345";
  assert.deepEqual(await client.pair(deviceToken), capability);
  await client.snapshot(42);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(new Headers(calls[0].init.headers).get("Authorization"), `Bearer ${deviceToken}`);
  assert.equal(new Headers(calls[1].init.headers).get("Authorization"), `Bearer ${capability.sessionToken}`);
  assert.equal(calls[1].url, `${DEFAULT_ORCHESTRATOR_URL}/v1/sessions/${sessionId}?afterRevision=42`);
  for (const { url, init } of calls) {
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal);
    assert.ok(!url.includes(capability.sessionToken) && !url.includes(deviceToken));
  }
});

test("revision cursor is clamped independently from context revision", async () => {
  assert.equal(clampRevision(-1), 0);
  assert.equal(clampRevision(NaN), 0);
  assert.equal(clampRevision(Infinity), 0);
  assert.equal(clampRevision(2.9), 2);
  const { client, calls } = fixture(() => json(snapshot()));
  await client.snapshot(1e12);
  assert.ok(calls[0].url.endsWith("?afterRevision=999999999"));
});

test("identity, context event, brief and media request use exact v1 command shapes", async () => {
  const { client, calls } = fixture(url => {
    if (url.endsWith("/identify_customer")) return json(snapshot().customer);
    if (url.endsWith("/create_ad_brief")) return json(brief);
    if (url.endsWith("/start_media_job")) return json(job(), 202);
    return json(snapshot());
  });
  assert.equal((await client.identify("demo-alex")).synthetic, true);
  await client.event({ schemaVersion: 1, eventId, type: "context_updated", payload: { preferences: ["Beach road trips"] } });
  assert.equal((await client.createBrief()).id, briefId);
  await client.startMedia(briefId, "stable.command:key-1");
  assert.deepEqual(calls.map(call => JSON.parse(String(call.init.body))), [
    { customerId: "demo-alex", method: "manual" },
    { schemaVersion: 1, eventId, type: "context_updated", payload: { preferences: ["Beach road trips"] } },
    { productId: "demo-car" }, { briefId, idempotencyKey: "stable.command:key-1" },
  ]);
  for (const call of calls) assert.equal(new Headers(call.init.headers).get("Content-Type"), "application/json");
});

test("rejects invalid capabilities and malformed or cross-session response receipts", async () => {
  const { client } = fixture(() => json({ ...brief, sessionId: assetId }));
  assert.throws(() => client.join({ ...capability, sessionToken: "short" }));
  assert.throws(() => client.join({ ...capability, sessionToken: "x".repeat(24) + "\n" }));
  await assert.rejects(() => client.createBrief(), /another session/);
  const bad = fixture(() => json({ customerId: "demo-alex", displayName: "Alex", synthetic: false, method: "manual" }));
  await assert.rejects(() => bad.client.identify("demo-alex"), /invalid response/);
  const wrongJob = fixture(() => json({ ...job(), briefId: assetId }));
  await assert.rejects(() => wrongJob.client.startMedia(briefId, "stable-key"), /another brief/);
});

test("image uploads are raw permitted PNG/JPEG bytes, not multipart or a service request", async () => {
  const { client, calls } = fixture(() => json({ assetId }, 201));
  const file = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const receipt = await client.uploadImage(file, snapshot());
  assert.equal(receipt.assetId, assetId);
  assert.equal(calls[0].url, `${DEFAULT_ORCHESTRATOR_URL}/v1/sessions/${sessionId}/assets`);
  assert.equal(calls[0].init.body, file);
  assert.equal(new Headers(calls[0].init.headers).get("Content-Type"), "image/png");
  const noCapture = snapshot();
  noCapture.consent!.capture = false;
  assert.equal(mayProcessMedia(noCapture), false);
  await assert.rejects(() => client.uploadImage(file, noCapture), /permission/);
  await assert.rejects(() => client.uploadImage(file, { ...snapshot(), sessionId: assetId }), /permission/);
  await assert.rejects(() => client.uploadImage(file, { ...snapshot(), expiresAt: Date.now() - 1 }), /permission/);
  await assert.rejects(() => client.uploadImage(new Blob(["bad"], { type: "image/gif" }), snapshot()), /PNG or JPEG/);
  await assert.rejects(() => client.uploadImage(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" }), snapshot()), /5 MiB/);
  assert.equal(calls.length, 1);
});

test("nested API error shape is parsed and auth/expiry statuses are terminal", async () => {
  const body = { error: { code: "SESSION_EXPIRED", message: "Safe failure", requestId: eventId } };
  assert.deepEqual(parseApiErrorResponse(body), body);
  assert.equal(parseApiErrorResponse({ error: "legacy", message: "wrong format" }), undefined);
  assert.equal(parseApiErrorResponse({ code: "SESSION_EXPIRED" }), undefined);
  for (const status of [401, 403, 404, 410]) {
    const { client } = fixture(() => json(body, status));
    await assert.rejects(() => client.snapshot(), error =>
      error instanceof OrchestratorError && error.terminal && error.status === status && error.code === "SESSION_EXPIRED");
  }
});

const movieBytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
function result(): MediaResult {
  return { assetId, mimeType: "video/mp4", provenance: "mock_fixture", durationSeconds: 6,
    byteLength: movieBytes.byteLength, checksum: createHash("sha256").update(movieBytes).digest("hex") };
}

test("authorized movie download verifies bytes and SHA-256 before creating a Blob", async () => {
  const { client, calls } = fixture(() => new Response(movieBytes, { headers: {
    "Content-Type": "video/mp4", "Content-Length": String(movieBytes.length),
  } }));
  const blob = await client.downloadMovie(result());
  assert.equal(blob.type, "video/mp4");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), movieBytes);
  assert.equal(calls[0].url, `${DEFAULT_ORCHESTRATOR_URL}/v1/sessions/${sessionId}/assets/${assetId}`);
  assert.equal(new Headers(calls[0].init.headers).get("Range"), null);
});

test("movie download rejects MIME, declared size, bounded stream overflow, truncation and checksum errors", async () => {
  const cases: { bytes: Uint8Array<ArrayBuffer>; headers: Record<string, string>; match: RegExp }[] = [
    { bytes: movieBytes, headers: { "Content-Type": "image/png" }, match: /not a complete MP4/ },
    { bytes: movieBytes, headers: { "Content-Type": "video/mp4", "Content-Length": "100" }, match: /length does not match/ },
    { bytes: new Uint8Array(50), headers: { "Content-Type": "video/mp4" }, match: /exceeded/ },
    { bytes: new Uint8Array(1), headers: { "Content-Type": "video/mp4" }, match: /incomplete/ },
    { bytes: new Uint8Array(movieBytes.length), headers: { "Content-Type": "video/mp4" }, match: /checksum/ },
  ];
  for (const item of cases) {
    const { client } = fixture(() => new Response(item.bytes, { headers: item.headers }));
    await assert.rejects(() => client.downloadMovie(result()), item.match);
  }
  const { client, calls } = fixture(() => { throw new Error("Should not fetch oversized media"); });
  await assert.rejects(() => client.downloadMovie({ ...result(), byteLength: MAX_MOVIE_BYTES + 1 }), /supported size/);
  assert.equal(calls.length, 0);
});

test("overflow stops a chunked response without retaining an unbounded buffer", async () => {
  let cancelled = false;
  let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const { client } = fixture(() => new Response(stream, { headers: { "Content-Type": "video/mp4" } }));
  await assert.rejects(() => client.downloadMovie(result()), /exceeded/);
  assert.equal(cancelled, true);
  assert.ok(chunks <= 2);
});

test("request timeouts and external cancellation abort the actual fetch", async () => {
  const signals: AbortSignal[] = [];
  const client = new OrchestratorClient(DEFAULT_ORCHESTRATOR_URL, {
    requestTimeoutMs: 10,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  client.join(capability);
  await assert.rejects(() => client.snapshot(), /timed out or was stopped/);
  assert.equal(signals[0].aborted, true);
  const abort = new AbortController();
  const pending = client.snapshot(0, abort.signal);
  abort.abort();
  await assert.rejects(() => pending, /timed out or was stopped/);
  assert.equal(signals[1].aborted, true);
});

test("DELETE requires explicit 204 acknowledgement; 503 does not mean cleanup succeeded", async () => {
  const bad = fixture(() => json({ error: { code: "CLEANUP_PENDING", message: "Retry", requestId: eventId } }, 503));
  await assert.rejects(() => bad.client.revoke(), error => error instanceof OrchestratorError && error.status === 503);
  const ok = fixture(() => new Response(null, { status: 204 }));
  await ok.client.revoke();
  assert.equal(ok.calls[0].init.method, "DELETE");
  ok.client.forget();
  assert.throws(() => ok.client.snapshot(), /Rejoin/);
});
