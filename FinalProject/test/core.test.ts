import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import test from 'node:test';
import { AdBriefSchema, MediaJobSchema, SessionEventSchema, type AdBrief, type MediaJob } from '../src/contracts/index.js';
import { Orchestrator, ApiError, type OrchestratorOptions } from '../src/orchestrator/service.js';
import { createMockBriefProvider, createMockProfileProvider } from '../src/providers/mock.js';
import { ProviderFailure } from '../src/providers/http-client.js';
import type { BriefProvider, MediaInput, MediaOutput, MediaProvider, ProfileProvider } from '../src/providers/interfaces.js';

const mp4 = await readFile(new URL('../fixtures/media/mock-preview.mp4', import.meta.url));
const png = await readFile(new URL('../fixtures/media/sample.png', import.meta.url));
const output = (): MediaOutput => ({
  bytes: Uint8Array.from(mp4), mimeType: 'video/mp4', provenance: 'mock_fixture', durationSeconds: 1,
});
const immediateMedia = (): MediaProvider => ({ name: 'mock', async generate() { return output(); } });
const event = (type: string, payload: unknown = {}, eventId = randomUUID()) => ({
  schemaVersion: 1, eventId, type, payload,
});
const consent = (overrides: Partial<{ personalization: boolean; capture: boolean; enrichment: boolean }> = {}) =>
  event('consent_recorded', { personalization: true, capture: true, enrichment: false, ...overrides });
