import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Availability, Booking } from './availability.js';
import { hasCode, HttpError } from './errors.js';
import type { LiveAnswer } from './provider.js';
import { identitySchema } from './tools.js';

export type Stage = 'chat' | 'movie_offer' | 'watching' | 'feedback' | 'drive_offer' | 'selecting' | 'booked' | 'declined';
export type MovieStatus = 'processing' | 'ready' | 'error';
export const MOVIE_URL = '/Movies/demo.mp4' as const;
export const MOVIE_ERROR = 'The demo movie is unavailable. Please ask a sales representative for help.';
export const MOVIE_DELAY_MS = 5000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type MovieEvent =
  | { type: 'movie.ready'; customerId: string; movieUrl: typeof MOVIE_URL }
  | { type: 'movie.error'; customerId: string; message: string };

export interface ToolResult {
  ok: true;
  stage: Stage;
  uiAction?: string;
  movieUrl?: typeof MOVIE_URL;
  availability?: Availability;
  date?: string;
  timeZone?: string;
  slots?: Availability['slots'];
  demo?: true;
  booking?: Booking;
  destination?: 'model3' | 'modely';
  message?: string;
  answer?: string;
  replayed?: boolean;
}

export interface Customer {
  customerId: string;
  clientId: string;
  active: boolean;
  status: MovieStatus;
  stage: Stage;
  saved: boolean;
  controller: AbortController;
  save?: Promise<void>;
  cancelTimer?: () => void;
  availability?: Availability;
  booking?: Booking;
  following?: 'model3' | 'modely';
  receipts: Map<string, ToolResult>;
  expertCalls: Map<string, Promise<string>>;
  voiceCalls: Map<string, Promise<LiveAnswer>>;
}

export type Schedule = (task: () => Promise<void>, delayMs: number) => () => void;

