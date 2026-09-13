import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readConfig } from "../src/config.js";
import type { AdBrief, MediaJob } from "../src/contracts/index.js";
import { Orchestrator } from "../src/orchestrator/service.js";
import { DEMO_MEDIA, isPrerecordedDemoProvider, validateDemoMedia } from "../src/providers/demo-media.js";
import { createProviders } from "../src/providers/factory.js";
import { ProviderFailure } from "../src/providers/http-client.js";

const media = await readFile(new URL(`../fixtures/media/${DEMO_MEDIA.filename}`, import.meta.url));
const image = await readFile(new URL("../fixtures/media/sample.png", import.meta.url));

async function runDemo(core: Orchestrator) {
  const { sessionId } = core.createSession();
  core.event(sessionId, {
    schemaVersion: 1, eventId: randomUUID(), type: "consent_recorded",
    payload: { personalization: true, capture: true, enrichment: false },
  });
  await core.command(sessionId, "identify_customer", { customerId: "demo-alex", method: "manual" });
  core.event(sessionId, {
    schemaVersion: 1, eventId: randomUUID(), type: "context_updated", payload: { preferences: ["Quiet weekend trips"] },
  });
  await core.command(sessionId, "enrich_profile", {});
  core.uploadImage(sessionId, image, "image/png");
  const brief = await core.command(sessionId, "create_ad_brief", { productId: "demo-car" }) as AdBrief;
  assert.equal(brief.durationSeconds, 6, "The unchanged synthetic brief is not executed by prerecorded playback.");
  let job = await core.command(sessionId, "start_media_job", { briefId: brief.id, idempotencyKey: "demo" }) as MediaJob;
  for (let tries = 0; tries < 100 && ["queued", "running"].includes(job.status); tries++) {
    await new Promise<void>((done) => setImmediate(done));
    job = await core.command(sessionId, "get_media_status", { jobId: job.jobId }) as MediaJob;
  }
  return { job, sessionId };
}

function assertDemo(job: MediaJob, core: Orchestrator, sessionId: string) {
  assert.equal(job.status, "ready");
  assert.equal(job.result?.provenance, "prerendered_fallback");
  assert.equal(job.result.durationSeconds, 10);
  assert.equal(job.result.byteLength, 4_273_110);
  assert.equal(job.result.checksum, "69674967b142a7cd9f121df4aac8bb90d2f24274bae5d45d8841b5a337d41773");
  const bytes = core.asset(sessionId, job.result.assetId).bytes;
  assert.deepEqual(Buffer.from(bytes), media, "The supplied video, including its audio, must be byte-for-byte unchanged.");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), DEMO_MEDIA.sha256);
}

test("default media manifest is immutable and rejects truncated, tampered and oversized assets", () => {
  assert.equal(Object.isFrozen(DEMO_MEDIA), true);
  validateDemoMedia(media);
  assert.throws(() => validateDemoMedia(media.subarray(0, media.length - 1)), /invalid/);
  const tampered = Buffer.from(media);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
  assert.throws(() => validateDemoMedia(tampered), /invalid/);
  const invalidHeader = Buffer.from(media);
  invalidHeader.write("junk", 4, "ascii");
  assert.throws(() => validateDemoMedia(invalidHeader), /invalid/);
  assert.throws(() => createProviders(readConfig({ MAX_MEDIA_BYTES: "100" }), media), /MAX_MEDIA_BYTES/);
  assert.throws(() => createProviders(readConfig({}), new Uint8Array()), /invalid/);
});

test("MOCK_ONLY default returns the supplied 10-second prerecorded demo without external calls", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("External calls are forbidden."); });
  const providers = createProviders(readConfig({ MOCK_ONLY: "true", OPENAI_API_KEY: "unused-test-key" }), media);
  assert.equal(isPrerecordedDemoProvider(providers.mediaProvider), true);
  const core = new Orchestrator({ ...providers, allowFallbacks: false });
  t.after(() => core.dispose());
  const { job, sessionId } = await runDemo(core);
  assertDemo(job, core, sessionId);
  assert.equal(job.attempts, 1);
  assert.ok(job.warnings.some((warning) => warning.includes("not generated for this customer or brief")));
  assert.equal(core.snapshot(sessionId).events.some((event) => event.type === "fallback_selected"), false);
  assert.equal(fetch.mock.callCount(), 0);
});

test("explicit recovery uses the same supplied clip without reporting it as generated", async (t) => {
  const providers = createProviders(readConfig({
    MEDIA_PROVIDER: "http", MEDIA_SERVICE_URL: "http://127.0.0.1:3200", MEDIA_SERVICE_TOKEN: "unused-test-token",
  }), media);
  assert.equal(isPrerecordedDemoProvider(providers.mediaProvider), false);
  assert.equal(isPrerecordedDemoProvider(providers.fallbackMediaProvider), true);
  const core = new Orchestrator({
    ...providers, allowFallbacks: true,
    mediaProvider: { name: "failing-test-provider", async generate() {
      throw new ProviderFailure("OFFLINE", "Controlled local failure.");
    } },
  });
  t.after(() => core.dispose());
  const { job, sessionId } = await runDemo(core);
  assertDemo(job, core, sessionId);
  assert.equal(job.attempts, 2);
  assert.equal(core.snapshot(sessionId).events.some((event) => event.type === "fallback_selected"), true);
});

test("synthetic fixture injection keeps its distinct one-second mock metadata", async () => {
  const fixture = await readFile(new URL("../fixtures/media/mock-preview.mp4", import.meta.url));
  assert.equal(createHash("sha256").update(fixture).digest("hex"),
    "7c585ba34069ed9b254869bec3c2dab16a7c436736d167aee4820bceff393e69");
  const providers = createProviders(readConfig({}), fixture, { provenance: "mock_fixture", durationSeconds: 1 });
  assert.equal(isPrerecordedDemoProvider(providers.mediaProvider), false);
  const core = new Orchestrator(providers);
  try {
    const { job, sessionId } = await runDemo(core);
    assert.equal(job.status, "ready");
    assert.equal(job.result?.provenance, "mock_fixture");
    assert.equal(job.result.durationSeconds, 1);
    assert.deepEqual(Buffer.from(core.asset(sessionId, job.result.assetId).bytes), fixture);
  } finally {
    core.dispose();
  }
});

test("prerecorded primary capability cannot be spoofed by provider name, cloning, or fixture metadata", async (t) => {
  const registered = createProviders(readConfig({}), media).mediaProvider;
  const injected = createProviders(readConfig({}), media, { ...DEMO_MEDIA }).mediaProvider;
  for (const provider of [
    { ...registered },
    { name: "http", generate: registered.generate },
    injected,
  ]) {
    assert.equal(isPrerecordedDemoProvider(provider), false);
    const core = new Orchestrator({ mediaProvider: provider });
    t.after(() => core.dispose());
    const { job } = await runDemo(core);
    assert.equal(job.status, "failed");
    assert.equal(job.error?.code, "INVALID_MEDIA_OUTPUT");
    assert.equal(job.result, undefined);
  }
});

test("registered local demo provider is immutable and does not retain caller-owned mutable bytes", async (t) => {
  const supplied = Uint8Array.from(media);
  const providers = createProviders(readConfig({}), supplied);
  assert.equal(Object.isFrozen(providers.mediaProvider), true);
  supplied.fill(0);
  const core = new Orchestrator(providers);
  t.after(() => core.dispose());
  const { job, sessionId } = await runDemo(core);
  assertDemo(job, core, sessionId);
});
