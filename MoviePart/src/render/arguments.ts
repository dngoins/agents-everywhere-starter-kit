import { getTimeline, MovieError } from "../domain";
import { mediaCommandPath } from "./paths";

type Timeline = ReturnType<typeof getTimeline>;
export const SHOT_DURATIONS: readonly number[] = getTimeline().durations;
const common = [
  "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
  "-filter_threads", "1", "-filter_complex_threads", "1",
];
const encoding = [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
  "-pix_fmt", "yuv420p", "-r", "24", "-threads", "2",
  "-video_track_timescale", "12288", "-movflags", "+faststart",
  "-map_metadata", "-1", "-map_chapters", "-1",
];
const localInput = ["-protocol_whitelist", "file,pipe"];

export interface ClipAudioInput {
  path: string;
  segmentIndex: number;
}

function audioFilters(
  musicIndex: number | undefined, heroIndex: number | undefined, timeline: Timeline,
  clipAudio: readonly { inputIndex: number; segmentIndex: number }[] = [],
): string[] {
  const filters: string[] = [];
  const tracks: string[] = [];
  if (musicIndex !== undefined) {
    filters.push(`[${musicIndex}:a:0]aresample=48000,atrim=duration=${timeline.durationSeconds},asetpts=PTS-STARTPTS,`
      + `aformat=channel_layouts=stereo,volume=0.22,afade=t=in:st=0:d=0.5,afade=t=out:st=${timeline.durationSeconds - 2}:d=2[music]`);
    tracks.push("[music]");
  }
  const sources = heroIndex === undefined ? clipAudio
    : [{ inputIndex: heroIndex, segmentIndex: timeline.shotIds.indexOf(timeline.heroShotId) }];
  for (const [index, source] of sources.entries()) {
    const position = source.segmentIndex;
    shotFrames(position, timeline);
    const offsetMs = timeline.durations.slice(0, position).reduce((total, seconds) => total + seconds, 0) * 1000;
    const duration = timeline.durations[position];
    const label = heroIndex === undefined ? `clipAudio${index}` : "heroAudio";
    filters.push(`[${source.inputIndex}:a:0]aresample=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS,`
      + `aformat=channel_layouts=stereo,apad,atrim=duration=${duration},adelay=${offsetMs}|${offsetMs},`
      + `apad,atrim=duration=${timeline.durationSeconds}[${label}]`);
    tracks.push(`[${label}]`);
  }
  if (tracks.length >= 2) filters.push(`${tracks.join("")}amix=inputs=${tracks.length}:duration=longest:normalize=0,alimiter=limit=0.95:level=0,atrim=duration=${timeline.durationSeconds}[a]`);
  else if (tracks.length === 1) filters.push(`${tracks[0]}anull[a]`);
  return filters;
}

function shotFrames(index: number, timeline: Timeline): number {
  if (!Number.isInteger(index) || index < 0 || index >= timeline.shotIds.length) {
    throw new MovieError("INVALID_RENDER_INPUT", "A movie must use its planned shots.");
  }
  return timeline.durations[index] * 24;
}

export function buildStillArguments(
  inputPath: string, outputPath: string, shotIndex: number, timeline: Timeline = getTimeline(),
  bookend?: "opening" | "closing",
): string[] {
  const frames = shotFrames(shotIndex, timeline);
  const progress = `on/${frames - 1}`;
  const zoom = bookend === "opening" ? `1.035-0.035*${progress}`
    : bookend === "closing" || shotIndex % 2 === 0 ? `1+0.035*${progress}` : `1.035-0.035*${progress}`;
  const pan = bookend ? "0.5" : shotIndex % 2 === 0 ? `0.45+0.1*${progress}` : `0.55-0.1*${progress}`;
  // Fit rather than stretch/crop the source. A small centered move preserves
  // the subject while the double-size working canvas reduces zoom jitter.
  const filter = [
    "scale=w='max(2,trunc(iw*sar/2)*2)':h=ih", "setsar=1",
    "scale=2560:1440:force_original_aspect_ratio=decrease:force_divisible_by=2",
    "pad=2560:1440:(ow-iw)/2:(oh-ih)/2:color=black", "setsar=1",
    `zoompan=z='${zoom}':x='(iw-iw/zoom)*(${pan})':y='(ih-ih/zoom)/2':d=${frames}:s=1280x720:fps=24`,
    `trim=end_frame=${frames}`, "setpts=PTS-STARTPTS", "format=yuv420p",
  ].join(",");
  return [
    ...common, ...localInput, "-loop", "1", "-framerate", "24", "-i", mediaCommandPath(inputPath),
    "-map", "0:v:0", "-vf", filter, "-an", "-sn", "-dn", "-frames:v", String(frames),
    ...encoding, mediaCommandPath(outputPath),
  ];
}

