import { createHash } from "node:crypto";
import type { MediaProvider } from "./interfaces.js";

const prerecordedDemoProviders = new WeakSet<MediaProvider>();

export const DEMO_MEDIA = Object.freeze({
  filename: "default-demo.mp4",
  durationSeconds: 10,
  provenance: "prerendered_fallback",
  bytes: 4_273_110,
  sha256: "69674967b142a7cd9f121df4aac8bb90d2f24274bae5d45d8841b5a337d41773",
} as const);

export function validateDemoMedia(bytes: Uint8Array, maxBytes: number = DEMO_MEDIA.bytes): void {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength !== DEMO_MEDIA.bytes || bytes.byteLength > maxBytes
      || header.toString("ascii", 4, 8) !== "ftyp"
      || createHash("sha256").update(bytes).digest("hex") !== DEMO_MEDIA.sha256) {
    throw new Error("The user-provided default-demo.mp4 is invalid or exceeds MAX_MEDIA_BYTES. Restore the documented asset.");
  }
}

export function createPrerecordedDemoProvider(bytes: Uint8Array, maxBytes: number = DEMO_MEDIA.bytes): MediaProvider {
  validateDemoMedia(bytes, maxBytes);
  const fixture = Uint8Array.from(bytes);
  const provider = Object.freeze<MediaProvider>({
    name: "mock",
    async generate(_input, signal, progress) {
      signal.throwIfAborted();
      progress("rendering");
      return {
        bytes: Uint8Array.from(fixture), mimeType: "video/mp4",
        provenance: DEMO_MEDIA.provenance, durationSeconds: DEMO_MEDIA.durationSeconds,
      };
    },
  });
  prerecordedDemoProviders.add(provider);
  return provider;
}

export function isPrerecordedDemoProvider(provider: MediaProvider): boolean {
  return prerecordedDemoProviders.has(provider);
}
