import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import {
  assetSchema, getMovieFormat, getRenderTimeline, getTimeline, MOVIE_DURATIONS, MovieError, moviePlanSchema, renderLayoutSchema,
  storyboardFrameSchema, videoArtifactSchema,
} from "../domain";
import type { GenerationContext, MovieConfig, RendererService } from "../domain/services";
import { buildAssemblyArguments, buildBookendExtractionArguments, buildHeroArguments, buildStillArguments } from "./arguments";
import { mediaCommandPath } from "./paths";
import { probeMedia, validateRenderedMedia } from "./probe";
import { runMediaCommand, throwIfRenderCancelled } from "./process";
import { isFrameApproved } from "../domain/storyboard-state";
import { normalizeVideoClip, requireOwnedVideo } from "./continuation";

type RenderInput = Parameters<RendererService["render"]>[0];

export function validateRenderInput(input: RenderInput, jobId: string): void {
  if (
    !assetSchema.shape.id.safeParse(jobId).success || !moviePlanSchema.safeParse(input.plan).success
    || !Array.isArray(input.frames) || !renderLayoutSchema.optional().safeParse(input.renderLayout).success
    || input.movieDurationSeconds !== undefined && !MOVIE_DURATIONS.includes(input.movieDurationSeconds)
  ) {
    throw new MovieError("INVALID_RENDER_INPUT", "Rendering requires a valid job and planned, approved storyboard frames.", 400);
  }
  const timeline = getTimeline(input.plan.storyFormat, input.plan.templateId);
  const movieFirst = input.productionMode === "movie-first";
  if (input.frames.length !== timeline.shotIds.length) {
    throw new MovieError("INVALID_RENDER_INPUT", "Rendering requires one approved storyboard frame per planned shot.", 400);
  }
  for (let index = 0; index < timeline.shotIds.length; index++) {
    const shot = input.plan.shots[index];
    const frame = input.frames[index];
    if (
      shot.id !== timeline.shotIds[index] || shot.durationSeconds !== timeline.durations[index]
      || !storyboardFrameSchema.safeParse(frame).success || frame.shotId !== shot.id
      || (movieFirst ? frame.designerDecision?.action === "regenerate" || frame.continuity.verdict === "REJECT" && !isFrameApproved(frame) : !isFrameApproved(frame))
    ) {
      throw new MovieError("INVALID_RENDER_INPUT", movieFirst
        ? "Movie-first rendering requires one usable visual per planned scene; rejected or missing visuals are not substituted."
        : "The PASS frames must match the selected timeline's ordered shot plan.", 400);
    }
  }
  if (input.hero !== null && (
    !videoArtifactSchema.safeParse(input.hero).success || input.hero.shotId !== timeline.heroShotId
  )) {
    throw new MovieError("INVALID_RENDER_INPUT", `An optional hero video must belong to ${timeline.heroShotId}.`, 400);
  }
  if (input.renderLayout === "video-bookends" && (movieFirst || !input.hero)) {
    throw new MovieError("ANIMATION_REQUIRED", "Video bookends require an approved generated hero clip and a reviewed storyboard. Still-image motion is not a substitute.", 409);
  }
  if (input.renderLayout === "video-bookends") {
    const clips = input.videoClips === undefined ? [input.hero!] : input.videoClips;
    if (!Array.isArray(clips) || clips.length !== getMovieFormat(input.movieDurationSeconds).clipCount) {
      throw new MovieError("ANIMATION_REQUIRED", "The selected movie length requires its complete ordered list of generated eight-second clips.", 409);
    }
    if (clips.some(clip => !videoArtifactSchema.safeParse(clip).success || clip.shotId !== timeline.heroShotId
      || clip.provider !== input.hero!.provider)
      || clips[0].assetId !== input.hero!.assetId || clips[0].model !== input.hero!.model
      || new Set(clips.map(clip => clip.assetId)).size !== clips.length) {
      throw new MovieError("INVALID_RENDER_INPUT", "Generated clips must be distinct, match the planned hero and provider, and begin with the saved hero.", 400);
    }
  }
}

function localPath(path: string): boolean {
  return isAbsolute(path) && !path.startsWith("\\\\") && !path.startsWith("//") && !/[\0\r\n]/.test(path);
}

async function requireLocalFile(path: string): Promise<string> {
  if (!localPath(path) || !(await stat(path)).isFile()) {
    throw new MovieError("RENDER_FAILED", "The renderer requires readable, local media files.");
  }
  return path;
}

