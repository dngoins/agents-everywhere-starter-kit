import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import sharp from "sharp";
import {
  getMovieFormat, getRenderTimeline, getTimeline, MOVIE_DURATIONS, MovieError,
  type AssetRecord, type MoviePlan, type StoryFormat, type TemplateId,
} from "../src/domain";
import type { GenerationContext, MovieConfig, RendererService } from "../src/domain/services";
import { createRenderer, validateRenderInput } from "../src/render";
import {
  buildAssemblyArguments, buildBookendExtractionArguments, buildHeroArguments, buildStillArguments,
} from "../src/render/arguments";
import { mediaCommandPath } from "../src/render/paths";
import { probeMedia, validateRenderedMedia } from "../src/render/probe";
import { runMediaCommand } from "../src/render/process";
import { createContinuationReference } from "../src/render/continuation";

type RenderInput = Parameters<RendererService["render"]>[0];
const hasCode = (code: string) => (error: unknown) => error instanceof MovieError && error.code === code;
const option = (args: string[], key: string) => args[args.indexOf(key) + 1];

function inputFixture(storyFormat: StoryFormat = "four-shot", templateId: TemplateId = "DREAM_ROUTE"): RenderInput {
  const timeline = getTimeline(storyFormat, templateId);
  const plan: MoviePlan = {
    id: randomUUID(), characterId: randomUUID(), productId: "synthetic-bookends",
    templateId, templateVersion: 1, referenceVersion: 1, storyFormat, videoProvider: "google-veo",
    durationSeconds: timeline.durationSeconds, aspectRatio: "16:9", heroShotId: timeline.heroShotId,
    logline: "Synthetic moving test pattern", wardrobe: "None", cinematicStyle: "Geometry",
    worldTransitions: "Hard cuts", personalizationUsed: [],
    shots: timeline.shotIds.map((id, index) => ({
      id, durationSeconds: timeline.durations[index], purpose: "Synthetic test",
      camera: "Static", action: "Moving test pattern", environment: "Plain", lighting: "Even",
      personalization: [], imagePrompt: "Geometry", motionPrompt: "Actual motion", audioCues: [],
    })),
  };
  return {
    plan, renderLayout: "video-bookends", productionMode: "reviewed-storyboard",
    frames: plan.shots.map(shot => ({
      shotId: shot.id, assetId: randomUUID(),
      continuity: { verdict: "PASS", reasons: [], confidence: 1 },
      provider: "Synthetic test", model: "No generation API",
      designerDecision: { action: "keep", note: `Keep ${shot.id}`, at: "2026-09-13T00:00:00.000Z" },
    })),
    hero: { assetId: randomUUID(), shotId: timeline.heroShotId, provider: "Google Veo", model: "Synthetic local fixture" },
  };
}

test("bookend timelines keep both planned hero mappings without changing legacy timelines or arguments", () => {
  for (const format of ["four-shot", "six-shot"] as const) {
    for (const templateId of ["DREAM_ROUTE", "HERO_OF_THE_DAY"] as const) {
      const original = getTimeline(format, templateId);
      const timeline = getRenderTimeline(format, templateId, "video-bookends");
      assert.deepEqual(getRenderTimeline(format, templateId), original);
      assert.deepEqual(getRenderTimeline(format, templateId, "storyboard"), original);
      assert.deepEqual(timeline.shotIds, [original.shotIds[0], original.heroShotId, original.shotIds.at(-1)]);
      assert.deepEqual(timeline.durations, [3, 8, 4]);
      assert.equal(timeline.durationSeconds, 15);
      assert.equal(timeline.heroShotId, format === "six-shot" ? "shot_04" : "shot_03");
      const source = "C:\\Synthetic fixtures\\a & [b] ' video.mp4";
      const output = "C:\\Synthetic fixtures\\output file.mp4";
      for (const [index, bookend, count] of [[0, "opening", 72], [2, "closing", 96]] as const) {
        const args = buildStillArguments(source, output, index, timeline, bookend);
        const filter = option(args, "-vf");
        assert.equal(option(args, "-i"), source);
        assert.equal(args.at(-1), output);
        assert.equal(option(args, "-protocol_whitelist"), "file,pipe");
        assert.equal(option(args, "-frames:v"), String(count));
        assert.ok(filter.includes(bookend === "opening" ? "z='1.035-0.035*on/71'" : "z='1+0.035*on/95'"));
        assert.ok(filter.includes("x='(iw-iw/zoom)*(0.5)':y='(ih-ih/zoom)/2'"));
        const extraction = buildBookendExtractionArguments(source, output, bookend);
        assert.equal(option(extraction, "-vf"), `select=eq(n\\,${bookend === "opening" ? 0 : 191})`);
        assert.equal(option(extraction, "-frames:v"), "1");
        assert.equal(option(extraction, "-fps_mode"), "passthrough");
        assert.equal(option(extraction, "-protocol_whitelist"), "file,pipe");
        assert.equal(option(extraction, "-i"), source);
        assert.equal(extraction.at(-1), output);
      }
      const hero = buildHeroArguments(source, output, timeline, false);
      assert.equal(option(hero, "-frames:v"), "192");
      assert.doesNotMatch(option(hero, "-vf"), /tpad/);
      assert.ok(hero.includes("-xerror"));
      assert.match(option(buildHeroArguments(source, output), "-vf"), /tpad=stop_mode=clone:stop_duration=8/);
      assert.match(option(buildStillArguments(source, output, 0), "-vf"), /0\.45\+0\.1\*on\/71/);
      const paths = timeline.shotIds.map(id => `C:\\Synthetic fixtures\\${id}.mp4`);
      for (const music of [undefined, "C:\\Synthetic fixtures\\music.wav"]) {
        const assembly = buildAssemblyArguments(paths, output, music, timeline, source);
        const filter = option(assembly, "-filter_complex");
        assert.ok(filter.startsWith("[0:v:0][1:v:0][2:v:0]concat=n=3:v=1:a=0[v]"));
        assert.match(filter, /adelay=3000\|3000/);
        assert.match(filter, /apad,atrim=duration=8/);
        assert.ok(filter.includes(`[${music ? 4 : 3}:a:0]`));
        if (music) {
          assert.match(filter, /afade=t=out:st=13:d=2/);
          assert.match(filter, /amix=inputs=2:duration=longest:normalize=0/);
        }
        assert.equal(option(assembly, "-frames:v"), "360");
        assert.equal(option(assembly, "-t"), "15");
        assert.ok(assembly.includes("aac"));
      }
    }
  }
});

