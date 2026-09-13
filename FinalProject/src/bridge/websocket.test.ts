import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { BridgeServerMessageSchema, type BridgeServerMessage } from '../contracts/bridge.js';
import { BridgeBroker } from './broker.js';
import { attachBridgeWebSocket } from './websocket.js';

test('local WebSocket authenticates only once, rejects competing controllers and never replays motion', { timeout: 30_000 }, async (t) => {
  const now = Date.now(), sessionId = randomUUID(), errors: string[] = [];
  const broker = new BridgeBroker({ now: () => now, sessionSafety: () => ({ active: true, motionConsent: true }) });
  const pairing = broker.register({ label: 'Mock bridge', platform: 'windows-chrome' });
  const operatorCode = broker.operatorPairing(pairing.bridgeId);
  broker.pairOperator(pairing.bridgeId, operatorCode.operatorCode);
  const credential = broker.pair(pairing.bridgeId, pairing.pairingCode);
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const control = attachBridgeWebSocket(server, { broker, allowedOrigins: ['http://127.0.0.1:3202'], onError: (code) => errors.push(code) });
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    control.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `ws://127.0.0.1:${address.port}/v1/bridges/${pairing.bridgeId}/connect`;
  const create = async () => {
    const client = new WebSocket(url, { origin: 'http://127.0.0.1:3202' });
    clients.push(client);
    const messages: BridgeServerMessage[] = [];
    client.on('message', (bytes) => messages.push(BridgeServerMessageSchema.parse(JSON.parse(bytes.toString()))));
    await once(client, 'open');
    const received = once(client, 'message');
    client.send(JSON.stringify({ type: 'authenticate', bridgeToken: credential.bridgeToken }));
    await received;
    return { client, messages };
  };
  const first = await create();
  assert.equal(first.messages[0]!.type, 'state');
  const second = new WebSocket(url, { origin: 'http://127.0.0.1:3202' });
  clients.push(second);
  await once(second, 'open');
  const secondClosed = once(second, 'close');
  second.send(JSON.stringify({ type: 'authenticate', bridgeToken: credential.bridgeToken }));
  assert.equal((await secondClosed)[0], 1008);
  assert.equal(broker.status(pairing.bridgeId).armed, false);
  // Establish a fresh local heartbeat without involving any hardware.
  broker.heartbeat(pairing.bridgeId, { leaseId: null, leaseGeneration: broker.status(pairing.bridgeId).leaseGeneration,
    lastSequence: 0, connected: true, foreground: true, stopped: true, at: now });
  const lease = await broker.lease(pairing.bridgeId, { eventId: randomUUID(), sessionId,
    expectedGeneration: broker.status(pairing.bridgeId).leaseGeneration, operatorArmed: true, rearClearanceConfirmed: true });
  broker.heartbeat(pairing.bridgeId, { leaseId: lease.leaseId, leaseGeneration: lease.generation,
    lastSequence: 0, connected: true, foreground: true, stopped: true, at: now });
  const permit = await broker.authorizeMotion(sessionId, { intent: 'reverse_for_half_body', speed: 'low', pulseMs: 250,
    leaseId: lease.leaseId, leaseGeneration: lease.generation, tracking: { capturedAt: new Date(now).toISOString(),
      confidence: 0.95, personCount: 1, goal: 'half_body', centerX: 0.5, centerY: 0.5, bodyOccupancy: 0.8 } });
  assert.equal(permit.type, 'motion');
  const closed = once(first.client, 'close');
  first.client.close();
  await closed;
  // The close handler disarms before this next connection can authenticate.
  const reconnect = await create();
  assert.equal(reconnect.messages[0]!.type, 'state');
  assert.equal(reconnect.messages.some((message) => message.type === 'command'), false);
  assert.equal(broker.status(pairing.bridgeId).armed, false);
  const finalClose = once(reconnect.client, 'close');
  reconnect.client.send(JSON.stringify({ type: 'authenticate', bridgeToken: credential.bridgeToken }));
  assert.equal((await finalClose)[0], 1008);
  assert.ok(errors.includes('BRIDGE_CONTROL_REJECTED'));
});

test('WebSocket denies missing/foreign origins and all query credentials before upgrade', { timeout: 30_000 }, async (t) => {
  const server = createServer(), broker = new BridgeBroker({ sessionSafety: () => ({ active: false, motionConsent: false }) });
  const control = attachBridgeWebSocket(server, { broker, allowedOrigins: ['http://127.0.0.1:3202'], onError() {} });
  t.after(async () => { control.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  for (const [origin, query] of [[undefined, ''], ['https://public.example', ''], ['http://127.0.0.1:3202', '?token=forbidden']] as const) {
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/v1/bridges/${randomUUID()}/connect${query}`, { origin });
    const status = await new Promise<number>((resolve, reject) => {
      client.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); client.terminate(); });
      client.on('error', (error) => { if (!/closed before/.test(error.message)) reject(error); });
    });
    assert.equal(status, 403);
  }
});
