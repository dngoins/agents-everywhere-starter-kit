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

function shotFrames(index: number, timeline: Timeline): number {
  if (!Number.isInteger(index) || index < 0 || index >= timeline.shotIds.length) {
    throw new MovieError("INVALID_RENDER_INPUT", "A movie must use its planned shots.");
  }
  return timeline.durations[index] * 24;
}

export function buildStillArguments(
  inputPath: string, outputPath: string, shotIndex: number, timeline: Timeline = getTimeline(),
): string[] {
  const frames = shotFrames(shotIndex, timeline);
  const progress = `on/${frames - 1}`;
  const zoom = shotIndex % 2 === 0 ? `1+0.035*${progress}` : `1.035-0.035*${progress}`;
  const pan = shotIndex % 2 === 0 ? `0.45+0.1*${progress}` : `0.55-0.1*${progress}`;
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
): string[] {
  const heroIndex = timeline.shotIds.indexOf(timeline.heroShotId);
  const frames = shotFrames(heroIndex, timeline);
  const duration = timeline.durations[heroIndex];
  const filter = [
    "setpts=PTS-STARTPTS",
    "scale=w='max(2,trunc(iw*sar/2)*2)':h=ih", "setsar=1",
    "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2",
    "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black", "setsar=1", "fps=24",
    `tpad=stop_mode=clone:stop_duration=${duration}`, `trim=end_frame=${frames}`,
    "setpts=PTS-STARTPTS", "format=yuv420p",
  ].join(",");
  return [
    ...common, ...localInput, "-i", mediaCommandPath(inputPath), "-map", "0:v:0", "-vf", filter,
    "-an", "-sn", "-dn", "-frames:v", String(frames), ...encoding, mediaCommandPath(outputPath),
  ];
}

export function buildAssemblyArguments(
  shotPaths: readonly string[],
  outputPath: string,
  musicPath?: string,
  timeline: Timeline = getTimeline(),
): string[] {
  if (shotPaths.length !== timeline.shotIds.length) {
    throw new MovieError("INVALID_RENDER_INPUT", "Assembly requires all planned normalized shots.");
  }
  const args = [...common];
  for (const shotPath of shotPaths) args.push(...localInput, "-i", mediaCommandPath(shotPath));
  if (musicPath) args.push(...localInput, "-stream_loop", "-1", "-i", mediaCommandPath(musicPath));
  let filter = shotPaths.map((_, index) => `[${index}:v:0]`).join("")
    + `concat=n=${shotPaths.length}:v=1:a=0[v]`;
  if (musicPath) {
    filter += `;[${shotPaths.length}:a:0]aresample=48000,atrim=duration=${timeline.durationSeconds},asetpts=PTS-STARTPTS,`
      + `volume=0.22,afade=t=in:st=0:d=0.5,afade=t=out:st=${timeline.durationSeconds - 2}:d=2[a]`;
  }
  args.push("-filter_complex", filter, "-map", "[v]");
  if (musicPath) args.push("-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  else args.push("-an");
  args.push("-sn", "-dn", "-frames:v", String(timeline.durationSeconds * 24),
    "-t", String(timeline.durationSeconds), ...encoding, mediaCommandPath(outputPath));
  return args;
}
