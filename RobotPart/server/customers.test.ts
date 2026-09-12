import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { WebSocket } from 'ws';
import { MAX_IMAGE_BYTES, MOVIE_DELAY_MS, MOVIE_ERROR, MOVIE_URL } from './customers.js';
import { HttpError } from './errors.js';
import { CLIENT_A, CLIENT_B, CUSTOMER_A, CUSTOMER_B, CUSTOMER_C, deferred, fixture, imageBytes } from './test-helpers.js';

test('upload saves actual rotated, resized JPEG; delay starts after save and never offers automatically', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t);
  const socket = await h.connect(); // Client registration happens before any upload.
  const input = await sharp(await imageBytes('#e33', 1800, 900)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await h.upload(CUSTOMER_A, CLIENT_A, input);
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, { customerId: CUSTOMER_A, status: 'processing' });
  const bytes = await readFile(join(h.root, 'Faces', `${CUSTOMER_A}.jpg`));
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 800);
  assert.equal(metadata.height, 1600);
  assert.equal(metadata.orientation, undefined);
  assert.equal(h.schedule.entries[0].at, MOVIE_DELAY_MS);
  await h.schedule.advance(4999);
  await socket.barrier();
  assert.deepEqual(socket.messages, []);
  assert.equal((await h.customer()).body.status, 'processing');
  await h.schedule.advance(1);
  await socket.waitFor(1);
  assert.deepEqual(socket.messages, [{ type: 'movie.ready', customerId: CUSTOMER_A, movieUrl: MOVIE_URL }]);
  assert.deepEqual((await h.customer()).body, { customerId: CUSTOMER_A, status: 'ready', movieUrl: MOVIE_URL, stage: 'chat' });
});

test('reject invalid/empty/oversized files, invalid UUIDs, unknown fields and malformed multipart', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t);
  const invalidImages = [Buffer.alloc(0), Buffer.from('not an image'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), Buffer.alloc(MAX_IMAGE_BYTES + 1)];
  for (const [index, bytes] of invalidImages.entries()) {
    const id = `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, '0')}`;
    const result = await h.upload(id, CLIENT_A, bytes);
    assert.equal(result.status, 400);
    assert.equal(typeof result.body.error, 'string');
  }
  assert.equal((await h.upload('not-uuid')).status, 400);
  assert.equal((await h.upload(CUSTOMER_B, 'bad-client')).status, 400);
  assert.equal((await h.upload(CUSTOMER_B, CLIENT_A, h.image, 'file')).status, 400);
  const form = new FormData();
  form.set('clientId', CLIENT_A);
  form.set('customerId', CUSTOMER_B);
  assert.equal((await fetch(`${h.base}/newCustomerFace`, { method: 'POST', body: form })).status, 400);
  form.set('image', new Blob([new Uint8Array(h.image)]), 'image.png');
  form.set('unexpected', 'extra-field');
  assert.equal((await fetch(`${h.base}/newCustomerFace`, { method: 'POST', body: form })).status, 400);
  const malformed = await fetch(`${h.base}/newCustomerFace`, {
    method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=missing' }, body: 'malformed',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await readdir(join(h.root, 'Faces')), []);
  assert.equal(h.schedule.pending, 0);
});

test('concurrent duplicates share ownership/save/timer; another client cannot steal or overwrite', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t);
  const red = await imageBytes('#f00');
  const blue = await imageBytes('#00f');
  const store = h.server.app.robot.store;
  const first = store.upload(CLIENT_A, CUSTOMER_A, red);
  const duplicate = store.upload(CLIENT_A, CUSTOMER_A.toUpperCase(), blue);
  await assert.rejects(store.upload(CLIENT_B, CUSTOMER_A, blue), (error: unknown) => error instanceof HttpError && error.status === 403);
  assert.deepEqual(await first, await duplicate);
  const expected = await sharp(red).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  assert.deepEqual(await readFile(join(h.root, 'Faces', `${CUSTOMER_A}.jpg`)), expected);
  assert.equal(h.schedule.pending, 1);
  assert.equal((await h.upload(CUSTOMER_A, CLIENT_B, blue)).status, 403);
  assert.equal((await h.upload(CUSTOMER_A, CLIENT_A, blue)).status, 202);
  await h.schedule.advance(5000);
  assert.equal((await h.upload(CUSTOMER_A, CLIENT_A, blue)).status, 200);
  assert.equal(h.schedule.entries.length, 1);
  assert.deepEqual(await readFile(join(h.root, 'Faces', `${CUSTOMER_A}.jpg`)), expected);
  const parallel = await Promise.all([h.upload(CUSTOMER_B), h.upload(CUSTOMER_B)]);
  assert.ok(parallel.every((response) => response.status === 202));
  assert.equal(h.schedule.entries.length, 2);
});

test('a pre-existing image is never overwritten even without a memory record', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t);
  const path = join(h.root, 'Faces', `${CUSTOMER_A}.jpg`);
  await writeFile(path, 'older customer fixture');
  assert.equal((await h.upload()).status, 409);
  assert.equal(await readFile(path, 'utf8'), 'older customer fixture');
  assert.equal(h.schedule.pending, 0);
});

