import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { MediaProvider } from "./interfaces.js";
import { fetchJson, ProviderFailure, responseBytes } from "./http-client.js";
import {
  MediaAcceptanceSchema, MediaServiceStatusSchema, MediaSubmitRequestSchema,
  MediaCapabilitiesSchema, MediaCancellationSchema,
} from "../contracts/media.js";

export function createHttpMediaProvider(
  baseUrl: string, token: string, maxBytes: number,
  cleanupDirectory = resolve(".runtime", "media-cleanup"),
): MediaProvider {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  return {
    name: "http",
    async generate(input, signal, progress) {
      const capabilities = MediaCapabilitiesSchema.safeParse(await fetchJson(new URL("capabilities", base), {
        headers: { authorization: `Bearer ${token}` },
      }, { signal, timeoutMs: 3_000 }));
      if (!capabilities.success) throw new ProviderFailure("MEDIA_CAPABILITIES_REQUIRED", "The renderer must support cancellation by job key and asset deletion before receiving participant data.");
      const submission = MediaSubmitRequestSchema.parse({
        schemaVersion: 1, jobId: input.jobId, idempotencyKey: input.jobId,
        brief: input.brief,
        image: { mimeType: input.image.mimeType, base64: Buffer.from(input.image.bytes).toString("base64") },
      });
      await mkdir(cleanupDirectory, { recursive: true, mode: 0o700 });
      const receipt = resolve(cleanupDirectory, `${input.jobId}.json`);
      // Persist only reconciliation metadata before transferring a participant image.
      await writeFile(receipt, JSON.stringify({ jobId: input.jobId, mediaBase: base.href, cleanupRequired: true }), { flag: "wx", mode: 0o600 });
      try {
        progress("accepted");
        const accepted = MediaAcceptanceSchema.safeParse(await fetchJson(new URL("jobs", base), {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": input.jobId },
          body: JSON.stringify(submission),
        }, { signal, timeoutMs: 3_000, effectful: true }));
        if (!accepted.success) throw new ProviderFailure("MEDIA_ACCEPTANCE_UNCERTAIN", "Media submission could not be reconciled. Do not automatically submit it again.", false, true);
        await writeFile(receipt, JSON.stringify({
          jobId: input.jobId, providerJobId: accepted.data.providerJobId, mediaBase: base.href, cleanupRequired: true,
        }), { mode: 0o600 });
        let retries = 0;
        while (true) {
          signal.throwIfAborted();
          let response: unknown;
          try {
            response = await fetchJson(new URL(`jobs/${accepted.data.providerJobId}`, base), {
              headers: { authorization: `Bearer ${token}` },
            }, { signal, timeoutMs: 3_000 });
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof ProviderFailure && error.retryable && retries++ < 1) {
              await delay(250, undefined, { signal });
              continue;
            }
            throw new ProviderFailure("MEDIA_STATUS_UNCERTAIN", "An accepted render could not be reconciled. Inspect the local cleanup receipt before submitting another job.", false, true);
          }
          const status = MediaServiceStatusSchema.safeParse(response);
          if (!status.success) throw new ProviderFailure("INVALID_MEDIA_STATUS", "Media service returned an invalid status.", false, true);
          if (status.data.status === "failed") throw new ProviderFailure("MEDIA_RENDER_FAILED", "The media service reported a failed render.");
          if (status.data.status === "ready") {
            let media: Response;
            try {
              media = await fetch(new URL(status.data.result.assetPath, base), {
                headers: { authorization: `Bearer ${token}` },
                redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
              });
            } catch {
              signal.throwIfAborted();
              throw new ProviderFailure("MEDIA_DOWNLOAD_FAILED", "The completed media could not be downloaded.");
            }
            if (!media.ok || media.headers.get("content-type")?.split(";")[0]?.trim() !== "video/mp4") {
              await media.body?.cancel();
              throw new ProviderFailure("MEDIA_DOWNLOAD_INVALID", "The completed asset is not an accessible MP4.");
            }
            return {
              bytes: await responseBytes(media, maxBytes), mimeType: "video/mp4",
              provenance: "generated", durationSeconds: status.data.result.durationSeconds,
            };
          }
          progress(status.data.stage ?? "rendering");
          await delay(500, undefined, { signal });
        }
      } finally {
        try {
          const cancelled = MediaCancellationSchema.safeParse(await fetchJson(new URL(`jobs/by-key/${input.jobId}`, base), {
            method: "DELETE", headers: { authorization: `Bearer ${token}` },
          }, { signal: new AbortController().signal, timeoutMs: 3_000, effectful: true }));
          if (!cancelled.success) throw new ProviderFailure("MEDIA_CLEANUP_UNCERTAIN", "Renderer cleanup was not acknowledged.", false, true);
          await unlink(receipt);
        } catch {
          console.error(JSON.stringify({ event: "media_cleanup_pending", jobId: input.jobId }));
          throw new ProviderFailure("MEDIA_CLEANUP_UNCERTAIN", "Remote cancellation/deletion is unconfirmed. Reconcile the ignored media-cleanup receipt before another render.", false, true);
        }
      }
    },
  };
}
