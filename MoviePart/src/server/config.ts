import path from "node:path";
import type { MovieConfig } from "../domain/services";
import { MovieError } from "../domain";

export function loadConfig(): MovieConfig {
  const value = (name: string) => process.env[name]?.trim() || undefined;
  const positive = (name: string, fallback: number, maximum: number) => {
    const raw = value(name);
    const result = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
      throw new MovieError("INVALID_CONFIGURATION", `${name} must be an integer from 1 to ${maximum}.`, 503);
    }
    return result;
  };
  const continuityPolicy = value("CONTINUITY_POLICY") ?? "practical";
  if (continuityPolicy !== "practical" && continuityPolicy !== "strict") {
    throw new MovieError("INVALID_CONFIGURATION", "CONTINUITY_POLICY must be practical or strict.", 503);
  }
  return {
    dataDir: path.resolve(value("MOVIE_DATA_DIR") ?? ".movie-data"),
    openaiKey: value("OPENAI_API_KEY"),
    visionModel: value("OPENAI_VISION_MODEL"),
    directorModel: value("OPENAI_DIRECTOR_MODEL"),
    imageModel: value("OPENAI_IMAGE_MODEL") ?? "gpt-image-2.5-flare",
    videoModel: value("OPENAI_VIDEO_MODEL") ?? "sora-2-pro",
    googleKey: value("GEMINI_API_KEY") ?? value("GOOGLE_API_KEY"),
    veoModel: value("VEO_MODEL") ?? "veo-3.1-generate-preview",
    apiToken: value("MOVIE_API_TOKEN"),
    ffmpegPath: value("FFMPEG_PATH"),
    ffprobePath: value("FFPROBE_PATH"),
    musicPath: value("MOVIE_MUSIC_PATH"),
    storyboardMaxAttempts: positive("STORYBOARD_MAX_ATTEMPTS", 8, 20),
    storyboardConcurrency: positive("STORYBOARD_CONCURRENCY", 2, 4),
    continuityPolicy,
  };
}
