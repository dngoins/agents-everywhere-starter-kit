import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { AdBrief, MediaJob, SessionCreated, SessionEvent, SessionSnapshot } from "../integration/dwight/types";
import { OrchestratorClient } from "../integration/orchestrator-client";
import { acceptSnapshot, BlobSlot, currentJob, KioskController, parsePreferences, provenanceLabel } from "../src/kiosk/controller";

const ids = {
  session: "11111111-1111-4111-8111-111111111111", brief: "22222222-2222-4222-8222-222222222222",
  job: "33333333-3333-4333-8333-333333333333", consent: "44444444-4444-4444-8444-444444444444",
  asset: "55555555-5555-4555-8555-555555555555", instance: "66666666-6666-4666-8666-666666666666",
};
const capability: SessionCreated = { sessionId: ids.session, sessionToken: "test-session-token-123456789012345", serverInstanceId: ids.instance };
const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
const brief: AdBrief = {
  schemaVersion: 1, id: ids.brief, sessionId: ids.session, customerId: "demo-alex", productId: "demo-car", contextRevision: 1,
  objective: "A synthetic concept", audiencePreferences: ["Beach road trips"],
  scenes: [{ durationSeconds: 6, visual: "Demo car", onScreenText: "A synthetic demo" }],
  callToAction: "Ask the team.", templateId: "demo-car-v1", durationSeconds: 6, provenance: "mock",
};
function snapshot(): SessionSnapshot {
  return {
    sessionId: ids.session, serverInstanceId: ids.instance, revision: 4, state: "brief_ready", expiresAt: Date.now() + 60000,
    consent: { personalization: true, capture: true, enrichment: false, consentId: ids.consent, policyVersion: 1, recordedAt: Date.now() },
    customer: { customerId: "demo-alex", displayName: "Alex", synthetic: true, method: "manual" },
    context: { preferences: ["Beach road trips"], revision: 1, source: "conversation" }, brief, jobs: [], events: [],
  };
}
function readyJob(): MediaJob {
  return { jobId: ids.job, briefId: ids.brief, status: "ready", stage: "ready", createdAt: 100, updatedAt: 110,
    deadline: Date.now() + 60000, attempts: 1, warnings: [], result: {
      assetId: ids.asset, mimeType: "video/mp4", provenance: "mock_fixture", durationSeconds: 6,
      byteLength: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"),
    } };
}
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function errorResponse(status: number) { return json({ error: { code: "REQUEST_FAILED", message: "Safe failure", requestId: ids.consent } }, status); }
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Expected state was not reached within 500ms");
}
function harness(options: { pollIntervalMs?: number; retryDelayMs?: number; maxRetries?: number } = {}) {
  let current = snapshot();
  const calls: { url: string; init: RequestInit }[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  let intercept: ((url: string, init: RequestInit) => Response | Promise<Response> | undefined) | undefined;
  const controller = new KioskController({
    ...options, uuid: randomUUID, pollIntervalMs: options.pollIntervalMs ?? 60000,
    urls: { createObjectURL: () => { const url = `blob:fixture-${created.length + 1}`; created.push(url); return url; }, revokeObjectURL: url => { revoked.push(url); } },
    client: base => new OrchestratorClient(base, { fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init! });
      const override = intercept?.(url, init!);
      if (override !== undefined) return override;
      if (init!.method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/events")) {
        const event = JSON.parse(String(init!.body)) as SessionEvent;
        current = { ...current, revision: current.revision + 1, acknowledgement: { eventId: event.eventId, revision: current.revision + 1 } };
        if (event.type === "consent_recorded") current.consent = { ...event.payload, consentId: event.eventId, policyVersion: 1, recordedAt: Date.now() };
        if (event.type === "context_updated") {
          current.context = { preferences: event.payload.preferences, revision: (current.context?.revision ?? 0) + 1, source: "conversation" };
          current.brief = undefined;
        }
        if (event.type === "media_revealed") current.state = "revealed";
        return json(current);
      }
      if (url.endsWith("/assets") && init!.method === "POST") return json({ assetId: ids.asset }, 201);
      if (url.endsWith(`/assets/${ids.asset}`)) return new Response(bytes, { headers: { "Content-Type": "video/mp4" } });
      if (url.endsWith("/start_media_job")) {
        const job = { ...readyJob(), status: "queued", stage: "accepted", result: undefined };
        current = { ...current, jobs: [job as MediaJob], revision: current.revision + 1, state: "media_pending" };
        return json(job, 202);
      }
      if (url.endsWith("/identify_customer")) {
        const body = JSON.parse(String(init!.body));
        current = { ...current, revision: current.revision + 1, customer: { customerId: body.customerId, displayName: body.customerId === "demo-sam" ? "Sam" : "Alex", synthetic: true, method: "manual" } };
        return json(current.customer);
      }
      if (url.endsWith("/create_ad_brief")) {
        current = { ...current, revision: current.revision + 1, brief: { ...brief, contextRevision: current.context!.revision } };
        return json(current.brief);
      }
      return json(current);
    } }),
  });
  return {
    controller, calls, created, revoked,
    setSnapshot(value: SessionSnapshot) { current = value; },
    getSnapshot() { return current; },
    intercept(value: typeof intercept) { intercept = value; },
    connect: () => controller.connect("http://127.0.0.1:3101", capability),
  };
}

