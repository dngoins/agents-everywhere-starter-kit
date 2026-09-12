import type {
  AdBrief, AssetUploaded, CustomerProfile, MediaJob, MediaResult, SessionCreated, SessionEvent, SessionSnapshot,
} from "./dwight/types";
import {
  isAssetUploaded, isBrief, isCustomer, isJob, isResult, isSessionCreated,
  isSnapshot, isToken, isUuid, parseApiErrorResponse,
} from "../src/kiosk/contracts";

export { parseApiErrorResponse };
export const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:3101";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MOVIE_BYTES = 100 * 1024 * 1024;

export class OrchestratorError extends Error {
  constructor(message: string, public readonly status = 0, public readonly code = "NETWORK_ERROR") {
    super(message);
    this.name = "OrchestratorError";
  }
  get terminal() { return [401, 403, 404, 410].includes(this.status); }
}

export function normalizeOrchestratorUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("Enter the trusted orchestrator URL."); }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Use an HTTPS origin, or HTTP on loopback only. Credentials, paths and query strings are not allowed.");
  }
  return url.origin;
}

export function clampRevision(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(999999999, Math.floor(value))) : 0;
}

export function mayProcessMedia(snapshot: SessionSnapshot | null, now = Date.now()): boolean {
  return !!snapshot && snapshot.state !== "cancelled" && snapshot.expiresAt > now &&
    snapshot.consent?.capture === true && snapshot.consent.personalization === true;
}

export interface ClientOptions {
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
  maxMovieBytes?: number;
}

export class OrchestratorClient {
  readonly baseUrl: string;
  private capability: SessionCreated | null = null;
  private readonly transport: typeof fetch;
  private readonly requestTimeout: number;
  private readonly uploadTimeout: number;
  private readonly maxMovieBytes: number;

  constructor(baseUrl = DEFAULT_ORCHESTRATOR_URL, options: ClientOptions = {}) {
    this.baseUrl = normalizeOrchestratorUrl(baseUrl);
    this.transport = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.requestTimeout = options.requestTimeoutMs ?? 15000;
    this.uploadTimeout = options.uploadTimeoutMs ?? 30000;
    this.maxMovieBytes = Math.min(options.maxMovieBytes ?? MAX_MOVIE_BYTES, MAX_MOVIE_BYTES);
  }

  join(capability: SessionCreated) {
    if (!isSessionCreated(capability)) throw new Error("The trusted bridge session fields are invalid.");
    this.capability = { ...capability };
  }

  forget() { this.capability = null; }

  private sessionPath(suffix = ""): string {
    if (!this.capability) throw new Error("Rejoin a trusted session first.");
    return `/v1/sessions/${this.capability.sessionId}${suffix}`;
  }

