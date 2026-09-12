import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import { consentSchema, jobRequestSchema, MovieError, type AssetRecord, type MovieJob } from "../domain";
import type { AssetView, ConfigView, JobView, Readiness } from "../domain/http";
import type { MovieConfig } from "../domain/services";
import { JobStore } from "../jobs/store";
import { allTemplates } from "../templates";
import { SessionAuth } from "./auth";
import { ProductCatalog } from "./catalog";
import { loadConfig } from "./config";
import { LocalMediaRepository } from "./media";
import { boundedBody, uploadPhotos } from "./uploads";
import { uploadProductReferences } from "./product-upload";

const privateHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
};

export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(privateHeaders);
  new Headers(headers).forEach((value, key) => result.set(key, value));
  return Response.json(value, { status, headers: result });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof MovieError) return json({ error: error.message, code: error.code }, error.httpStatus);
  if (error instanceof z.ZodError) return json({ error: "The request does not match the movie API schema.", code: "INVALID_REQUEST" }, 400);
  return json({ error: "The local movie service could not complete this request.", code: "INTERNAL_ERROR" }, 500);
}

export function assetView(asset: AssetRecord): AssetView {
  return { id: asset.id, mime: asset.mime, width: asset.width, height: asset.height };
}

export function jobView(job: MovieJob): JobView {
  return {
    id: job.id, sessionId: job.request.session_id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt,
    events: job.events, warnings: job.warnings, error: job.error, character: job.character, plan: job.plan,
    frames: job.frames, hero: job.hero, result: job.result,
  };
}

export function parseRange(header: string, size: number): { start: number; end: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) throw new MovieError("INVALID_RANGE", "The requested byte range is not available.", 416);
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new MovieError("INVALID_RANGE", "The requested byte range is not available.", 416);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      throw new MovieError("INVALID_RANGE", "The requested byte range is not available.", 416);
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

type Dependencies = {
  media?: LocalMediaRepository;
  store?: JobStore;
  catalog?: ProductCatalog;
  rendererReady?: () => Promise<Readiness>;
};

