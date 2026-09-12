import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { normalizeImage } from "../server/media";
import type { MediaSubmitRequest } from "../../integration/dwight/types";

export const MAX_BODY_BYTES = 7_100_000;
export const MAX_ASSET_BYTES = 50 * 1024 * 1024;
export const uuid = z.uuid();
export const briefSchema = z.object({
  schemaVersion: z.literal(1),
  id: uuid,
  sessionId: uuid,
  customerId: z.enum(["demo-alex", "demo-sam"]),
  productId: z.literal("demo-car"),
  contextRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  objective: z.string().min(1).max(500),
  audiencePreferences: z.array(z.string().min(1).max(200)).max(20),
  scenes: z.array(z.object({
    durationSeconds: z.number().positive().max(30),
    visual: z.string().min(1).max(1000),
    onScreenText: z.string().min(1).max(300),
  }).strict()).min(1).max(10),
  callToAction: z.string().min(1).max(200),
  templateId: z.literal("demo-car-v1"),
  durationSeconds: z.number().positive().max(30),
  provenance: z.enum(["mock", "generated"]),
}).strict().refine(brief =>
  Math.abs(brief.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) - brief.durationSeconds) < 1e-6,
"Scene durations must sum to the total.");

export const submissionSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: uuid,
  idempotencyKey: uuid,
  brief: briefSchema,
  image: z.object({
    mimeType: z.enum(["image/png", "image/jpeg"]),
    base64: z.string().min(1).max(7_000_000),
  }).strict(),
}).strict();

export class ServiceError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseSubmission(value: unknown, header: string | undefined): MediaSubmitRequest {
  const parsed = submissionSchema.safeParse(value);
  if (!parsed.success || header !== parsed.data.jobId || header !== parsed.data.idempotencyKey) {
    throw new ServiceError(400, "INVALID_SUBMISSION");
  }
  return parsed.data;
}

export function fingerprint(input: MediaSubmitRequest): string {
  return createHash("sha256").update(canonical(input)).digest("hex");
}

export async function decodeParticipantImage(input: MediaSubmitRequest["image"]): Promise<Buffer> {
  if (input.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) {
    throw new ServiceError(400, "INVALID_IMAGE");
  }
  const bytes = Buffer.from(input.base64, "base64");
  if (!bytes.length || bytes.length > 5_250_000 || bytes.toString("base64") !== input.base64) {
    throw new ServiceError(400, "INVALID_IMAGE");
  }
  try {
    const metadata = await sharp(bytes, { limitInputPixels: 25_000_000, animated: true }).metadata();
    if (metadata.format !== (input.mimeType === "image/png" ? "png" : "jpeg") || (metadata.pages ?? 1) !== 1) {
      throw new Error("Invalid image");
    }
    return (await normalizeImage(bytes)).bytes;
  } catch {
    throw new ServiceError(400, "INVALID_IMAGE");
  }
}
