import { z } from 'zod';
import { ShowroomRevisionSchema, ShowroomTimestampSchema } from './showroom-common.js';

export const BRIDGE_LIMITS = Object.freeze({
  maxPulseMs: 500,
  maxCommandLifetimeMs: 2_000,
  maxLeaseMs: 30_000,
  watchdogMs: 1_000,
  maxCumulativePulseMs: 2_000,
  maxPulseCount: 4,
  cooldownMs: 1_000,
  trackingFreshnessMs: 1_000,
});
export const BridgeRegistrationInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
  platform: z.literal('windows-chrome'),
});
export const BridgePairingSchema = z.strictObject({
  bridgeId: z.uuid(),
  pairingCode: z.string().regex(/^[A-Z0-9]{8}$/),
  expiresAt: ShowroomTimestampSchema,
});
export const BridgePairInputSchema = z.strictObject({
  pairingCode: BridgePairingSchema.shape.pairingCode,
});
export const BridgeCredentialSchema = z.strictObject({
  bridgeId: z.uuid(),
  bridgeToken: z.string().min(24).max(256),
  role: z.literal('bridge'),
  expiresAt: ShowroomTimestampSchema,
});
export const OperatorPairingSchema = z.strictObject({
  bridgeId: z.uuid(),
  operatorCode: z.string().regex(/^[A-Z0-9]{8}$/),
  expiresAt: ShowroomTimestampSchema,
});
export const OperatorPairInputSchema = z.strictObject({
  operatorCode: OperatorPairingSchema.shape.operatorCode,
});
export const OperatorCredentialSchema = z.strictObject({
  bridgeId: z.uuid(),
  operatorToken: z.string().min(24).max(256),
  role: z.literal('operator'),
  purpose: z.literal('bridge:lease'),
  expiresAt: ShowroomTimestampSchema,
});
export const BridgeLeaseInputSchema = z.strictObject({
  eventId: z.uuid(),
  sessionId: z.uuid(),
  expectedGeneration: ShowroomRevisionSchema,
  operatorArmed: z.literal(true),
  rearClearanceConfirmed: z.literal(true),
});
export const BridgeLeaseSchema = z.strictObject({
  bridgeId: z.uuid(),
  sessionId: z.uuid(),
  leaseId: z.uuid(),
  generation: ShowroomRevisionSchema.refine((value) => value > 0),
  issuedAt: ShowroomTimestampSchema,
  expiresAt: ShowroomTimestampSchema,
  operatorArmed: z.literal(true),
  rearClearanceConfirmed: z.literal(true),
}).refine((lease) => lease.expiresAt > lease.issuedAt && lease.expiresAt - lease.issuedAt <= BRIDGE_LIMITS.maxLeaseMs,
  'A bridge lease must expire within 30 seconds.').readonly();
