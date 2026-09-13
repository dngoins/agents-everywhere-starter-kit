import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { BridgeClientMessageSchema } from '../contracts/bridge.js';
import { BridgeBroker } from './broker.js';
import { assertLocalOperatorOrigins } from './origins.js';

/** No query credentials and no public/tunnel origin, even on a loopback proxy. */
export function attachBridgeWebSocket(server: Server, options: {
  broker: BridgeBroker; allowedOrigins: readonly string[]; onError(code: string): void;
}): { close(): void } {
  assertLocalOperatorOrigins(options.allowedOrigins);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  const onUpgrade = (request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/v1/bridges/')) return;
    const match = /^\/v1\/bridges\/([0-9a-f-]{36})\/connect$/.exec(url.pathname);
    const remote = request.socket.remoteAddress;
    if (!match || url.search || !options.allowedOrigins.includes(request.headers.origin ?? '')
      || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '')) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      const bridgeId = match[1]!;
      let credential: string | null = null;
      let disconnect: (() => void) | null = null;
      let count = 0, windowAt = Date.now();
      const authentication = setTimeout(() => client.close(1008, 'Authentication required'), 3000);
      authentication.unref();
      client.on('message', (bytes, binary) => {
        try {
          if (binary) throw new Error('Binary bridge messages are forbidden.');
          if (Date.now() - windowAt > 1000) { windowAt = Date.now(); count = 0; }
          if (++count > 20) throw new Error('Bridge rate limit exceeded.');
          const message = BridgeClientMessageSchema.parse(JSON.parse(bytes.toString()));
          if (!credential) {
            if (message.type !== 'authenticate') throw new Error('Authentication must be first.');
            credential = message.bridgeToken;
            disconnect = options.broker.connect(bridgeId, credential, {
              send: (value) => {
                if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > 16_384) throw new Error('Bridge transport is not writable.');
                client.send(JSON.stringify(value));
              },
              close: () => client.close(1008, 'Bridge lease closed'),
            });
            clearTimeout(authentication);
            return;
          }
          options.broker.authorize(bridgeId, credential, 'bridge');
          if (message.type === 'heartbeat') options.broker.heartbeat(bridgeId, message.heartbeat);
          else if (message.type === 'acknowledgement') options.broker.acknowledge(bridgeId, message.acknowledgement);
          else throw new Error('Bridge already authenticated.');
        } catch {
          options.onError('BRIDGE_CONTROL_REJECTED');
          client.close(1008, 'Bridge message rejected');
        }
      });
      client.on('close', () => { clearTimeout(authentication); credential = null; disconnect?.(); });
      client.on('error', () => { options.onError('BRIDGE_SOCKET_ERROR'); client.close(); });
    });
  };
  server.on('upgrade', onUpgrade);
  let ticking = false;
  const watchdog = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void options.broker.tick().catch(() => {
      options.onError('BRIDGE_WATCHDOG_FAILED');
      options.broker.close();
    }).finally(() => { ticking = false; });
  }, 250);
  watchdog.unref();
  return { close() {
    clearInterval(watchdog);
    server.off('upgrade', onUpgrade);
    options.broker.close();
    for (const client of sockets.clients) client.close(1001, 'Server closing');
    sockets.close();
  } };
}
