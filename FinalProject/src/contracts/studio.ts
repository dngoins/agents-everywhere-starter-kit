import { z } from 'zod';
import {
  ConfirmationFingerprintSchema, SessionVisitorSchema, ShowroomConsentRecordSchema,
  ShowroomContractError, ShowroomErrorSchema, ShowroomRevisionSchema, ShowroomTimestampSchema,
} from './showroom-common.js';

export const StudioTemplateIdSchema = z.enum(['VELOCITY', 'TOMORROW_DRIVE', 'DREAM_ROUTE', 'HERO_OF_THE_DAY']);
export const StudioHeroModeSchema = z.enum(['LIKENESS', 'POV', 'PERSONALIZED']);
export const StudioProductionModeSchema = z.enum(['reviewed-storyboard', 'movie-first']);
export const StudioVideoProviderSchema = z.enum(['openai-sora', 'google-veo']);
export const StudioProductIdSchema = z.string().min(1).max(120).regex(/^[a-z0-9_-]+$/);
export const StudioSelectionSchema = z.strictObject({
  productId: StudioProductIdSchema,
  templateId: StudioTemplateIdSchema,
  heroMode: StudioHeroModeSchema,
  productionMode: StudioProductionModeSchema,
  videoProvider: StudioVideoProviderSchema.nullable(),
  enableHeroVideo: z.boolean(),
  storyFormat: z.enum(['four-shot', 'six-shot']),
  renderLayout: z.enum(['storyboard', 'video-bookends']),
  movieDurationSeconds: z.union([z.literal(13), z.literal(15), z.literal(18), z.literal(23), z.literal(28)]).nullable(),
}).superRefine((value, context) => {
  if (value.videoProvider !== null && (!value.enableHeroVideo || value.productionMode === 'movie-first')) {
    context.addIssue({ code: 'custom', message: 'A selected video provider requires reviewed storyboards and enabled hero video.' });
  }
  if (value.renderLayout === 'video-bookends' && (value.videoProvider === null || !value.enableHeroVideo || value.productionMode !== 'reviewed-storyboard')) {
    context.addIssue({ code: 'custom', message: 'Video bookends require reviewed storyboards and an explicit video provider.' });
  }
  if (value.movieDurationSeconds !== null && value.renderLayout !== 'video-bookends') {
    context.addIssue({ code: 'custom', message: 'Selectable duration requires video bookends.' });
  }
}).readonly();
export const ApprovedInterestSchema = z.strictObject({
  value: z.string().trim().min(1).max(100),
  source: z.enum(['manual', 'approved-research']),
  visualUseAllowed: z.literal(true),
  confidence: z.number().min(0).max(1).nullable(),
}).refine((value) => value.source !== 'manual' || value.confidence === null, 'Self-reported interests must not manufacture confidence.').readonly();
export const ApprovedContextSchema = z.strictObject({
  signals: z.array(ApprovedInterestSchema).max(3).readonly(),
  customerFirstName: z.string().trim().min(1).max(80).optional(),
  city: z.string().trim().min(1).max(120).optional(),
}).readonly();
export const CaptureViewSchema = z.enum(['front_face', 'half_body', 'profile', 'three_quarter']);
export const CaptureReferenceSchema = z.strictObject({
  assetId: z.uuid(),
  view: CaptureViewSchema,
}).readonly();
export const CaptureSetSchema = z.strictObject({
  captureSetId: z.uuid(),
  sessionId: z.uuid(),
  consentId: z.uuid(),
  inputRevision: ShowroomRevisionSchema,
  references: z.array(CaptureReferenceSchema).min(1).max(4).readonly(),
  primaryAssetId: z.uuid(),
}).superRefine((value, context) => {
  const ids = value.references.map((reference) => reference.assetId);
  if (new Set(ids).size !== ids.length || !ids.includes(value.primaryAssetId)) {
    context.addIssue({ code: 'custom', message: 'Capture assets must be unique and include the primary asset.' });
  }
  if (new Set(value.references.map((reference) => reference.view)).size !== value.references.length) {
    context.addIssue({ code: 'custom', message: 'Use at most one original photo for each capture view.' });
  }
}).readonly();
export const StudioInputSchema = z.strictObject({
  mode: z.literal('studio'),
  sessionId: z.uuid(),
  inputRevision: ShowroomRevisionSchema,
  visitor: SessionVisitorSchema,
  selection: StudioSelectionSchema,
  context: ApprovedContextSchema,
  consent: ShowroomConsentRecordSchema,
  captureSet: CaptureSetSchema.nullable(),
}).superRefine((value, context) => {
  if (value.visitor.sessionId !== value.sessionId) {
    context.addIssue({ code: 'custom', message: 'The visitor belongs to a different session.' });
  }
  if (!value.consent.personalization || !value.consent.providerTransfer || value.consent.inputRevision !== value.inputRevision) {
    context.addIssue({ code: 'custom', message: 'Current personalization and provider-transfer consent are required.' });
  }
  if (value.selection.heroMode === 'LIKENESS' && (!value.captureSet || !value.consent.likeness)) {
    context.addIssue({ code: 'custom', message: 'Likeness mode requires consent and a capture set.' });
  }
  if (value.captureSet && (!value.consent.capture ||
      value.captureSet.sessionId !== value.sessionId || value.captureSet.consentId !== value.consent.consentId ||
      value.captureSet.inputRevision !== value.inputRevision)) {
    context.addIssue({ code: 'custom', message: 'The capture set must match current session consent and input revision.' });
  }
}).readonly();
export const AcceptedStudioSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotId: z.uuid(),
  acceptedAt: ShowroomTimestampSchema,
  acceptedRevision: ShowroomRevisionSchema,
  pendingActionId: z.uuid(),
  confirmationFingerprint: ConfirmationFingerprintSchema,
  input: StudioInputSchema,
}).readonly();
export const StudioStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('idle') }),
  z.strictObject({
    status: z.enum(['queued', 'running', 'awaiting_review']),
    snapshotId: z.uuid(), jobId: z.uuid(), stage: z.string().min(1).max(100),
  }),
  z.strictObject({
    status: z.literal('ready'), snapshotId: z.uuid(), jobId: z.uuid(),
    assetId: z.uuid(), mimeType: z.literal('video/mp4'),
    durationSeconds: z.number().positive().max(300),
    byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    checksum: ConfirmationFingerprintSchema,
    provenance: z.enum(['generated', 'mock_fixture']),
  }),
  z.strictObject({
    status: z.enum(['failed', 'cancelled']), snapshotId: z.uuid(), jobId: z.uuid(),
    error: ShowroomErrorSchema,
  }),
]);

