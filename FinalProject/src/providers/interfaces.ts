import type { AdBrief, CustomerContext, CustomerProfile, Product, ProfileResult } from '../contracts/index.js';

export type { AdBrief, ProfileResult } from '../contracts/index.js';
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