  private async request<T>(
    path: string, init: RequestInit, parse: (response: Response) => Promise<T>,
    signal?: AbortSignal, timeout = this.requestTimeout, deviceToken?: string,
  ): Promise<T> {
    const token = deviceToken ?? this.capability?.sessionToken;
    if (!token) throw new Error("Rejoin a trusted session first.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const response = await this.transport(`${this.baseUrl}${path}`, {
        ...init, headers, signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store",
      });
      if (!response.ok) {
        const error = parseApiErrorResponse(await response.json().catch(() => null));
        // The code is safe to show; a remote message must never echo a capability into the UI.
        throw new OrchestratorError(
          error ? `Orchestrator request failed (${error.error.code}).` : `Orchestrator request failed (HTTP ${response.status}).`,
          response.status, error?.error.code ?? "HTTP_ERROR",
        );
      }
      const result = await parse(response);
      if (controller.signal.aborted) throw new OrchestratorError("Request timed out or was stopped.", 0, "ABORTED");
      return result;
    } catch (error) {
      if (error instanceof OrchestratorError) throw error;
      if (controller.signal.aborted) throw new OrchestratorError("Request timed out or was stopped.", 0, "ABORTED");
      throw new OrchestratorError("Cannot reach the orchestrator. Check its address, trusted certificate and allowed browser origin.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private json<T>(path: string, method: string, body: unknown, guard: (value: unknown) => value is T, signal?: AbortSignal, deviceToken?: string) {
    return this.request(path, {
      method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }, async response => {
      const value: unknown = await response.json();
      if (!guard(value)) throw new OrchestratorError("The orchestrator returned an invalid response.", 0, "INVALID_RESPONSE");
      return value;
    }, signal, this.requestTimeout, deviceToken);
  }

  async pair(deviceToken: string, signal?: AbortSignal): Promise<SessionCreated> {
    if (!isToken(deviceToken)) throw new Error("Enter a 24–256 character device token without whitespace.");
    // No body: POST /v1/sessions is authenticated by the device bearer, not a service key.
    return this.json("/v1/sessions", "POST", undefined, isSessionCreated, signal, deviceToken);
  }

  snapshot(afterRevision = 0, signal?: AbortSignal): Promise<SessionSnapshot> {
    return this.json(`${this.sessionPath()}?afterRevision=${clampRevision(afterRevision)}`, "GET", undefined, isSnapshot, signal);
  }

  event(event: SessionEvent, signal?: AbortSignal): Promise<SessionSnapshot> {
    if (!isUuid(event.eventId)) throw new Error("Invalid event ID.");
    return this.json(this.sessionPath("/events"), "POST", event, isSnapshot, signal);
  }

  identify(customerId: "demo-alex" | "demo-sam", signal?: AbortSignal): Promise<CustomerProfile> {
    return this.json(this.sessionPath("/commands/identify_customer"), "POST", { customerId, method: "manual" }, isCustomer, signal);
  }

  async createBrief(signal?: AbortSignal): Promise<AdBrief> {
    const brief = await this.json(this.sessionPath("/commands/create_ad_brief"), "POST", { productId: "demo-car" }, isBrief, signal);
    if (brief.sessionId !== this.capability?.sessionId) throw new OrchestratorError("Brief belongs to another session.", 0, "SESSION_MISMATCH");
    return brief;
  }

  async startMedia(briefId: string, idempotencyKey: string, signal?: AbortSignal): Promise<MediaJob> {
    if (!isUuid(briefId) || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw new Error("Invalid media command.");
    const job = await this.json(this.sessionPath("/commands/start_media_job"), "POST", { briefId, idempotencyKey }, isJob, signal);
    if (job.briefId !== briefId) throw new OrchestratorError("Job belongs to another brief.", 0, "SESSION_MISMATCH");
    return job;
  }

  async uploadImage(file: Blob, snapshot: SessionSnapshot | null, signal?: AbortSignal): Promise<AssetUploaded> {
    if (!mayProcessMedia(snapshot) || snapshot?.sessionId !== this.capability?.sessionId ||
      snapshot?.serverInstanceId !== this.capability?.serverInstanceId) throw new Error("Confirm capture and personalization permission first.");
    if (!["image/png", "image/jpeg"].includes(file.type)) throw new Error("Choose a PNG or JPEG image.");
    if (file.size < 1 || file.size > MAX_IMAGE_BYTES) throw new Error("Choose an image up to 5 MiB.");
    return this.request(this.sessionPath("/assets"), {
      method: "POST", headers: { "Content-Type": file.type }, body: file,
    }, async response => {
      const value: unknown = await response.json();
      if (!isAssetUploaded(value)) throw new OrchestratorError("Invalid upload receipt.", 0, "INVALID_RESPONSE");
      return value;
    }, signal, this.uploadTimeout);
  }

  async downloadMovie(result: MediaResult, signal?: AbortSignal): Promise<Blob> {
    if (!isResult(result) || result.byteLength > this.maxMovieBytes) throw new Error("The movie exceeds the supported size or has invalid metadata.");
    return this.request(this.sessionPath(`/assets/${result.assetId}`), { method: "GET" }, async response => {
      const reject = async (message: string): Promise<never> => {
        await response.body?.cancel().catch(() => {});
        throw new OrchestratorError(message, 0, "INVALID_MEDIA");
      };
      if (response.status !== 200 || response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "video/mp4") {
        return reject("The authorized result is not a complete MP4.");
      }
      const length = response.headers.get("Content-Length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== result.byteLength)) {
        return reject("Movie length does not match its receipt.");
      }
      if (!response.body) throw new OrchestratorError("Movie response was empty.", 0, "INVALID_MEDIA");
      const reader = response.body.getReader();
      const bytes = new Uint8Array(result.byteLength);
      let offset = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (offset + value.byteLength > bytes.byteLength) throw new OrchestratorError("Movie exceeded its authorized size.", 0, "INVALID_MEDIA");
          bytes.set(value, offset);
          offset += value.byteLength;
        }
        if (offset !== bytes.byteLength) throw new OrchestratorError("Movie download was incomplete.", 0, "INVALID_MEDIA");
        if (!globalThis.crypto?.subtle) throw new OrchestratorError("Verified playback requires a secure browser context.", 0, "INVALID_MEDIA");
        const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        const checksum = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
        if (checksum !== result.checksum) throw new OrchestratorError("Movie checksum did not match. Playback was blocked.", 0, "INVALID_MEDIA");
        return new Blob([bytes], { type: "video/mp4" });
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        bytes.fill(0);
      }
    }, signal, this.uploadTimeout);
  }

  revoke(signal?: AbortSignal): Promise<void> {
    return this.request(this.sessionPath(), { method: "DELETE" }, async response => {
      if (response.status !== 204) throw new OrchestratorError("Cleanup was not confirmed.", response.status, "CLEANUP_UNCONFIRMED");
    }, signal);
  }
}