export const FramingTrackingSchema = z.strictObject({
  capturedAt: z.iso.datetime({ offset: true }),
  confidence: z.number().min(0).max(1),
  personCount: z.literal(1),
  goal: z.literal('half_body'),
  centerX: z.number().min(0).max(1),
  centerY: z.number().min(0).max(1),
  bodyOccupancy: z.number().min(0).max(1),
}).readonly();
export const MotionIntentSchema = z.strictObject({
  intent: z.literal('reverse_for_half_body'),
  speed: z.literal('low'),
  pulseMs: z.number().int().positive().max(BRIDGE_LIMITS.maxPulseMs),
  leaseId: z.uuid(),
  leaseGeneration: ShowroomRevisionSchema.refine((value) => value > 0),
  tracking: FramingTrackingSchema,
});
export const MotionApprovalSchema = MotionIntentSchema.omit({ tracking: true }).readonly();
export const MotionGrantSchema = z.strictObject({
  grantId: z.uuid(),
  sessionId: z.uuid(),
  inputRevision: ShowroomRevisionSchema,
  expiresAt: ShowroomTimestampSchema,
  intent: MotionApprovalSchema,
  maxPulseCount: z.literal(4),
  maxCumulativePulseMs: z.literal(2000),
}).readonly();
export const MotionExecutionRequestSchema = z.strictObject({
  grantId: z.uuid(),
  tracking: FramingTrackingSchema,
});
export const StopIntentSchema = z.strictObject({
  reason: z.enum(['user', 'operator', 'watchdog', 'lease_expired', 'session_ended', 'disconnect', 'playback']),
});
const commandBase = {
  commandId: z.uuid(),
  bridgeId: z.uuid(),
  sessionId: z.uuid(),
  leaseId: z.uuid(),
  leaseGeneration: ShowroomRevisionSchema.refine((value) => value > 0),
  sequence: ShowroomRevisionSchema.refine((value) => value > 0),
  issuedAt: ShowroomTimestampSchema,
  expiresAt: ShowroomTimestampSchema,
};
export const BridgeCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...commandBase, type: z.literal('motion'),
    intent: z.literal('reverse_for_half_body'), speed: z.literal('low'),
    pulseMs: MotionIntentSchema.shape.pulseMs,
    tracking: FramingTrackingSchema,
  }),
  z.strictObject({ ...commandBase, type: z.literal('stop'), reason: StopIntentSchema.shape.reason }),
]).refine((command) => command.expiresAt > command.issuedAt &&
  command.expiresAt - command.issuedAt <= BRIDGE_LIMITS.maxCommandLifetimeMs,
'Commands must expire within two seconds.');
export const BridgeAcknowledgementSchema = z.strictObject({
  commandId: z.uuid(),
  leaseId: z.uuid(),
  leaseGeneration: ShowroomRevisionSchema.refine((value) => value > 0),
  sequence: ShowroomRevisionSchema.refine((value) => value > 0),
  status: z.enum(['write_completed', 'stop_written', 'rejected']),
  physicalExecution: z.literal('unverified'),
  reason: z.enum(['completed', 'stop', 'expired', 'stale_generation', 'out_of_order', 'not_armed', 'disconnected', 'write_failed']),
  at: ShowroomTimestampSchema,
});
export const BridgeHeartbeatSchema = z.strictObject({
  leaseId: z.uuid().nullable(),
  leaseGeneration: ShowroomRevisionSchema,
  lastSequence: ShowroomRevisionSchema,
  connected: z.boolean(),
  foreground: z.boolean(),
  stopped: z.boolean(),
  at: ShowroomTimestampSchema,
});
export const BridgeCommandBatchSchema = z.strictObject({
  commands: z.array(BridgeCommandSchema).max(20),
  serverTime: ShowroomTimestampSchema,
});
export const BridgeStatusSchema = z.strictObject({
  bridgeId: z.uuid(),
  connected: z.boolean(),
  armed: z.boolean(),
  stopped: z.boolean(),
  leaseGeneration: ShowroomRevisionSchema,
  leaseId: z.uuid().nullable(),
  leaseExpiresAt: ShowroomTimestampSchema.nullable(),
  lastHeartbeatAt: ShowroomTimestampSchema.nullable(),
});
export const BridgeClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('authenticate'), bridgeToken: BridgeCredentialSchema.shape.bridgeToken }),
  z.strictObject({ type: z.literal('heartbeat'), heartbeat: BridgeHeartbeatSchema }),
  z.strictObject({ type: z.literal('acknowledgement'), acknowledgement: BridgeAcknowledgementSchema }),
]);
export const BridgeServerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('state'), bridgeId: z.uuid(),
    generation: ShowroomRevisionSchema, lastSequence: ShowroomRevisionSchema,
    lease: BridgeLeaseSchema.nullable(), serverTime: ShowroomTimestampSchema,
  }),
  z.strictObject({ type: z.literal('command'), command: BridgeCommandSchema }),
  z.strictObject({ type: z.literal('heartbeat'), serverTime: ShowroomTimestampSchema }),
]);

export type BridgeRegistrationInput = z.infer<typeof BridgeRegistrationInputSchema>;
export type BridgePairing = z.infer<typeof BridgePairingSchema>;
export type BridgePairInput = z.infer<typeof BridgePairInputSchema>;
export type BridgeCredential = z.infer<typeof BridgeCredentialSchema>;
export type OperatorPairing = z.infer<typeof OperatorPairingSchema>;
export type OperatorPairInput = z.infer<typeof OperatorPairInputSchema>;
export type OperatorCredential = z.infer<typeof OperatorCredentialSchema>;
export type BridgeLeaseInput = z.infer<typeof BridgeLeaseInputSchema>;
export type BridgeLease = z.infer<typeof BridgeLeaseSchema>;
export type MotionIntent = z.infer<typeof MotionIntentSchema>;
export type MotionApproval = z.infer<typeof MotionApprovalSchema>;
export type MotionGrant = z.infer<typeof MotionGrantSchema>;
export type MotionExecutionRequest = z.infer<typeof MotionExecutionRequestSchema>;
export type FramingTracking = z.infer<typeof FramingTrackingSchema>;
export type StopIntent = z.infer<typeof StopIntentSchema>;
export type BridgeCommand = z.infer<typeof BridgeCommandSchema>;
export type BridgeAcknowledgement = z.infer<typeof BridgeAcknowledgementSchema>;
export type BridgeHeartbeat = z.infer<typeof BridgeHeartbeatSchema>;
export type BridgeCommandBatch = z.infer<typeof BridgeCommandBatchSchema>;
export type BridgeStatus = z.infer<typeof BridgeStatusSchema>;
export type BridgeClientMessage = z.infer<typeof BridgeClientMessageSchema>;
export type BridgeServerMessage = z.infer<typeof BridgeServerMessageSchema>;
