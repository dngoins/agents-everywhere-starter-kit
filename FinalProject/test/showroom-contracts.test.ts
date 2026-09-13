import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AppointmentDraftSchema, ShowroomActionSchema, ShowroomContractError,
  StudioSelectionSchema, assertExpectedRevision, assertPendingConfirmation,
  type PendingAction,
} from '../src/contracts/showroom.js';
import { BRIDGE_LIMITS, BridgeCommandSchema, BridgeLeaseSchema } from '../src/contracts/bridge.js';

const id = '11111111-1111-4111-8111-111111111111';
const now = 1_800_000_000_000;
const selection = {
  productId: 'model-y', templateId: 'DREAM_ROUTE', heroMode: 'LIKENESS',
  productionMode: 'reviewed-storyboard', videoProvider: 'google-veo', enableHeroVideo: true,
  storyFormat: 'four-shot', renderLayout: 'storyboard', movieDurationSeconds: null,
};
const pending: PendingAction = {
  pendingActionId: id, expectedRevision: 3, inputRevision: 2,
  confirmationFingerprint: 'a'.repeat(64), readback: 'Your name is Alex. Is that right?',
  expiresAt: now + 1000, kind: 'answer', payload: { field: 'visitor', value: { displayName: 'Alex' } },
};
const confirmation = {
  pendingActionId: id, confirmationFingerprint: 'a'.repeat(64), decision: 'approve' as const, channel: 'voice' as const,
};

test('showroom actions require optimistic concurrency as well as dedupe and reject extra fields', () => {
  const action = { schemaVersion: 1, eventId: id, expectedRevision: 0, type: 'studio_requested', payload: {} };
  assert.equal(ShowroomActionSchema.safeParse(action).success, true);
  assert.equal(ShowroomActionSchema.safeParse({ ...action, expectedRevision: undefined }).success, false);
  assert.equal(ShowroomActionSchema.safeParse({ ...action, providerToken: 'not-allowed' }).success, false);
  assert.throws(() => assertExpectedRevision(0, 1), ShowroomContractError);
});

test('confirmation binds exact pending action, current state, input revision, fingerprint and expiry', () => {
  assertPendingConfirmation(pending, confirmation, 3, 3, 2, now);
  for (const mutate of [
    { expectedRevision: 4 }, { inputRevision: 3 }, { confirmationFingerprint: 'b'.repeat(64) },
    { pendingActionId: '22222222-2222-4222-8222-222222222222' }, { expiresAt: now },
  ]) assert.throws(() => assertPendingConfirmation({ ...pending, ...mutate }, confirmation, 3, 3, 2, now), ShowroomContractError);
});

test('studio selection preserves real provider and production restrictions', () => {
  assert.equal(StudioSelectionSchema.safeParse(selection).success, true);
  assert.equal(StudioSelectionSchema.safeParse({ ...selection, productId: 'demo car' }).success, false);
  assert.equal(StudioSelectionSchema.safeParse({ ...selection, templateId: 'invented' }).success, false);
  assert.equal(StudioSelectionSchema.safeParse({ ...selection, productionMode: 'movie-first' }).success, false);
  assert.equal(StudioSelectionSchema.safeParse({ ...selection, movieDurationSeconds: 15 }).success, false);
});

test('calendar drafts bind all invitees and exactly sixty minutes including offset transitions', () => {
  const draft = {
    startTime: '2026-11-01T01:30:00-04:00', endTime: '2026-11-01T01:30:00-05:00',
    timeZone: 'America/New_York', attendees: ['visitor@example.com', 'staff@example.com'],
    subject: 'Model Y test drive', location: 'Showroom', productId: 'model-y', productName: 'Model Y',
  };
  assert.equal(AppointmentDraftSchema.safeParse(draft).success, true);
  assert.equal(AppointmentDraftSchema.safeParse({ ...draft, endTime: '2026-11-01T02:30:00-05:00' }).success, false);
  assert.equal(AppointmentDraftSchema.safeParse({ ...draft, timeZone: 'Invented/Zone' }).success, false);
  assert.equal(AppointmentDraftSchema.safeParse({ ...draft, attendees: ['VISITOR@example.com', 'visitor@example.com'] }).success, false);
});

test('motion has bounded pulses and fresh-command lifetime, no raw BLE or unbounded directions', () => {
  const base = {
    bridgeId: id, sessionId: id, leaseId: id, leaseGeneration: 1,
    commandId: id, sequence: 1, issuedAt: now, expiresAt: now + BRIDGE_LIMITS.maxCommandLifetimeMs,
    type: 'motion', intent: 'reverse_for_half_body', speed: 'low', pulseMs: 500,
    tracking: { capturedAt: new Date(now).toISOString(), confidence: 0.9, personCount: 1, goal: 'half_body', centerX: 0.5, centerY: 0.5, bodyOccupancy: 0.7 },
  };
  assert.equal(BridgeCommandSchema.safeParse(base).success, true);
  for (const mutate of [{ pulseMs: 501 }, { speed: 'high' }, { intent: 'forward' }, { sequence: 0 },
    { expiresAt: now + 2001 }, { expiresAt: now }, { bytes: [1, 2] }]) {
    assert.equal(BridgeCommandSchema.safeParse({ ...base, ...mutate }).success, false);
  }
  const lease = { bridgeId: id, sessionId: id, leaseId: id, generation: 1, issuedAt: now, expiresAt: now + 30_000, operatorArmed: true, rearClearanceConfirmed: true };
  assert.equal(BridgeLeaseSchema.safeParse(lease).success, true);
  assert.equal(BridgeLeaseSchema.safeParse({ ...lease, expiresAt: now + 30_001 }).success, false);
});
