import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configFromEnv } from './config.js';
import { hasCode } from './errors.js';
import { createRobotServer } from './server.js';

export { createApp } from './app.js';
export { createRobotServer } from './server.js';
export { configFromEnv } from './config.js';

function listenPort(production: boolean): number {
  const fallback = production ? 5173 : 8787;
  const configured = process.env.PORT?.trim();
  if (!configured) return fallback;
  const port = Number(configured);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

function publicOrigin(): string[] | undefined {
  const configured = process.env.PUBLIC_ORIGIN?.trim();
  if (!configured) return undefined;
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error('PUBLIC_ORIGIN must be a valid URL origin.'); }
  if (url.origin !== configured || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PUBLIC_ORIGIN must be an http or https origin without a path.');
  }
  return [url.origin];
}

export async function startServer() {
  // Resolve against THIS module, never the terminal's working directory.
  try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw new Error('Unable to load server configuration.');
  }
  const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
  const server = createRobotServer({
    config: configFromEnv(process.env), production, allowedOrigins: publicOrigin(),
  });
  const port = listenPort(production);
  const host = process.env.HOST || '0.0.0.0';
  try { await server.listen(port, host); } catch {
    await server.close();
    throw new Error(`Unable to start HTTP server on ${host}:${port}.`);
  }
  return server;
}

// Imports in tests have no environment, socket or signal-handler side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void startServer().then((server) => {
    const address = server.httpServer.address();
    const port = address && typeof address !== 'string' ? address.port : 'unknown';
    console.log(`Sales robot demo: http://localhost:${port}`);
    const stop = (): void => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      void server.close().catch(() => { process.exitCode = 1; });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(() => {
    console.error('Unable to start the sales robot server. Check local configuration and PORT.');
    process.exitCode = 1;
  });
}
