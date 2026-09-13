import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { getTimeline } from "../src/domain";
import { buildAssemblyArguments, buildAudioRestorationArguments } from "../src/render/arguments";
import { runMediaCommand } from "../src/render/process";
import { probeMedia, validateRenderedMedia } from "../src/render/probe";

test("native hero audio is placed at its timeline offset and can mix with music without shell interpolation", () => {
  for (const format of ["four-shot", "six-shot"] as const) {
    const timeline = getTimeline(format, "DREAM_ROUTE");
    const hero = "C:\\Private Clips\\hero & native audio.mp4";
    const shots = timeline.shotIds.map(id => `C:\\Private Clips\\${id}.mp4`);
    const expected = format === "four-shot" ? 6000 : 8000;
    for (const music of [undefined, "C:\\Private Clips\\music.wav"]) {
      const args = buildAssemblyArguments(shots, "C:\\Private Clips\\output.mp4", music, timeline, hero);
      const filter = args[args.indexOf("-filter_complex") + 1];
      assert.match(filter, new RegExp(`adelay=${expected}\\|${expected}`));
      assert.ok(!filter.includes(hero));
      assert.ok(!args.includes("-an"));
      assert.ok(args.includes("aac"));
      assert.equal(filter.includes("amix=inputs=2"), !!music);
    }
  }
});

test("audio restoration preserves encoded video and sound is audible only in the correct hero segment", async t => {
  assert.ok(ffmpeg);
  const directory = await mkdtemp(path.join(os.tmpdir(), "movie-audio-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const original = path.join(directory, "original.mp4");
  const audio = path.join(directory, "hero.wav");
  const restored = path.join(directory, "restored.mp4");
  await runMediaCommand(ffmpeg, [
    "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=1280x720:r=24:d=18", "-an",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-threads", "2",
    "-video_track_timescale", "12288", "-movflags", "+faststart", original,
  ], { label: "Synthetic original movie" });
  await runMediaCommand(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=8", "-c:a", "pcm_s16le", audio], { label: "Synthetic hero audio" });
  await runMediaCommand(ffmpeg, buildAudioRestorationArguments(original, audio, restored), { label: "Audio restoration test" });
  assert.equal(validateRenderedMedia(await probeMedia(ffprobe.path, restored, undefined, true), true), 18);
  const hash = (file: string) => runMediaCommand(ffmpeg!, ["-v", "error", "-i", file, "-map", "0:v:0", "-c:v", "copy", "-f", "hash", "-hash", "sha256", "pipe:1"], { label: "Video stream hash" });
  assert.equal(await hash(original), await hash(restored));
  const rms = (time: number) => {
    const samples = execFileSync(ffmpeg!, [
      "-v", "error", "-ss", String(time), "-i", restored, "-t", "0.25", "-map", "0:a:0",
      "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1",
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    let energy = 0;
    for (let offset = 0; offset < samples.length; offset += 4) energy += samples.readFloatLE(offset) ** 2;
    return Math.sqrt(energy / (samples.length / 4));
  };
  assert.ok(rms(2) < 0.001, "No hero audio before its shot");
  assert.ok(rms(7) > 0.02, "Hero audio is audible during its shot");
  assert.ok(rms(16) < 0.001, "No hero audio after its shot");
});
