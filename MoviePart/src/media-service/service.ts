import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { MediaCancellation, MediaServiceStatus, MediaSubmitRequest } from "../../integration/dwight/types";
import { atomicWrite, isMissing, processAlive, readJson, withDiskLock } from "../server/files";
import { briefSchema, decodeParticipantImage, fingerprint, ServiceError, uuid } from "./contracts";
import type { MediaExecutor } from "./executor";
import { sceneFrames, validateMp4, type RenderTools, type Stage } from "./render";
import { settleMediaProcesses } from "./process";

const receiptSchema = z.object({
  schemaVersion: z.literal(1),
  key: uuid,
  providerJobId: z.string().regex(/^render-[0-9a-f-]{36}$/),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  status: z.enum(["queued", "running", "ready", "failed", "cancelled"]),
  stage: z.enum(["accepted", "preparing", "generating", "rendering", "encoding", "finalizing"]),
  durationSeconds: z.number().positive().max(30).nullable(),
  cleanup: z.enum(["none", "pending", "deleted"]),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;
interface Active {
  key: string;
  controller: AbortController;
  settled: Promise<void>;
  finish(): void;
}
export interface ServiceOptions extends RenderTools {
  directory: string;
  executor: MediaExecutor;
  cleanupTimeoutMs?: number;
  removeWork?: (directory: string, signal: AbortSignal) => Promise<void>;
}

async function waitFor(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new ServiceError(503, "CLEANUP_PENDING"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class MediaService {
  readonly directory: string;
  private readonly token = randomUUID();
  private readonly records = new Map<string, Receipt>();
  private active?: Active;
  private worker?: Promise<void>;
  private accepting = false;
  private ownsLease = false;

  constructor(private readonly options: ServiceOptions) {
    this.directory = path.resolve(options.directory);
  }
  private lock<T>(operation: () => Promise<T>): Promise<T> {
    return withDiskLock(this.directory, operation);
  }
  private receiptPath(key: string): string { return path.join(this.directory, "receipts", `${key}.json`); }
  private workPath(record: Receipt): string { return path.join(this.directory, "work", record.providerJobId); }
  private outputPath(record: Receipt): string { return path.join(this.workPath(record), `${record.providerJobId}.mp4`); }
  private async save(record: Receipt): Promise<void> {
    receiptSchema.parse(record);
    await atomicWrite(this.receiptPath(record.key), JSON.stringify(record));
    this.records.set(record.key, record);
  }
  private requireStarted(): void {
    if (!this.accepting || !this.ownsLease) throw new ServiceError(503, "SERVICE_UNAVAILABLE");
  }
  private byProvider(id: string): Receipt {
    const record = [...this.records.values()].find(item => item.providerJobId === id);
    if (!record) throw new ServiceError(404, "JOB_NOT_FOUND");
    return record;
  }

  async start(): Promise<void> {
    await this.lock(async () => {
      const leasePath = path.join(this.directory, "worker-lease.json");
      try {
        const owner = z.object({ pid: z.number().int().positive(), token: z.string().uuid() }).strict().parse(await readJson(leasePath));
        if (processAlive(owner.pid)) throw new ServiceError(503, "WORKER_ALREADY_RUNNING");
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await atomicWrite(leasePath, JSON.stringify({ pid: process.pid, token: this.token }));
      this.ownsLease = true;
      try {
        const receipts = path.join(this.directory, "receipts");
        await mkdir(receipts, { recursive: true, mode: 0o700 });
        await mkdir(path.join(this.directory, "work"), { recursive: true, mode: 0o700 });
        for (const name of await readdir(receipts)) {
          if (!name.endsWith(".json")) continue;
          const record = receiptSchema.parse(await readJson(path.join(receipts, name)));
          if (name !== `${record.key}.json` || record.providerJobId !== `render-${record.key}`) {
            throw new ServiceError(503, "INVALID_RECEIPT");
          }
          this.records.set(record.key, record);
          if (record.status === "queued" || record.status === "running") {
            // A lost acknowledgement may hide a paid operation. Never resume or resubmit after a restart.
            await this.save({ ...record, status: "failed", cleanup: "pending" });
          }
        }
        for (const record of this.records.values()) {
          if (record.status === "cancelled" || record.status === "failed" || record.cleanup === "pending") {
            try { await this.cleanup(record.key); } catch { /* The durable pending receipt remains retryable. */ }
          }
        }
        // Orphans can only be local files from an interrupted transaction, never resumable jobs.
        for (const name of await readdir(path.join(this.directory, "work"))) {
          if (![...this.records.values()].some(record => record.providerJobId === name)) {
            await settleMediaProcesses(path.join(this.directory, "work", name), AbortSignal.timeout(30_000));
            await rm(path.join(this.directory, "work", name), { recursive: true, force: true });
          }
        }
        this.accepting = true;
      } catch (error) {
        await rm(leasePath, { force: true });
        this.ownsLease = false;
        throw error;
      }
    });
  }

  async ready(): Promise<boolean> {
    this.requireStarted();
    return this.options.executor.ready().catch(() => false);
  }

  async submit(input: MediaSubmitRequest): Promise<{ providerJobId: string }> {
    this.requireStarted();
    const key = input.jobId.toLowerCase();
    const hash = fingerprint(input);
    sceneFrames(input.brief);
    const existing = await this.lock(async () => this.duplicate(key, hash));
    if (existing) return existing;
    if (!await this.ready()) throw new ServiceError(503, "PROVIDER_NOT_CONFIGURED");
    const image = await decodeParticipantImage(input.image);
    const result = await this.lock(async () => {
      this.requireStarted();
      const duplicate = this.duplicate(key, hash);
      if (duplicate) return duplicate;
      const record: Receipt = {
        schemaVersion: 1, key, providerJobId: `render-${key}`, fingerprint: hash,
        status: "queued", stage: "accepted", durationSeconds: input.brief.durationSeconds, cleanup: "none",
      };
      // The non-PII receipt is durable before any input is stored and before acknowledging acceptance.
      await this.save(record);
      try {
        await atomicWrite(path.join(this.workPath(record), "brief.json"), JSON.stringify(input.brief));
        await atomicWrite(path.join(this.workPath(record), "participant.jpg"), image);
      } catch {
        await this.save({ ...record, status: "failed", cleanup: "pending" });
        try { await this.cleanup(key); } catch { /* DELETE retries the persisted receipt. */ }
        throw new ServiceError(503, "STORE_UNAVAILABLE");
      }
      return { providerJobId: record.providerJobId };
    });
    this.kick();
    return result;
  }

  private duplicate(key: string, hash: string): { providerJobId: string } | undefined {
    const existing = this.records.get(key);
    if (!existing) return;
    if (existing.status === "cancelled") throw new ServiceError(409, "JOB_CANCELLED");
    if (existing.fingerprint !== hash) throw new ServiceError(409, "IDEMPOTENCY_CONFLICT");
    return { providerJobId: existing.providerJobId };
  }

  private kick(): void {
    if (this.worker || !this.accepting) return;
    this.worker = Promise.resolve().then(() => this.drain()).catch(() => {
      // Fail closed on a store failure. Restart reconciles interrupted jobs without paid retries.
      this.accepting = false;
    }).finally(() => {
      this.worker = undefined;
      if (this.accepting && [...this.records.values()].some(record => record.status === "queued")) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.accepting) {
      const claimed = await this.lock(async () => {
        if (!this.accepting) return;
        const record = [...this.records.values()].find(item => item.status === "queued");
        if (!record) return;
        await this.save({ ...record, status: "running", stage: "preparing" });
        let finish!: () => void;
        const settled = new Promise<void>(resolve => { finish = resolve; });
        this.active = { key: record.key, controller: new AbortController(), settled, finish };
        return { record, active: this.active };
      });
      if (!claimed) return;
      const { record, active } = claimed;
      const signal = AbortSignal.any([active.controller.signal, AbortSignal.timeout(10 * 60_000)]);
      try {
        const brief = briefSchema.parse(await readJson(path.join(this.workPath(record), "brief.json")));
        signal.throwIfAborted();
        await this.options.executor.execute({
          brief, directory: this.workPath(record), input: path.join(this.workPath(record), "participant.jpg"),
          output: this.outputPath(record), signal,
          progress: async (stage: Stage) => {
            signal.throwIfAborted();
            await this.lock(async () => {
              const current = this.records.get(record.key)!;
              signal.throwIfAborted();
              if (current.status !== "running") throw new ServiceError(409, "JOB_CANCELLED");
              await this.save({ ...current, stage });
            });
          },
        });
        signal.throwIfAborted();
        await validateMp4(this.outputPath(record), brief.durationSeconds, this.options, signal);
        await this.lock(async () => {
          signal.throwIfAborted();
          const current = this.records.get(record.key)!;
          if (current.status !== "running") throw new ServiceError(409, "JOB_CANCELLED");
          await this.save({ ...current, status: "ready", stage: "finalizing" });
        });
      } catch {
        await this.lock(async () => {
          const current = this.records.get(record.key)!;
          if (current.status !== "cancelled") {
            await this.save({ ...current, status: "failed", cleanup: "pending" });
            try { await this.cleanup(record.key); } catch { /* A durable receipt requires later cleanup. */ }
          }
        });
      } finally {
        this.active = undefined;
        active.finish();
      }
    }
  }

  async status(providerJobId: string): Promise<MediaServiceStatus> {
    this.requireStarted();
    return this.lock(async () => {
      const record = this.byProvider(providerJobId);
      if (record.status === "cancelled" || record.status === "failed") return { status: "failed" };
      if (record.status === "ready") {
        try {
          await validateMp4(this.outputPath(record), record.durationSeconds!, this.options);
        } catch {
          await this.save({ ...record, status: "failed", cleanup: "pending" });
          return { status: "failed" };
        }
        return {
          status: "ready",
          result: {
            assetPath: `assets/${record.providerJobId}.mp4`, mimeType: "video/mp4",
            durationSeconds: record.durationSeconds!,
          },
        };
      }
      return { status: record.status, stage: record.stage };
    });
  }

  async asset(filename: string): Promise<Buffer> {
    this.requireStarted();
    return this.lock(async () => {
      const record = this.byProvider(filename.slice(0, -4));
      if (record.status !== "ready" || filename !== `${record.providerJobId}.mp4`) throw new ServiceError(404, "ASSET_NOT_FOUND");
      try {
        await validateMp4(this.outputPath(record), record.durationSeconds!, this.options);
        return await readFile(this.outputPath(record));
      } catch {
        await this.save({ ...record, status: "failed", cleanup: "pending" });
        throw new ServiceError(404, "ASSET_NOT_FOUND");
      }
    });
  }

  private async cleanup(key: string, signal = AbortSignal.timeout(this.options.cleanupTimeoutMs ?? 30_000)): Promise<void> {
    const record = this.records.get(key)!;
    await this.save({ ...record, cleanup: "pending" });
    signal.throwIfAborted();
    const directory = this.workPath(record);
    await settleMediaProcesses(directory, signal);
    if (this.options.removeWork) await this.options.removeWork(directory, signal);
    else await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    signal.throwIfAborted();
    try {
      await lstat(directory);
      throw new ServiceError(503, "CLEANUP_PENDING");
    } catch (error) { if (!isMissing(error)) throw error; }
    await this.save({ ...this.records.get(key)!, cleanup: "deleted" });
  }

  async cancel(jobId: string): Promise<MediaCancellation> {
    this.requireStarted();
    if (!uuid.safeParse(jobId).success) throw new ServiceError(400, "INVALID_JOB_KEY");
    const key = jobId.toLowerCase();
    const settled = await this.lock(async () => {
      const old = this.records.get(key);
      await this.save({
        schemaVersion: 1, key, providerJobId: `render-${key}`, fingerprint: old?.fingerprint ?? null,
        status: "cancelled", stage: "accepted", durationSeconds: old?.durationSeconds ?? null,
        cleanup: old?.cleanup === "deleted" ? "deleted" : "pending",
      });
      const active = this.active?.key === key ? this.active : undefined;
      active?.controller.abort();
      return { promise: active?.settled ?? Promise.resolve() };
    });
    const signal = AbortSignal.timeout(this.options.cleanupTimeoutMs ?? 30_000);
    try {
      // Never use the aborted render signal for cleanup, and never delete beneath a live executor.
      await waitFor(settled.promise, signal);
      await this.lock(async () => this.cleanup(key, signal));
    } catch { throw new ServiceError(503, "CLEANUP_PENDING"); }
    return { status: "cancelled", assetsDeleted: true };
  }

  async close(): Promise<void> {
    this.accepting = false;
    this.active?.controller.abort();
    await this.worker;
    if (this.ownsLease) {
      await this.lock(async () => {
        const filename = path.join(this.directory, "worker-lease.json");
        const lease = await readJson(filename) as { token?: string };
        if (lease.token === this.token) await rm(filename, { force: true });
        this.ownsLease = false;
      });
    }
  }
}
