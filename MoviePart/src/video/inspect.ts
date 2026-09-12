import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { z } from "zod";
import { MovieError, type ContinuityResult } from "../domain";
import type { GenerationContext, MovieConfig } from "../domain/services";
import { inspectContinuity } from "../continuity";
import type { OpenAITransport } from "../providers/openai/client";
import { loadOriginals, type LoadedReference } from "../references";
import type { FrameInput } from "../storyboard/compile";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const probeSchema = z.object({
  streams: z.array(z.object({
    codec_type: z.string(), width: z.number().optional(), height: z.number().optional(),
    duration: z.string().optional(),
  })),
  format: z.object({ duration: z.string() }),
});

function binary(configured: string | undefined, module: string, fallback: string): string {
  if (configured) return configured;
  try {
    const value: unknown = require(module);
    if (typeof value === "string") return value;
    const result = z.object({ path: z.string() }).safeParse(value);
    if (result.success) return result.data.path;
  } catch { /* A configured system executable is also supported. */ }
  return fallback;
}

export async function inspectVideo(
  config: MovieConfig,
  transport: OpenAITransport,
  input: FrameInput,
  assetId: string,
  context: GenerationContext,
): Promise<ContinuityResult> {
  context.signal.throwIfAborted();
  const path = await context.media.assetPath(assetId);
  const probe = await execute(binary(config.ffprobePath, "ffprobe-static", "ffprobe"), [
    "-v", "error", "-show_entries", "stream=codec_type,width,height,duration:format=duration", "-of", "json", path,
  ], { timeout: 30_000, maxBuffer: 1024 * 1024, signal: context.signal, windowsHide: true });
  const metadata = probeSchema.parse(JSON.parse(probe.stdout));
  const video = metadata.streams.find(stream => stream.codec_type === "video");
  const duration = Number(metadata.format.duration);
  if (!video?.width || !video.height || video.width * video.height > 25_000_000 ||
      !Number.isFinite(duration) || duration < 7.5 || duration > 8.5 ||
      Math.abs(video.width / video.height - 16 / 9) > 0.05) {
    throw new MovieError("INVALID_HERO_VIDEO", "Veo did not return a usable eight-second landscape video.");
  }
  const candidates: LoadedReference[] = [];
  for (const second of [0, 2, 4, 6, 7.4]) {
    const frame = await execute(binary(config.ffmpegPath, "ffmpeg-static", "ffmpeg"), [
      "-v", "error", "-ss", String(second), "-i", path,
      "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=960:-2", "-f", "image2pipe", "-c:v", "png", "pipe:1",
    ], { encoding: "buffer", timeout: 30_000, maxBuffer: 12 * 1024 * 1024, signal: context.signal, windowsHide: true });
    if (!frame.stdout.length) throw new MovieError("INVALID_HERO_VIDEO", "A Veo continuity sample could not be decoded.");
    candidates.push({
      assetId, kind: "supplement", origin: "generated", role: `Video sample at ${second}s`,
      mime: "image/png", bytes: frame.stdout,
    });
  }
  return inspectContinuity(config, transport, input, await loadOriginals(input.character, input.product, context, false, input.plan.heroMode), candidates, context);
}