async function createWorkDirectory(config: MovieConfig, jobId: string): Promise<string> {
  const dataDir = resolve(config.dataDir);
  if (!localPath(dataDir)) throw new MovieError("RENDER_FAILED", "The renderer requires a local private data directory.");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const dataRoot = await realpath(dataDir);
  const workRoot = join(dataRoot, "render-tmp");
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(workRoot)).isSymbolicLink() || await realpath(workRoot) !== workRoot) {
    throw new MovieError("RENDER_FAILED", "The renderer work directory cannot be a redirected directory.");
  }
  const directory = join(workRoot, `${jobId}-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

function controlledError(error: unknown): MovieError {
  return error instanceof MovieError ? error
    : new MovieError("RENDER_FAILED", "Local movie rendering failed. Check the media files and private data directory.");
}

export function createRenderer(config: MovieConfig): RendererService {
  const ffmpeg = config.ffmpegPath ?? ffmpegStatic;
  const ffprobe = config.ffprobePath ?? ffprobeStatic.path;
  const executablesValid = () => Boolean(
    ffmpeg && ffprobe && [ffmpeg, ffprobe].every(path =>
      !/[\0\r\n]/.test(path) && !path.startsWith("\\\\") && !path.startsWith("//") && !/^[a-z]+:\/\//i.test(path)),
  );
  const checkReady = async (signal?: AbortSignal) => {
    if (!executablesValid()) {
      return { available: false, message: "Configure local FFmpeg and ffprobe executables, or install the bundled static packages." };
    }
    try {
      const [encoders, probeVersion] = await Promise.all([
        runMediaCommand(ffmpeg!, ["-hide_banner", "-encoders"], { signal, label: "FFmpeg readiness check", timeoutMs: 10_000 }),
        runMediaCommand(ffprobe, ["-version"], { signal, label: "FFprobe readiness check", timeoutMs: 10_000 }),
      ]);
      if (!/\blibx264\b/.test(encoders) || !/ffprobe version/i.test(probeVersion)) {
        return { available: false, message: "Local FFmpeg with the libx264 encoder and a working ffprobe are required." };
      }
      return { available: true, message: "Local FFmpeg (H.264) and ffprobe are available." };
    } catch {
      return { available: false, message: "Local FFmpeg or ffprobe could not run. Check the executable overrides or bundled static packages." };
    }
  };

  return {
    ready: () => checkReady(),
    async render(input, context) {
      validateRenderInput(input, context.jobId);
      const requiredProvider = input.plan.videoProvider === "openai-sora" ? "OpenAI Sora" : input.plan.videoProvider === "google-veo" ? "Google Veo" : null;
      if (requiredProvider && (input.productionMode === "movie-first" || input.hero?.provider !== requiredProvider)) {
        throw new MovieError("ANIMATION_REQUIRED", `Hybrid output requires its generated ${requiredProvider} clip. Still-image motion is not a substitute.`, 409);
      }
      const bookends = input.renderLayout === "video-bookends";
      const timeline = getRenderTimeline(input.plan.storyFormat, input.plan.templateId, input.renderLayout, input.movieDurationSeconds);
      const clips = bookends ? input.videoClips ?? [input.hero!] : [];
      throwIfRenderCancelled(context.signal);
      const readiness = await checkReady(context.signal);
      throwIfRenderCancelled(context.signal);
      if (!readiness.available) {
        throw new MovieError("RENDERER_UNAVAILABLE", "Local FFmpeg with H.264 support and ffprobe must be available before rendering.");
      }
      let directory: string | undefined;
      try {
        throwIfRenderCancelled(context.signal);
        directory = await createWorkDirectory(config, context.jobId);
        const sources = await Promise.all(input.frames.map(async frame =>
          requireLocalFile(await context.media.assetPath(frame.assetId))));
        const sourcesByShot = new Map(input.frames.map((frame, index) => [frame.shotId, sources[index]]));
        const clipMedia = [];
        for (const clip of clips) clipMedia.push(await requireOwnedVideo(config, clip, context));
        if (new Set(clipMedia.map(clip => clip.path)).size !== clipMedia.length) {
          throw new MovieError("INVALID_RENDER_INPUT", "Each middle segment must use a distinct generated clip.", 400);
        }
        const heroPath = bookends ? clipMedia[0].path : input.hero
          ? await requireLocalFile(await context.media.assetPath(input.hero.assetId)) : undefined;
        const heroHasAudio = bookends ? clipMedia.some(clip => clip.hasAudio)
          : heroPath ? (await probeMedia(ffprobe, heroPath, context.signal)).audioStreamCount > 0 : false;
        let musicPath: string | undefined;
        if (config.musicPath !== undefined) {
          try {
            if (!config.musicPath.trim()) throw new Error("Empty music configuration");
            musicPath = await requireLocalFile(resolve(config.musicPath));
            const music = await probeMedia(ffprobe, musicPath, context.signal);
            if (!music.audio || music.audio.durationSeconds === null) throw new Error("Missing finite audio stream");
          } catch (error) {
            if (error instanceof MovieError && ["RENDER_CANCELLED", "RENDER_TIMEOUT"].includes(error.code)) throw error;
            throw new MovieError("INVALID_MUSIC", "The configured licensed music bed is missing, unreadable, or has no valid audio stream.");
          }
        } else if (!heroHasAudio) {
          await context.warn("No music bed or provider audio is available; the movie will be silent.");
        }
        const normalizedClipPaths: string[] = [];
        const bookendSources: string[] = [];
        if (bookends) {
          // Keep every saved approval usable without including its still in the movie.
          for (const source of sources) {
            await runMediaCommand(ffmpeg!, [
              "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror",
              "-protocol_whitelist", "file,pipe", "-err_detect", "explode", "-i", mediaCommandPath(source),
              "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn", "-f", "null", "-",
            ], { signal: context.signal, label: "FFmpeg approved frame validation", timeoutMs: 60_000 });
          }
          for (let index = 0; index < clips.length; index++) {
            const normalized = join(directory, `segment-${index + 1}.mp4`);
            await context.report({
              stage: "ASSEMBLING", provider: "FFmpeg", shotId: timeline.heroShotId,
              message: `Normalizing approved video clip ${index + 1} of ${clips.length} once, without frozen-frame padding.`,
            });
            await normalizeVideoClip(ffmpeg!, ffprobe, clipMedia[index].path, normalized, clips[index], context);
            normalizedClipPaths.push(normalized);
          }
          for (const bookend of ["opening", "closing"] as const) {
            const imagePath = join(directory, `${bookend}.png`);
            const normalized = normalizedClipPaths[bookend === "opening" ? 0 : normalizedClipPaths.length - 1];
            await runMediaCommand(ffmpeg!, buildBookendExtractionArguments(normalized, imagePath, bookend), {
              signal: context.signal, label: "FFmpeg bookend extraction", timeoutMs: 60_000,
            });
            bookendSources.push(await requireLocalFile(imagePath));
          }
        }
        const shotPaths: string[] = [];
        for (let index = 0; index < timeline.shotIds.length; index++) {
          throwIfRenderCancelled(context.signal);
          const shotId = timeline.shotIds[index];
          if (bookends && index > 0 && index < timeline.shotIds.length - 1) {
            shotPaths.push(normalizedClipPaths[index - 1]);
            continue;
          }
          const bookend = bookends ? index === 0 ? "opening" : "closing" : undefined;
          await context.report({
            stage: "ASSEMBLING", provider: "FFmpeg", shotId,
            message: shotId === timeline.heroShotId && heroPath
              ? "Normalizing the approved hero video; its native audio will be aligned separately in the final movie."
              : bookend
                ? `Animating the approved video's ${bookend === "opening" ? "first" : "last"} frame as the ${bookend} bookend.`
                : input.productionMode === "movie-first"
                ? "Creating the movie scene with cinematic image motion."
                : "Animating the approved storyboard with a gentle centered pan and zoom.",
          });
          const outputPath = join(directory, bookends ? `segment-${index}.mp4` : `${shotId}.mp4`);
          await runMediaCommand(ffmpeg!, shotId === timeline.heroShotId && heroPath
            ? buildHeroArguments(heroPath, outputPath, timeline)
            : buildStillArguments(bookend ? bookendSources[index === 0 ? 0 : 1] : sourcesByShot.get(shotId)!, outputPath, index, timeline, bookend), {
            signal: context.signal, label: "FFmpeg shot encoding",
          });
          shotPaths.push(outputPath);
        }
        await context.report({
          stage: "ASSEMBLING", provider: "FFmpeg",
          message: `Assembling ${timeline.shotIds.length} hard-cut shots ${heroHasAudio ? "with the provider's original audio" : musicPath ? "with the configured music bed" : "without audio"}${heroHasAudio && musicPath ? " and the configured music bed" : ""}.`,
        });
        const outputPath = join(directory, "movie.mp4");
        const nativeAudio = bookends ? clipMedia.flatMap((clip, index) =>
          clip.hasAudio ? [{ path: clip.path, segmentIndex: index + 1 }] : []) : heroHasAudio ? heroPath : undefined;
        await runMediaCommand(ffmpeg!, buildAssemblyArguments(shotPaths, outputPath, musicPath, timeline, nativeAudio), {
          signal: context.signal, label: "FFmpeg final assembly", timeoutMs: 180_000,
        });
        const probe = await probeMedia(ffprobe, outputPath, context.signal, true);
        const durationSeconds = validateRenderedMedia(probe, Boolean(musicPath) || heroHasAudio, timeline);
        const outputSize = (await stat(outputPath)).size;
        if (outputSize < 1 || outputSize > 100 * 1024 * 1024) {
          throw new MovieError("RENDER_INVALID_OUTPUT", "The rendered movie has an invalid file size.");
        }
        throwIfRenderCancelled(context.signal);
        const asset = await context.media.saveAsset({
          ownerId: context.ownerId, jobId: context.jobId, kind: "video", mime: "video/mp4",
          bytes: await readFile(outputPath), width: 1280, height: 720,
        });
        return {
          assetId: asset.id, mode: heroPath ? "hybrid-video" : input.productionMode === "movie-first" ? "image-motion" : "storyboard-motion",
          durationSeconds, hasAudio: probe.audioStreamCount > 0,
          ...(bookends ? { renderLayout: "video-bookends" as const } : {}),
        };
      } catch (error) {
        throw controlledError(error);
      } finally {
        if (directory) await cleanupWorkDirectory(directory, context);
      }
    },
  };
}

async function cleanupWorkDirectory(directory: string, context: GenerationContext): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    await context.warn("The job's private renderer intermediates could not all be removed; local cleanup is required.");
  }
}