export function buildHeroArguments(
  inputPath: string, outputPath: string, timeline: Timeline = getTimeline(),
  padShortClip = true,
): string[] {
  const heroIndex = timeline.shotIds.indexOf(timeline.heroShotId);
  const frames = shotFrames(heroIndex, timeline);
  const duration = timeline.durations[heroIndex];
  const filter = [
    "setpts=PTS-STARTPTS",
    "scale=w='max(2,trunc(iw*sar/2)*2)':h=ih", "setsar=1",
    "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2",
    "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black", "setsar=1", "fps=24",
    ...(padShortClip ? [`tpad=stop_mode=clone:stop_duration=${duration}`] : []), `trim=end_frame=${frames}`,
    "setpts=PTS-STARTPTS", "format=yuv420p",
  ].join(",");
  return [
    ...common, ...(!padShortClip ? ["-xerror"] : []), ...localInput,
    ...(!padShortClip ? ["-err_detect", "explode"] : []),
    "-i", mediaCommandPath(inputPath), "-map", "0:v:0", "-vf", filter,
    "-an", "-sn", "-dn", "-frames:v", String(frames), ...encoding, mediaCommandPath(outputPath),
  ];
}

export function buildBookendExtractionArguments(
  inputPath: string, outputPath: string, bookend: "opening" | "closing",
): string[] {
  return [
    ...common, ...localInput, "-threads", "2", "-i", mediaCommandPath(inputPath),
    "-map", "0:v:0", "-an", "-sn", "-dn",
    "-vf", `select=eq(n\\,${bookend === "opening" ? 0 : 191})`,
    "-frames:v", "1", "-fps_mode", "passthrough", "-c:v", "png", "-threads", "1",
    "-f", "image2", "-update", "1", mediaCommandPath(outputPath),
  ];
}

export function buildAssemblyArguments(
  shotPaths: readonly string[],
  outputPath: string,
  musicPath?: string,
  timeline: Timeline = getTimeline(),
  heroAudioPath?: string | readonly ClipAudioInput[],
): string[] {
  if (shotPaths.length !== timeline.shotIds.length) {
    throw new MovieError("INVALID_RENDER_INPUT", "Assembly requires all planned normalized shots.");
  }
  const args = [...common];
  for (const shotPath of shotPaths) args.push(...localInput, "-i", mediaCommandPath(shotPath));
  if (musicPath) args.push(...localInput, "-stream_loop", "-1", "-i", mediaCommandPath(musicPath));
  const heroAudio = typeof heroAudioPath === "string" ? heroAudioPath : undefined;
  const clips = typeof heroAudioPath === "string" ? [] : heroAudioPath ?? [];
  if (new Set(clips.map(clip => clip.segmentIndex)).size !== clips.length) {
    throw new MovieError("INVALID_RENDER_INPUT", "Each normalized segment may have only one native soundtrack.");
  }
  if (heroAudio) args.push(...localInput, "-i", mediaCommandPath(heroAudio));
  for (const clip of clips) args.push(...localInput, "-i", mediaCommandPath(clip.path));
  let filter = shotPaths.map((_, index) => `[${index}:v:0]`).join("")
    + `concat=n=${shotPaths.length}:v=1:a=0[v]`;
  const audio = audioFilters(musicPath ? shotPaths.length : undefined,
    heroAudio ? shotPaths.length + Number(Boolean(musicPath)) : undefined, timeline,
    clips.map((clip, index) => ({
      inputIndex: shotPaths.length + Number(Boolean(musicPath)) + index, segmentIndex: clip.segmentIndex,
    })));
  if (audio.length) filter += `;${audio.join(";")}`;
  args.push("-filter_complex", filter, "-map", "[v]");
  if (audio.length) args.push("-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  else args.push("-an");
  args.push("-sn", "-dn", "-frames:v", String(timeline.durationSeconds * 24),
    "-t", String(timeline.durationSeconds), ...encoding, mediaCommandPath(outputPath));
  return args;
}

/** Copy the existing video stream unchanged and replace only its soundtrack. */
export function buildAudioRestorationArguments(
  moviePath: string, heroAudioPath: string, outputPath: string, timeline: Timeline = getTimeline(),
): string[] {
  return [
    ...common, ...localInput, "-i", mediaCommandPath(moviePath),
    ...localInput, "-i", mediaCommandPath(heroAudioPath),
    "-filter_complex", audioFilters(undefined, 1, timeline).join(";"),
    "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-ar", "48000", "-ac", "2", "-sn", "-dn", "-t", String(timeline.durationSeconds),
    "-movflags", "+faststart", "-map_metadata", "-1", "-map_chapters", "-1", mediaCommandPath(outputPath),
  ];
}
