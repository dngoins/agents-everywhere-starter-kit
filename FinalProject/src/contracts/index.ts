import { z } from 'zod';

export const SessionStateSchema = z.enum([
  'awaiting_consent', 'identified', 'context_ready', 'brief_ready',
  'media_pending', 'media_ready', 'revealed', 'cancelled',
]);
export const JobStatusSchema = z.enum(['queued', 'running', 'ready', 'failed', 'cancelled', 'expired']);
export const ConsentInputSchema = z.strictObject({
  personalization: z.boolean(),
  capture: z.boolean(),
  enrichment: z.boolean(),
});
export const ConsentRecordSchema = ConsentInputSchema.extend({
  consentId: z.uuid(),
  policyVersion: z.literal(1),
  recordedAt: z.number().finite(),
});
export const CustomerProfileSchema = z.strictObject({
  customerId: z.enum(['demo-alex', 'demo-sam']),
  displayName: z.enum(['Alex', 'Sam']),
  method: z.enum(['manual', 'qr', 'enrolled']),
  synthetic: z.literal(true),
});
const preference = z.string().trim().min(1).max(200);
const publicUrl = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'An HTTPS profile URL without credentials is required.');
export const ContextInputSchema = z.strictObject({
  preferences: z.array(preference).max(20),
  profileUrl: publicUrl.optional(),
});
export const ProfileResultSchema = z.strictObject({
  preferences: z.array(preference).max(20),
  citations: z.array(publicUrl).max(10),
  provenance: z.enum(['demo', 'provided_profile', 'exa', 'unavailable']),
  warnings: z.array(z.string().max(300)).max(10),
  evidence: z.array(z.strictObject({
    url: publicUrl,
    excerpt: z.string().max(1000),
  })).max(5).optional(),
});
export const CustomerContextSchema = ContextInputSchema.extend({
  revision: z.number().int().positive(),
  source: z.literal('conversation'),
  profile: ProfileResultSchema.optional(),
});
export const ProductSchema = z.strictObject({
  productId: z.literal('demo-car'),
  name: z.string().min(1).max(100),
  facts: z.array(z.string().min(1).max(200)).min(1).max(10),
  templateId: z.literal('demo-car-v1'),
  maxDurationSeconds: z.literal(30),
  callToAction: z.string().min(1).max(200),
});
export const AdBriefSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  sessionId: z.uuid(),
  customerId: z.enum(['demo-alex', 'demo-sam']),
  productId: z.literal('demo-car'),
  contextRevision: z.number().int().positive(),
  objective: z.string().min(1).max(500),
  audiencePreferences: z.array(preference).max(20),
  scenes: z.array(z.strictObject({
    durationSeconds: z.number().positive().max(30),
    visual: z.string().min(1).max(1000),
    onScreenText: z.string().min(1).max(300),
  })).min(1).max(10),
  callToAction: z.string().min(1).max(200),
  templateId: z.literal('demo-car-v1'),
  durationSeconds: z.number().positive().max(30),
  provenance: z.enum(['mock', 'generated']),
}).refine((brief) => Math.abs(
  brief.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) - brief.durationSeconds,
) < 0.001, 'Scene durations must match the total duration.');
export const MediaResultSchema = z.strictObject({
  assetId: z.uuid(),
  mimeType: z.literal('video/mp4'),
  provenance: z.enum(['generated', 'mock_fixture', 'prerendered_fallback']),
  durationSeconds: z.number().positive().max(30),
  byteLength: z.number().int().positive(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export const MediaJobSchema = z.strictObject({
  jobId: z.uuid(),
  briefId: z.uuid(),
  status: JobStatusSchema,
  stage: z.string(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  deadline: z.number().finite(),
  attempts: z.number().int().nonnegative(),
  result: MediaResultSchema.optional(),
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
  warnings: z.array(z.string()),
});
const eventBase = { schemaVersion: z.literal(1), eventId: z.uuid() };
export const SessionEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...eventBase, type: z.literal('customer_detected'), payload: z.strictObject({}) }),
  z.strictObject({ ...eventBase, type: z.literal('consent_recorded'), payload: ConsentInputSchema }),
  z.strictObject({ ...eventBase, type: z.literal('context_updated'), payload: ContextInputSchema }),
  z.strictObject({ ...eventBase, type: z.literal('media_revealed'), payload: z.strictObject({ jobId: z.uuid() }) }),
  z.strictObject({ ...eventBase, type: z.literal('session_cancelled'), payload: z.strictObject({}) }),
]);
export const IdentifyCustomerInputSchema = z.strictObject({
  customerId: z.string().min(1).max(64),
  method: z.enum(['manual', 'qr', 'enrolled']),
});
export const EnrichProfileInputSchema = z.strictObject({});
export const CreateAdBriefInputSchema = z.strictObject({ productId: z.literal('demo-car') });
export const StartMediaJobInputSchema = z.strictObject({
  briefId: z.uuid(),
  idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
});
export const GetMediaStatusInputSchema = z.strictObject({ jobId: z.uuid() });
export const ScheduleFollowupInputSchema = z.strictObject({});
export const CommandSchemas = {
  identify_customer: IdentifyCustomerInputSchema,
  enrich_profile: EnrichProfileInputSchema,
  create_ad_brief: CreateAdBriefInputSchema,
  start_media_job: StartMediaJobInputSchema,
  get_media_status: GetMediaStatusInputSchema,
  schedule_followup: ScheduleFollowupInputSchema,
} as const;

export type SessionState = z.infer<typeof SessionStateSchema>;
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;
export type CustomerProfile = z.infer<typeof CustomerProfileSchema>;
export type CustomerContext = z.infer<typeof CustomerContextSchema>;
export type ProfileResult = z.infer<typeof ProfileResultSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type AdBrief = z.infer<typeof AdBriefSchema>;
export type MediaJob = z.infer<typeof MediaJobSchema>;
export type MediaResult = z.infer<typeof MediaResultSchema>;
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface OutputEvent {
  schemaVersion: 1;
  eventId: string;
  type: string;
  revision: number;
  receivedAt: number;
  payload: { [key: string]: JsonValue };
}
export interface SessionSnapshot {
  sessionId: string;
  serverInstanceId: string;
  state: SessionState;
  revision: number;
  expiresAt: number;
  consent?: ConsentRecord;
  customer?: CustomerProfile;
  context?: CustomerContext;
  brief?: AdBrief;
  jobs: MediaJob[];
  events: OutputEvent[];
  resetRequired?: boolean;
  acknowledgement?: { eventId: string; revision: number };
}

export const DEMO_PRODUCT: Readonly<Product> = Object.freeze({
  productId: 'demo-car',
  name: 'MagicPitch concept car',
  facts: ['Synthetic demonstration vehicle', 'Personalized concept preview'],
  templateId: 'demo-car-v1',
  maxDurationSeconds: 30,
  callToAction: 'Ask the team about this concept.',
});
