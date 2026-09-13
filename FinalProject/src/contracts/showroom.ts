import { z } from 'zod';
import {
  ActionConfirmationSchema, ConfirmationFingerprintSchema, SessionVisitorSchema,
  ShowroomConsentInputSchema, ShowroomConsentRecordSchema, ShowroomContractError,
  ShowroomErrorSchema, ShowroomMutationSchema, ShowroomRevisionSchema, ShowroomTimestampSchema,
  assertExpectedRevision, type ActionConfirmation,
} from './showroom-common.js';
import {
  AcceptedStudioSnapshotSchema, ApprovedContextSchema, CaptureSetSchema,
  StudioInputSchema, StudioProductIdSchema, StudioSelectionSchema, StudioStatusSchema,
} from './studio.js';
import {
  BridgeStatusSchema, MotionApprovalSchema, MotionExecutionRequestSchema, MotionGrantSchema, StopIntentSchema,
} from './bridge.js';

export * from './showroom-common.js';
export * from './studio.js';

export const KioskPairingInputSchema = z.strictObject({});
export const KioskPairingSchema = z.strictObject({
  pairingCode: z.string().regex(/^[A-Z0-9]{8}$/),
  expiresAt: ShowroomTimestampSchema,
});
export const KioskPairExchangeSchema = z.strictObject({
  pairingCode: KioskPairingSchema.shape.pairingCode,
});
export const ShowroomSessionCreatedSchema = z.strictObject({
  sessionId: z.uuid(),
  sessionToken: z.string().min(24).max(256),
  serverInstanceId: z.uuid(),
  expiresAt: ShowroomTimestampSchema,
});
export const ShowroomAnswerSchema = z.discriminatedUnion('field', [
  z.strictObject({ field: z.literal('visitor'), value: z.strictObject({ displayName: SessionVisitorSchema.unwrap().shape.displayName }) }),
  z.strictObject({ field: z.literal('context'), value: ApprovedContextSchema }),
  z.strictObject({ field: z.literal('selection'), value: StudioSelectionSchema }),
]);
export const AppointmentDraftSchema = z.strictObject({
  startTime: z.iso.datetime({ offset: true }),
  endTime: z.iso.datetime({ offset: true }),
  timeZone: z.string().min(1).max(100).refine((value) => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; }
    catch (error) { if (error instanceof RangeError) return false; throw error; }
  }, 'Use an IANA time zone.'),
  attendees: z.array(z.email().max(254)).min(1).max(20).readonly(),
  subject: z.string().trim().min(1).max(200),
  location: z.string().trim().min(1).max(500),
  productId: StudioProductIdSchema,
  productName: z.string().trim().min(1).max(200),
}).superRefine((draft, context) => {
  if (Date.parse(draft.endTime) - Date.parse(draft.startTime) !== 60 * 60 * 1000) {
    context.addIssue({ code: 'custom', message: 'Appointments must last exactly 60 minutes.' });
  }
  if (new Set(draft.attendees.map((email) => email.toLowerCase())).size !== draft.attendees.length) {
    context.addIssue({ code: 'custom', message: 'Invitees must be unique.' });
  }
}).readonly();
export const CalendarDraftSchema = z.strictObject({
  draftId: z.uuid(),
  inputRevision: ShowroomRevisionSchema,
  appointment: AppointmentDraftSchema,
}).readonly();
export const CalendarDraftProposalSchema = z.strictObject({
  startTime: AppointmentDraftSchema.unwrap().shape.startTime,
  customerEmail: z.email().max(254),
});
const pendingBase = {
  pendingActionId: z.uuid(),
  expectedRevision: ShowroomRevisionSchema,
  inputRevision: ShowroomRevisionSchema,
  confirmationFingerprint: ConfirmationFingerprintSchema,
  readback: z.string().trim().min(1).max(4000),
  expiresAt: ShowroomTimestampSchema,
};
export const PendingActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...pendingBase, kind: z.literal('answer'), payload: ShowroomAnswerSchema }),
  z.strictObject({ ...pendingBase, kind: z.literal('consent'), payload: ShowroomConsentInputSchema }),
  z.strictObject({ ...pendingBase, kind: z.literal('studio'), payload: StudioInputSchema }),
  z.strictObject({ ...pendingBase, kind: z.literal('calendar'), payload: CalendarDraftSchema }),
  z.strictObject({ ...pendingBase, kind: z.literal('motion'), payload: MotionApprovalSchema }),
]);
export const PlaybackEventSchema = z.strictObject({
  jobId: z.uuid(),
  assetId: z.uuid(),
  playbackId: z.uuid(),
});
export const ShowroomActionSchema = z.discriminatedUnion('type', [
  ShowroomMutationSchema.extend({ type: z.literal('answer_proposed'), payload: ShowroomAnswerSchema }),
  ShowroomMutationSchema.extend({ type: z.literal('action_confirmed'), payload: ActionConfirmationSchema }),
  ShowroomMutationSchema.extend({ type: z.literal('consent_recorded'), payload: ShowroomConsentInputSchema }),
  ShowroomMutationSchema.extend({ type: z.literal('capture_set_recorded'), payload: CaptureSetSchema }),
  ShowroomMutationSchema.extend({ type: z.literal('studio_requested'), payload: z.strictObject({}) }),
  ShowroomMutationSchema.extend({ type: z.literal('playback_started'), payload: PlaybackEventSchema }),
  ShowroomMutationSchema.extend({ type: z.literal('playback_ended'), payload: PlaybackEventSchema }),
  ShowroomMutationSchema.extend({ type: z.literal('calendar_draft_proposed'), payload: CalendarDraftProposalSchema }),
  ShowroomMutationSchema.extend({ type: z.literal('motion_requested'), payload: MotionApprovalSchema }),
  ShowroomMutationSchema.extend({ type: z.literal('motion_execution_requested'), payload: MotionExecutionRequestSchema }),
  ShowroomMutationSchema.extend({ type: z.literal('stop_requested'), payload: StopIntentSchema }),
]);
export const CalendarStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('idle') }),
  z.strictObject({ status: z.literal('draft'), draft: CalendarDraftSchema }),
  z.strictObject({ status: z.literal('submitting'), draftId: z.uuid(), confirmationId: z.uuid() }),
  z.strictObject({
    status: z.literal('scheduled'), draftId: z.uuid(), confirmationId: z.uuid(),
    eventId: z.string().min(1).max(1024), invitationStatus: z.literal('sent'),
  }),
  z.strictObject({ status: z.enum(['failed', 'uncertain']), draftId: z.uuid(), error: ShowroomErrorSchema }),
]);
export const PlaybackStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('idle') }),
  z.strictObject({ status: z.enum(['playing', 'ended']), ...PlaybackEventSchema.shape }),
]);
export const ShowroomSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.enum(['studio', 'fixture']),
  sessionId: z.uuid(),
  serverInstanceId: z.uuid(),
  revision: ShowroomRevisionSchema,
  inputRevision: ShowroomRevisionSchema,
  expiresAt: ShowroomTimestampSchema,
  state: z.enum(['intake', 'capture', 'review', 'producing', 'playback', 'followup', 'cancelled']),
  visitor: SessionVisitorSchema.nullable(),
  consent: ShowroomConsentRecordSchema.nullable(),
  context: ApprovedContextSchema.nullable(),
  selection: StudioSelectionSchema.nullable(),
  captureSet: CaptureSetSchema.nullable(),
  pendingAction: PendingActionSchema.nullable(),
  acceptedStudio: AcceptedStudioSnapshotSchema.nullable(),
  studio: StudioStatusSchema,
  playback: PlaybackStatusSchema,
  calendar: CalendarStatusSchema,
  bridge: BridgeStatusSchema.nullable(),
  motionGrant: MotionGrantSchema.nullable(),
  acknowledgement: z.strictObject({ eventId: z.uuid(), revision: ShowroomRevisionSchema }).optional(),
});
export const ShowroomCatalogSchema = z.strictObject({
  mode: z.enum(['studio', 'fixture']),
  products: z.array(z.strictObject({ id: StudioProductIdSchema, name: z.string().min(1).max(200), ready: z.boolean() })).max(100),
  templates: z.array(z.strictObject({ id: StudioSelectionSchema.unwrap().shape.templateId, name: z.string().min(1).max(200) })).max(20),
  videoProviders: z.array(z.strictObject({ id: StudioSelectionSchema.unwrap().shape.videoProvider.unwrap(), available: z.boolean() })).max(10),
  workerAvailable: z.boolean(),
  rendererAvailable: z.boolean(),
});
export const ShowroomReferenceUploadQuerySchema = z.strictObject({
  expectedRevision: ShowroomRevisionSchema,
  eventId: z.uuid(),
});
export const ShowroomReferenceUploadedSchema = z.strictObject({
  assetId: z.uuid(),
  snapshot: ShowroomSnapshotSchema,
});
export const ShowroomSdpSchema = z.string().min(1).max(128 * 1024)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 128 * 1024 && /^v=0(?:\r?\n|$)/.test(value),
    'Invalid SDP offer or answer.');