test("bookends fail closed on missing video, movie-first, invalid layout, wrong hero IDs and incomplete approvals", async () => {
  for (const format of ["four-shot", "six-shot"] as const) {
    const original = inputFixture(format);
    assert.doesNotThrow(() => validateRenderInput(original, randomUUID()));
    for (const mutate of [
      (input: RenderInput) => { input.frames.pop(); },
      (input: RenderInput) => { input.frames.reverse(); },
      (input: RenderInput) => { input.frames[1].designerDecision!.action = "regenerate"; },
      (input: RenderInput) => { input.plan.shots[1].durationSeconds = 8; },
      (input: RenderInput) => { input.hero!.shotId = format === "six-shot" ? "shot_03" : "shot_04"; },
      (input: RenderInput) => { (input as { renderLayout: unknown }).renderLayout = "invalid"; },
    ]) {
      const input = structuredClone(original);
      mutate(input);
      assert.throws(() => validateRenderInput(input, randomUUID()), hasCode("INVALID_RENDER_INPUT"));
    }
    for (const input of [
      { ...original, hero: null },
      { ...original, productionMode: "movie-first" as const },
    ]) {
      assert.throws(() => validateRenderInput(input, randomUUID()), hasCode("ANIMATION_REQUIRED"));
      await assert.rejects(createRenderer({
        dataDir: resolve(".unused-bookend-test"), imageModel: "unused", veoModel: "unused",
        ffmpegPath: resolve("nonexistent-ffmpeg.exe"),
      }).render(input, { jobId: randomUUID() } as GenerationContext), hasCode("ANIMATION_REQUIRED"));
    }
    const legacy = { ...original, hero: null, renderLayout: undefined };
    delete legacy.plan.videoProvider;
    assert.doesNotThrow(() => validateRenderInput(legacy, randomUUID()));
  }
});

