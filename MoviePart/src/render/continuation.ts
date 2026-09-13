import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import sharp from "sharp";
import { assetSchema, MovieError, videoArtifactSchema, type VideoArtifact } from "../domain";
import type { GenerationContext, MovieConfig } from "../domain/services";
import { buildBookendExtractionArguments, buildHeroArguments } from "./arguments";
import { probeMedia, validateRenderedMedia } from "./probe";
import { runMediaCommand, throwIfRenderCancelled } from "./process";

function localPath(path: string): boolean {
  return isAbsolute(path) && !path.startsWith("\\\\") && !path.startsWith("//") && !/[\0\r\n]/.test(path);
}

export async function requireOwnedVideo(
  config: MovieConfig, clip: VideoArtifact, context: GenerationContext,
): Promise<{ path: string; hasAudio: boolean }> {
  throwIfRenderCancelled(context.signal);
  if (!videoArtifactSchema.safeParse(clip).success || !assetSchema.shape.id.safeParse(context.jobId).success
    || !context.ownerId.trim()) {
    throw new MovieError("INVALID_RENDER_INPUT", "An approved video and valid job are required.", 400);
  }
  const parsed = assetSchema.safeParse(await context.media.getAsset(clip.assetId));
  if (!parsed.success || parsed.data.id !== clip.assetId || parsed.data.ownerId !== context.ownerId
    || parsed.data.jobId !== context.jobId || parsed.data.kind !== "video" || parsed.data.mime !== "video/mp4") {
    throw new MovieError("ASSET_NOT_FOUND", "The generated clip must be an MP4 owned by this job.", 404);
  }
  const configuredRoot = resolve(config.dataDir);
  const managedPath = await context.media.assetPath(clip.assetId);
  if (!localPath(configuredRoot) || !localPath(managedPath) || (await lstat(managedPath)).isSymbolicLink()) {
    throw new MovieError("RENDER_FAILED", "Generated clips must be managed local media files.");
  }
  const root = await realpath(configuredRoot);
  const path = await realpath(managedPath);
  const location = relative(root, path);
  if (!localPath(path) || !location || isAbsolute(location) || location === ".." || location.startsWith(`..${sep}`)) {
    throw new MovieError("RENDER_FAILED", "Generated clips must remain inside the private data directory.");
  }
  const file = await stat(path);
  if (!file.isFile() || file.size < 1 || file.size > 100 * 1024 * 1024 || file.size !== parsed.data.bytes) {
    throw new MovieError("RENDER_FAILED", "A generated clip has an invalid file size.");
  }
  const probe = await probeMedia(config.ffprobePath ?? ffprobeStatic.path, path, context.signal);
  if (!probe.formatName?.split(",").includes("mp4") || probe.videoStreamCount !== 1 || !probe.video
    || probe.video.durationSeconds === null || probe.video.durationSeconds < 7.999) {
    throw new MovieError("RENDER_INVALID_OUTPUT", "Each generated clip must contain eight full seconds of readable video.");
  }
  return { path, hasAudio: probe.audioStreamCount > 0 };
}

export async function normalizeVideoClip(
  ffmpeg: string, ffprobe: string, source: string, output: string,
  clip: VideoArtifact, context: GenerationContext,
): Promise<void> {
  const timeline = { shotIds: [clip.shotId], heroShotId: clip.shotId, durations: [8], durationSeconds: 8 };
  await runMediaCommand(ffmpeg, buildHeroArguments(source, output, timeline, false), {
    signal: context.signal, label: "FFmpeg clip normalization", timeoutMs: 120_000,
  });
  validateRenderedMedia(await probeMedia(ffprobe, output, context.signal, true), false, timeline);
}

export async function createContinuationReference(
  config: MovieConfig, clip: VideoArtifact, context: GenerationContext,
): Promise<string> {
  const ffmpeg = config.ffmpegPath ?? ffmpegStatic;
  const ffprobe = config.ffprobePath ?? ffprobeStatic.path;
  if (!ffmpeg || [ffmpeg, ffprobe].some(path => !path.trim() || /[\0\r\n]/.test(path)
    || path.startsWith("\\\\") || path.startsWith("//") || /^[a-z]+:\/\//i.test(path))) {
    throw new MovieError("RENDERER_UNAVAILABLE", "Local FFmpeg and ffprobe executables are required.");
  }
  let directory: string | undefined;
  try {
    const source = await requireOwnedVideo(config, clip, context);
    const root = join(await realpath(resolve(config.dataDir)), "continuation-tmp");
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) {
      throw new MovieError("RENDER_FAILED", "The continuation work directory cannot be redirected.");
    }
    directory = join(root, `${context.jobId}-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    const normalized = join(directory, "normalized.mp4");
    await normalizeVideoClip(ffmpeg, ffprobe, source.path, normalized, clip, context);
    const imagePath = join(directory, "continuation.png");
    await runMediaCommand(ffmpeg, buildBookendExtractionArguments(normalized, imagePath, "closing"), {
      signal: context.signal, label: "FFmpeg continuation reference", timeoutMs: 60_000,
    });
    const file = await stat(imagePath);
    if (file.size < 1 || file.size > 10 * 1024 * 1024) {
      throw new MovieError("RENDER_INVALID_OUTPUT", "The continuation image exceeds its size limit.");
    }
    const bytes = await readFile(imagePath);
    const image = sharp(bytes, { limitInputPixels: 1280 * 720, failOn: "warning", animated: true }).timeout({ seconds: 10 });
    try {
      const metadata = await image.metadata();
      if (metadata.format !== "png" || metadata.width !== 1280 || metadata.height !== 720 || (metadata.pages ?? 1) !== 1) {
        throw new MovieError("RENDER_INVALID_OUTPUT", "The continuation reference must be a single 1280×720 PNG.");
      }
      await image.raw().toBuffer();
    } finally {
      image.destroy();
    }
    throwIfRenderCancelled(context.signal);
    const asset = await context.media.saveAsset({
      ownerId: context.ownerId, jobId: context.jobId, kind: "storyboard", mime: "image/png",
      bytes, width: 1280, height: 720,
    });
    return asset.id;
  } catch (error) {
    if (error instanceof MovieError) throw error;
    throw new MovieError("RENDER_FAILED", "Local continuation reference extraction failed. Check the generated clip and private data directory.");
  } finally {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        await context.warn("Private continuation intermediates could not all be removed; local cleanup is required.");
      }
    }
  }
}