test("full snapshots replace state on reset and never resurrect absent assets", () => {
  const old = { ...snapshot(), revision: 10, jobs: [readyJob()] };
  const incoming = { ...snapshot(), revision: 11, resetRequired: true, brief: undefined, context: undefined };
  const accepted = acceptSnapshot(old, incoming, capability);
  assert.equal(accepted.brief, undefined);
  assert.equal(accepted.context, undefined);
  assert.deepEqual(accepted.jobs, []);
  assert.equal(accepted.resetRequired, true);
});

test("old revisions are ignored; context revision is not the snapshot cursor", () => {
  const old = { ...snapshot(), revision: 100 };
  assert.equal(acceptSnapshot(old, { ...snapshot(), revision: 99, resetRequired: true }, capability), old);
  assert.equal(acceptSnapshot(old, { ...snapshot(), revision: 99, expiresAt: 0 }, capability), old);
  assert.equal(acceptSnapshot(old, { ...snapshot(), revision: 101 }, capability).context?.revision, 1);
});

test("foreign sessions, new server instances, expiry and cancellation invalidate rather than merge", () => {
  for (const patch of [
    { sessionId: ids.asset }, { serverInstanceId: ids.asset }, { expiresAt: 0 }, { state: "cancelled" as const },
  ]) assert.throws(() => acceptSnapshot(snapshot(), { ...snapshot(), ...patch }, capability));
});

test("events stay bounded and current job is isolated to the active brief", () => {
  const events = Array.from({ length: 150 }, (_, revision) => ({ schemaVersion: 1 as const, eventId: randomUUID(), type: "progress", revision: revision + 1, receivedAt: 1, payload: {} }));
  assert.equal(acceptSnapshot(null, { ...snapshot(), events }, capability).events.length, 100);
  assert.equal(currentJob({ ...snapshot(), jobs: [{ ...readyJob(), briefId: ids.asset }] }), undefined);
  assert.equal(currentJob({ ...snapshot(), jobs: [readyJob()] })?.jobId, ids.job);
});

test("preference limits and provenance labels are explicit", () => {
  assert.deepEqual(parsePreferences("  Beach roads \n\n Quiet cabin \r\n"), ["Beach roads", "Quiet cabin"]);
  assert.deepEqual(parsePreferences(""), []);
  assert.throws(() => parsePreferences("a".repeat(201)), /200/);
  assert.throws(() => parsePreferences(Array(21).fill("one").join("\n")), /20/);
  assert.equal(provenanceLabel("mock_fixture"), "Synthetic sample — not the customer");
  assert.equal(provenanceLabel("prerendered_fallback"), "Prerecorded fallback");
  assert.equal(provenanceLabel("generated"), "Generated by media adapter");
});

test("blob slots release replaced and disposed URLs exactly once", () => {
  const revoked: string[] = [];
  let index = 0;
  const slot = new BlobSlot({ createObjectURL: () => `blob:${++index}`, revokeObjectURL: url => { revoked.push(url); } });
  slot.replace(new Blob(["one"]));
  slot.replace(new Blob(["two"]));
  slot.clear();
  slot.clear();
  assert.deepEqual(revoked, ["blob:1", "blob:2"]);
  assert.equal(slot.url, null);
});

test("default kiosk is unpaired, empty and denies capture", t => {
  const h = harness();
  t.after(() => h.controller.dispose());
  assert.equal(h.controller.getState().connection, "unpaired");
  assert.deepEqual(h.controller.getState().consent, { personalization: false, capture: false, enrichment: false });
  h.controller.selectPhoto(new Blob(["x"], { type: "image/png" }));
  assert.equal(h.controller.getState().photoUrl, null);
  assert.equal(h.calls.length, 0);
});

