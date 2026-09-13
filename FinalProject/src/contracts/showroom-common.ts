import { z } from 'zod';

export const ShowroomRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ShowroomTimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ConfirmationFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ShowroomMutationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: z.uuid(),
  expectedRevision: ShowroomRevisionSchema,
});
export const ApprovalReferenceSchema = z.strictObject({
  pendingActionId: z.uuid(),
  confirmationFingerprint: ConfirmationFingerprintSchema,
});
export const ActionConfirmationSchema = ApprovalReferenceSchema.extend({
  decision: z.enum(['approve', 'reject']),
  channel: z.enum(['voice', 'touch']),
});
export const ShowroomConsentInputSchema = z.strictObject({
  policyVersion: z.string().trim().min(1).max(80),
  personalization: z.boolean(),
  capture: z.boolean(),
  likeness: z.boolean(),
  providerTransfer: z.boolean(),
  calendar: z.boolean(),
  motion: z.boolean(),
});
export const ShowroomConsentRecordSchema = ShowroomConsentInputSchema.extend({
  consentId: z.uuid(),
  inputRevision: ShowroomRevisionSchema,
  recordedAt: ShowroomTimestampSchema,
}).readonly();
export const SessionVisitorSchema = z.strictObject({
  visitorId: z.uuid(),
  sessionId: z.uuid(),
  source: z.literal('self_reported'),
  displayName: z.string().trim().min(1).max(80),
}).readonly();
export const ShowroomErrorSchema = z.strictObject({
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(500),
}).readonly();

export type ShowroomMutation = z.infer<typeof ShowroomMutationSchema>;
export type ApprovalReference = z.infer<typeof ApprovalReferenceSchema>;
export type ActionConfirmation = z.infer<typeof ActionConfirmationSchema>;
export type ShowroomConsentInput = z.infer<typeof ShowroomConsentInputSchema>;
export type ShowroomConsentRecord = z.infer<typeof ShowroomConsentRecordSchema>;
export type SessionVisitor = z.infer<typeof SessionVisitorSchema>;

export class ShowroomContractError extends Error {
  constructor(public readonly code: 'REVISION_CONFLICT' | 'APPROVAL_MISMATCH' | 'APPROVAL_EXPIRED' | 'INVALID_STUDIO_INPUT', message: string) {
    super(message);
    this.name = 'ShowroomContractError';
  }
}

export function assertExpectedRevision(expectedRevision: number, currentRevision: number): void {
  ShowroomRevisionSchema.parse(expectedRevision);
  ShowroomRevisionSchema.parse(currentRevision);
  if (expectedRevision !== currentRevision) {
    throw new ShowroomContractError('REVISION_CONFLICT', 'Refresh the session before submitting this action.');
  }
}
