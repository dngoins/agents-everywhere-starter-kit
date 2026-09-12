import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TIME_ZONE } from './config.js';
import { CLIENT_A, CUSTOMER_A, fixture, TEST_CONFIG } from './test-helpers.js';

test('health/config report safe metadata and never disclose configuration credentials', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t, { config: TEST_CONFIG });
  assert.deepEqual((await h.api('/api/health')).body, { ok: true, demo: true });
  const config = await h.api('/api/config');
  assert.deepEqual(config.body, { configured: true, models: TEST_CONFIG.models, timeZone: TIME_ZONE, demoMovieAvailable: true });
  assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.ok(!JSON.stringify(config.body).includes(TEST_CONFIG.apiKey));
});

test('only the demo MP4 is served; byte ranges and HEAD work', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t);
  const range = await fetch(`${h.base}/Movies/demo.mp4`, { headers: { Range: 'bytes=3-8' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 3-8/${h.movieBytes.length}`);
  assert.equal(range.headers.get('accept-ranges'), 'bytes');
  assert.equal(range.headers.get('content-type'), 'video/mp4');
  assert.equal(await range.text(), '345678');
  const suffix = await fetch(`${h.base}/Movies/demo.mp4`, { headers: { Range: 'bytes=-3' } });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), 'xyz');
  const head = await fetch(`${h.base}/Movies/demo.mp4`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(h.movieBytes.length));
  assert.equal(await head.text(), '');
  const impossible = await fetch(`${h.base}/Movies/demo.mp4`, { headers: { Range: 'bytes=999-1000' } });
  assert.equal(impossible.status, 416);
  assert.equal((await h.api('/Movies/private.txt')).status, 404);
  assert.equal((await h.api('/Movies')).status, 404);
});

test('production SPA works only for non-API navigation; private paths stay private', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t, { production: true });
  await h.upload();
  for (const path of ['/', '/sales/welcome']) {
    const page = await fetch(`${h.base}${path}`, { headers: { Accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Mock SPA<\/title>/);
  }
  for (const path of ['/api', '/api/not-found', '/newCustomerFace', '/ws', '/.env', '/%2eenv',
    `/Faces/${CUSTOMER_A}.jpg`, `/faces/${CUSTOMER_A}.jpg`, `/%46aces/${CUSTOMER_A}.jpg`,
    '/server/config.ts', '/RobotLibrary/padbot.js', '/Movies/missing.mp4']) {
    const response = await fetch(`${h.base}${path}`, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await response.json(), { error: 'Not found.' });
  }
  const rootFile = await fetch(`${h.base}/root-only.txt`);
  assert.ok(!(await rootFile.text()).includes('root files must never be served'));
  assert.equal((await h.api('/sales/welcome', {}, 'POST')).status, 404);
});

test('development does not serve root or SPA and malformed requests return JSON errors', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t);
  assert.equal((await h.api('/')).status, 404);
  assert.equal((await h.api('/root-only.txt')).status, 404);
  const malformed = await fetch(`${h.base}/api/tools/stop_following`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{malformed',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Invalid request.' });
  assert.equal((await h.api(`/api/customers/${CUSTOMER_A}?clientId=not-a-uuid`)).status, 400);
  assert.equal((await h.api(`/api/customers/not-uuid?clientId=${CLIENT_A}`)).status, 400);
  assert.equal((await h.api(`/api/customers/${CUSTOMER_A}?clientId=${CLIENT_A}`)).status, 404);
  const rejected = await fetch(`${h.base}/api/voice/session`, {
    method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: 'Unexpected request origin.' });
});