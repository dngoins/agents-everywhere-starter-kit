import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configFromEnv } from './config.js';
import { hasCode } from './errors.js';
import { createRobotServer } from './server.js';

export { createApp } from './app.js';
export { createRobotServer } from './server.js';
export { configFromEnv } from './config.js';

export async function startServer() {
  // Resolve against THIS module, never the terminal's working directory.
  try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw new Error('Unable to load server configuration.');
  }
  const server = createRobotServer({
    config: configFromEnv(process.env), production: process.env.NODE_ENV === 'production',
  });
  try { await server.listen(8787); } catch {
    await server.close();
    throw new Error('Unable to start HTTP server on 127.0.0.1:8787.');
  }
  return server;
}

// Imports in tests have no environment, socket or signal-handler side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void startServer().then((server) => {
    console.log('Sales robot demo: http://127.0.0.1:8787');
    const stop = (): void => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      void server.close().catch(() => { process.exitCode = 1; });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(() => {
    console.error('Unable to start the sales robot server. Check local configuration and port 8787.');
    process.exitCode = 1;
  });
}