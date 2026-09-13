import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import sharp from "sharp";
import {
  assetSchema, getTimeline, MovieError, moviePlanSchema, renderResultSchema,
  type MoviePlan, type RenderResult, type StoryboardFrame,
} from "../domain";
import type { GenerationContext, MovieConfig } from "../domain/services";
import { mediaCommandPath } from "./paths";
import { probeMedia, validateRenderedMedia } from "./probe";
import { runMediaCommand, throwIfRenderCancelled } from "./process";

const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;
const FRAME_RATE = 24;

function localPath(path: string): boolean {
  return isAbsolute(path) && !path.startsWith("\\\\") && !path.startsWith("//") && !/[\0\r\n]/.test(path);
}

function localExecutable(path: string | null): path is string {
  return Boolean(path?.trim() && !/[\0\r\n]/.test(path)
    && !path.startsWith("\\\\") && !path.startsWith("//") && !/^[a-z]+:\/\//i.test(path));
}

async function moviePath(
  dataRoot: string, movie: RenderResult, context: GenerationContext,
): Promise<string> {
  const parsed = assetSchema.safeParse(await context.media.getAsset(movie.assetId));
  if (!parsed.success || parsed.data.id !== movie.assetId
    || parsed.data.ownerId !== context.ownerId || parsed.data.jobId !== context.jobId
    || parsed.data.kind !== "video" || parsed.data.mime !== "video/mp4") {
    throw new MovieError("ASSET_NOT_FOUND", "A finished MP4 owned by this job is required.", 404);
  }
  const managedPath = await context.media.assetPath(movie.assetId);
  if (!localPath(managedPath) || (await lstat(managedPath)).isSymbolicLink()) {
    throw new MovieError("RENDER_INVALID_OUTPUT", "The finished movie must be a managed local media file.");
  }
  const path = await realpath(managedPath);
  const location = relative(dataRoot, path);
  if (!localPath(path) || !location || isAbsolute(location) || location === ".." || location.startsWith(`..${sep}`)) {
    throw new MovieError("RENDER_INVALID_OUTPUT", "The finished movie must remain inside the private data directory.");
  }
  const file = await stat(path);
  if (!file.isFile() || file.size < 1 || file.size > 100 * 1024 * 1024 || file.size !== parsed.data.bytes) {
    throw new MovieError("RENDER_INVALID_OUTPUT", "The finished movie has an invalid file size.");
  }
  return path;
}

async function createWorkDirectory(dataRoot: string, jobId: string): Promise<string> {
  const root = join(dataRoot, "storyboard-tmp");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) {
    throw new MovieError("RENDER_FAILED", "The storyboard work directory cannot be redirected.");
  }
  const directory = join(root, `${jobId}-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

async function readFrame(path: string, signal: AbortSignal): Promise<Buffer> {
  throwIfRenderCancelled(signal);
  const file = await stat(path);
  if (!file.isFile() || file.size < 1 || file.size > MAX_FRAME_BYTES) {
    throw new MovieError("RENDER_INVALID_OUTPUT", "An extracted storyboard image exceeds the PNG size limit.");
  }
  const bytes = await readFile(path);
  if (!bytes.length || bytes.length > MAX_FRAME_BYTES) {
    throw new MovieError("RENDER_INVALID_OUTPUT", "An extracted storyboard image exceeds the PNG size limit.");
  }
  throwIfRenderCancelled(signal);
  const image = sharp(bytes, {
    limitInputPixels: FRAME_WIDTH * FRAME_HEIGHT, failOn: "warning", animated: true,
  }).timeout({ seconds: 10 });
  try {
    const metadata = await image.metadata();
    if (metadata.format !== "png" || metadata.width !== FRAME_WIDTH || metadata.height !== FRAME_HEIGHT
      || (metadata.pages ?? 1) !== 1) {
      throw new MovieError("RENDER_INVALID_OUTPUT", "The extracted storyboard image must be a single 1280×720 PNG.");
    }
    throwIfRenderCancelled(signal);
    await image.raw().toBuffer();
  } catch (error) {
    if (error instanceof MovieError) throw error;
    throw new MovieError("RENDER_INVALID_OUTPUT", "An extracted storyboard PNG could not be decoded.");
  } finally {
    image.destroy();
  }
  throwIfRenderCancelled(signal);
  return bytes;
}

export async function extractStoryboard(
  config: MovieConfig, plan: MoviePlan, movie: RenderResult, context: GenerationContext,
): Promise<StoryboardFrame[]> {
  throwIfRenderCancelled(context.signal);
  if (!moviePlanSchema.safeParse(plan).success || !renderResultSchema.safeParse(movie).success
    || !assetSchema.shape.id.safeParse(context.jobId).success || !context.ownerId.trim()) {
    throw new MovieError("INVALID_STORYBOARD_EXTRACTION_INPUT", "Storyboard extraction requires a valid plan, job, and finished movie.", 400);
  }
  const timeline = getTimeline(plan.storyFormat, plan.templateId);
  if (movie.durationSeconds !== timeline.durationSeconds) {
    throw new MovieError("RENDER_INVALID_OUTPUT", "The finished movie must match the planned timeline.");
  }
  const ffmpeg = config.ffmpegPath ?? ffmpegStatic;
  const ffprobe = config.ffprobePath ?? ffprobeStatic.path;
  if (!localExecutable(ffmpeg) || !localExecutable(ffprobe)) {
    throw new MovieError("RENDERER_UNAVAILABLE", "Local FFmpeg and ffprobe executables are required for storyboard extraction.");
  }
  let directory: string | undefined;
  try {
    const configuredRoot = resolve(config.dataDir);
    if (!localPath(configuredRoot)) {
      throw new MovieError("RENDER_FAILED", "Storyboard extraction requires a local private data directory.");
    }
    const dataRoot = await realpath(configuredRoot);
    if (!localPath(dataRoot)) {
      throw new MovieError("RENDER_FAILED", "Storyboard extraction requires a local private data directory.");
    }
    const source = await moviePath(dataRoot, movie, context);
    throwIfRenderCancelled(context.signal);
    validateRenderedMedia(await probeMedia(ffprobe, source, context.signal, true), movie.hasAudio, timeline);
    throwIfRenderCancelled(context.signal);
    directory = await createWorkDirectory(dataRoot, context.jobId);
    const frames: StoryboardFrame[] = [];
    let startSeconds = 0;
    for (const shot of plan.shots) {
      throwIfRenderCancelled(context.signal);
      const endSeconds = startSeconds + shot.durationSeconds;
      const frameIndex = Math.round((startSeconds + shot.durationSeconds / 2) * FRAME_RATE);
      const extractedAtSeconds = frameIndex / FRAME_RATE;
      if (extractedAtSeconds < startSeconds || extractedAtSeconds >= endSeconds
        || extractedAtSeconds >= timeline.durationSeconds) {
        throw new MovieError("INVALID_STORYBOARD_EXTRACTION_INPUT", "A storyboard sample falls outside its planned shot.", 400);
      }
      await context.report({
        stage: "EXTRACTING_STORYBOARD", provider: "FFmpeg", shotId: shot.id,
        message: `Extracting the finished movie's ${shot.id} frame at ${extractedAtSeconds} seconds; no continuity approval is performed.`,
      });
      const output = join(directory, `${shot.id}.png`);
      // Select by decoded frame number rather than keyframe seeking so the
      // recorded 24fps timestamp identifies the exact frame saved below.
      await runMediaCommand(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-protocol_whitelist", "file,pipe", "-threads", "2", "-i", mediaCommandPath(source),
        "-map", "0:v:0", "-an", "-sn", "-dn",
        "-vf", `select=eq(n\\,${frameIndex}),scale=${FRAME_WIDTH}:${FRAME_HEIGHT},setsar=1`,
        "-frames:v", "1", "-fps_mode", "passthrough", "-c:v", "png", "-threads", "1",
        "-f", "image2", "-update", "1", mediaCommandPath(output),
      ], { signal: context.signal, label: "FFmpeg storyboard extraction", timeoutMs: 60_000 });
      const bytes = await readFrame(output, context.signal);
      throwIfRenderCancelled(context.signal);
      const asset = await context.media.saveAsset({
        ownerId: context.ownerId, jobId: context.jobId, kind: "storyboard", mime: "image/png",
        bytes, width: FRAME_WIDTH, height: FRAME_HEIGHT,
      });
      const frame: StoryboardFrame = {
        shotId: shot.id, assetId: asset.id,
        continuity: {
          verdict: "NOT_REVIEWED",
          reasons: ["Extracted from the finished movie; not a continuity approval."],
          confidence: 0,
        },
        provider: "FFmpeg", model: "frame-extraction", source: "extracted", extractedAtSeconds,
      };
      await context.saveFrame(frame);
      frames.push(frame);
      throwIfRenderCancelled(context.signal);
      startSeconds = endSeconds;
    }
    return frames;
  } catch (error) {
    if (error instanceof MovieError) throw error;
    throw new MovieError("RENDER_FAILED", "Finished-movie storyboard extraction failed. Check local media and the private data directory.");
  } finally {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        await context.warn("The job's private storyboard extraction intermediates could not all be removed; local cleanup is required.");
      }
    }
  }
}