export const scheduleTimer: Schedule = (task, delayMs) => {
  const timer = setTimeout(() => { void task(); }, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

export interface CustomerOptions {
  facesDir: string;
  movieAvailable: () => Promise<boolean>;
  movieDelayMs?: number;
  schedule?: Schedule;
}

export class CustomerStore {
  private readonly records = new Map<string, Customer>();
  private readonly listeners = new Set<(clientId: string, event: MovieEvent) => void>();
  private readonly options: CustomerOptions;
  private closed = false;

  constructor(options: CustomerOptions) {
    this.options = options;
  }

  subscribe(listener: (clientId: string, event: MovieEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private bound(clientId: string, customerId: string): Customer {
    const identity = identitySchema.parse({ clientId, customerId });
    const record = this.records.get(identity.customerId);
    if (!record) throw new HttpError(404, 'Customer not found.');
    if (record.clientId !== identity.clientId) throw new HttpError(403, 'Customer belongs to another client.');
    return record;
  }

  assertActive(record: Customer): void {
    if (this.closed || !record.active || this.records.get(record.customerId) !== record) {
      throw new HttpError(409, 'Customer is inactive.');
    }
  }

  get(clientId: string, customerId: string): Customer {
    const record = this.bound(clientId, customerId);
    this.assertActive(record);
    return record;
  }

  snapshot(clientId: string, customerId: string) {
    const record = this.get(clientId, customerId);
    return {
      customerId: record.customerId,
      status: record.status,
      ...(record.status === 'ready' ? { movieUrl: MOVIE_URL } : {}),
      stage: record.stage,
      ...(record.booking ? { booking: record.booking } : {}),
    };
  }

  deactivate(clientId: string, customerId: string): void {
    const record = this.bound(clientId, customerId);
    record.active = false;
    record.following = undefined;
    record.cancelTimer?.();
    record.cancelTimer = undefined;
    record.controller.abort();
  }

  completedFor(clientId: string): MovieEvent[] {
    return [...this.records.values()]
      .filter((record) => record.active && record.clientId === clientId && record.saved && record.status !== 'processing')
      .map((record) => this.eventFor(record));
  }

  private eventFor(record: Customer): MovieEvent {
    return record.status === 'ready'
      ? { type: 'movie.ready', customerId: record.customerId, movieUrl: MOVIE_URL }
      : { type: 'movie.error', customerId: record.customerId, message: MOVIE_ERROR };
  }

  async upload(clientId: string, customerId: string, bytes: Buffer) {
    const identity = identitySchema.parse({ clientId, customerId });
    if (this.closed) throw new HttpError(503, 'Server is closing.');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new HttpError(400, 'Provide an image no larger than 5 MB.');
    const previous = this.records.get(identity.customerId);
    if (previous) {
      const record = this.get(identity.clientId, identity.customerId);
      await record.save;
      this.assertActive(record);
      return { statusCode: record.status === 'processing' ? 202 : 200,
        body: { customerId: record.customerId, status: record.status } };
    }
    const record: Customer = {
      ...identity, active: true, status: 'processing', stage: 'chat', saved: false,
      controller: new AbortController(), receipts: new Map(), expertCalls: new Map(), voiceCalls: new Map(),
    };
    // Claim ownership synchronously BEFORE the first await (sharp/disk may take time).
    this.records.set(record.customerId, record);
    record.save = this.saveFace(record, bytes).catch((error: unknown) => {
      record.status = 'error';
      throw error instanceof HttpError ? error : new HttpError(500, 'Unable to save the customer image.');
    });
    await record.save;
    this.assertActive(record);
    return { statusCode: 202, body: { customerId: record.customerId, status: 'processing' as const } };
  }

  private async saveFace(record: Customer, bytes: Buffer): Promise<void> {
    let jpeg: Buffer;
    try {
      const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning', animated: false });
      const metadata = await image.metadata();
      if (!metadata.format || !['jpeg', 'png', 'webp', 'heif', 'avif', 'tiff'].includes(metadata.format)
        || (metadata.pages ?? 1) !== 1) throw new Error('Unsupported image');
      jpeg = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 }).toBuffer();
    } catch {
      throw new HttpError(400, 'Provide a valid, single-frame raster image.');
    }
    this.assertActive(record);
    await mkdir(this.options.facesDir, { recursive: true });
    this.assertActive(record);
    const path = join(this.options.facesDir, `${record.customerId}.jpg`);
    let file;
    try {
      // Exclusive create also protects prior customers' files across server restarts.
      file = await open(path, 'wx', 0o600);
    } catch (error) {
      if (hasCode(error, 'EEXIST')) throw new HttpError(409, 'A customer image already exists for this ID. Use a new customer ID.');
      throw new HttpError(500, 'Unable to save the customer image.');
    }
    try {
      this.assertActive(record);
      await file.writeFile(jpeg);
    } catch (error) {
      await file.close();
      await unlink(path).catch(() => undefined); // Only remove a file WE exclusively created.
      throw error;
    }
    await file.close();
    this.assertActive(record);
    record.saved = true;
    record.cancelTimer = (this.options.schedule ?? scheduleTimer)(
      () => this.finishMovie(record), this.options.movieDelayMs ?? MOVIE_DELAY_MS);
  }

  private async finishMovie(record: Customer): Promise<void> {
    record.cancelTimer = undefined;
    if (this.closed || !record.active) return;
    let available = false;
    try { available = await this.options.movieAvailable(); } catch { /* Treat inaccessible as absent. */ }
    // Deletion/close can occur WHILE checking disk; never publish a stale callback.
    if (this.closed || !record.active) return;
    record.status = available ? 'ready' : 'error';
    const event = this.eventFor(record);
    for (const listener of this.listeners) listener(record.clientId, event);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const record of this.records.values()) {
      record.active = false;
      record.cancelTimer?.();
      record.cancelTimer = undefined;
      record.controller.abort();
    }
    this.listeners.clear();
    await Promise.allSettled([...this.records.values()].map((record) => record.save));
  }
}