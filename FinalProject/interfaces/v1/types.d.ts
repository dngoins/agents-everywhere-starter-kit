// Generated from the executable MagicPitch v1 contracts. Do not edit.
// Type-only, dependency-free: safe to copy into a TypeScript client.

export type SessionState = "awaiting_consent" | "identified" | "context_ready" | "brief_ready" | "media_pending" | "media_ready" | "revealed" | "cancelled";

export type ConsentRecord = { personalization: boolean; capture: boolean; enrichment: boolean; consentId: string; policyVersion: 1; recordedAt: number; };

export type CustomerProfile = { customerId: "demo-alex" | "demo-sam"; displayName: "Alex" | "Sam"; method: "manual" | "qr" | "enrolled"; synthetic: true; };

export type CustomerContext = { preferences: string[]; revision: number; source: "conversation"; profileUrl?: string | undefined; profile?: { preferences: string[]; citations: string[]; provenance: "demo" | "provided_profile" | "exa" | "unavailable"; warnings: string[]; evidence?: { url: string; excerpt: string; }[] | undefined; } | undefined; };

export type ProfileResult = { preferences: string[]; citations: string[]; provenance: "demo" | "provided_profile" | "exa" | "unavailable"; warnings: string[]; evidence?: { url: string; excerpt: string; }[] | undefined; };

export type Product = { productId: "demo-car"; name: string; facts: string[]; templateId: "demo-car-v1"; maxDurationSeconds: 30; callToAction: string; };

export type AdBrief = { schemaVersion: 1; id: string; sessionId: string; customerId: "demo-alex" | "demo-sam"; productId: "demo-car"; contextRevision: number; objective: string; audiencePreferences: string[]; scenes: { durationSeconds: number; visual: string; onScreenText: string; }[]; callToAction: string; templateId: "demo-car-v1"; durationSeconds: number; provenance: "mock" | "generated"; };

export type MediaJob = { jobId: string; briefId: string; status: "cancelled" | "queued" | "running" | "ready" | "failed" | "expired"; stage: string; createdAt: number; updatedAt: number; deadline: number; attempts: number; warnings: string[]; result?: { assetId: string; mimeType: "video/mp4"; provenance: "generated" | "mock_fixture" | "prerendered_fallback"; durationSeconds: number; byteLength: number; checksum: string; } | undefined; error?: { code: string; message: string; } | undefined; };

export type MediaResult = { assetId: string; mimeType: "video/mp4"; provenance: "generated" | "mock_fixture" | "prerendered_fallback"; durationSeconds: number; byteLength: number; checksum: string; };

export type SessionEvent = { type: "customer_detected"; payload: Record<string, never>; schemaVersion: 1; eventId: string; } | { type: "consent_recorded"; payload: { personalization: boolean; capture: boolean; enrichment: boolean; }; schemaVersion: 1; eventId: string; } | { type: "context_updated"; payload: { preferences: string[]; profileUrl?: string | undefined; }; schemaVersion: 1; eventId: string; } | { type: "media_revealed"; payload: { jobId: string; }; schemaVersion: 1; eventId: string; } | { type: "session_cancelled"; payload: Record<string, never>; schemaVersion: 1; eventId: string; };

export type JsonValue = string | number | boolean | JsonValue[] | { [key: string]: JsonValue; } | null;

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

export type MediaSubmitRequest = { schemaVersion: 1; jobId: string; idempotencyKey: string; brief: { schemaVersion: 1; id: string; sessionId: string; customerId: "demo-alex" | "demo-sam"; productId: "demo-car"; contextRevision: number; objective: string; audiencePreferences: string[]; scenes: { durationSeconds: number; visual: string; onScreenText: string; }[]; callToAction: string; templateId: "demo-car-v1"; durationSeconds: number; provenance: "mock" | "generated"; }; image: { mimeType: "image/png" | "image/jpeg"; base64: string; }; };

export type MediaAcceptance = { providerJobId: string; };

export type MediaServiceStatus = { status: "queued" | "running"; stage?: "accepted" | "preparing" | "generating" | "rendering" | "encoding" | "finalizing" | undefined; } | { status: "ready"; result: { assetPath: string; mimeType: "video/mp4"; durationSeconds: number; }; } | { status: "failed"; };

export type MediaCapabilities = { schemaVersion: 1; cancelByKey: true; deleteAssets: true; };

export type MediaCancellation = { status: "cancelled"; assetsDeleted: true; };

export type SessionCreated = { sessionId: string; sessionToken: string; serverInstanceId: string; };

export type AssetUploaded = { assetId: string; };

export type ApiErrorResponse = { error: { code: string; message: string; requestId: string; }; };

export interface BriefInput {
  briefId: string;
  sessionId: string;
  customer: CustomerProfile;
  context: CustomerContext;
  product: Product;
}

export interface BriefProvider {
  name: string;
  create(input: BriefInput, signal: AbortSignal): Promise<AdBrief>;
}

export interface ProfileInput {
  sessionId: string;
  customer: CustomerProfile;
  context: CustomerContext;
}

export interface ProfileProvider {
  name: string;
  enrich(input: ProfileInput, signal: AbortSignal): Promise<ProfileResult>;
}

export interface MediaInput {
  jobId: string;
  idempotencyKey: string;
  brief: AdBrief;
  image: { bytes: Uint8Array; mimeType: string };
}

export interface MediaOutput {
  bytes: Uint8Array;
  mimeType: 'video/mp4';
  provenance: 'generated' | 'mock_fixture' | 'prerendered_fallback';
  durationSeconds: number;
}

export interface MediaProvider {
  name: string;
  generate(input: MediaInput, signal: AbortSignal, progress: (stage: string) => void): Promise<MediaOutput>;
}
