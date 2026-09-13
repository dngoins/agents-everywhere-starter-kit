import { MovieError, type MovieJob, type RenderResult } from "../domain";
import type { GenerationContext, MovieConfig } from "../domain/services";
import { LocalMediaRepository } from "../server/media";
import { JobStore, terminal, WORKER_HEARTBEAT_MS } from "./store";

type Checkpoint = (patch: Partial<Pick<MovieJob, "character" | "plan" | "hero" | "heroAttempted">>) => Promise<void>;
export type MovieExecutor = (job: MovieJob, context: GenerationContext, checkpoint: Checkpoint, config: MovieConfig) => Promise<RenderResult>;

export class MovieWorker {
  readonly store: JobStore;
  readonly media: LocalMediaRepository;
  private token: string | null = null;
  private readonly controller = new AbortController();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatWork: Promise<void> = Promise.resolve();
  private active: Promise<boolean> | null = null;
  private readonly execute: MovieExecutor;

  constructor(private readonly config: MovieConfig, dependencies: {
    store?: JobStore; media?: LocalMediaRepository; execute?: MovieExecutor;
  } = {}) {
    this.store = dependencies.store ?? new JobStore(config.dataDir);
    this.media = dependencies.media ?? new LocalMediaRepository(config.dataDir);
    this.execute = dependencies.execute ?? (async (...args) => (await import("../pipeline")).executeMovie(...args));
  }

  async start(): Promise<void> {
    if (this.token) return;
    if (this.controller.signal.aborted) throw new MovieError("WORKER_STOPPED", "This worker has already stopped.", 409);
    this.token = await this.store.acquireWorker();
    try { await this.store.recoverInterrupted(this.token); } catch (error) {
      await this.store.releaseWorker(this.token);
      this.token = null;
      throw error;
    }
    this.heartbeatTimer = setInterval(() => {
      this.heartbeatWork = this.heartbeatWork.then(async () => {
        if (this.token) await this.store.heartbeat(this.token);
      }).catch(() => { this.controller.abort(); });
    }, WORKER_HEARTBEAT_MS);
    this.heartbeatTimer.unref();
  }

  async runOnce(): Promise<boolean> {
    if (!this.token) throw new MovieError("WORKER_NOT_STARTED", "Start the worker before claiming jobs.", 409);
    if (this.active) return this.active;
    if (this.controller.signal.aborted) return false;
    this.active = this.processNext(this.token);
    try { return await this.active; } finally { this.active = null; }
  }

  private cleanMessage(message: string): string {
    let result = message;
    for (const sensitive of [this.config.openaiKey, this.config.googleKey, this.config.apiToken, this.config.dataDir]) {
      if (sensitive) result = result.replaceAll(sensitive, "[redacted]");
    }
    return result.slice(0, 2_000);
  }

  private async processNext(token: string): Promise<boolean> {
    const job = await this.store.claim(token);
    if (!job) return false;
    const mutate = async (change: (current: MovieJob) => void) => {
      this.controller.signal.throwIfAborted();
      await this.store.update(job.id, current => {
        if (terminal(current)) throw new MovieError("JOB_TERMINAL", "The job has already ended.", 409);
        change(current);
      });
    };
    const context: GenerationContext = {
      jobId: job.id, ownerId: job.ownerId, media: this.media, signal: this.controller.signal,
      report: async update => {
        if (update.stage === "COMPLETED" || update.stage === "FAILED") {
          throw new MovieError("INVALID_STAGE", "Only the worker may complete or fail a job.");
        }
        await mutate(current => {
          current.status = update.stage;
          current.events.push({
            at: new Date().toISOString(), stage: update.stage, message: this.cleanMessage(update.message),
            provider: update.provider ?? null, shotId: update.shotId ?? null,
          });
        });
      },
      warn: async message => mutate(current => { current.warnings.push(this.cleanMessage(message)); }),
      recordOperation: async (provider, id) => mutate(current => {
        if (!current.operations.some(operation => operation.provider === provider && operation.id === id)) {
          current.operations.push({ provider, id });
        }
      }),
      saveFrame: async frame => {
        const asset = await this.media.requireOwned(frame.assetId, job.ownerId);
        if (asset.jobId !== job.id) throw new MovieError("INVALID_ARTIFACT", "A storyboard asset belongs to a different job.");
        await mutate(current => {
          const index = current.frames.findIndex(existing => existing.assetId === frame.assetId);
          if (index >= 0) current.frames[index] = frame;
          else current.frames.push(frame);
        });
      },
    };
    try {
      const result = await this.execute(job, context, async patch => mutate(current => { Object.assign(current, patch); }), this.config);
      this.controller.signal.throwIfAborted();
      const asset = await this.media.requireOwned(result.assetId, job.ownerId);
      if (asset.jobId !== job.id || asset.kind !== "video") throw new MovieError("INVALID_ARTIFACT", "The renderer did not produce a private video asset for this job.");
      await this.store.update(job.id, current => {
        current.result = result;
        current.status = "COMPLETED";
        current.events.push({ at: new Date().toISOString(), stage: "COMPLETED", message: "Movie ready.", provider: null, shotId: null });
      });
    } catch (error) {
      await this.store.update(job.id, current => {
        const stage = current.status;
        const aborted = this.controller.signal.aborted;
        current.error = {
          code: aborted ? "WORKER_ABORTED" : error instanceof MovieError ? error.code : "GENERATION_FAILED",
          message: aborted
            ? "The local worker was stopped. Saved artifacts remain available; paid operations will not be repeated automatically."
            : error instanceof MovieError ? this.cleanMessage(error.message) : `Generation failed during ${stage}. Saved artifacts were retained.`,
          stage,
        };
        current.status = "FAILED";
        current.events.push({ at: new Date().toISOString(), stage: "FAILED", message: current.error.message, provider: null, shotId: null });
      });
    } finally { await this.store.finishClaim(job.id, token); }
    return true;
  }

  async run(signal?: AbortSignal): Promise<void> {
    const abort = () => this.controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await this.start();
      while (!this.controller.signal.aborted) {
        if (!await this.runOnce()) {
          await new Promise<void>(resolve => {
            const onAbort = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => { this.controller.signal.removeEventListener("abort", onAbort); resolve(); }, 500);
            this.controller.signal.addEventListener("abort", onAbort, { once: true });
            if (this.controller.signal.aborted) onAbort();
          });
        }
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    this.controller.abort();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try { await this.active; } finally {
      await this.heartbeatWork;
      if (this.token) {
        await this.store.releaseWorker(this.token);
        this.token = null;
      }
    }
  }
}
