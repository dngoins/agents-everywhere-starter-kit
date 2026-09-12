import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createApp, originAllowed, type AppOptions } from './app.js';
import type { MovieEvent } from './customers.js';
import { uuidSchema } from './tools.js';

export interface ServerOptions extends AppOptions {
  heartbeatMs?: number;
}

export function createRobotServer(options: ServerOptions = {}) {
  const app = createApp(options);
  const httpServer = createServer(app);
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const peers = new Map<WebSocket, { clientId: string; alive: boolean }>();
  let closing: Promise<void> | undefined;
  const send = (socket: WebSocket, event: MovieEvent): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 64 * 1024) { socket.terminate(); return; }
    socket.send(JSON.stringify(event), (error) => { if (error) socket.terminate(); });
  };
  const unsubscribe = app.robot.store.subscribe((clientId, event) => {
    for (const [socket, peer] of peers) if (peer.clientId === clientId) send(socket, event);
  });

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    socket.on('error', () => { /* Never print request URLs or websocket errors. */ });
    const reject = (status: number): void => {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (closing) { reject(503); return; }
    let url: URL;
    try { url = new URL(request.url ?? '/', 'http://127.0.0.1'); } catch { reject(400); return; }
    if (url.pathname !== '/ws') { reject(404); return; }
    if (!originAllowed(request.headers.origin, request.headers.host, options.allowedOrigins)) { reject(403); return; }
    const client = uuidSchema.safeParse(url.searchParams.get('clientId'));
    if (!client.success || url.searchParams.getAll('clientId').length !== 1) { reject(400); return; }
    webSockets.handleUpgrade(request, socket, head, (connection) => {
      // A tab may connect BEFORE it uploads a face; no customer registration prerequisite.
      const peer = { clientId: client.data, alive: true };
      peers.set(connection, peer);
      connection.on('error', () => connection.terminate());
      connection.on('pong', () => { peer.alive = true; });
      connection.on('close', () => peers.delete(connection));
      for (const event of app.robot.store.completedFor(client.data)) send(connection, event);
    });
  });

  // Exported for deterministic heartbeat tests; production uses the interval below.
  const heartbeat = (): void => {
    for (const [socket, peer] of peers) {
      if (!peer.alive) { socket.terminate(); continue; }
      peer.alive = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  };
  const timer = setInterval(heartbeat, options.heartbeatMs ?? 30_000);
  timer.unref();

  return {
    app, httpServer, webSockets, heartbeat,
    async listen(port = 8787, host = '0.0.0.0'): Promise<AddressInfo> {
      httpServer.listen(port, host);
      await once(httpServer, 'listening');
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('HTTP server has no TCP address');
      return address;
    },
    close(): Promise<void> {
      closing ??= (async () => {
        clearInterval(timer);
        unsubscribe();
        const runtimeClosed = app.robot.close();
        for (const socket of peers.keys()) socket.terminate();
        const wsClosed = new Promise<void>((resolve) => webSockets.close(() => resolve()));
        const httpClosed = new Promise<void>((resolve, reject) => {
          if (!httpServer.listening) { resolve(); return; }
          httpServer.close((error) => error ? reject(error) : resolve());
          httpServer.closeAllConnections();
        });
        await Promise.all([runtimeClosed, wsClosed, httpClosed]);
        peers.clear();
      })();
      return closing;
    },
  };
}

export type RobotServer = ReturnType<typeof createRobotServer>;