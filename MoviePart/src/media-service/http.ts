import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MAX_BODY_BYTES, parseSubmission, ServiceError, uuid } from "./contracts";
import type { MediaService } from "./service";

function authorized(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return false;
  return timingSafeEqual(createHash("sha256").update(authorization).digest(),
    createHash("sha256").update(`Bearer ${token}`).digest());
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ServiceError(415, "JSON_REQUIRED");
  }
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") {
    throw new ServiceError(415, "ENCODING_UNSUPPORTED");
  }
  if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) throw new ServiceError(413, "BODY_TOO_LARGE");
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new ServiceError(413, "BODY_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ServiceError(400, "INVALID_JSON"); }
}

export function createMediaHttpServer(service: MediaService, token: string) {
  if (!token.trim() || /[\r\n]/.test(token)) throw new ServiceError(503, "MEDIA_SERVICE_TOKEN_REQUIRED");
  const server = createServer(async (request, response) => {
    try {
      if (!authorized(request, token)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        throw new ServiceError(401, "UNAUTHORIZED");
      }
      const target = request.url ?? "";
      if (request.method === "GET" && target === "/capabilities") {
        if (!await service.ready()) throw new ServiceError(503, "PROVIDER_NOT_CONFIGURED");
        json(response, 200, { schemaVersion: 1, cancelByKey: true, deleteAssets: true });
      } else if (request.method === "POST" && target === "/jobs") {
        // Check credentials/readiness before reading participant bytes from the request stream.
        if (!await service.ready()) throw new ServiceError(503, "PROVIDER_NOT_CONFIGURED");
        const header = request.headers["idempotency-key"];
        if (typeof header !== "string" || !uuid.safeParse(header).success) throw new ServiceError(400, "INVALID_IDEMPOTENCY_KEY");
        json(response, 202, await service.submit(parseSubmission(await body(request), header)));
      } else if (request.method === "DELETE" && /^\/jobs\/by-key\/[0-9a-fA-F-]+$/.test(target)) {
        json(response, 200, await service.cancel(target.slice("/jobs/by-key/".length)));
      } else if (request.method === "GET" && /^\/jobs\/[A-Za-z0-9_-]+$/.test(target)) {
        json(response, 200, await service.status(target.slice("/jobs/".length)));
      } else if (request.method === "GET" && /^\/assets\/[A-Za-z0-9_-]+\.mp4$/.test(target)) {
        const data = await service.asset(target.slice("/assets/".length));
        response.writeHead(200, {
          "Content-Type": "video/mp4", "Content-Length": data.length,
          "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        });
        response.end(data);
      } else { throw new ServiceError(404, "NOT_FOUND"); }
    } catch (error) {
      const safe = error instanceof ServiceError ? error : new ServiceError(503, "SERVICE_UNAVAILABLE");
      if (!response.headersSent) json(response, safe.status, { error: { code: safe.code, message: safe.code, requestId: randomUUID() } });
      else response.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  return server;
}