export type StudioSelection = z.infer<typeof StudioSelectionSchema>;
export type ApprovedContext = z.infer<typeof ApprovedContextSchema>;
export type CaptureSet = z.infer<typeof CaptureSetSchema>;
export type StudioInput = z.infer<typeof StudioInputSchema>;
export type AcceptedStudioSnapshot = z.infer<typeof AcceptedStudioSnapshotSchema>;
export type StudioStatus = z.infer<typeof StudioStatusSchema>;
export interface StudioAcceptanceContext {
  sessionId: string;
  inputRevision: number;
  consentId: string;
  ownedAssetIds: readonly string[];
  availableProductIds: readonly string[];
}

// Ownership/catalog membership are server facts, never client-supplied authorization flags.
export function parseAcceptedStudioSnapshot(input: unknown, authority: StudioAcceptanceContext): AcceptedStudioSnapshot {
  const parsed = AcceptedStudioSnapshotSchema.parse(input);
  const value = parsed.input;
  if (value.sessionId !== authority.sessionId || value.inputRevision !== authority.inputRevision ||
      value.consent.consentId !== authority.consentId ||
      !authority.availableProductIds.includes(value.selection.productId) ||
      value.captureSet?.references.some((reference) => !authority.ownedAssetIds.includes(reference.assetId))) {
    throw new ShowroomContractError('INVALID_STUDIO_INPUT', 'Studio input must use the current session, approved revision, consent, owned assets and available catalog product.');
  }
  return parsed;
}