const errorCode = (status: number, code?: string) => (error: unknown) => {
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  return true;
};
function setup(options: Partial<OrchestratorOptions> = {}) {
  return new Orchestrator({ mediaProvider: immediateMedia(), ...options });
}
async function prepare(core: Orchestrator, upload = true) {
  const session = core.createSession();
  core.event(session.sessionId, event('customer_detected'));
  core.event(session.sessionId, consent());
  const customer = await core.command(session.sessionId, 'identify_customer', { customerId: 'demo-alex', method: 'manual' });
  core.event(session.sessionId, event('context_updated', { preferences: ['Comfortable weekend travel'] }));
  const brief = await core.command(session.sessionId, 'create_ad_brief', { productId: 'demo-car' }) as AdBrief;
  if (upload) core.uploadImage(session.sessionId, png, 'image/png');
  return { ...session, customer, brief };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function terminalJob(core: Orchestrator, sessionId: string, jobId: string): Promise<MediaJob> {
  for (let tries = 0; tries < 100; tries++) {
    const job = await core.command(sessionId, 'get_media_status', { jobId }) as MediaJob;
    if (!['queued', 'running'].includes(job.status)) return job;
    await tick();
  }
  assert.fail('The job did not finish.');
}
function deferredMedia() {
  let resolve!: (result: MediaOutput) => void;
  let reject!: (reason: unknown) => void;
  let progress!: (stage: string) => void;
  let signal!: AbortSignal;
  const calls: MediaInput[] = [];
  const promise = new Promise<MediaOutput>((yes, no) => { resolve = yes; reject = no; });
  const provider: MediaProvider = {
    name: 'controlled',
    async generate(input, suppliedSignal, suppliedProgress) {
      calls.push(input);
      signal = suppliedSignal;
      progress = suppliedProgress;
      return promise;
    },
  };
  return { provider, calls, resolve, reject, progress: (stage: string) => progress(stage), signal: () => signal };
}

test('cancellation releases personalized job inputs from retained session records', async (t) => {
  const pending = deferredMedia();
  const core = setup({ mediaProvider: pending.provider });
  t.after(() => core.dispose());
  const session = await prepare(core);
  await core.command(session.sessionId, 'start_media_job', { briefId: session.brief.id, idempotencyKey: 'private-input' });
  await tick();
  core.event(session.sessionId, event('session_cancelled'));
  assert.equal(inspect(core, { depth: null }).includes('Comfortable weekend travel'), false);
  pending.resolve(output());
  await tick();
});

test('golden path returns validated immutable contracts and real private MP4 bytes', async (t) => {
  let received: MediaInput | undefined;
  const core = setup({
    mediaProvider: { name: 'mock', async generate(input, _signal, progress) {
      received = input;
      progress('rendering');
      return output();
    } },
  });
  t.after(() => core.dispose());
  const session = await prepare(core);
  assert.equal(core.authorize(session.sessionId, session.sessionToken), true);
  assert.equal(core.authorize(session.sessionId, 'incorrect'), false);
  assert.equal(AdBriefSchema.safeParse(session.brief).success, true);
  assert.equal(session.brief.provenance, 'mock');
  assert.equal((session.customer as { synthetic: boolean }).synthetic, true);
  const started = await core.command(session.sessionId, 'start_media_job', { briefId: session.brief.id, idempotencyKey: 'golden' }) as MediaJob;
  const ready = await terminalJob(core, session.sessionId, started.jobId);
  assert.equal(ready.status, 'ready');
  assert.equal(MediaJobSchema.safeParse(ready).success, true);
  assert.equal(ready.result?.provenance, 'mock_fixture');
  assert.equal(ready.result?.byteLength, mp4.byteLength);
  assert.equal(ready.result?.checksum, createHash('sha256').update(mp4).digest('hex'));
  assert.deepEqual(received?.image.bytes, Uint8Array.from(png));
  const asset = core.asset(session.sessionId, ready.result!.assetId);
  assert.deepEqual(asset.bytes, Uint8Array.from(mp4));
  assert.equal(asset.mimeType, 'video/mp4');
  asset.bytes.fill(0);
  assert.deepEqual(core.asset(session.sessionId, ready.result!.assetId).bytes, Uint8Array.from(mp4));
  const snapshot = core.snapshot(session.sessionId);
  assert.equal(snapshot.state, 'media_ready');
  snapshot.brief!.scenes[0]!.visual = 'tampered';
  assert.notEqual(core.snapshot(session.sessionId).brief!.scenes[0]!.visual, 'tampered');
  assert.equal(JSON.stringify(snapshot).includes(session.sessionToken), false);
  assert.equal(JSON.stringify(snapshot).includes('"bytes"'), false);
  assert.equal(JSON.stringify(snapshot).includes('idempotencyKey'), false);
  core.event(session.sessionId, event('media_revealed', { jobId: ready.jobId }));
  assert.equal(core.snapshot(session.sessionId).state, 'revealed');
  await assert.rejects(core.command(session.sessionId, 'schedule_followup', {}), errorCode(503, 'FOLLOWUP_DISABLED'));
});

test('consent and roster are explicit; detection has no business side effects', async (t) => {
  const media = deferredMedia();
  let briefCalls = 0;
  const mockBrief = createMockBriefProvider();
  const core = setup({ mediaProvider: media.provider, briefProvider: {
    name: 'mock', async create(input, signal) { briefCalls++; return mockBrief.create(input, signal); },
  } });
  t.after(() => core.dispose());
  const { sessionId } = core.createSession();
  core.event(sessionId, event('customer_detected'));
  assert.equal(core.snapshot(sessionId).customer, undefined);
  assert.equal(media.calls.length, 0);
  assert.equal(briefCalls, 0);
  await assert.rejects(core.command(sessionId, 'identify_customer', { customerId: 'demo-alex', method: 'manual' }), errorCode(403));
  await assert.rejects(core.command(sessionId, 'create_ad_brief', { productId: 'demo-car' }), errorCode(403));
  assert.throws(() => core.uploadImage(sessionId, png, 'image/png'), errorCode(403));
  core.event(sessionId, consent({ capture: false }));
  await assert.rejects(core.command(sessionId, 'identify_customer', { customerId: 'unknown', method: 'manual' }), errorCode(404));
  assert.equal(core.snapshot(sessionId).customer, undefined);
  await core.command(sessionId, 'identify_customer', { customerId: 'demo-sam', method: 'enrolled' });
  assert.equal(core.snapshot(sessionId).customer?.displayName, 'Sam');
  assert.throws(() => core.uploadImage(sessionId, png, 'image/png'), errorCode(403, 'CAPTURE_CONSENT_REQUIRED'));
  assert.equal(media.calls.length, 0);
  assert.equal(briefCalls, 0);
});

test('strict schemas reject old envelopes, unknown properties and stale transitions', async (t) => {
  const core = setup();
  t.after(() => core.dispose());
  const { sessionId } = core.createSession();
  for (const bad of [
    { ...event('customer_detected'), schemaVersion: 0 },
    { ...event('customer_detected'), eventId: 'not-a-uuid' },
    { ...event('customer_detected'), occurredAt: 'old' },
    event('customer_detected', { image: 'hidden capture' }),
    event('consent_recorded', { personalization: 'true', capture: true, enrichment: false }),
    event('context_updated', { preferences: ['safe'], profileUrl: 'file:///private' }),
    event('context_updated', { preferences: ['safe'], profileUrl: 'https://user:password@example.com' }),
    event('unknown'),
  ]) {
    assert.equal(SessionEventSchema.safeParse(bad).success, false);
    assert.throws(() => core.event(sessionId, bad), errorCode(400));
  }
  assert.throws(() => core.event(sessionId, event('media_revealed', { jobId: randomUUID() })), errorCode(409));
  await assert.rejects(core.command(sessionId, 'identify_customer', { customerId: 'demo-alex', method: 'manual', secret: 1 }), errorCode(400));
  await assert.rejects(core.command(sessionId, 'unknown', {}), errorCode(400));
  core.event(sessionId, consent());
  await core.command(sessionId, 'identify_customer', { customerId: 'demo-alex', method: 'qr' });
  assert.throws(() => core.event(sessionId, event('customer_detected')), errorCode(409));
  await assert.rejects(core.command(sessionId, 'identify_customer', { customerId: 'demo-sam', method: 'qr' }), errorCode(409));
});

test('event IDs deduplicate with original acknowledgement and reject changed payloads', async (t) => {
  const core = setup();
  t.after(() => core.dispose());
  const { sessionId } = core.createSession();
  const input = consent();
  const first = core.event(sessionId, input);
  assert.deepEqual(core.event(sessionId, input), first);
  await core.command(sessionId, 'identify_customer', { customerId: 'demo-alex', method: 'manual' });
  const before = core.snapshot(sessionId).revision;
  const replay = core.event(sessionId, input);
  assert.deepEqual(replay.acknowledgement, first.acknowledgement);
  assert.equal(replay.revision, before);
  assert.throws(() => core.event(sessionId, { ...input, payload: { personalization: true, capture: false, enrichment: false } }), errorCode(409, 'EVENT_CONFLICT'));
});

test('media needs a registered upload; commands do not accept forged asset URLs or IDs', async (t) => {
  const core = setup();
  t.after(() => core.dispose());
  const session = await prepare(core, false);
  const input = { briefId: session.brief.id, idempotencyKey: 'upload-required' };
  await assert.rejects(core.command(session.sessionId, 'start_media_job', input), errorCode(409, 'IMAGE_REQUIRED'));
  await assert.rejects(core.command(session.sessionId, 'start_media_job', { ...input, imageUrl: 'https://example.com/photo.png' }), errorCode(400));
  assert.throws(() => core.uploadImage(session.sessionId, new Uint8Array([1, 2]), 'image/png'), errorCode(415));
  assert.throws(() => core.uploadImage(session.sessionId, new Uint8Array(5 * 1024 * 1024 + 1), 'image/png'), errorCode(413));
  const one = core.uploadImage(session.sessionId, png, 'image/png');
  const two = core.uploadImage(session.sessionId, png, 'image/png');
  assert.throws(() => core.asset(session.sessionId, one.assetId), errorCode(404));
  assert.deepEqual(core.asset(session.sessionId, two.assetId).bytes, Uint8Array.from(png));
});

test('concurrent idempotency permits one call, freezes context and persists terminal acknowledgement', async (t) => {
  const media = deferredMedia();
  const core = setup({ mediaProvider: media.provider });
  t.after(() => core.dispose());
  const session = await prepare(core);
  const input = { briefId: session.brief.id, idempotencyKey: 'same-key' };
  const jobs = await Promise.all(Array.from({ length: 20 }, () => core.command(session.sessionId, 'start_media_job', input) as Promise<MediaJob>));
  await tick();
  assert.equal(new Set(jobs.map((job) => job.jobId)).size, 1);
  assert.equal(media.calls.length, 1);
  assert.throws(() => core.event(session.sessionId, event('context_updated', { preferences: ['changed'] })), errorCode(409));
  assert.throws(() => core.uploadImage(session.sessionId, png, 'image/png'), errorCode(409));
  await assert.rejects(core.command(session.sessionId, 'create_ad_brief', { productId: 'demo-car' }), errorCode(409));
  await assert.rejects(core.command(session.sessionId, 'enrich_profile', {}), errorCode(409));
  await assert.rejects(core.command(session.sessionId, 'start_media_job', { ...input, idempotencyKey: 'second' }), errorCode(409));
  await assert.rejects(core.command(session.sessionId, 'start_media_job', { ...input, briefId: randomUUID() }), errorCode(409, 'IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(media.calls[0]?.brief, session.brief);
  media.resolve(output());
  const ready = await terminalJob(core, session.sessionId, jobs[0]!.jobId);
  assert.deepEqual(await core.command(session.sessionId, 'start_media_job', input), ready);
  const revision = core.snapshot(session.sessionId).revision;
  media.progress('rendering');
  assert.equal(core.snapshot(session.sessionId).revision, revision);
  assert.equal(core.snapshot(session.sessionId).jobs[0]?.status, 'ready');
});

test('one media execution runs globally with a bounded waiting queue', async (t) => {
  const media = deferredMedia();
  const core = setup({ mediaProvider: media.provider, maxQueuedJobs: 1 });
  t.after(() => core.dispose());
  const one = await prepare(core);
  const two = await prepare(core);
  const three = await prepare(core);
  const first = await core.command(one.sessionId, 'start_media_job', { briefId: one.brief.id, idempotencyKey: 'one' }) as MediaJob;
  const second = await core.command(two.sessionId, 'start_media_job', { briefId: two.brief.id, idempotencyKey: 'two' }) as MediaJob;
  assert.equal(first.status, 'running');
  assert.equal(second.status, 'queued');
  await assert.rejects(core.command(three.sessionId, 'start_media_job', { briefId: three.brief.id, idempotencyKey: 'three' }), errorCode(429));
  assert.equal(core.snapshot(three.sessionId).state, 'brief_ready');
  await tick();
  assert.equal(media.calls.length, 1);
  media.resolve(output());
  await terminalJob(core, one.sessionId, first.jobId);
  await terminalJob(core, two.sessionId, second.jobId);
  assert.equal(media.calls.length, 2);
});

test('cancellation revokes assets, aborts provider and suppresses late results/progress', async (t) => {
  const media = deferredMedia();
  const core = setup({ mediaProvider: media.provider });
  t.after(() => core.dispose());
  const session = await prepare(core);
  const photo = core.uploadImage(session.sessionId, png, 'image/png');
  const job = await core.command(session.sessionId, 'start_media_job', { briefId: session.brief.id, idempotencyKey: 'cancel' }) as MediaJob;
  await tick();
  core.event(session.sessionId, event('session_cancelled'));
  assert.equal(media.signal().aborted, true);
  assert.throws(() => core.asset(session.sessionId, photo.assetId), errorCode(404));
  const cancelled = core.snapshot(session.sessionId);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.jobs[0]?.status, 'cancelled');
  assert.equal(cancelled.consent, undefined);
  assert.equal(cancelled.customer, undefined);
  assert.equal(cancelled.brief, undefined);
  media.progress('rendering');
  media.resolve(output());
  await tick();
  assert.deepEqual(core.snapshot(session.sessionId), cancelled);
  assert.equal((await core.command(session.sessionId, 'get_media_status', { jobId: job.jobId }) as MediaJob).result, undefined);
  await assert.rejects(core.command(session.sessionId, 'create_ad_brief', { productId: 'demo-car' }), errorCode(409));
});

test('revoking any granted scope cancels; deleting invalidates credentials and session ownership', async (t) => {
  const core = setup();
  t.after(() => core.dispose());
  const session = await prepare(core);
  const started = await core.command(session.sessionId, 'start_media_job', { briefId: session.brief.id, idempotencyKey: 'revoke' }) as MediaJob;
  const ready = await terminalJob(core, session.sessionId, started.jobId);
  core.event(session.sessionId, consent({ capture: false }));
  const cancelled = core.snapshot(session.sessionId);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.jobs[0]?.status, 'ready', 'terminal job status never regresses');
  assert.equal(cancelled.jobs[0]?.result, undefined);
  assert.throws(() => core.asset(session.sessionId, ready.result!.assetId), errorCode(404));
  core.deleteSession(session.sessionId);
  assert.throws(() => core.authorize(session.sessionId, session.sessionToken), errorCode(410));
  assert.throws(() => core.snapshot(session.sessionId), errorCode(410));
  const other = core.createSession();
  await assert.rejects(core.command(other.sessionId, 'get_media_status', { jobId: started.jobId }), errorCode(404));
});

test('fake-clock expiration is enforced on reads, writes, authorization and provider completion', async (t) => {
  let now = 10;
  const media = deferredMedia();
  const core = setup({ now: () => now, sessionTtlMs: 100, mediaProvider: media.provider });
  t.after(() => core.dispose());
  const session = await prepare(core);
  await core.command(session.sessionId, 'start_media_job', { briefId: session.brief.id, idempotencyKey: 'expiry' });
  await tick();
  now = 110;
  media.resolve(output());
  await tick();
  assert.equal(media.signal().aborted, true);
  assert.throws(() => core.authorize(session.sessionId, session.sessionToken), errorCode(410));
  assert.throws(() => core.snapshot(session.sessionId), errorCode(410));
  assert.throws(() => core.event(session.sessionId, consent()), errorCode(410));
  assert.throws(() => core.uploadImage(session.sessionId, png, 'image/png'), errorCode(410));
  assert.throws(() => core.asset(session.sessionId, randomUUID()), errorCode(410));
  assert.throws(() => core.deleteSession(session.sessionId), errorCode(410));
  await assert.rejects(core.command(session.sessionId, 'enrich_profile', {}), errorCode(410));
});

test('provider deadline wins even if the provider ignores AbortSignal', async (t) => {
  const media = deferredMedia();
  const core = setup({ mediaProvider: media.provider, jobTimeoutMs: 20 });
  t.after(() => core.dispose());
  const session = await prepare(core);
  const started = await core.command(session.sessionId, 'start_media_job', { briefId: session.brief.id, idempotencyKey: 'timeout' }) as MediaJob;
  await new Promise((resolve) => setTimeout(resolve, 40));
  const expired = await core.command(session.sessionId, 'get_media_status', { jobId: started.jobId }) as MediaJob;
  assert.equal(expired.status, 'expired');
  assert.equal(media.signal().aborted, true);
  media.resolve(output());
  await tick();
  assert.deepEqual(await core.command(session.sessionId, 'get_media_status', { jobId: started.jobId }), expired);
});

test('queued jobs expire without being submitted and cancellation before dispatch calls no provider', async (t) => {
  let now = 0;
  const media = deferredMedia();
  const core = setup({ mediaProvider: media.provider, now: () => now, jobTimeoutMs: 100 });
  t.after(() => core.dispose());
  const one = await prepare(core);
  const two = await prepare(core);
  await core.command(one.sessionId, 'start_media_job', { briefId: one.brief.id, idempotencyKey: 'first' });
  const queued = await core.command(two.sessionId, 'start_media_job', { briefId: two.brief.id, idempotencyKey: 'queued' }) as MediaJob;
  await tick();
  now = 101;
  assert.equal((await core.command(two.sessionId, 'get_media_status', { jobId: queued.jobId }) as MediaJob).status, 'expired');
  media.resolve(output());
  await tick();
  assert.equal(media.calls.length, 1);
  const three = await prepare(core);
  const acceptance = core.command(three.sessionId, 'start_media_job', { briefId: three.brief.id, idempotencyKey: 'no-dispatch' });
  core.event(three.sessionId, event('session_cancelled'));
  await acceptance;
  await tick();
  assert.equal(media.calls.length, 1);
});

test('malformed media never becomes ready and public failures do not expose provider data', async (t) => {
  const badOutputs: unknown[] = [
    { ...output(), bytes: new Uint8Array() },
    { ...output(), bytes: new TextEncoder().encode('not-an-mp4 secret token') },
    { ...output(), durationSeconds: NaN },
    { ...output(), provenance: 'generated', mimeType: 'text/html' },
    { ...output(), provenance: 'prerendered_fallback' },
    { ...output(), internalProviderToken: 'secret' },
  ];
  for (const invalid of badOutputs) {
    const core = setup({ mediaProvider: { name: 'invalid', async generate() { return invalid as MediaOutput; } } });
    t.after(() => core.dispose());
    const session = await prepare(core);
    const started = await core.command(session.sessionId, 'start_media_job', { briefId: session.brief.id, idempotencyKey: 'invalid' }) as MediaJob;
    const failed = await terminalJob(core, session.sessionId, started.jobId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'INVALID_MEDIA_OUTPUT');
    assert.equal(failed.result, undefined);
    assert.equal(JSON.stringify(core.snapshot(session.sessionId)).includes('secret'), false);
  }
});

test('generated provenance is preserved; fallback is explicit and never retries uncertain acceptance', async (t) => {
  let fallbackCalls = 0;
  const fallback: MediaProvider = { name: 'fixture-fallback', async generate() {
    fallbackCalls++;
    return { ...output(), provenance: 'prerendered_fallback' };
  } };
  const generated = setup({ mediaProvider: { name: 'real', async generate() { return { ...output(), provenance: 'generated' }; } } });
  t.after(() => generated.dispose());
  const realSession = await prepare(generated);
  const realJob = await generated.command(realSession.sessionId, 'start_media_job', { briefId: realSession.brief.id, idempotencyKey: 'generated' }) as MediaJob;
  assert.equal((await terminalJob(generated, realSession.sessionId, realJob.jobId)).result?.provenance, 'generated');
  for (const [allowFallbacks, uncertain, expectFallback] of [[false, false, false], [true, false, true], [true, true, false]] as const) {
    let primaryCalls = 0;
    const core = setup({
      allowFallbacks, fallbackMediaProvider: fallback,
      mediaProvider: { name: 'real', async generate() {
        primaryCalls++;
        throw new ProviderFailure('OFFLINE', 'secret provider payload', false, uncertain);
      } },
    });
    t.after(() => core.dispose());
    const before = fallbackCalls;
    const session = await prepare(core);
    const job = await core.command(session.sessionId, 'start_media_job', { briefId: session.brief.id, idempotencyKey: 'fallback' }) as MediaJob;
    const result = await terminalJob(core, session.sessionId, job.jobId);
    assert.equal(primaryCalls, 1);
    assert.equal(fallbackCalls - before, expectFallback ? 1 : 0);
    assert.equal(result.status, expectFallback ? 'ready' : 'failed');
    assert.equal(core.snapshot(session.sessionId).events.some((item) => item.type === 'fallback_selected'), expectFallback);
    if (expectFallback) {
      assert.equal(result.result?.provenance, 'prerendered_fallback');
      assert.equal(result.warnings.length, 1);
    }
    assert.equal(JSON.stringify(core.snapshot(session.sessionId)).includes('secret'), false);
  }
});

test('real enrichment requires separate consent and a supplied URL; suggestions remain unconfirmed', async (t) => {
  let calls = 0;
  const provider: ProfileProvider = { name: 'mock', async enrich(input) {
    calls++;
    assert.equal(input.context.profileUrl, 'https://example.com/profile');
    return { preferences: ['Unconfirmed provider suggestion'], citations: ['https://example.com/profile'], provenance: 'exa', warnings: [] };
  } };
  const core = setup({ profileProvider: provider });
  t.after(() => core.dispose());
  const session = await prepare(core);
  await assert.rejects(core.command(session.sessionId, 'enrich_profile', {}), errorCode(403));
  core.event(session.sessionId, consent({ enrichment: true }));
  await assert.rejects(core.command(session.sessionId, 'enrich_profile', {}), errorCode(400));
  assert.equal(calls, 0);
  core.event(session.sessionId, event('context_updated', { preferences: ['Confirmed preference'], profileUrl: 'https://example.com/profile' }));
  await core.command(session.sessionId, 'enrich_profile', {});
  assert.equal(calls, 1);
  const context = core.snapshot(session.sessionId).context!;
  assert.deepEqual(context.preferences, ['Confirmed preference']);
  assert.deepEqual(context.profile?.preferences, ['Unconfirmed provider suggestion']);
  assert.equal(core.snapshot(session.sessionId).brief, undefined);
  const mock = setup({ profileProvider: createMockProfileProvider() });
  t.after(() => mock.dispose());
  const demo = await prepare(mock);
  await mock.command(demo.sessionId, 'enrich_profile', {});
  assert.equal(mock.snapshot(demo.sessionId).context?.profile?.provenance, 'demo');
});

test('brief/profile boundaries validate outputs, lock concurrent mutations and propagate unexpected errors', async (t) => {
  const unexpected = new Error('Internal failure to be handled by the HTTP boundary');
  const base = createMockBriefProvider();
  const invalidProviders: BriefProvider[] = [
    { name: 'invalid', async create(input, signal) { return { ...await base.create(input, signal), customerId: 'demo-sam' }; } },
    { name: 'invalid', async create(input, signal) { return { ...await base.create(input, signal), audiencePreferences: ['invented'] }; } },
  ];
  for (const briefProvider of invalidProviders) {
    const core = setup({ briefProvider });
    t.after(() => core.dispose());
    const { sessionId } = core.createSession();
    core.event(sessionId, consent());
    await core.command(sessionId, 'identify_customer', { customerId: 'demo-alex', method: 'manual' });
    core.event(sessionId, event('context_updated', { preferences: ['Confirmed'] }));
    await assert.rejects(core.command(sessionId, 'create_ad_brief', { productId: 'demo-car' }), errorCode(502));
    assert.equal(core.snapshot(sessionId).brief, undefined);
    assert.equal(core.snapshot(sessionId).state, 'context_ready');
  }
  const errorCore = setup({ briefProvider: { name: 'broken', async create() { throw unexpected; } } });
  t.after(() => errorCore.dispose());
  const { sessionId } = errorCore.createSession();
  errorCore.event(sessionId, consent());
  await errorCore.command(sessionId, 'identify_customer', { customerId: 'demo-alex', method: 'manual' });
  errorCore.event(sessionId, event('context_updated', { preferences: ['Confirmed'] }));
  await assert.rejects(errorCore.command(sessionId, 'create_ad_brief', { productId: 'demo-car' }), (error) => error === unexpected);

  let finish!: (value: AdBrief) => void;
  let expected!: AdBrief;
  const delayed = setup({ briefProvider: { name: 'delayed', async create(input, signal) {
    expected = await base.create(input, signal);
    return new Promise((resolve) => { finish = resolve; });
  } } });
  t.after(() => delayed.dispose());
  const waiting = delayed.createSession();
  delayed.event(waiting.sessionId, consent());
  await delayed.command(waiting.sessionId, 'identify_customer', { customerId: 'demo-alex', method: 'manual' });
  delayed.event(waiting.sessionId, event('context_updated', { preferences: ['Confirmed'] }));
  const pending = delayed.command(waiting.sessionId, 'create_ad_brief', { productId: 'demo-car' });
  await tick();
  assert.throws(() => delayed.event(waiting.sessionId, event('context_updated', { preferences: ['Changed'] })), errorCode(409));
  const rejects = assert.rejects(pending, errorCode(410));
  delayed.event(waiting.sessionId, event('session_cancelled'));
  await rejects;
  finish(expected);
  await tick();
  assert.equal(delayed.snapshot(waiting.sessionId).brief, undefined);
});

test('sessions and event history are bounded; cursors reset and restarts invalidate sessions', async (t) => {
  let now = 0;
  const core = setup({ maxSessions: 1, sessionTtlMs: 100, now: () => now });
  t.after(() => core.dispose());
  const session = core.createSession();
  assert.throws(() => core.createSession(), errorCode(429));
  core.event(session.sessionId, consent());
  await core.command(session.sessionId, 'identify_customer', { customerId: 'demo-alex', method: 'manual' });
  for (let index = 0; index < 255; index++) {
    core.event(session.sessionId, event('context_updated', { preferences: [`Preference ${index}`] }));
  }
  assert.throws(() => core.event(session.sessionId, event('context_updated', { preferences: ['over limit'] })), errorCode(429));
  const snapshot = core.snapshot(session.sessionId, 0);
  assert.equal(snapshot.events.length, 64);
  assert.equal(snapshot.resetRequired, true);
  assert.deepEqual(core.snapshot(session.sessionId, snapshot.revision).events, []);
  assert.equal(core.snapshot(session.sessionId, snapshot.revision + 1).resetRequired, true);
  assert.throws(() => core.snapshot(session.sessionId, -1), errorCode(400));
  core.event(session.sessionId, consent({ capture: false }));
  assert.equal(core.snapshot(session.sessionId).state, 'cancelled', 'receipt capacity must never prevent revocation');
  now = 100;
  const replacement = core.createSession();
  assert.notEqual(replacement.sessionId, session.sessionId);
  const restarted = setup();
  t.after(() => restarted.dispose());
  assert.notEqual(restarted.serverInstanceId, core.serverInstanceId);
  assert.throws(() => restarted.authorize(replacement.sessionId, replacement.sessionToken), errorCode(404));
});

test('dispose aborts active work and queued work is never submitted', async () => {
  const media = deferredMedia();
  const core = setup({ mediaProvider: media.provider });
  const one = await prepare(core);
  const two = await prepare(core);
  await core.command(one.sessionId, 'start_media_job', { briefId: one.brief.id, idempotencyKey: 'active' });
  await core.command(two.sessionId, 'start_media_job', { briefId: two.brief.id, idempotencyKey: 'queued' });
  await tick();
  core.dispose();
  assert.equal(media.signal().aborted, true);
  media.resolve(output());
  await tick();
  assert.equal(media.calls.length, 1);
  assert.throws(() => core.createSession(), errorCode(503));
  assert.throws(() => core.snapshot(one.sessionId), errorCode(503));
  core.dispose();
});

test('malformed profile output is rejected and profile timeouts cannot mutate the context later', async (t) => {
  let resolve!: (value: unknown) => void;
  const malformed: ProfileProvider = {
    name: 'real-profile',
    async enrich() { return { preferences: ['suggestion'], citations: [], provenance: 'exa', warnings: [], secret: 'provider-only' } as never; },
  };
  const core = setup({ profileProvider: malformed });
  t.after(() => core.dispose());
  const session = await prepare(core);
  core.event(session.sessionId, consent({ enrichment: true }));
  core.event(session.sessionId, event('context_updated', { preferences: ['Confirmed'], profileUrl: 'https://example.com/profile' }));
  const before = core.snapshot(session.sessionId).context;
  await assert.rejects(core.command(session.sessionId, 'enrich_profile', {}), errorCode(502, 'INVALID_PROFILE_OUTPUT'));
  assert.deepEqual(core.snapshot(session.sessionId).context, before);
  assert.equal(JSON.stringify(core.snapshot(session.sessionId)).includes('provider-only'), false);
  const delayed = setup({
    jobTimeoutMs: 20,
    profileProvider: { name: 'real-profile', async enrich() { return new Promise((yes) => { resolve = yes; }) as never; } },
  });
  t.after(() => delayed.dispose());
  const waiting = await prepare(delayed);
  delayed.event(waiting.sessionId, consent({ enrichment: true }));
  delayed.event(waiting.sessionId, event('context_updated', { preferences: ['Confirmed'], profileUrl: 'https://example.com/profile' }));
  const initial = delayed.snapshot(waiting.sessionId);
  await assert.rejects(delayed.command(waiting.sessionId, 'enrich_profile', {}), errorCode(504));
  resolve({ preferences: ['Late result'], citations: [], provenance: 'exa', warnings: [] });
  await tick();
  assert.deepEqual(delayed.snapshot(waiting.sessionId), initial);
});

test('expiry between acceptance and dispatch does not invoke a provider', async (t) => {
  let now = 0;
  const media = deferredMedia();
  const core = setup({ now: () => now, sessionTtlMs: 100, mediaProvider: media.provider });
  t.after(() => core.dispose());
  const session = await prepare(core);
  const started = core.command(session.sessionId, 'start_media_job', { briefId: session.brief.id, idempotencyKey: 'expires-before-dispatch' });
  now = 100;
  await started;
  await tick();
  assert.equal(media.calls.length, 0);
  assert.throws(() => core.snapshot(session.sessionId), errorCode(410));
});
