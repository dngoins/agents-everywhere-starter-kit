import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backendWorkflowPrompt, voiceInstructions } from './prompts.js';
import type { FetchLike } from './provider.js';
import { modelTools } from './tools.js';
import { ANSWER, CLIENT_A, CLIENT_B, CUSTOMER_A, deferred, fixture, OFFER, TEST_CONFIG } from './test-helpers.js';

test('Live uses exact route/body, canonical models, delegated strict tools and strips all provider extras', { timeout: 10_000 }, async (t) => {
  const calls: { url: string; body: unknown; init: RequestInit }[] = [];
  const fake: FetchLike = async (url, init) => {
    assert.ok(init);
    assert.equal(typeof init.body, 'string');
    calls.push({ url: String(url), body: JSON.parse(init.body as string) as unknown, init });
    return Response.json({ session: { id: 'live_test_opaque_id', client_secret: 'do-not-forward', model: 'provider-extra' },
      transport: { type: 'webrtc', sdp: ANSWER, token: 'do-not-forward' }, secret: 'do-not-forward' }, { status: 201 });
  };
  const h = await fixture(t, { config: TEST_CONFIG, fetch: fake });
  await h.upload();
  const request = { clientId: CLIENT_A, customerId: CUSTOMER_A, sdp: OFFER };
  const [first, retry] = await Promise.all([h.api('/api/voice/session', request), h.api('/api/voice/session', request)]);
  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.deepEqual(first.body, { session: { id: 'live_test_opaque_id' }, transport: { type: 'webrtc', sdp: ANSWER } });
  assert.deepEqual(retry.body, first.body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(new Headers(calls[0].init.headers).get('Authorization') === `Bearer ${TEST_CONFIG.apiKey}`);
  assert.equal(new Headers(calls[0].init.headers).get('Content-Type'), 'application/json');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(calls[0].body, {
    session: { model: 'gpt-live-1', instructions: voiceInstructions, store: false,
      delegation: { type: 'responses', responses: {
        model: 'gpt-5.6-luna', instructions: backendWorkflowPrompt,
        tools: modelTools, tool_choice: 'auto', parallel_tool_calls: false,
      } } }, transport: { type: 'webrtc', sdp: OFFER },
  });
  assert.ok(!modelTools.some((tool) => tool.name === 'movie_finished'));
  assert.equal(modelTools.length, 9);
  for (const tool of modelTools) {
    assert.equal(tool.strict, true);
    assert.equal(tool.type, 'function');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual([...(tool.parameters.required ?? [])].sort(), Object.keys(tool.parameters.properties ?? {}).sort());
  }
});

test('SDP and identity validation rejects requests before any provider call', { timeout: 10_000 }, async (t) => {
  let calls = 0;
  const h = await fixture(t, { config: TEST_CONFIG, fetch: async () => { calls += 1; throw new Error('Must not call'); } });
  await h.upload();
  for (const sdp of ['', '  ', 'not-an-sdp', 'v=1\r\n', 'v=0\r\n' + 'x'.repeat(128 * 1024), 10, null]) {
    assert.equal((await h.api('/api/voice/session', { clientId: CLIENT_A, customerId: CUSTOMER_A, sdp })).status, 400);
  }
  assert.equal((await h.api('/api/voice/session', { clientId: CLIENT_B, customerId: CUSTOMER_A, sdp: OFFER })).status, 403);
  assert.equal((await h.api('/api/voice/session', { clientId: 'bad', customerId: CUSTOMER_A, sdp: OFFER })).status, 400);
  assert.equal((await h.api('/api/voice/session', { clientId: CLIENT_A, customerId: CUSTOMER_A, sdp: OFFER, model: 'override' })).status, 400);
  await h.api(`/api/customers/${CUSTOMER_A}`, { clientId: CLIENT_A }, 'DELETE');
  assert.equal((await h.api('/api/voice/session', { clientId: CLIENT_A, customerId: CUSTOMER_A, sdp: OFFER })).status, 409);
  assert.equal(calls, 0);
});

test('exact 128 KiB SDP boundary is accepted', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t, { config: TEST_CONFIG, fetch: async () => Response.json({
    session: { id: 'live_boundary' }, transport: { type: 'webrtc', sdp: ANSWER },
  }) });
  await h.upload();
  const sdp = 'v=0\r\n' + 'x'.repeat(128 * 1024 - 5);
  assert.equal((await h.api('/api/voice/session', { clientId: CLIENT_A, customerId: CUSTOMER_A, sdp })).status, 201);
});

test('missing configuration returns 503 without reading environment or invoking fetch', { timeout: 10_000 }, async (t) => {
  let calls = 0;
  const h = await fixture(t, { fetch: async () => { calls += 1; throw new Error('Must not call'); } });
  await h.upload();
  assert.equal((await h.api('/api/config')).body.configured, false);
  assert.equal((await h.api('/api/voice/session', { clientId: CLIENT_A, customerId: CUSTOMER_A, sdp: OFFER })).status, 503);
  assert.equal((await h.tool('ask_vehicle_expert', { question: 'Where is the Model Y?', deepReasoning: false })).status, 503);
  assert.equal(calls, 0);
});

for (const status of [400, 401, 429, 500, 503]) {
  test(`provider HTTP ${status} is sanitized with no automatic retries`, { timeout: 10_000 }, async (t) => {
    let calls = 0;
    const h = await fixture(t, { config: TEST_CONFIG, fetch: async () => {
      calls += 1;
      return Response.json({ error: { message: `Raw upstream text ${TEST_CONFIG.apiKey}` } }, { status });
    } });
    await h.upload();
    const body = { clientId: CLIENT_A, customerId: CUSTOMER_A, sdp: OFFER };
    const failed = await h.api('/api/voice/session', body);
    assert.equal(failed.status, status);
    assert.deepEqual(failed.body, { error: `Live session creation failed (HTTP ${status}).` });
    assert.deepEqual((await h.api('/api/voice/session', body)).body, failed.body);
    assert.equal(calls, 1);
  });
}

