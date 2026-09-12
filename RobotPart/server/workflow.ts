import { createHash, randomUUID } from 'node:crypto';
import { availabilityFor, type Booking } from './availability.js';
import { TIME_ZONE } from './config.js';
import { CustomerStore, MOVIE_URL, type Customer, type Stage, type ToolResult } from './customers.js';
import { HttpError } from './errors.js';
import { OpenAIProvider, sdpSchema, type LiveAnswer } from './provider.js';
import { toolCallSchema } from './tools.js';

export const BOOKING_TODO = 'TODO: communicate mock all-day test drive with sales team';
export const FOLLOW_MESSAGE = 'Following is camera-based only while customer faces robot; stop if face lost; no mapped navigation.';
export type BookingLogger = (message: string, booking: Booking) => void;

export class Workflow {
  private readonly store: CustomerStore;
  private readonly provider: OpenAIProvider;
  private readonly now: () => Date;
  private readonly log: BookingLogger;

  constructor(store: CustomerStore, provider: OpenAIProvider, now: () => Date = () => new Date(),
    log: BookingLogger = (message, booking) => console.log(message, booking)) {
    this.store = store;
    this.provider = provider;
    this.now = now;
    this.log = log;
  }

  private requireStage(record: Customer, stage: Stage): void {
    if (record.stage !== stage) throw new HttpError(409, `This action requires stage '${stage}'.`);
  }

  private slots(record: Customer): ToolResult {
    this.requireStage(record, 'selecting');
    // Always recompute tomorrow from the injected clock; stale dates cannot survive midnight.
    record.availability = availabilityFor(record.customerId, this.now());
    return { ok: true, stage: record.stage, uiAction: 'show_slots',
      ...record.availability, availability: record.availability };
  }

  async createVoice(clientId: string, customerId: string, sdp: string): Promise<LiveAnswer> {
    const record = this.store.get(clientId, customerId);
    const offer = sdpSchema.parse(sdp);
    const key = createHash('sha256').update(offer).digest('hex');
    // Concurrent identical handshakes (even failed ones) never cause an automatic paid retry.
    let pending = record.voiceCalls.get(key);
    if (!pending) {
      pending = this.provider.createLive(offer, record.controller.signal);
      record.voiceCalls.set(key, pending);
    }
    const answer = await pending;
    this.store.assertActive(record);
    return answer;
  }

  async execute(clientId: string, customerId: string, name: string, rawArgs: unknown): Promise<ToolResult> {
    const record = this.store.get(clientId, customerId);
    const call = toolCallSchema.parse({ name, args: rawArgs });
    const key = `${call.name}:${JSON.stringify(call.args)}`;
    const previous = record.receipts.get(key);
    if (previous) {
      // Never replay an old UI action after the workflow has moved on.
      if (previous.stage !== record.stage) return { ok: true, stage: record.stage, replayed: true };
      if (record.stage === 'selecting') return this.slots(record);
      return { ...previous, replayed: true };
    }
    const complete = (stage: Stage, data: Omit<ToolResult, 'ok' | 'stage'>): ToolResult => {
      record.stage = stage;
      const result: ToolResult = { ok: true, stage, ...data };
      record.receipts.set(key, result);
      return result;
    };
    switch (call.name) {
      case 'offer_movie':
        this.requireStage(record, 'chat');
        if (!record.saved || record.status !== 'ready') throw new HttpError(409, 'The movie is not ready.');
        return complete('movie_offer', { uiAction: 'offer_movie', movieUrl: MOVIE_URL });
      case 'show_movie':
        this.requireStage(record, 'movie_offer');
        if (!call.args.accepted) return complete('declined', { uiAction: 'decline_movie' });
        if (record.status !== 'ready') throw new HttpError(409, 'The movie is not ready.');
        record.following = undefined;
        return complete('watching', { uiAction: 'show_movie', movieUrl: MOVIE_URL });
      case 'movie_finished':
        this.requireStage(record, 'watching');
        return complete('feedback', { uiAction: 'feedback' });
      case 'movie_feedback':
        this.requireStage(record, 'feedback');
        return call.args.liked
          ? complete('drive_offer', { uiAction: 'offer_test_drive' })
          : complete('declined', { uiAction: 'decline_test_drive' });
      case 'test_drive_interest':
        this.requireStage(record, 'drive_offer');
        if (!call.args.accepted) return complete('declined', { uiAction: 'decline_test_drive' });
        record.stage = 'selecting';
        return complete('selecting', this.slots(record));
      case 'get_test_drive_slots':
        return this.slots(record);
      case 'book_test_drive': {
        if (!call.args.confirmed) throw new HttpError(400, 'Explicit booking confirmation is required.');
        if (record.booking) throw new HttpError(409, 'A different demo booking already exists for this customer.');
        this.requireStage(record, 'selecting');
        const current = availabilityFor(record.customerId, this.now());
        const offered = record.availability;
        const slot = offered?.date === current.date
          ? offered.slots.find((candidate) => candidate.id === call.args.slotId
            && current.slots.some((valid) => valid.id === candidate.id)) : undefined;
        if (!slot) throw new HttpError(409, 'This pickup slot was not offered or is stale. Refresh slots and confirm again.');
        const booking: Booking = {
          id: randomUUID(), customerId: record.customerId, slotId: slot.id, car: call.args.car,
          startAt: slot.startAt, returnAt: slot.returnAt, timeZone: TIME_ZONE, demo: true,
        };
        // All validation + mutation + receipt creation is synchronous: one atomic in-process commit.
        record.booking = booking;
        const result = complete('booked', { uiAction: 'booked', booking });
        try { this.log(BOOKING_TODO, { ...booking }); } catch { /* Logging cannot undo a committed booking. */ }
        return result;
      }
      case 'follow_customer':
        if (!call.args.confirmed) throw new HttpError(400, 'Explicit following confirmation is required.');
        if (record.stage === 'watching') throw new HttpError(409, 'Following is unavailable while a movie is playing.');
        if (record.following === call.args.destination) {
          return { ok: true, stage: record.stage, destination: record.following, message: FOLLOW_MESSAGE, replayed: true };
        }
        record.following = call.args.destination;
        return { ok: true, stage: record.stage, uiAction: 'follow_customer', destination: record.following, message: FOLLOW_MESSAGE };
      case 'stop_following':
        record.following = undefined;
        return { ok: true, stage: record.stage, uiAction: 'stop_following' };
      case 'ask_vehicle_expert': {
        let pending = record.expertCalls.get(key);
        if (!pending) {
          pending = this.provider.askExpert(call.args.question, call.args.deepReasoning, record.controller.signal);
          record.expertCalls.set(key, pending);
        }
        const answer = await pending;
        this.store.assertActive(record);
        return { ok: true, stage: record.stage, answer };
      }
    }
  }
}