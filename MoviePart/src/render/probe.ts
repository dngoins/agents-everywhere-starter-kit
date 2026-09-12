import { getTimeline, MovieError } from "../domain";
import { runMediaCommand } from "./process";
import { mediaCommandPath } from "./paths";

interface VideoProbe {
  codec: string | null;
  width: number | null;
  height: number | null;
  pixelFormat: string | null;
  frameRate: number | null;
  frameCount: number | null;
  durationSeconds: number | null;
  sampleAspectRatio: string | null;
}

export interface MediaProbe {
  video: VideoProbe | null;
  audio: { codec: string | null; durationSeconds: number | null } | null;
  videoStreamCount: number;
  audioStreamCount: number;
  durationSeconds: number | null;
  formatName: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function positiveNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function positiveInteger(value: unknown): number | null {
  const result = positiveNumber(value);
  return result !== null && Number.isSafeInteger(result) ? result : null;
}

function frameRate(value: unknown): number | null {
  if (typeof value !== "string") return positiveNumber(value);
  const parts = value.split("/");
  if (parts.length === 1) return positiveNumber(value);
  if (parts.length !== 2) return null;
  const numerator = positiveNumber(parts[0]);
  const denominator = positiveNumber(parts[1]);
  return numerator !== null && denominator !== null ? numerator / denominator : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function parseProbeOutput(output: string): MediaProbe {
  let raw: Record<string, unknown>;
  try {
    raw = record(JSON.parse(output));
  } catch {
    throw new MovieError("RENDER_INVALID_OUTPUT", "FFprobe returned invalid media metadata.");
  }
  if (!Array.isArray(raw.streams)) {
    throw new MovieError("RENDER_INVALID_OUTPUT", "FFprobe did not return media streams.");
  }
  const streams = raw.streams.map(record);
  const videos = streams.filter(stream => stream.codec_type === "video");
  const audios = streams.filter(stream => stream.codec_type === "audio");
  const format = record(raw.format);
  const duration = positiveNumber(format.duration);
  const video = videos[0];
  const audio = audios[0];
  return {
    video: video ? {
      codec: text(video.codec_name),
      width: positiveInteger(video.width),
      height: positiveInteger(video.height),
      pixelFormat: text(video.pix_fmt),
      frameRate: frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate),
      frameCount: positiveInteger(video.nb_read_frames) ?? positiveInteger(video.nb_frames),
      durationSeconds: positiveNumber(video.duration) ?? duration,
      sampleAspectRatio: text(video.sample_aspect_ratio),
    } : null,
    audio: audio ? {
      codec: text(audio.codec_name),
      durationSeconds: positiveNumber(audio.duration) ?? duration,
    } : null,
    videoStreamCount: videos.length,
    audioStreamCount: audios.length,
    durationSeconds: duration,
    formatName: text(format.format_name),
  };
}

export async function probeMedia(
  executable: string,
  path: string,
  signal?: AbortSignal,
  countFrames = false,
): Promise<MediaProbe> {
  const args = [
    "-v", "error", "-protocol_whitelist", "file,pipe",
    ...(countFrames ? ["-count_frames"] : []),
    "-show_entries",
    "format=duration,format_name:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,duration,sample_aspect_ratio",
    "-of", "json", "-i", mediaCommandPath(path),
  ];
  return parseProbeOutput(await runMediaCommand(executable, args, {
    signal, label: "FFprobe media validation", timeoutMs: 60_000,
  }));
}

export function validateRenderedMedia(
  probe: MediaProbe, expectAudio: boolean, timeline: ReturnType<typeof getTimeline> = getTimeline(),
): number {
  const video = probe.video;
  const { durationSeconds } = timeline;
  const frames = durationSeconds * 24;
  if (
    !probe.formatName?.split(",").includes("mp4")
    || probe.videoStreamCount !== 1 || !video || video.codec !== "h264"
    || video.width !== 1280 || video.height !== 720 || video.pixelFormat !== "yuv420p"
    || video.sampleAspectRatio !== "1:1" || video.frameCount !== frames
    || video.frameRate === null || Math.abs(video.frameRate - 24) > 0.0001
    || video.durationSeconds === null || Math.abs(video.durationSeconds - durationSeconds) > 0.001
    || probe.durationSeconds === null || Math.abs(probe.durationSeconds - durationSeconds) > 0.08
    || probe.audioStreamCount !== (expectAudio ? 1 : 0)
    || (expectAudio && (
      probe.audio?.codec !== "aac" || probe.audio.durationSeconds === null
      || Math.abs(probe.audio.durationSeconds - durationSeconds) > 0.08
    ))
  ) {
    throw new MovieError(
      "RENDER_INVALID_OUTPUT",
      `The rendered movie did not match the required ${frames}-frame, ${durationSeconds}-second, 720p H.264 MP4 timeline and audio configuration.`,
    );
  }
  return video.durationSeconds;
}
