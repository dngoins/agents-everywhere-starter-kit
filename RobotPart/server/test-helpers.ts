import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import sharp from 'sharp';
import { WebSocket } from 'ws';
import { configFromEnv, type ServerConfig } from './config.js';
import type { MovieEvent, Schedule, ToolResult } from './customers.js';
import type { FetchLike, LiveAnswer } from './provider.js';
import { createRobotServer, type ServerOptions } from './server.js';

export const CLIENT_A = '11111111-1111-4111-8111-111111111111';
export const CLIENT_B = '22222222-2222-4222-8222-222222222222';
export const CUSTOMER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const CUSTOMER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const CUSTOMER_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const OFFER = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=Mock offer\r\nt=0 0\r\n';
export const ANSWER = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=Mock answer\r\nt=0 0\r\n';
export const TEST_CONFIG = configFromEnv({ OPENAI_API_KEY: 'synthetic-test-credential-never-an-actual-key',
  VOICE_MODEL: 'GPT-Live-1', REGULAR_MODEL: 'GPT-5.6-luna', HIGHEND_MODEL: 'GPT-6-astra' });
export const noExternalCalls: FetchLike = async () => { throw new Error('External calls are disabled in tests'); };

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export class ManualScheduler {
  elapsed = 0;
  entries: { at: number; active: boolean; task: () => Promise<void> }[] = [];
  schedule: Schedule = (task, delayMs) => {
    const entry = { at: this.elapsed + delayMs, active: true, task };
    this.entries.push(entry);
    return () => { entry.active = false; };
  };
  get pending(): number { return this.entries.filter((entry) => entry.active).length; }
  async advance(ms: number): Promise<void> {
    this.elapsed += ms;
    for (const entry of this.entries.filter((entry) => entry.active && entry.at <= this.elapsed)) {
      entry.active = false;
      await entry.task();
    }
  }
}

export interface ApiBody extends Partial<ToolResult> {
  error?: string;
  customerId?: string;
  status?: string;
  configured?: boolean;
  models?: ServerConfig['models'];
  demoMovieAvailable?: boolean;
  active?: boolean;
  session?: LiveAnswer['session'];
  transport?: LiveAnswer['transport'];
}

export async function imageBytes(color = '#e33', width = 16, height = 8): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

export async function fixture(t: TestContext, options: ServerOptions & { movie?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sales-robot-test-'));
  const schedule = new ManualScheduler();
  let server: ReturnType<typeof createRobotServer> | undefined;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  for (const dir of ['Faces', 'Movies', 'dist']) await mkdir(join(root, dir));
  const movieBytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  if (options.movie !== false) await writeFile(join(root, 'Movies', 'demo.mp4'), movieBytes);
  await writeFile(join(root, 'Movies', 'private.txt'), 'not publicly served');
  await writeFile(join(root, 'dist', 'index.html'), '<!doctype html><title>Mock SPA</title>');
  await writeFile(join(root, 'root-only.txt'), 'root files must never be served');
  const { movie: _movie, ...overrides } = options;
  server = createRobotServer({ config: configFromEnv(), fetch: noExternalCalls,
    schedule: schedule.schedule, now: () => new Date('2026-09-12T16:00:00Z'),
    logBooking: () => undefined, ...overrides,
    // Test paths cannot accidentally point at project data, even via an override.
    rootDir: root, facesDir: join(root, 'Faces'), moviesDir: join(root, 'Movies'), distDir: join(root, 'dist'),
  });
  const address = await server.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const image = await imageBytes();
  const api = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as ApiBody };
  };
  const upload = async (customerId = CUSTOMER_A, clientId = CLIENT_A, bytes = image, field = 'image') => {
    const form = new FormData();
    form.set('clientId', clientId);
    form.set('customerId', customerId);
    // Deliberately wrong MIME: the server must trust decoded bytes, not this value.
    form.set(field, new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), 'not-trusted.bin');
    const response = await fetch(`${base}/newCustomerFace`, { method: 'POST', body: form });
    return { status: response.status, body: await response.json() as ApiBody };
  };
  const tool = (name: string, args: unknown = {}, customerId = CUSTOMER_A, clientId = CLIENT_A) =>
    api(`/api/tools/${name}`, { clientId, customerId, args });
  const customer = (customerId = CUSTOMER_A, clientId = CLIENT_A) =>
    api(`/api/customers/${customerId}?clientId=${clientId}`);
  const connect = async (clientId = CLIENT_A, autoPong = true) => {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws?clientId=${clientId}`, { autoPong });
    sockets.push(socket);
    const events = new EventEmitter();
    const messages: MovieEvent[] = [];
    socket.on('error', () => undefined);
    socket.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()) as MovieEvent);
      events.emit('message');
    });
    // Listeners exist before the handshake, so an immediate replay cannot race the test.
    await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
    return {
      socket, messages,
      async waitFor(count: number) {
        while (messages.length < count) await once(events, 'message', { signal: AbortSignal.timeout(3000) });
        return messages;
      },
      async barrier() {
        const pong = once(socket, 'pong', { signal: AbortSignal.timeout(3000) });
        socket.ping();
        await pong; // Frames sent before this pong have been read; no sleep-based assertions.
      },
    };
  };
  const selecting = async (customerId = CUSTOMER_A, clientId = CLIENT_A) => {
    assert.equal((await upload(customerId, clientId)).status, 202);
    await schedule.advance(options.movieDelayMs ?? 5000);
    for (const [name, args] of [
      ['offer_movie', {}], ['show_movie', { accepted: true }], ['movie_finished', {}],
      ['movie_feedback', { liked: true }], ['test_drive_interest', { accepted: true }],
    ] as const) assert.equal((await tool(name, args, customerId, clientId)).status, 200);
    return (await tool('get_test_drive_slots', {}, customerId, clientId)).body;
  };
  return { server, root, base, schedule, image, movieBytes, api, upload, tool, customer, connect, selecting };
}