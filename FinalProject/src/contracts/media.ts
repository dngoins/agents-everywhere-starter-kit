import { z } from "zod";
import { AdBriefSchema, StartMediaJobInputSchema } from "./index.js";

export const MediaSubmitRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: z.uuid(),
  idempotencyKey: StartMediaJobInputSchema.shape.idempotencyKey,
  brief: AdBriefSchema,
  image: z.strictObject({
    mimeType: z.enum(["image/png", "image/jpeg"]),
    base64: z.string().min(1).max(7_000_000),
  }),
}).refine((request) => request.idempotencyKey === request.jobId, "The renderer idempotency key must equal the globally unique MagicPitch job ID.");
export const MediaAcceptanceSchema = z.object({
  providerJobId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
});
export const MediaCapabilitiesSchema = z.object({
  schemaVersion: z.literal(1),
  cancelByKey: z.literal(true),
  deleteAssets: z.literal(true),
});
export const MediaCancellationSchema = z.object({
  status: z.literal("cancelled"),
  assetsDeleted: z.literal(true),
});
export const MediaServiceStatusSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["queued", "running"]),
    stage: z.enum(["accepted", "preparing", "generating", "rendering", "encoding", "finalizing"]).optional(),
  }),
  z.object({
    status: z.literal("ready"),
    result: z.object({
      assetPath: z.string().regex(/^assets\/[A-Za-z0-9_-]+\.mp4$/),
      mimeType: z.literal("video/mp4"),
      durationSeconds: z.number().positive().max(30),
    }),
  }),
  z.object({ status: z.literal("failed") }),
]);

export type MediaSubmitRequest = z.infer<typeof MediaSubmitRequestSchema>;
export type MediaAcceptance = z.infer<typeof MediaAcceptanceSchema>;
export type MediaServiceStatus = z.infer<typeof MediaServiceStatusSchema>;
export type MediaCapabilities = z.infer<typeof MediaCapabilitiesSchema>;
export type MediaCancellation = z.infer<typeof MediaCancellationSchema>;