export const ShowroomVoiceSetupInputSchema = z.strictObject({
  sdp: ShowroomSdpSchema,
  generation: ShowroomRevisionSchema.optional(),
});
export const ShowroomVoiceSetupSchema = z.strictObject({
  sessionId: z.uuid(),
  generation: ShowroomRevisionSchema,
  session: z.strictObject({ id: z.string().min(1).max(512) }),
  transport: z.strictObject({ type: z.literal('webrtc'), sdp: ShowroomSdpSchema }),
});

export type KioskPairing = z.infer<typeof KioskPairingSchema>;
export type KioskPairExchange = z.infer<typeof KioskPairExchangeSchema>;
export type ShowroomSessionCreated = z.infer<typeof ShowroomSessionCreatedSchema>;
export type ShowroomAnswer = z.infer<typeof ShowroomAnswerSchema>;
export type AppointmentDraft = z.infer<typeof AppointmentDraftSchema>;
export type CalendarDraft = z.infer<typeof CalendarDraftSchema>;
export type CalendarDraftProposal = z.infer<typeof CalendarDraftProposalSchema>;
export type PendingAction = z.infer<typeof PendingActionSchema>;
export type PlaybackEvent = z.infer<typeof PlaybackEventSchema>;
export type ShowroomAction = z.infer<typeof ShowroomActionSchema>;
export type CalendarStatus = z.infer<typeof CalendarStatusSchema>;
export type ShowroomSnapshot = z.infer<typeof ShowroomSnapshotSchema>;
export type ShowroomCatalog = z.infer<typeof ShowroomCatalogSchema>;
export type ShowroomReferenceUploadQuery = z.infer<typeof ShowroomReferenceUploadQuerySchema>;
export type ShowroomReferenceUploaded = z.infer<typeof ShowroomReferenceUploadedSchema>;
export type ShowroomVoiceSetupInput = z.infer<typeof ShowroomVoiceSetupInputSchema>;
export type ShowroomVoiceSetup = z.infer<typeof ShowroomVoiceSetupSchema>;

export function assertPendingConfirmation(
  pendingInput: PendingAction, confirmationInput: ActionConfirmation,
  expectedRevision: number, currentRevision: number, inputRevision: number, now: number,
): void {
  const pending = PendingActionSchema.parse(pendingInput);
  const confirmation = ActionConfirmationSchema.parse(confirmationInput);
  ShowroomTimestampSchema.parse(now);
  ShowroomRevisionSchema.parse(inputRevision);
  assertExpectedRevision(expectedRevision, currentRevision);
  if (pending.expectedRevision !== currentRevision || pending.inputRevision !== inputRevision ||
      pending.pendingActionId !== confirmation.pendingActionId ||
      pending.confirmationFingerprint !== confirmation.confirmationFingerprint) {
    throw new ShowroomContractError('APPROVAL_MISMATCH', 'The approval does not match the current readback and inputs.');
  }
  if (pending.expiresAt <= now) {
    throw new ShowroomContractError('APPROVAL_EXPIRED', 'The approval expired; request a new readback.');
  }
}