test("consent and context retries reuse stable event IDs and display snapshot-owned customer", async t => {
  const h = harness();
  t.after(() => h.controller.dispose());
  await h.connect();
  assert.equal(h.controller.getState().snapshot?.customer?.displayName, "Alex");
  await h.controller.identify("demo-sam");
  assert.equal(h.controller.getState().snapshot?.customer?.displayName, "Sam");
  let fail = true;
  h.intercept((url) => url.endsWith("/events") && fail ? errorResponse(503) : undefined);
  h.controller.setConsent("enrichment", true);
  await h.controller.saveConsent();
  fail = false;
  await h.controller.saveConsent();
  let events = h.calls.filter(call => call.url.endsWith("/events")).map(call => JSON.parse(String(call.init.body)));
  assert.deepEqual(events[0], events[1]);
  assert.equal(events[0].schemaVersion, 1);
  assert.deepEqual(events[0].payload, { personalization: true, capture: true, enrichment: true });
  fail = true;
  await h.controller.confirmPreferences("Road trips\nQuiet cabin");
  fail = false;
  await h.controller.confirmPreferences("Road trips\nQuiet cabin");
  events = h.calls.filter(call => call.url.endsWith("/events")).map(call => JSON.parse(String(call.init.body)));
  assert.deepEqual(events[2], events[3]);
  assert.equal(events[2].type, "context_updated");
  assert.deepEqual(h.controller.getState().snapshot?.context?.preferences, ["Road trips", "Quiet cabin"]);
});

test("a brief and current permission precede raw upload; permission withdrawal clears reference immediately", async t => {
  const h = harness();
  t.after(() => h.controller.dispose());
  h.setSnapshot({ ...snapshot(), brief: undefined });
  await h.connect();
  const file = new Blob(["image"], { type: "image/png" });
  h.controller.selectPhoto(file);
  assert.equal(h.created.length, 0);
  await h.controller.createBrief();
  h.controller.selectPhoto(file);
  await h.controller.uploadPhoto();
  assert.equal(h.controller.getState().uploadedId, ids.asset);
  const upload = h.calls.find(call => call.init.method === "POST" && call.url.endsWith("/assets"));
  assert.equal(upload?.init.body, file);
  h.controller.setConsent("capture", false);
  assert.equal(h.controller.getState().photoUrl, null);
  assert.equal(h.controller.getState().uploadedId, null);
  assert.deepEqual(h.revoked, h.created);
  await h.controller.startMedia();
  assert.ok(!h.calls.some(call => call.url.endsWith("/start_media_job")));
});

test("lost start acknowledgement retries with the same brief, key and upload; no automatic resubmission", async t => {
  const h = harness();
  t.after(() => h.controller.dispose());
  await h.connect();
  h.controller.selectPhoto(new Blob(["image"], { type: "image/png" }));
  await h.controller.uploadPhoto();
  let fail = true;
  h.intercept(url => url.endsWith("/start_media_job") && fail ? errorResponse(503) : undefined);
  await h.controller.startMedia();
  assert.equal(h.controller.getState().startAttempted, true);
  assert.equal(h.calls.filter(call => call.url.endsWith("/start_media_job")).length, 1);
  h.controller.selectPhoto(new Blob(["different image"], { type: "image/png" }));
  assert.equal(h.created.length, 1);
  fail = false;
  await h.controller.startMedia();
  const starts = h.calls.filter(call => call.url.endsWith("/start_media_job"));
  assert.equal(starts.length, 2);
  assert.equal(starts[0].init.body, starts[1].init.body);
  assert.equal(JSON.parse(String(starts[0].init.body)).briefId, ids.brief);
  assert.equal(h.controller.getState().snapshot?.jobs[0].status, "queued");
});

test("load is authorized and cached; only playing emits reveal; retry is idempotent", async t => {
  const h = harness();
  t.after(() => h.controller.dispose());
  h.setSnapshot({ ...snapshot(), jobs: [readyJob()], state: "media_ready" });
  await h.connect();
  await h.controller.retryReveal();
  h.controller.onPlaying();
  assert.equal(h.calls.filter(call => call.url.endsWith("/events")).length, 0);
  await h.controller.loadMovie();
  await h.controller.loadMovie();
  assert.equal(h.calls.filter(call => call.url.endsWith(`/assets/${ids.asset}`)).length, 1);
  assert.equal(h.calls.filter(call => call.url.endsWith("/events")).length, 0);
  let fail = true;
  h.intercept(url => url.endsWith("/events") && fail ? errorResponse(503) : undefined);
  h.controller.onPlaying();
  await waitFor(() => h.controller.getState().reveal === "failed");
  h.controller.onPlaying();
  assert.equal(h.calls.filter(call => call.url.endsWith("/events")).length, 1);
  fail = false;
  await h.controller.retryReveal();
  h.controller.onPlaying();
  const events = h.calls.filter(call => call.url.endsWith("/events"));
  assert.equal(events.length, 2);
  assert.equal(events[0].init.body, events[1].init.body);
  assert.deepEqual(JSON.parse(String(events[0].init.body)).payload, { jobId: ids.job });
  assert.equal(h.controller.getState().reveal, "acknowledged");
});

