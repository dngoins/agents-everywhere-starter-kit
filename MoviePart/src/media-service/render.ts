import { lstat, open, readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import sharp from "sharp";
import type { AdBrief } from "../../integration/dwight/types";
import { atomicWrite } from "../server/files";
import { mediaCommandPath } from "../render/paths";
import { probeMedia } from "../render/probe";
import { runMediaCommand } from "../render/process";
import { MAX_ASSET_BYTES, ServiceError } from "./contracts";
import { runDurableMediaCommand } from "./process";

export const FPS = 24;
export type Stage = "accepted" | "preparing" | "generating" | "rendering" | "encoding" | "finalizing";
export interface RenderTools { ffmpeg?: string; ffprobe?: string }

function binaries(tools: RenderTools) {
  const ffmpeg = tools.ffmpeg ?? ffmpegStatic;
  const ffprobe = tools.ffprobe ?? ffprobeStatic.path;
  if (!ffmpeg || !ffprobe || [ffmpeg, ffprobe].some(value => /[\0\r\n]/.test(value) || value.startsWith("\\\\"))) {
    throw new ServiceError(503, "RENDERER_UNAVAILABLE");
  }
  return { ffmpeg, ffprobe };
}

export async function renderReady(tools: RenderTools = {}): Promise<boolean> {
  try {
    const { ffmpeg, ffprobe } = binaries(tools);
    const [encoders] = await Promise.all([
      runMediaCommand(ffmpeg, ["-hide_banner", "-encoders"], { label: "Media readiness", timeoutMs: 10_000 }),
      runMediaCommand(ffprobe, ["-version"], { label: "Media readiness", timeoutMs: 10_000 }),
    ]);
    return /\blibx264\b/.test(encoders);
  } catch { return false; }
}

export function sceneFrames(brief: AdBrief): number[] {
  let elapsed = 0;
  let prior = 0;
  return brief.scenes.map(scene => {
    elapsed += scene.durationSeconds;
    const next = Math.round(elapsed * FPS);
    const count = next - prior;
    prior = next;
    // Each requested scene must remain visible; sub-frame scenes cannot be represented.
    if (count < 1) throw new ServiceError(400, "SCENE_SHORTER_THAN_FRAME");
    return count;
  });
}

export function escapeSvg(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(/\s+/).filter(Boolean)) {
    for (let offset = 0; offset < word.length; offset += width) {
      const part = word.slice(offset, offset + width);
      if (line.length + part.length + 1 > width) { lines.push(line); line = ""; }
      line += `${line ? " " : ""}${part}`;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function composeFrame(
  image: Uint8Array, onScreenText: string, callToAction: string, sample = false,
): Promise<Buffer> {
  const copy = wrap(onScreenText, 43);
  const cta = wrap(callToAction, 50);
  const copySize = 27;
  const ctaSize = 23;
  const panelHeight = 32 + copy.length * 34 + (cta.length ? 14 + cta.length * 29 : 0);
  const top = 720 - panelHeight;
  const text = (lines: string[], start: number, size: number, step: number, color: string) =>
    lines.map((line, index) => `<text x="40" y="${start + index * step}" font-size="${size}" fill="${color}">${escapeSvg(line)}</text>`).join("");
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
    <g font-family="sans-serif">
      <rect x="0" y="0" width="1280" height="52" fill="#071b2d" fill-opacity=".94"/>
      <text x="30" y="35" fill="#fff" font-size="25">${sample ? "SYNTHETIC SAMPLE — OFFLINE / NOT CUSTOMER-GENERATED" : "SYNTHETIC CONCEPT — NOT A PRODUCTION VEHICLE"}</text>
      <rect x="0" y="${top}" width="1280" height="${panelHeight}" fill="#071b2d" fill-opacity=".94"/>
      ${text(copy, top + 37, copySize, 34, "#ffffff")}
      ${text(cta, top + 37 + copy.length * 34 + 10, ctaSize, 29, "#a8f4e5")}
    </g></svg>`);
  return sharp(image, { limitInputPixels: 25_000_000, failOn: "warning" })
    .rotate().resize(1280, 720, { fit: "cover" }).removeAlpha()
    .composite([{ input: overlay }]).png().toBuffer();
}

export async function validateMp4(
  filename: string, duration: number, tools: RenderTools = {}, signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 32 || info.size > MAX_ASSET_BYTES) {
    throw new ServiceError(502, "INVALID_OUTPUT");
  }
  const handle = await open(filename, "r");
  try {
    const header = Buffer.alloc(12);
    await handle.read(header, 0, 12, 0);
    if (header.toString("ascii", 4, 8) !== "ftyp") throw new ServiceError(502, "INVALID_OUTPUT");
  } finally { await handle.close(); }
  const probe = await probeMedia(binaries(tools).ffprobe, filename, signal, true);
  const video = probe.video;
  const expected = Math.round(duration * FPS);
  if (!video || probe.videoStreamCount !== 1 || video.codec !== "h264" ||
      video.width !== 1280 || video.height !== 720 || video.pixelFormat !== "yuv420p" ||
      video.frameCount !== expected || video.frameRate !== FPS || probe.audioStreamCount !== 0 ||
      video.durationSeconds === null || Math.abs(video.durationSeconds - duration) > 1 / FPS + 0.001 ||
      probe.durationSeconds === null || Math.abs(probe.durationSeconds - duration) > 1 / FPS + 0.001) {
    throw new ServiceError(502, "INVALID_OUTPUT");
  }
  signal?.throwIfAborted();
  return video.durationSeconds;
}

export async function encodeTimeline(
  brief: AdBrief, frames: string[], directory: string, output: string,
  signal: AbortSignal, progress: (stage: Stage) => Promise<void>, tools: RenderTools = {},
): Promise<void> {
  const counts = sceneFrames(brief);
  if (frames.length !== counts.length) throw new ServiceError(502, "MISSING_FRAMES");
  const { ffmpeg } = binaries(tools);
  await progress("rendering");
  const clips: string[] = [];
  for (const [index, frame] of frames.entries()) {
    signal.throwIfAborted();
    const clip = path.join(directory, `scene-${index}.mp4`);
    await runDurableMediaCommand(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-loop", "1", "-framerate", String(FPS), "-i", mediaCommandPath(frame),
      "-frames:v", String(counts[index]), "-an", "-vf", "setsar=1",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-threads", "2", "-movflags", "+faststart", mediaCommandPath(clip),
    ], directory, signal);
    clips.push(clip);
  }
  await progress("encoding");
  // Only generated numeric filenames enter the concat manifest, never user copy or paths.
  const manifest = path.join(directory, "timeline.txt");
  await atomicWrite(manifest, clips.map((_, index) => `file 'scene-${index}.mp4'`).join("\n"));
  await runDurableMediaCommand(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "1",
    "-protocol_whitelist", "file,pipe", "-i", mediaCommandPath(manifest),
    "-map", "0:v:0", "-an", "-c", "copy", "-movflags", "+faststart", mediaCommandPath(output),
  ], directory, signal);
  await progress("finalizing");
  await validateMp4(output, brief.durationSeconds, tools, signal);
}

export async function generateSample(output: string, tools: RenderTools = {}): Promise<void> {
  const examples = JSON.parse(await readFile(new URL("../../integration/dwight/examples.json", import.meta.url), "utf8")) as { brief: AdBrief };
  const directory = `${path.resolve(output)}.sample-work`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const frames: string[] = [];
    for (const [index, scene] of examples.brief.scenes.entries()) {
      const backdrop = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
        <rect width="1280" height="720" fill="${index === 0 ? "#245272" : "#503465"}"/>
        <ellipse cx="640" cy="480" rx="430" ry="55" fill="#162638"/>
        <path d="M260 432 L310 360 L462 340 L540 268 L762 268 L858 355 L985 378 L1010 445 L260 445Z" fill="#75d5db" stroke="#c9f8ef" stroke-width="6"/>
        <circle cx="423" cy="439" r="48" fill="#101b30"/><circle cx="849" cy="439" r="48" fill="#101b30"/>
        <path d="M498 340 L562 290 L745 290 L802 340Z" fill="#172a43"/>
      </svg>`);
      const frame = await composeFrame(backdrop, scene.onScreenText,
        index === examples.brief.scenes.length - 1 ? examples.brief.callToAction : "", true);
      const filename = path.join(directory, `frame-${index}.png`);
      await atomicWrite(filename, frame);
      frames.push(filename);
    }
    await encodeTimeline(examples.brief, frames, directory, path.resolve(output),
      new AbortController().signal, async () => {}, tools);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