test("all five lengths enforce distinct ordered clips and independently positioned audio, including silent gaps", () => {
  const expected = [[2, 8, 3], [3, 8, 4], [1, 8, 8, 1], [3, 8, 8, 4], [2, 8, 8, 8, 2]];
  for (const format of ["four-shot", "six-shot"] as const) {
    for (const [index, duration] of MOVIE_DURATIONS.entries()) {
      const input = inputFixture(format);
      input.movieDurationSeconds = duration;
      input.videoClips = Array.from({ length: getMovieFormat(duration).clipCount }, (_, index) =>
        index === 0 ? input.hero! : { ...input.hero!, assetId: randomUUID() });
      assert.doesNotThrow(() => validateRenderInput(input, randomUUID()));
      const timeline = getRenderTimeline(format, input.plan.templateId, "video-bookends", duration);
      assert.deepEqual(timeline.durations, expected[index]);
      assert.deepEqual(timeline.shotIds.slice(1, -1), input.videoClips.map(clip => clip.shotId));
      assert.equal(timeline.durationSeconds, duration);
      const paths = timeline.shotIds.map((_, i) => `C:\\Synthetic\\segment-${i}.mp4`);
      const soundtracks = input.videoClips.map((_, i) => ({ path: `C:\\Synthetic\\native-${i}.mp4`, segmentIndex: i + 1 }));
      for (const music of [undefined, "C:\\Synthetic\\music.wav"]) {
        const args = buildAssemblyArguments(paths, "C:\\Synthetic\\movie.mp4", music, timeline, soundtracks);
        const filter = option(args, "-filter_complex");
        assert.equal(option(args, "-frames:v"), String([312, 360, 432, 552, 672][index]));
        assert.equal(option(args, "-t"), String(duration));
        for (const [audioIndex, track] of soundtracks.entries()) {
          const delay = (timeline.durations[0] + audioIndex * 8) * 1000;
          assert.ok(filter.includes(`adelay=${delay}|${delay}`));
          assert.ok(filter.includes(`[${paths.length + Number(Boolean(music)) + audioIndex}:a:0]`));
          assert.ok(args.includes(track.path));
        }
        if (music || soundtracks.length > 1) {
          assert.ok(filter.includes(`amix=inputs=${soundtracks.length + Number(Boolean(music))}:duration=longest:normalize=0`));
        }
      }
      if (soundtracks.length === 3) {
        const sparse = buildAssemblyArguments(paths, "C:\\Synthetic\\movie.mp4", undefined, timeline, [soundtracks[0], soundtracks[2]]);
        assert.match(option(sparse, "-filter_complex"), /adelay=18000\|18000/);
        assert.doesNotMatch(option(sparse, "-filter_complex"), /adelay=10000\|10000/);
      }
      for (const mutate of [
        (value: RenderInput) => { value.videoClips = []; },
        (value: RenderInput) => { value.videoClips!.push({ ...value.hero!, assetId: randomUUID() }); },
      ]) {
        const invalid = structuredClone(input);
        mutate(invalid);
        assert.throws(() => validateRenderInput(invalid, randomUUID()), hasCode("ANIMATION_REQUIRED"));
      }
      for (const mutate of [
        (value: RenderInput) => { value.videoClips![0].assetId = randomUUID(); },
        (value: RenderInput) => { value.videoClips![0].provider = "OpenAI Sora"; },
        (value: RenderInput) => { value.videoClips![0].shotId = format === "four-shot" ? "shot_04" : "shot_03"; },
        (value: RenderInput) => { (value as { movieDurationSeconds: unknown }).movieDurationSeconds = 16; },
      ]) {
        const invalid = structuredClone(input);
        // Separate hero and list references so mutating a list entry does not mutate the hero.
        invalid.videoClips = structuredClone(invalid.videoClips);
        mutate(invalid);
        assert.throws(() => validateRenderInput(invalid, randomUUID()), hasCode("INVALID_RENDER_INPUT"));
      }
      if (input.videoClips.length > 1) {
        const duplicate = structuredClone(input);
        duplicate.videoClips![1] = duplicate.videoClips![0];
        assert.throws(() => validateRenderInput(duplicate, randomUUID()), hasCode("INVALID_RENDER_INPUT"));
        const wrongProvider = structuredClone(input);
        wrongProvider.videoClips![1].provider = "OpenAI Sora";
        assert.throws(() => validateRenderInput(wrongProvider, randomUUID()), hasCode("INVALID_RENDER_INPUT"));
        const missing = { ...input, videoClips: undefined };
        assert.throws(() => validateRenderInput(missing, randomUUID()), hasCode("ANIMATION_REQUIRED"));
      }
    }
  }
});

async function mediaFixture(root: string, format: StoryFormat, allowReferences = false) {
  await mkdir(root, { recursive: true });
  const input = inputFixture(format);
  const config: MovieConfig = { dataDir: root, imageModel: "unused", veoModel: "unused" };
  const paths = new Map<string, string>();
  const requestedIds: string[] = [];
  const saved: AssetRecord[] = [];
  const records = new Map<string, AssetRecord>();
  const events: Parameters<GenerationContext["report"]>[0][] = [];
  const context: GenerationContext = {
    jobId: randomUUID(), ownerId: "synthetic-bookend-test", signal: new AbortController().signal,
    media: {
      getAsset: async id => records.get(id) ?? {
        id, ownerId: context.ownerId, jobId: context.jobId, kind: "video", mime: "video/mp4",
        filename: "synthetic source.mp4", bytes: (await stat(paths.get(id)!)).size,
        width: 320, height: 180, createdAt: "2026-09-13T00:00:00.000Z",
      },
      readAsset: async id => readFile(paths.get(id)!),
      assetPath: async id => {
        requestedIds.push(id);
        assert.ok(paths.has(id), "Only opaque fixture-owned asset IDs may be resolved");
        return paths.get(id)!;
      },
      saveAsset: async asset => {
        if (!allowReferences) assert.equal(asset.kind, "video", "Extracted bookends must never be saved as storyboard assets");
        const id = randomUUID();
        const path = join(root, `${id}.${asset.kind === "storyboard" ? "png" : "mp4"}`);
        await writeFile(path, asset.bytes);
        paths.set(id, path);
        const record: AssetRecord = {
          id, ownerId: asset.ownerId, jobId: asset.jobId, kind: asset.kind, mime: asset.mime,
          filename: "synthetic movie.mp4", bytes: asset.bytes.length,
          width: asset.width ?? null, height: asset.height ?? null, createdAt: new Date().toISOString(),
        };
        saved.push(record);
        records.set(id, record);
        return record;
      },
    },
    report: async event => { events.push(event); },
    warn: async () => {},
    saveFrame: async () => assert.fail("Rendering must not overwrite approvals"),
    recordOperation: async () => assert.fail("Rendering must never invoke a generation provider"),
  };
  const still = join(root, "synthetic storyboard.png");
  await sharp({ create: { width: 64, height: 36, channels: 3, background: "#c030b0" } }).png().toFile(still);
  for (const frame of input.frames) paths.set(frame.assetId, still);
  return { input, config, context, paths, saved, records, requestedIds, events, still };
}

