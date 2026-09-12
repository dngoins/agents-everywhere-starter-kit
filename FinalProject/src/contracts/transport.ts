import { z } from "zod";
import {
  AdBriefSchema, ConsentRecordSchema, CustomerContextSchema, CustomerProfileSchema,
  MediaJobSchema, SessionStateSchema,
  type OutputEvent, type SessionSnapshot,
} from "./index.js";

export const SessionCreatedSchema = z.strictObject({
  sessionId: z.uuid(), sessionToken: z.string().min(24).max(256), serverInstanceId: z.uuid(),
});
export const AssetUploadedSchema = z.strictObject({ assetId: z.uuid() });
export const ApiErrorResponseSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string(), requestId: z.uuid() }),
});
export const OutputEventSchema = z.strictObject({
  schemaVersion: z.literal(1), eventId: z.uuid(), type: z.string(),
  revision: z.number().int().positive(), receivedAt: z.number(),
  payload: z.record(z.string(), z.json()),
}) satisfies z.ZodType<OutputEvent>;
export const SessionSnapshotSchema = z.strictObject({
  sessionId: z.uuid(), serverInstanceId: z.uuid(), state: SessionStateSchema,
  revision: z.number().int().nonnegative(), expiresAt: z.number(),
  consent: ConsentRecordSchema.optional(), customer: CustomerProfileSchema.optional(),
  context: CustomerContextSchema.optional(), brief: AdBriefSchema.optional(),
  jobs: z.array(MediaJobSchema), events: z.array(OutputEventSchema),
  resetRequired: z.boolean().optional(),
  acknowledgement: z.strictObject({ eventId: z.uuid(), revision: z.number().int().positive() }).optional(),
}) satisfies z.ZodType<SessionSnapshot>;

export type SessionCreated = z.infer<typeof SessionCreatedSchema>;
export type AssetUploaded = z.infer<typeof AssetUploadedSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