export function createApiHandlers(config: MovieConfig, dependencies: Dependencies = {}) {
  const media = dependencies.media ?? new LocalMediaRepository(config.dataDir);
  const store = dependencies.store ?? new JobStore(config.dataDir);
  const catalog = dependencies.catalog ?? new ProductCatalog(config.dataDir, media);
  const auth = new SessionAuth(config);
  const rendererReady = dependencies.rendererReady ?? (async () => (await import("../render")).createRenderer(config).ready());
  const guarded = <A extends unknown[]>(handle: (request: Request, ...args: A) => Promise<Response>) =>
    async (request: Request, ...args: A): Promise<Response> => {
      try { return await handle(request, ...args); } catch (error) { return errorResponse(error); }
    };

  const providers = (): ConfigView["providers"] => ({
    openai: {
      available: !!(config.openaiKey && config.visionModel && config.directorModel && config.imageModel),
      message: config.openaiKey && config.visionModel && config.directorModel && config.imageModel
        ? "OpenAI is configured; model access is verified by the provider when generation starts."
        : "Set OPENAI_API_KEY, OPENAI_VISION_MODEL and OPENAI_DIRECTOR_MODEL before generating a movie.",
    },
    veo: {
      available: !!config.googleKey,
      message: config.googleKey ? "Optional Veo enhancement is configured; access is checked at generation time." : "Optional Veo is not configured; storyboard-motion remains available.",
    },
  });

  return {
    config: guarded(async request => {
      const session = await auth.authenticate(request, { createSession: true });
      const [products, renderer, worker] = await Promise.all([catalog.list(), rendererReady(), store.workerReadiness()]);
      const view: ConfigView = {
        templates: allTemplates,
        products,
        providers: providers(), worker,
        renderer,
      };
      return json(view, 200, session.cookie ? { "set-cookie": session.cookie } : undefined);
    }),
    upload: guarded(async request => {
      const { ownerId } = await auth.authenticate(request, { mutation: true });
      return json({ assets: (await uploadPhotos(request, ownerId, media)).map(assetView) }, 201);
    }),
    uploadProduct: guarded(async (request, productId: string) => {
      await auth.authenticate(request, { mutation: true });
      return json({ product: await uploadProductReferences(request, productId, catalog) }, 201);
    }),
    submit: guarded(async request => {
      const { ownerId } = await auth.authenticate(request, { mutation: true });
      if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        throw new MovieError("INVALID_CONTENT_TYPE", "Send the job request as application/json.", 415);
      }
      const bytes = await boundedBody(request, 64 * 1024);
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
        throw new MovieError("INVALID_JSON", "The job request must be valid JSON.", 400);
      }
      const input = jobRequestSchema.parse(parsed);
      const previous = await store.findIdempotent(ownerId, input);
      if (previous) return json({ job_id: previous.id, status: previous.status, status_url: `/api/movie-jobs/${previous.id}` }, 202);
      const verifyReferences = async () => {
        const sourceHashes = new Set<string>();
        for (const id of input.customer_reference_asset_ids) {
          const asset = await media.requireOwned(id, ownerId);
          if (asset.kind !== "customer" || asset.jobId !== null || !consentSchema.safeParse(await media.getConsent(id)).success) {
            throw new MovieError("INVALID_REFERENCE", "All customer references must be consented uploads owned by this session.", 400);
          }
          const file = await stat(await media.assetPath(id)).catch(() => null);
          if (!file || file.size !== asset.bytes) throw new MovieError("ASSET_NOT_FOUND", "A customer reference is no longer available.", 404);
          const hash = await media.getSourceHash(id);
          if (!hash || sourceHashes.has(hash)) throw new MovieError("DUPLICATE_PHOTO", "Choose unique consented customer photos.", 400);
          sourceHashes.add(hash);
        }
      };
      await verifyReferences();
      const product = await catalog.getProduct(input.product_id);
      const openai = providers().openai;
      if (!openai.available) throw new MovieError("OPENAI_NOT_READY", openai.message, 503);
      const [renderer, worker] = await Promise.all([rendererReady(), store.workerReadiness()]);
      if (!renderer.available) throw new MovieError("RENDERER_NOT_READY", renderer.message, 503);
      if (!worker.available) throw new MovieError("WORKER_NOT_READY", worker.message, 503);
      const job = await store.create(ownerId, input, product, verifyReferences);
      return json({ job_id: job.id, status: job.status, status_url: `/api/movie-jobs/${job.id}` }, 202);
    }),
    getJob: guarded(async (request, id: string) => {
      const { ownerId } = await auth.authenticate(request);
      return json({ job: jobView(await store.getOwned(id, ownerId)) });
    }),
    deleteJob: guarded(async (request, id: string) => {
      const { ownerId } = await auth.authenticate(request, { mutation: true });
      await store.deleteOwned(id, ownerId, media);
      return new Response(null, { status: 204, headers: privateHeaders });
    }),
    getAsset: guarded(async (request, id: string) => {
      const { ownerId } = await auth.authenticate(request);
      const asset = await media.requireOwned(id, ownerId);
      const filename = await media.assetPath(id);
      const info = await stat(filename).catch(() => null);
      if (!info?.isFile()) throw new MovieError("ASSET_NOT_FOUND", "Asset not found.", 404);
      const headers = new Headers({
        ...privateHeaders, "content-type": asset.mime, "content-length": String(info.size),
        "content-disposition": `inline; filename="${asset.id}${asset.mime === "video/mp4" ? ".mp4" : asset.mime === "image/jpeg" ? ".jpg" : ".media"}"`,
        "content-security-policy": "default-src 'none'; sandbox",
      });
      let range: { start: number; end: number } | undefined;
      if (asset.mime.startsWith("video/")) {
        headers.set("accept-ranges", "bytes");
        const requested = request.headers.get("range");
        if (requested) {
          try { range = parseRange(requested, info.size); } catch (error) {
            const response = errorResponse(error);
            response.headers.set("content-range", `bytes */${info.size}`);
            return response;
          }
          headers.set("content-range", `bytes ${range.start}-${range.end}/${info.size}`);
          headers.set("content-length", String(range.end - range.start + 1));
        }
      }
      const stream = request.method === "HEAD" ? null : Readable.toWeb(createReadStream(filename, range)) as ReadableStream<Uint8Array>;
      return new Response(stream, { status: range ? 206 : 200, headers });
    }),
  };
}

let handlers: ReturnType<typeof createApiHandlers> | undefined;
export function api() { return handlers ??= createApiHandlers(loadConfig()); }