async function decodedPixels(input: string, output: string): Promise<Buffer> {
  await runMediaCommand(ffmpeg!, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-protocol_whitelist", "file,pipe", "-i", mediaCommandPath(input),
    "-map", "0:v:0", "-vf", "scale=160:90", "-pix_fmt", "gray", "-an", "-sn", "-dn",
    "-threads", "1", "-f", "rawvideo", mediaCommandPath(output),
  ], { label: "Decode synthetic motion", timeoutMs: 60_000 });
  return readFile(output);
}

function difference(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length);
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

test("real synthetic bookends retain approvals, exact decoded endpoints, moving video and native audio at 3–11 seconds", { timeout: 240_000 }, async () => {
  assert.ok(ffmpeg);
  const root = resolve(`.bookend-render-test-${randomUUID()}`);
  const sample = await mediaFixture(root, "six-shot");
  const original = structuredClone(sample.input);
  const source = join(root, "synthetic moving video & audio.mp4");
  sample.paths.set(sample.input.hero!.assetId, source);
  const frameBytes = 160 * 90;
  const frameAt = (bytes: Buffer, index: number) => bytes.subarray(index * frameBytes, (index + 1) * frameBytes);
  let normalized: Buffer | undefined;
  let inspected = false;
  let inspectionError: unknown;
  const report = sample.context.report;
  sample.context.report = async event => {
    await report(event);
    if (event.shotId !== "shot_01" || inspected) return;
    inspected = true;
    const workRoot = join(sample.config.dataDir, "render-tmp");
    const directories = await readdir(workRoot);
    assert.equal(directories.length, 1);
    const work = join(workRoot, directories[0]);
    assert.deepEqual((await readdir(work)).sort(), ["closing.png", "opening.png", "segment-1.mp4"]);
    const hero = join(work, "segment-1.mp4");
    normalized = await decodedPixels(hero, join(root, "normalized.gray"));
    assert.equal(normalized.length, 192 * frameBytes);
    for (const [bookend, index] of [["opening", 0], ["closing", 191]] as const) {
      const expected = join(root, `${bookend}-expected.png`);
      await runMediaCommand(ffmpeg!, [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-protocol_whitelist", "file,pipe", "-i", mediaCommandPath(hero),
        "-vf", `select=eq(n\\,${index})`, "-frames:v", "1", "-fps_mode", "passthrough",
        "-threads", "1", "-update", "1", mediaCommandPath(expected),
      ], { label: "Check exact synthetic endpoint", timeoutMs: 60_000 });
      assert.deepEqual(await sharp(await readFile(join(work, `${bookend}.png`))).raw().toBuffer(),
        await sharp(await readFile(expected)).raw().toBuffer(), `${bookend} must use exact normalized decoded frame ${index}`);
    }
  };
  const inspectReport = sample.context.report;
  sample.context.report = async event => {
    try {
      await inspectReport(event);
    } catch (error) {
      inspectionError = error;
      throw error;
    }
  };
  try {
    await runMediaCommand(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=8",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=8",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-threads", "2", "-c:a", "aac", "-t", "8", mediaCommandPath(source),
    ], { label: "Create local synthetic motion and tone", timeoutMs: 60_000 });
    const result = await createRenderer(sample.config).render(sample.input, sample.context).catch(error => {
      throw inspectionError ?? error;
    });
    assert.equal(result.mode, "hybrid-video");
    assert.equal(result.renderLayout, "video-bookends");
    assert.equal(result.durationSeconds, 15);
    assert.equal(result.hasAudio, true);
    assert.deepEqual(sample.input, original, "All six approvals and the original director plan must stay unchanged");
    assert.deepEqual(sample.requestedIds, [...original.frames.map(frame => frame.assetId), original.hero!.assetId]);
    assert.equal(sample.saved.length, 1);
    assert.equal(sample.events.length, 4, "Exactly one normalization, two still encodes and final assembly");
    assert.deepEqual(sample.events.filter(event => event.shotId).map(event => event.shotId), ["shot_04", "shot_01", "shot_06"]);
    assert.match(sample.events.at(-1)!.message, /Assembling 3 hard-cut shots/);
    assert.ok(inspected && normalized);
    const movie = sample.paths.get(result.assetId)!;
    const probe = await probeMedia(ffprobe.path, movie, undefined, true);
    assert.equal(validateRenderedMedia(probe, true, getRenderTimeline("six-shot", "DREAM_ROUTE", "video-bookends")), 15);
    assert.equal(probe.video?.frameCount, 360);
    assert.equal(probe.video?.codec, "h264");
    assert.equal(probe.audio?.codec, "aac");
    const pixels = await decodedPixels(movie, join(root, "movie.gray"));
    assert.equal(pixels.length, 360 * frameBytes);
    for (let i = 0; i < 192; i++) {
      assert.ok(difference(frameAt(pixels, 72 + i), frameAt(normalized, i)) < 2,
        `Middle frame ${i} must be the actual normalized video, not a storyboard still or padded frame`);
    }
    assert.ok(difference(frameAt(pixels, 96), frameAt(pixels, 216)) > 8, "The middle must contain detectable actual motion");
    assert.ok(difference(frameAt(pixels, 71), frameAt(normalized, 0)) < 2, "Opening ends at neutral first-video-frame scale");
    assert.ok(difference(frameAt(pixels, 264), frameAt(normalized, 191)) < 2, "Closing starts at neutral last-video-frame scale");
    for (const [start, end, sourceIndex] of [[0, 71, 0], [264, 359, 191]]) {
      for (let i = start; i <= end; i++) {
        assert.ok(difference(frameAt(pixels, i), frameAt(normalized, sourceIndex)) < 16,
          `Bookend frame ${i} must remain derived from its own video endpoint`);
      }
      assert.ok(difference(frameAt(pixels, start), frameAt(pixels, end)) > 1, "Each bookend must actually zoom");
    }
    const audioPath = join(root, "movie-audio.pcm");
    await runMediaCommand(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-protocol_whitelist", "file,pipe", "-i", mediaCommandPath(movie),
      "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "s16le", mediaCommandPath(audioPath),
    ], { label: "Measure synthetic soundtrack", timeoutMs: 60_000 });
    const audio = await readFile(audioPath);
    const rms = (start: number, end: number) => {
      let sum = 0;
      for (let sampleIndex = start * 48000; sampleIndex < end * 48000; sampleIndex++) {
        sum += (audio.readInt16LE(sampleIndex * 2) / 32768) ** 2;
      }
      return Math.sqrt(sum / ((end - start) * 48000));
    };
    assert.ok(rms(0, 2.95) < 0.001, "Opening is silent before native audio starts at 3 seconds");
    assert.ok(rms(3.05, 10.95) > 0.04, "The original tone must be audible throughout the eight-second middle");
    assert.ok(rms(11.05, 14.95) < 0.001, "Closing is silent after native audio ends at 11 seconds");
    assert.deepEqual(await readdir(join(sample.config.dataDir, "render-tmp")), []);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("bookends reject missing, corrupt and short media rather than substituting stills", { timeout: 120_000 }, async () => {
  assert.ok(ffmpeg);
  const root = resolve(`.bookend-failure-test-${randomUUID()}`);
  const sample = await mediaFixture(root, "four-shot");
  const source = join(root, "hero.mp4");
  sample.paths.set(sample.input.hero!.assetId, source);
  try {
    const renderer = createRenderer(sample.config);
    await assert.rejects(renderer.render(sample.input, sample.context), hasCode("RENDER_FAILED"));
    await writeFile(source, "not a video");
    await assert.rejects(renderer.render(sample.input, sample.context), hasCode("RENDER_FAILED"));
    await runMediaCommand(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", mediaCommandPath(source),
    ], { label: "Create short synthetic clip", timeoutMs: 60_000 });
    await assert.rejects(renderer.render(sample.input, sample.context), hasCode("RENDER_INVALID_OUTPUT"));
    await assert.rejects(createContinuationReference(sample.config, sample.input.hero!, sample.context), hasCode("RENDER_INVALID_OUTPUT"));
    await syntheticClip(source);
    await writeFile(sample.still, "corrupt approved image");
    await assert.rejects(renderer.render(sample.input, sample.context), hasCode("RENDER_FAILED"));
    await rm(sample.still);
    await assert.rejects(renderer.render(sample.input, sample.context), hasCode("RENDER_FAILED"));
    assert.equal(sample.saved.length, 0, "Failures must never save a substituted movie");
    assert.deepEqual(await readdir(join(sample.config.dataDir, "render-tmp")), []);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

async function syntheticClip(path: string, variant = 0, audio = true): Promise<void> {
  await runMediaCommand(ffmpeg!, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=8",
    ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=${660 + variant * 330}:sample_rate=48000:duration=8`] : []),
    "-vf", ["null", "hflip", "hflip,vflip"][variant],
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-threads", "2", ...(audio ? ["-c:a", "aac"] : ["-an"]), "-t", "8", mediaCommandPath(path),
  ], { label: "Create distinct synthetic eight-second clip", timeoutMs: 60_000 });
}

async function decodedAudio(movie: string, output: string): Promise<Buffer> {
  await runMediaCommand(ffmpeg!, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-protocol_whitelist", "file,pipe", "-i", mediaCommandPath(movie),
    "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "s16le", mediaCommandPath(output),
  ], { label: "Decode synthetic clip soundtracks", timeoutMs: 60_000 });
  return readFile(output);
}

function audioRms(audio: Buffer, start: number, end: number): number {
  let sum = 0;
  const first = Math.round(start * 48000);
  const last = Math.round(end * 48000);
  for (let i = first; i < last; i++) sum += (audio.readInt16LE(i * 2) / 32768) ** 2;
  return Math.sqrt(sum / (last - first));
}

function toneStrength(audio: Buffer, second: number, frequency: number): number {
  let real = 0;
  let imaginary = 0;
  const count = 4800;
  for (let i = 0; i < count; i++) {
    const value = audio.readInt16LE((Math.round(second * 48000) + i) * 2) / 32768;
    const angle = 2 * Math.PI * frequency * i / 48000;
    real += value * Math.cos(angle);
    imaginary += value * Math.sin(angle);
  }
  return Math.hypot(real, imaginary) / count;
}

test("real 13/18/23/28-second movies use distinct moving clips, exact outer endpoints and independently aligned audio", { timeout: 600_000 }, async t => {
  const root = resolve(`.multi-bookend-test-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  try {
    const sources = [0, 1, 2].map(i => join(root, `source-${i}.mp4`));
    for (let i = 0; i < sources.length; i++) await syntheticClip(sources[i], i);
    const silent = join(root, "silent.mp4");
    await syntheticClip(silent, 1, false);
    for (const [caseIndex, duration] of ([13, 18, 23, 28] as const).entries()) {
      await t.test(`${duration} seconds`, async () => {
        const format = caseIndex % 2 ? "six-shot" : "four-shot";
        const fixtureRoot = join(root, `case-${duration}`);
        const sample = await mediaFixture(fixtureRoot, format);
        sample.config.dataDir = root;
        const preset = getMovieFormat(duration);
        sample.input.movieDurationSeconds = duration;
        sample.input.videoClips = Array.from({ length: preset.clipCount }, (_, index) =>
          index === 0 ? sample.input.hero! : { ...sample.input.hero!, assetId: randomUUID() });
        for (const [index, clip] of sample.input.videoClips.entries()) {
          sample.paths.set(clip.assetId, duration === 18 && index === 1 ? silent : sources[index]);
        }
        const original = structuredClone(sample.input);
        const normalized: Buffer[] = [];
        const frameBytes = 160 * 90;
        const frame = (pixels: Buffer, index: number) => pixels.subarray(index * frameBytes, (index + 1) * frameBytes);
        let inspectionError: unknown;
        const report = sample.context.report;
        sample.context.report = async event => {
          await report(event);
          if (event.shotId !== "shot_01") return;
          try {
            const workRoot = join(root, "render-tmp");
            const entries = await readdir(workRoot);
            assert.equal(entries.length, 1);
            const work = join(workRoot, entries[0]);
            const expectedFiles = ["opening.png", "closing.png", ...sample.input.videoClips!.map((_, i) => `segment-${i + 1}.mp4`)];
            assert.deepEqual((await readdir(work)).sort(), expectedFiles.sort());
            for (let i = 0; i < preset.clipCount; i++) {
              normalized.push(await decodedPixels(join(work, `segment-${i + 1}.mp4`), join(fixtureRoot, `normalized-${i}.gray`)));
            }
            for (const [bookend, clipIndex, frameIndex] of [["opening", 0, 0], ["closing", preset.clipCount - 1, 191]] as const) {
              const expected = join(fixtureRoot, `${bookend}-expected.png`);
              await runMediaCommand(ffmpeg!, [
                "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                "-protocol_whitelist", "file,pipe", "-i", mediaCommandPath(join(work, `segment-${clipIndex + 1}.mp4`)),
                "-vf", `select=eq(n\\,${frameIndex})`, "-frames:v", "1", "-fps_mode", "passthrough",
                "-threads", "1", "-update", "1", mediaCommandPath(expected),
              ], { label: "Verify exact multi-clip endpoint", timeoutMs: 60_000 });
              assert.deepEqual(await sharp(await readFile(join(work, `${bookend}.png`))).raw().toBuffer(),
                await sharp(await readFile(expected)).raw().toBuffer());
            }
          } catch (error) {
            inspectionError = error;
            throw error;
          }
        };
        const result = await createRenderer(sample.config).render(sample.input, sample.context).catch(error => {
          throw inspectionError ?? error;
        });
        assert.equal(result.durationSeconds, duration);
        assert.equal(result.renderLayout, "video-bookends");
        assert.equal(result.mode, "hybrid-video");
        assert.equal(result.hasAudio, true);
        assert.equal(sample.saved.length, 1);
        assert.deepEqual(sample.input, original);
        assert.equal(sample.events.length, preset.clipCount + 3);
        assert.equal(normalized.length, preset.clipCount);
        const movie = sample.paths.get(result.assetId)!;
        const timeline = getRenderTimeline(format, sample.input.plan.templateId, "video-bookends", duration);
        const probe = await probeMedia(ffprobe.path, movie, undefined, true);
        assert.equal(validateRenderedMedia(probe, true, timeline), duration);
        assert.equal(probe.video?.frameCount, duration * 24);
        const pixels = await decodedPixels(movie, join(fixtureRoot, "movie.gray"));
        assert.equal(pixels.length, duration * 24 * frameBytes);
        for (let clipIndex = 0; clipIndex < preset.clipCount; clipIndex++) {
          assert.equal(normalized[clipIndex].length, 192 * frameBytes);
          const offset = preset.openingSeconds * 24 + clipIndex * 192;
          for (let i = 0; i < 192; i++) {
            assert.ok(difference(frame(pixels, offset + i), frame(normalized[clipIndex], i)) < 2,
              `Clip ${clipIndex}, frame ${i} must be actual source footage in the correct order`);
          }
          assert.ok(difference(frame(pixels, offset + 24), frame(pixels, offset + 144)) > 8);
          if (clipIndex) assert.ok(difference(frame(normalized[clipIndex - 1], 72), frame(normalized[clipIndex], 72)) > 20);
        }
        const endOfOpening = preset.openingSeconds * 24 - 1;
        const startOfClosing = (duration - preset.closingSeconds) * 24;
        assert.ok(difference(frame(pixels, endOfOpening), frame(normalized[0], 0)) < 2);
        assert.ok(difference(frame(pixels, startOfClosing), frame(normalized.at(-1)!, 191)) < 2);
        assert.ok(difference(frame(pixels, 0), frame(pixels, endOfOpening)) > 1);
        assert.ok(difference(frame(pixels, startOfClosing), frame(pixels, duration * 24 - 1)) > 1);
        const audio = await decodedAudio(movie, join(fixtureRoot, "movie.pcm"));
        assert.ok(audioRms(audio, 0, preset.openingSeconds - 0.05) < 0.001);
        assert.ok(audioRms(audio, duration - preset.closingSeconds + 0.05, duration - 0.05) < 0.001);
        for (let i = 0; i < preset.clipCount; i++) {
          const start = preset.openingSeconds + i * 8;
          const level = audioRms(audio, start + 0.05, start + 7.95);
          if (duration === 18 && i === 1) {
            assert.ok(level < 0.001, "A clip with no audio must leave its own eight-second window silent");
          } else {
            assert.ok(level > 0.04);
            assert.ok(toneStrength(audio, start + 1, 660 + i * 330) > 0.02, "Each native tone must occur in its own clip window");
            for (let other = 0; other < preset.clipCount; other++) {
              if (other !== i) assert.ok(toneStrength(audio, start + 1, 660 + other * 330) < 0.002);
            }
          }
        }
        if (duration === 28) {
          const music = join(root, "synthetic-music.wav");
          await runMediaCommand(ffmpeg!, [
            "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=1",
            "-c:a", "pcm_s16le", mediaCommandPath(music),
          ], { label: "Create looping synthetic music", timeoutMs: 60_000 });
          sample.context.report = report;
          const mixedResult = await createRenderer({ ...sample.config, musicPath: music }).render(sample.input, sample.context);
          const mixedMovie = sample.paths.get(mixedResult.assetId)!;
          assert.equal(validateRenderedMedia(await probeMedia(ffprobe.path, mixedMovie, undefined, true), true, timeline), 28);
          const mixedAudio = await decodedAudio(mixedMovie, join(fixtureRoot, "mixed.pcm"));
          assert.ok(audioRms(mixedAudio, 0.75, 1.75) > 0.01, "Music must play over the opening bookend");
          assert.ok(audioRms(mixedAudio, 26.1, 27) > 0.005, "Music must extend over the closing bookend with its normal fade");
          for (let i = 0; i < 3; i++) {
            const second = preset.openingSeconds + i * 8 + 1;
            assert.ok(toneStrength(mixedAudio, second, 660 + i * 330) > 0.02);
            assert.ok(toneStrength(mixedAudio, second, 220) > 0.005);
          }
          assert.deepEqual(sample.input, original);
        }
        assert.deepEqual(await readdir(join(root, "render-tmp")), []);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("continuation references use exact normalized frame 191 and reject unowned or invalid clips without changing approvals", { timeout: 180_000 }, async () => {
  const root = resolve(`.continuation-reference-test-${randomUUID()}`);
  const sample = await mediaFixture(root, "four-shot", true);
  const source = join(root, "source.mp4");
  sample.paths.set(sample.input.hero!.assetId, source);
  const original = structuredClone(sample.input);
  try {
    await syntheticClip(source, 2);
    const owned = await sample.context.media.getAsset(sample.input.hero!.assetId);
    for (const changed of [
      { ownerId: "another-owner" }, { jobId: randomUUID() }, { id: randomUUID() },
      { kind: "storyboard" as const }, { mime: "image/png" },
    ]) {
      sample.records.set(owned.id, { ...owned, ...changed });
      await assert.rejects(createContinuationReference(sample.config, sample.input.hero!, sample.context), hasCode("ASSET_NOT_FOUND"));
      await assert.rejects(createRenderer(sample.config).render(sample.input, sample.context), hasCode("ASSET_NOT_FOUND"));
    }
    sample.records.set(owned.id, owned);
    const referenceId = await createContinuationReference(sample.config, sample.input.hero!, sample.context);
    assert.equal(sample.saved.length, 1);
    const reference = sample.saved[0];
    assert.equal(reference.id, referenceId);
    assert.equal(reference.kind, "storyboard");
    assert.equal(reference.mime, "image/png");
    assert.equal(reference.ownerId, sample.context.ownerId);
    assert.equal(reference.jobId, sample.context.jobId);
    assert.equal(reference.width, 1280);
    assert.equal(reference.height, 720);
    assert.deepEqual(sample.input, original);
    const normalized = join(root, "expected-normalized.mp4");
    const expected = join(root, "expected-last.png");
    await runMediaCommand(ffmpeg!, buildHeroArguments(source, normalized, getRenderTimeline(), false), {
      label: "Normalize synthetic expected continuation", timeoutMs: 120_000,
    });

    test("additional clips fail closed on ownership, provider, duplicate IDs, missing files and corrupt or short video", { timeout: 120_000 }, async () => {
      const root = resolve(`.multi-clip-failure-test-${randomUUID()}`);
      const sample = await mediaFixture(root, "six-shot");
      const first = join(root, "first.mp4");
      const second = join(root, "second.mp4");
      const continuation = { ...sample.input.hero!, assetId: randomUUID() };
      sample.input.movieDurationSeconds = 18;
      sample.input.videoClips = [sample.input.hero!, continuation];
      sample.paths.set(sample.input.hero!.assetId, first);
      sample.paths.set(continuation.assetId, second);
      try {
        await syntheticClip(first);
        const renderer = createRenderer(sample.config);
        await assert.rejects(renderer.render(sample.input, sample.context), hasCode("RENDER_FAILED"));
        await writeFile(second, "corrupt continuation");
        await assert.rejects(renderer.render(sample.input, sample.context), hasCode("RENDER_FAILED"));
        await runMediaCommand(ffmpeg!, [
          "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
          "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=1",
          "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", mediaCommandPath(second),
        ], { label: "Create incomplete synthetic continuation", timeoutMs: 60_000 });
        await assert.rejects(renderer.render(sample.input, sample.context), hasCode("RENDER_INVALID_OUTPUT"));
        const owned = await sample.context.media.getAsset(continuation.assetId);
        sample.records.set(continuation.assetId, { ...owned, ownerId: "another-owner" });
        await assert.rejects(renderer.render(sample.input, sample.context), hasCode("ASSET_NOT_FOUND"));
        sample.records.set(continuation.assetId, { ...owned, jobId: randomUUID() });
        await assert.rejects(renderer.render(sample.input, sample.context), hasCode("ASSET_NOT_FOUND"));
        sample.input.videoClips = [sample.input.hero!, { ...continuation, provider: "OpenAI Sora" }];
        await assert.rejects(renderer.render(sample.input, sample.context), hasCode("INVALID_RENDER_INPUT"));
        sample.input.videoClips = [sample.input.hero!, sample.input.hero!];
        await assert.rejects(renderer.render(sample.input, sample.context), hasCode("INVALID_RENDER_INPUT"));
        sample.input.videoClips = [sample.input.hero!];
        await assert.rejects(renderer.render(sample.input, sample.context), hasCode("ANIMATION_REQUIRED"));
        assert.equal(sample.saved.length, 0);
        assert.deepEqual(await readdir(join(root, "render-tmp")), []);
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    });
    await runMediaCommand(ffmpeg!, buildBookendExtractionArguments(normalized, expected, "closing"), {
      label: "Extract synthetic expected continuation", timeoutMs: 60_000,
    });
    assert.deepEqual(await sharp(await readFile(sample.paths.get(referenceId)!)).raw().toBuffer(),
      await sharp(await readFile(expected)).raw().toBuffer());
    assert.deepEqual(await readdir(join(root, "continuation-tmp")), []);
    await writeFile(source, "not a video");
    sample.records.delete(owned.id);
    await assert.rejects(createContinuationReference(sample.config, sample.input.hero!, sample.context), hasCode("RENDER_FAILED"));
    await rm(source);
    await assert.rejects(createContinuationReference(sample.config, sample.input.hero!, sample.context), hasCode("RENDER_FAILED"));
    assert.equal(sample.saved.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