test('network exceptions and invalid success payloads never expose provider data', { timeout: 10_000 }, async (t) => {
  let mode = 0;
  const h = await fixture(t, { config: TEST_CONFIG, fetch: async () => {
    mode += 1;
    if (mode === 1) throw new Error(`Network error ${TEST_CONFIG.apiKey}`);
    if (mode === 2) return new Response('not JSON', { status: 200 });
    return Response.json({ session: { id: 'live_test', token: 'secret' }, transport: { type: 'webrtc', sdp: 'invalid' } });
  } });
  await h.upload();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await h.api('/api/voice/session', { clientId: CLIENT_A, customerId: CUSTOMER_A, sdp: `${OFFER}a=test:${attempt}\r\n` });
    assert.equal(result.status, 502);
    assert.equal(Object.keys(result.body).length, 1);
    assert.ok(!JSON.stringify(result.body).includes(TEST_CONFIG.apiKey));
    assert.ok(!JSON.stringify(result.body).includes('not JSON'));
  }
});

test('provider timeout aborts fetch and reports 504 without a retry', { timeout: 10_000 }, async (t) => {
  let calls = 0;
  let aborted = false;
  const h = await fixture(t, { config: TEST_CONFIG, providerTimeoutMs: 5, fetch: async (_url, init) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => { aborted = true; reject(new Error('Synthetic abort')); };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener('abort', abort, { once: true });
    });
  } });
  await h.upload();
  const result = await h.api('/api/voice/session', { clientId: CLIENT_A, customerId: CUSTOMER_A, sdp: OFFER });
  assert.equal(result.status, 504);
  assert.deepEqual(result.body, { error: 'Live session creation timed out.' });
  assert.equal(calls, 1);
  assert.equal(aborted, true);
});

test('customer cancellation aborts and discards a late successful voice response', { timeout: 10_000 }, async (t) => {
  const started = deferred<void>();
  const response = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const h = await fixture(t, { config: TEST_CONFIG, fetch: async (_url, init) => {
    signal = init?.signal;
    started.resolve();
    return response.promise; // Deliberately ignores abort to exercise the late-result check.
  } });
  await h.upload();
  const pending = h.api('/api/voice/session', { clientId: CLIENT_A, customerId: CUSTOMER_A, sdp: OFFER });
  await started.promise;
  await h.api(`/api/customers/${CUSTOMER_A}`, { clientId: CLIENT_A }, 'DELETE');
  assert.equal(signal?.aborted, true);
  response.resolve(Response.json({ session: { id: 'late_live_id' }, transport: { type: 'webrtc', sdp: ANSWER } }));
  const result = await pending;
  assert.equal(result.status, 409);
  assert.ok(!JSON.stringify(result.body).includes('late_live_id'));
});

test('vehicle expert is functional, concise and only escalates complex questions', { timeout: 10_000 }, async (t) => {
  const calls: { url: string; model: string; store: boolean; instructions: string }[] = [];
  const h = await fixture(t, { config: TEST_CONFIG, fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; store: boolean; instructions: string };
    calls.push({ url: String(url), ...body });
    return Response.json({ output: [{ type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: 'In this demo the Model Y is far left.' }] }] });
  } });
  await h.upload();
  const question = { question: 'Where is Model Y?', deepReasoning: false };
  const [answer, retry] = await Promise.all([h.tool('ask_vehicle_expert', question), h.tool('ask_vehicle_expert', question)]);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.answer, 'In this demo the Model Y is far left.');
  assert.deepEqual(answer.body, retry.body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].model, 'gpt-5.6-luna');
  assert.equal(calls[0].store, false);
  assert.match(calls[0].instructions, /Never invent pricing/);
  assert.equal((await h.tool('ask_vehicle_expert', { question: 'Compare these demo descriptions carefully.', deepReasoning: true })).status, 200);
  assert.equal(calls[1].model, 'gpt-6-astra');
  for (const invalid of ['', ' '.repeat(3), 'x'.repeat(2001)]) {
    assert.equal((await h.tool('ask_vehicle_expert', { question: invalid, deepReasoning: false })).status, 400);
  }
  assert.equal((await h.tool('ask_vehicle_expert', { question: 'Where?' })).status, 400);
  assert.equal(calls.length, 2);
});

test('vehicle expert errors and results after deletion remain safe', { timeout: 10_000 }, async (t) => {
  const started = deferred<void>();
  const late = deferred<Response>();
  let calls = 0;
  const h = await fixture(t, { config: TEST_CONFIG, fetch: async () => {
    calls += 1;
    if (calls === 1) return Response.json({ error: TEST_CONFIG.apiKey }, { status: 401 });
    started.resolve();
    return late.promise;
  } });
  await h.upload();
  const failure = await h.tool('ask_vehicle_expert', { question: 'Price?', deepReasoning: false });
  assert.deepEqual(failure.body, { error: 'Vehicle expert failed (HTTP 401).' });
  const pending = h.tool('ask_vehicle_expert', { question: 'Location?', deepReasoning: false });
  await started.promise;
  await h.api(`/api/customers/${CUSTOMER_A}`, { clientId: CLIENT_A }, 'DELETE');
  late.resolve(Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Late text.' }] }] }));
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.body.answer, undefined);
});