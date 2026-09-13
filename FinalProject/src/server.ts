import { randomBytes } from "node:crypto";
import { Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { readConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { Orchestrator } from "./orchestrator/service.js";
import { createProviders } from "./providers/factory.js";
import { DEMO_MEDIA } from "./providers/demo-media.js";

async function main() {
  const config = readConfig();
  const root = process.cwd();
  const fixture = new Uint8Array(await readFile(resolve(root, "fixtures", "media", DEMO_MEDIA.filename)));
  const providers = createProviders(config, fixture);
  let deviceToken = config.DEMO_DEVICE_TOKEN;
  if (!deviceToken) {
    deviceToken = randomBytes(32).toString("base64url");
    const directory = resolve(root, ".runtime");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, "device-token");
    await writeFile(path, `${deviceToken}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ event: "pairing_file", path }));
  }
  const orchestrator = new Orchestrator({
    ...providers,
    sessionTtlMs: config.SESSION_TTL_MS,
    jobTimeoutMs: config.JOB_TIMEOUT_MS,
    maxSessions: config.MAX_SESSIONS,
    maxQueuedJobs: config.MAX_QUEUED_JOBS,
    allowFallbacks: config.ALLOW_DEMO_FALLBACKS,
  });
  const app = createApp({ orchestrator, config, deviceToken, root });
  const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
    console.log(JSON.stringify({ event: "server_started", host: config.HOST, port: info.port }));
  });
  if (!(server instanceof Server)) throw new Error("The local runner requires an HTTP/1 Node server.");
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    orchestrator.dispose();
    server.close(() => { process.exitCode = 0; });
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      process.exitCode = 0;
    }, 2_000).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(JSON.stringify({ event: "server_error", code: error.code ?? "LISTEN_FAILED" }));
    orchestrator.dispose();
    process.exitCode = 1;
  });
}

main().catch((error: unknown) => {
  // Startup errors come from local configuration/file setup, not provider responses.
  const message = error instanceof Error ? error.message : "Unable to start the API.";
  console.error(JSON.stringify({ event: "startup_failed", message }));
  process.exitCode = 1;
});