test("reset removing a ready result destroys the loaded movie URL", async t => {
  const h = harness({ pollIntervalMs: 5 });
  t.after(() => h.controller.dispose());
  h.setSnapshot({ ...snapshot(), jobs: [readyJob()], state: "media_ready" });
  await h.connect();
  await h.controller.loadMovie();
  assert.ok(h.controller.getState().movieUrl);
  h.setSnapshot({ ...snapshot(), revision: 20, resetRequired: true, jobs: [] });
  await waitFor(() => h.controller.getState().snapshot?.revision === 20);
  assert.equal(h.controller.getState().movieUrl, null);
  assert.deepEqual(h.revoked, h.created);
});

test("auth failures clear capability and blobs instead of spinning", async t => {
  for (const status of [401, 403, 404, 410]) {
    const h = harness({ pollIntervalMs: 5 });
    t.after(() => h.controller.dispose());
    h.setSnapshot({ ...snapshot(), jobs: [readyJob()], state: "media_ready" });
    await h.connect();
    await h.controller.loadMovie();
    h.intercept(() => errorResponse(status));
    await waitFor(() => h.controller.getState().connection === "terminal");
    assert.equal(h.controller.getState().snapshot, null);
    assert.equal(h.controller.getState().movieUrl, null);
    assert.deepEqual(h.revoked, h.created);
    const count = h.calls.length;
    h.controller.retryConnection();
    await h.controller.loadMovie();
    assert.equal(h.calls.length, count);
  }
});

test("network reconnect is bounded and an explicit retry recovers the same session", async t => {
  const h = harness({ pollIntervalMs: 5, retryDelayMs: 1, maxRetries: 3 });
  t.after(() => h.controller.dispose());
  let fail = true;
  h.intercept(() => fail ? errorResponse(503) : undefined);
  await h.connect();
  await waitFor(() => h.controller.getState().connection === "offline");
  assert.equal(h.calls.length, 3);
  assert.match(h.controller.getState().networkError!, /Automatic reconnect stopped/);
  fail = false;
  h.controller.retryConnection();
  await waitFor(() => h.controller.getState().connection === "active");
  assert.ok(h.calls.every(call => call.init.method === "GET"));
});

test("cancel immediately releases blobs, uses a fresh signal and does not claim cleanup on 503", async t => {
  const h = harness();
  t.after(() => h.controller.dispose());
  await h.connect();
  h.controller.selectPhoto(new Blob(["image"], { type: "image/png" }));
  const pollSignal = h.calls[0].init.signal!;
  let fail = true;
  h.intercept((_url, init) => init.method === "DELETE" && fail ? errorResponse(503) : undefined);
  const ending = h.controller.cancel();
  assert.equal(h.controller.getState().photoUrl, null);
  assert.equal(h.controller.getState().connection, "cancelling");
  await ending;
  assert.equal(h.controller.getState().connection, "cleanup_failed");
  assert.match(h.controller.getState().error!, /NOT confirmed/);
  assert.deepEqual(h.revoked, h.created);
  const firstDelete = h.calls.find(call => call.init.method === "DELETE")!;
  assert.notEqual(firstDelete.init.signal, pollSignal);
  assert.equal(firstDelete.init.signal!.aborted, false);
  fail = false;
  await h.controller.cancel();
  assert.equal(h.controller.getState().connection, "unpaired");
  assert.match(h.controller.getState().notice!, /confirmed cleanup/);
  const count = h.calls.length;
  await h.controller.cancel();
  assert.equal(h.calls.length, count);
});

test("server restart invalidates and expiry uses milliseconds, without creating a fresh session", async t => {
  const h = harness({ pollIntervalMs: 5 });
  t.after(() => h.controller.dispose());
  await h.connect();
  h.setSnapshot({ ...snapshot(), serverInstanceId: ids.asset });
  await waitFor(() => h.controller.getState().connection === "terminal");
  assert.match(h.controller.getState().error!, /restarted/);
  h.setSnapshot({ ...snapshot(), expiresAt: Date.now() + 20 });
  await h.connect();
  await waitFor(() => h.controller.getState().connection === "terminal");
  assert.match(h.controller.getState().error!, /expired/);
  assert.ok(h.calls.every(call => call.init.method === "GET"));
});

test("session replacement aborts old work and disposal revokes remaining local blobs", async () => {
  const h = harness();
  await h.connect();
  h.controller.selectPhoto(new Blob(["image"], { type: "image/png" }));
  await h.connect();
  assert.equal(h.controller.getState().photoUrl, null);
  h.controller.selectPhoto(new Blob(["image"], { type: "image/png" }));
  h.controller.dispose();
  assert.deepEqual(h.revoked, h.created);
  assert.equal(h.controller.getState().snapshot, null);
  assert.equal(h.controller.getState().connection, "unpaired");
});
