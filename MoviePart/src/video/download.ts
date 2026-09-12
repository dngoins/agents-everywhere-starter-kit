import { MovieError } from "../domain";

const API_HOST = "generativelanguage.googleapis.com";
const DOWNLOAD_HOSTS = new Set([API_HOST, "storage.googleapis.com"]);
export const MAX_VIDEO_BYTES = 80 * 1024 * 1024;

export async function downloadVeoVideo(uri: string, apiKey: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<Uint8Array> {
  let url = new URL(uri);
  if (url.hostname !== API_HOST) throw new MovieError("VIDEO_DOWNLOAD_REJECTED", "Veo returned an unexpected download host.");
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    if (url.protocol !== "https:" || url.port || url.username || url.password || !DOWNLOAD_HOSTS.has(url.hostname)) {
      throw new MovieError("VIDEO_DOWNLOAD_REJECTED", "Veo returned an unsupported download URL.");
    }
    const response = await request(url, {
      signal, redirect: "manual",
      headers: url.hostname === API_HOST ? { "x-goog-api-key": apiKey } : {},
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) break;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body || !/^(video\/mp4|application\/octet-stream)(;|$)/i.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel();
      throw new MovieError("VIDEO_DOWNLOAD_FAILED", "Veo did not return an MP4 download.");
    }
    if (Number(response.headers.get("content-length") ?? 0) > MAX_VIDEO_BYTES) {
      await response.body.cancel();
      throw new MovieError("VIDEO_DOWNLOAD_FAILED", "The Veo clip exceeds the download limit.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > MAX_VIDEO_BYTES) throw new MovieError("VIDEO_DOWNLOAD_FAILED", "The Veo clip exceeds the download limit.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (length === 0) throw new MovieError("VIDEO_DOWNLOAD_FAILED", "The Veo clip is empty.");
    return Buffer.concat(chunks);
  }
  throw new MovieError("VIDEO_DOWNLOAD_REJECTED", "Veo download exceeded the allowed redirect count.");
}
