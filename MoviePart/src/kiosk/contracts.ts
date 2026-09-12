import type {
  AdBrief, ApiErrorResponse, AssetUploaded, CustomerProfile, MediaJob, MediaResult,
  SessionCreated, SessionSnapshot,
} from "../../integration/dwight/types";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 1000, min = 1): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max;
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min;
const oneOf = (value: unknown, values: readonly unknown[]) => values.includes(value);
const strings = (value: unknown, maxItems = 20, maxLength = 200): value is string[] =>
  Array.isArray(value) && value.length <= maxItems && value.every(item => text(item, maxLength));

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(value);
}

export function isToken(value: unknown): value is string {
  return text(value, 256, 24) && /^[\x21-\x7e]+$/.test(value);
}

export function isSessionCreated(value: unknown): value is SessionCreated {
  return record(value) && isUuid(value.sessionId) && isUuid(value.serverInstanceId) && isToken(value.sessionToken);
}

export function isCustomer(value: unknown): value is CustomerProfile {
  return record(value) && oneOf(value.customerId, ["demo-alex", "demo-sam"]) &&
    oneOf(value.displayName, ["Alex", "Sam"]) && oneOf(value.method, ["manual", "qr", "enrolled"]) &&
    value.synthetic === true;
}

export function isBrief(value: unknown): value is AdBrief {
  if (!record(value)) return false;
  return value.schemaVersion === 1 && isUuid(value.id) && isUuid(value.sessionId) &&
    oneOf(value.customerId, ["demo-alex", "demo-sam"]) && value.productId === "demo-car" &&
    integer(value.contextRevision, 1) && text(value.objective, 500) && strings(value.audiencePreferences) &&
    text(value.callToAction, 200) && value.templateId === "demo-car-v1" &&
    number(value.durationSeconds) && value.durationSeconds > 0 && value.durationSeconds <= 30 &&
    oneOf(value.provenance, ["mock", "generated"]) && Array.isArray(value.scenes) &&
    value.scenes.length > 0 && value.scenes.length <= 10 && value.scenes.every(scene =>
      record(scene) && number(scene.durationSeconds) && scene.durationSeconds > 0 &&
      scene.durationSeconds <= 30 && text(scene.visual, 1000) && text(scene.onScreenText, 300)) &&
    Math.abs(value.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) - value.durationSeconds) < 0.001;
}

export function isResult(value: unknown): value is MediaResult {
  return record(value) && isUuid(value.assetId) && value.mimeType === "video/mp4" &&
    oneOf(value.provenance, ["generated", "mock_fixture", "prerendered_fallback"]) &&
    number(value.durationSeconds) && value.durationSeconds > 0 && value.durationSeconds <= 30 &&
    integer(value.byteLength, 1) && typeof value.checksum === "string" && /^[a-f0-9]{64}$/.test(value.checksum);
}

export function isJob(value: unknown): value is MediaJob {
  return record(value) && isUuid(value.jobId) && isUuid(value.briefId) &&
    oneOf(value.status, ["queued", "running", "ready", "failed", "cancelled", "expired"]) &&
    text(value.stage, 1000, 0) && number(value.createdAt) && number(value.updatedAt) &&
    number(value.deadline) && integer(value.attempts) && strings(value.warnings, 100, 2000) &&
    (value.result === undefined || isResult(value.result)) &&
    (value.error === undefined || (record(value.error) && text(value.error.code) && text(value.error.message, 2000)));
}

export function isSnapshot(value: unknown): value is SessionSnapshot {
  if (!record(value)) return false;
  const consent = value.consent;
  const context = value.context;
  const ack = value.acknowledgement;
  return isUuid(value.sessionId) && isUuid(value.serverInstanceId) && integer(value.revision) &&
    number(value.expiresAt) && oneOf(value.state, [
      "awaiting_consent", "identified", "context_ready", "brief_ready", "media_pending", "media_ready", "revealed", "cancelled",
    ]) && (consent === undefined || (record(consent) && typeof consent.personalization === "boolean" &&
      typeof consent.capture === "boolean" && typeof consent.enrichment === "boolean" &&
      isUuid(consent.consentId) && consent.policyVersion === 1 && number(consent.recordedAt))) &&
    (value.customer === undefined || isCustomer(value.customer)) &&
    (context === undefined || (record(context) && strings(context.preferences) &&
      integer(context.revision, 1) && context.source === "conversation")) &&
    (value.brief === undefined || (isBrief(value.brief) && value.brief.sessionId === value.sessionId)) &&
    Array.isArray(value.jobs) && value.jobs.every(isJob) &&
    Array.isArray(value.events) && value.events.every(event => record(event) &&
      event.schemaVersion === 1 && isUuid(event.eventId) && text(event.type) &&
      integer(event.revision, 1) && number(event.receivedAt) && record(event.payload)) &&
    (value.resetRequired === undefined || typeof value.resetRequired === "boolean") &&
    (ack === undefined || (record(ack) && isUuid(ack.eventId) && integer(ack.revision, 1)));
}

export function isAssetUploaded(value: unknown): value is AssetUploaded {
  return record(value) && isUuid(value.assetId);
}

export function parseApiErrorResponse(value: unknown): ApiErrorResponse | undefined {
  if (!record(value) || !record(value.error)) return undefined;
  const error = value.error;
  return text(error.code, 200) && text(error.message, 2000) && isUuid(error.requestId)
    ? { error: { code: error.code, message: error.message, requestId: error.requestId } }
    : undefined;
}
