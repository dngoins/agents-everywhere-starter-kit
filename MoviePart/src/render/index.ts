import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import {
  assetSchema, getTimeline, MovieError, moviePlanSchema, storyboardFrameSchema, videoArtifactSchema,
} from "../domain";
import type { GenerationContext, MovieConfig, RendererService } from "../domain/services";
import { buildAssemblyArguments, buildHeroArguments, buildStillArguments } from "./arguments";
import { probeMedia, validateRenderedMedia } from "./probe";
import { runMediaCommand, throwIfRenderCancelled } from "./process";

type RenderInput = Parameters<RendererService["render"]>[0];

export function validateRenderInput(input: RenderInput, jobId: string): void {
  if (
    !assetSchema.shape.id.safeParse(jobId).success || !moviePlanSchema.safeParse(input.plan).success
    || !Array.isArray(input.frames)
  ) {
    throw new MovieError("INVALID_RENDER_INPUT", "Rendering requires a valid job and planned, approved storyboard frames.", 400);
  }
  const timeline = getTimeline(input.plan.storyFormat, input.plan.templateId);
  if (input.frames.length !== timeline.shotIds.length) {
    throw new MovieError("INVALID_RENDER_INPUT", "Rendering requires one approved storyboard frame per planned shot.", 400);
  }
  for (let index = 0; index < timeline.shotIds.length; index++) {
    const shot = input.plan.shots[index];
    const frame = input.frames[index];
    if (
      shot.id !== timeline.shotIds[index] || shot.durationSeconds !== timeline.durations[index]
      || !storyboardFrameSchema.safeParse(frame).success || frame.shotId !== shot.id
      || frame.continuity.verdict !== "PASS"
    ) {
      throw new MovieError("INVALID_RENDER_INPUT", "The PASS frames must match the selected timeline's ordered shot plan.", 400);
    }
  }
  if (input.hero !== null && (
    !videoArtifactSchema.safeParse(input.hero).success || input.hero.shotId !== timeline.heroShotId
  )) {
    throw new MovieError("INVALID_RENDER_INPUT", `An optional hero video must belong to ${timeline.heroShotId}.`, 400);
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
      const timeline = getTimeline(input.plan.storyFormat, input.plan.templateId);
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
        const heroPath = input.hero
          ? await requireLocalFile(await context.media.assetPath(input.hero.assetId)) : undefined;
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
        } else {
          await context.warn("No licensed music bed is configured; the movie will be silent. Provider-native audio is always muted.");
        }
        const shotPaths: string[] = [];
        for (let index = 0; index < timeline.shotIds.length; index++) {
          throwIfRenderCancelled(context.signal);
          const shotId = input.plan.shots[index].id;
          await context.report({
            stage: "ASSEMBLING", provider: "FFmpeg", shotId,
            message: shotId === timeline.heroShotId && heroPath
              ? "Normalizing the approved hero video to eight seconds; muting native audio."
              : "Animating the approved storyboard with a gentle centered pan and zoom.",
          });
          const outputPath = join(directory, `${shotId}.mp4`);
          await runMediaCommand(ffmpeg!, shotId === timeline.heroShotId && heroPath
            ? buildHeroArguments(heroPath, outputPath, timeline)
            : buildStillArguments(sources[index], outputPath, index, timeline), {
            signal: context.signal, label: "FFmpeg shot encoding",
          });
          shotPaths.push(outputPath);
        }
        await context.report({
          stage: "ASSEMBLING", provider: "FFmpeg",
          message: `Assembling ${timeline.shotIds.length} hard-cut shots ${musicPath ? "with the configured music bed" : "without audio"}.`,
        });
        const outputPath = join(directory, "movie.mp4");
        await runMediaCommand(ffmpeg!, buildAssemblyArguments(shotPaths, outputPath, musicPath, timeline), {
          signal: context.signal, label: "FFmpeg final assembly", timeoutMs: 180_000,
        });
        const probe = await probeMedia(ffprobe, outputPath, context.signal, true);
        const durationSeconds = validateRenderedMedia(probe, Boolean(musicPath), timeline);
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
          assetId: asset.id, mode: heroPath ? "hybrid-video" : "storyboard-motion",
          durationSeconds, hasAudio: probe.audioStreamCount > 0,
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