test('WebSocket events and ready replay are scoped to client and exclude inactive customers', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t, { movieDelayMs: 25 });
  const a = await h.connect(CLIENT_A);
  const b = await h.connect(CLIENT_B);
  await h.upload();
  assert.equal(h.schedule.entries[0].at, 25);
  await h.schedule.advance(25);
  await a.waitFor(1);
  await b.barrier();
  assert.deepEqual(b.messages, []);
  const replay = await h.connect(CLIENT_A);
  assert.deepEqual(await replay.waitFor(1), a.messages);
  const otherReplay = await h.connect(CLIENT_B);
  await otherReplay.barrier();
  assert.deepEqual(otherReplay.messages, []);
  await h.upload(CUSTOMER_B, CLIENT_B);
  await h.schedule.advance(25);
  await b.waitFor(1);
  await a.barrier();
  assert.equal(a.messages.length, 1);
  assert.equal((b.messages[0] as { customerId: string }).customerId, CUSTOMER_B);
  assert.equal((await h.customer(CUSTOMER_A, CLIENT_B)).status, 403);
  assert.equal((await h.api(`/api/customers/${CUSTOMER_A}`, { clientId: CLIENT_B }, 'DELETE')).status, 403);
  assert.equal((await h.api(`/api/customers/${CUSTOMER_A}`, { clientId: CLIENT_A }, 'DELETE')).status, 200);
  const afterDelete = await h.connect();
  await afterDelete.barrier();
  assert.deepEqual(afterDelete.messages, []);
});

test('missing movie emits sanitized error and replays error, never a ready action', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t, { movie: false });
  const client = await h.connect();
  assert.equal((await h.api('/api/config')).body.demoMovieAvailable, false);
  await h.upload();
  await h.schedule.advance(5000);
  assert.deepEqual(await client.waitFor(1), [{ type: 'movie.error', customerId: CUSTOMER_A, message: MOVIE_ERROR }]);
  const replay = await h.connect();
  assert.deepEqual(await replay.waitFor(1), client.messages);
  assert.deepEqual((await h.customer()).body, { customerId: CUSTOMER_A, status: 'error', stage: 'chat' });
  assert.equal((await h.tool('offer_movie')).status, 409);
});

test('delete cancels timer, is idempotent, rejects stale tools/uploads and in-flight disk callbacks', { timeout: 10_000 }, async (t) => {
  const entered = deferred<void>();
  const check = deferred<boolean>();
  const h = await fixture(t, { movieAvailable: async () => { entered.resolve(); return check.promise; } });
  const socket = await h.connect();
  await h.upload();
  const callback = h.schedule.advance(5000);
  await entered.promise;
  const remove = () => h.api(`/api/customers/${CUSTOMER_A}`, { clientId: CLIENT_A }, 'DELETE');
  assert.equal((await remove()).status, 200);
  assert.equal((await remove()).status, 200);
  check.resolve(true);
  await callback;
  await socket.barrier();
  assert.deepEqual(socket.messages, []);
  assert.equal((await h.customer()).status, 409);
  assert.equal((await h.tool('stop_following')).status, 409);
  assert.equal((await h.upload()).status, 409);
  await h.upload(CUSTOMER_B);
  await h.api(`/api/customers/${CUSTOMER_B}`, { clientId: CLIENT_A }, 'DELETE');
  assert.equal(h.schedule.pending, 0);
  await h.schedule.advance(5000);
  await socket.barrier();
  assert.deepEqual(socket.messages, []);
});

test('deactivation during image normalization prevents a stale save and scheduling', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t);
  const store = h.server.app.robot.store;
  const saving = store.upload(CLIENT_A, CUSTOMER_A, h.image);
  const rejected = assert.rejects(saving, (error: unknown) => error instanceof HttpError && error.status === 409);
  store.deactivate(CLIENT_A, CUSTOMER_A);
  await rejected;
  assert.deepEqual(await readdir(join(h.root, 'Faces')), []);
  assert.equal(h.schedule.pending, 0);
});

test('invalid websocket UUID and unexpected origin are rejected before upgrade', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t);
  for (const [suffix, expected, origin] of [
    ['/ws?clientId=bad', 400, undefined], ['/ws', 400, undefined],
    [`/ws?clientId=${CLIENT_A}&clientId=${CLIENT_B}`, 400, undefined],
    [`/ws?clientId=${CLIENT_A}`, 403, 'https://untrusted.example'], ['/elsewhere', 404, undefined],
  ] as const) {
    const ws = new WebSocket(`${h.base.replace('http:', 'ws:')}${suffix}`, { origin });
    ws.on('error', () => undefined);
    t.after(() => ws.terminate());
    const status = await new Promise<number>((resolve, reject) => {
      ws.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); ws.terminate(); });
      ws.once('open', () => reject(new Error('Unexpected successful upgrade')));
    });
    assert.equal(status, expected);
  }
});

test('heartbeat closes non-responsive sockets and close cleans all timers and connections', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t);
  const healthy = await h.connect(CLIENT_A);
  const unresponsive = await h.connect(CLIENT_B, false);
  const ping = once(unresponsive.socket, 'ping');
  h.server.heartbeat();
  await ping;
  await healthy.barrier(); // Its automatic pong has reached the server.
  const closed = once(unresponsive.socket, 'close');
  h.server.heartbeat();
  await closed;
  assert.equal(healthy.socket.readyState, WebSocket.OPEN);
  await h.upload(CUSTOMER_C);
  assert.equal(h.schedule.pending, 1);
  const healthyClosed = once(healthy.socket, 'close');
  await h.server.close();
  await healthyClosed;
  await h.server.close();
  assert.equal(h.schedule.pending, 0);
  assert.equal(h.server.httpServer.listening, false);
  await h.schedule.advance(10_000);
});