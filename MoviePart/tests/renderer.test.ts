import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import sharp from "sharp";
import {
  getTimeline, MovieError, type MoviePlan, type StoryboardFrame, type AssetRecord,
  type VideoArtifact, type StoryFormat, type TemplateId,
} from "../src/domain";
import type { GenerationContext, MovieConfig } from "../src/domain/services";
import { createRenderer, validateRenderInput } from "../src/render";
import { buildAssemblyArguments, buildHeroArguments, buildStillArguments } from "../src/render/arguments";
import { parseProbeOutput, probeMedia, validateRenderedMedia } from "../src/render/probe";
import { runMediaCommand } from "../src/render/process";
import { mediaCommandPath } from "../src/render/paths";

function inputFixture(storyFormat?: StoryFormat, templateId: TemplateId = "DREAM_ROUTE") {
  const timeline = getTimeline(storyFormat, templateId);
  const plan: MoviePlan = {
    id: randomUUID(), characterId: randomUUID(), productId: "synthetic-test",
    templateId, templateVersion: 1, referenceVersion: 1,
    ...(storyFormat ? { storyFormat } : {}),
    durationSeconds: timeline.durationSeconds, aspectRatio: "16:9", heroShotId: timeline.heroShotId,
    logline: "Synthetic renderer test", wardrobe: "Not applicable", cinematicStyle: "Geometric",
    worldTransitions: "Hard cuts", personalizationUsed: [],
    shots: timeline.shotIds.map((id, index) => ({
      id, durationSeconds: timeline.durations[index], purpose: "Synthetic geometry",
      camera: "Gentle pan", action: "None", environment: "Plain background",
      lighting: "Even", personalization: [], imagePrompt: "Colored geometric shapes",
      motionPrompt: "Gentle zoom", audioCues: [],
    })),
  };
  const frames: StoryboardFrame[] = plan.shots.map(shot => ({
    shotId: shot.id, assetId: randomUUID(),
    continuity: { verdict: "PASS", reasons: [], confidence: 1 },
    provider: "Synthetic test fixture", model: "No generation provider",
  }));
  return { plan, frames, hero: null as VideoArtifact | null };
}

const configFor = (dataDir: string): MovieConfig => ({ dataDir, imageModel: "unused", veoModel: "unused" });
const hasCode = (code: string) => (error: unknown) => error instanceof MovieError && error.code === code;

test("renderer rejects non-PASS frames and any change to the fixed shot timeline or identities", () => {
  const valid = inputFixture();
  assert.doesNotThrow(() => validateRenderInput(valid, randomUUID()));
  for (const mutate of [
    (input: ReturnType<typeof inputFixture>) => { input.frames.pop(); },
    (input: ReturnType<typeof inputFixture>) => { input.frames.push(input.frames[0]); },
    (input: ReturnType<typeof inputFixture>) => { input.frames[2].continuity.verdict = "RETRY"; },
    (input: ReturnType<typeof inputFixture>) => { input.frames[2].continuity.verdict = "REJECT"; },
    (input: ReturnType<typeof inputFixture>) => { input.frames[1].shotId = "shot_01"; },
    (input: ReturnType<typeof inputFixture>) => { input.frames.reverse(); },
    (input: ReturnType<typeof inputFixture>) => { input.frames[0].assetId = "..\\private-file"; },
    (input: ReturnType<typeof inputFixture>) => { input.plan.shots[0].durationSeconds = 4; input.plan.shots[3].durationSeconds = 3; },
    (input: ReturnType<typeof inputFixture>) => { input.plan.shots[1].id = "shot_01"; },
    (input: ReturnType<typeof inputFixture>) => {
      input.hero = { assetId: randomUUID(), shotId: "shot_02", provider: "Google Veo", model: "test" } as unknown as VideoArtifact;
    },
    (input: ReturnType<typeof inputFixture>) => {
      input.hero = { assetId: randomUUID(), shotId: "shot_04", provider: "Google Veo", model: "test" };
    },
  ]) {
    const input = structuredClone(valid);
    mutate(input);
    assert.throws(() => validateRenderInput(input, randomUUID()), hasCode("INVALID_RENDER_INPUT"));
  }
  assert.throws(() => validateRenderInput(valid, "..\\another-job"), hasCode("INVALID_RENDER_INPUT"));
});

test("six-shot validation enforces template timing, frame order, total duration and the fourth-shot hero", () => {
  for (const templateId of ["DREAM_ROUTE", "HERO_OF_THE_DAY"] as const) {
    const valid = inputFixture("six-shot", templateId);
    valid.hero = { assetId: randomUUID(), shotId: "shot_04", provider: "Google Veo", model: "test" };
    assert.doesNotThrow(() => validateRenderInput(valid, randomUUID()));
    for (const mutate of [
      (input: typeof valid) => { input.frames.pop(); },
      (input: typeof valid) => { input.frames.reverse(); },
      (input: typeof valid) => { input.frames[5].continuity.verdict = "REJECT"; },
      (input: typeof valid) => { input.plan.shots[2].durationSeconds = 8; },
      (input: typeof valid) => { input.plan.durationSeconds = 18; },
      (input: typeof valid) => { input.plan.heroShotId = "shot_03"; },
      (input: typeof valid) => { input.hero!.shotId = "shot_03"; },
      (input: typeof valid) => { delete input.plan.storyFormat; },
    ]) {
      const input = structuredClone(valid);
      mutate(input);
      assert.throws(() => validateRenderInput(input, randomUUID()), hasCode("INVALID_RENDER_INPUT"));
    }
  }
});

test("FFmpeg argument arrays preserve Windows spaces and metacharacters without interpolating paths into filters", () => {
  const source = "C:\\Private Data\\a & (b)\\frame's %PATH%; $(echo nope).png";
  const target = "C:\\Private Data\\job\\final movie.mp4";
  const music = "C:\\Licensed Music\\bed's [v]; & tune.wav";
  for (let index = 0; index < 4; index++) {
    const args = buildStillArguments(source, target, index);
    assert.equal(args[args.indexOf("-i") + 1], source);
    assert.equal(args.at(-1), target);
    assert.equal(args[args.indexOf("-frames:v") + 1], String([72, 72, 192, 96][index]));
    const filter = args[args.indexOf("-vf") + 1];
    assert.ok(!filter.includes(source));
    assert.match(filter, /force_original_aspect_ratio=decrease/);
    assert.match(filter, /setsar=1/);
    assert.match(filter, /zoompan=/);
    assert.ok(args.includes("-an"));
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,pipe");
  }
  const hero = buildHeroArguments(source, target);
  assert.ok(hero.includes("-an"));
  assert.match(hero[hero.indexOf("-vf") + 1], /tpad=stop_mode=clone:stop_duration=8/);
  assert.equal(hero[hero.indexOf("-frames:v") + 1], "192");
  const paths = [0, 1, 2, 3].map(index => `C:\\Private Data\\job\\shot ${index}.mp4`);
  const args = buildAssemblyArguments(paths, target, music);
  assert.deepEqual(args.flatMap((arg, index) => arg === "-i" ? [args[index + 1]] : []), [...paths, music]);
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(filter, /concat=n=4:v=1:a=0/);
  assert.ok(!filter.includes("xfade") && !filter.includes(music));
  assert.equal(args[args.indexOf("-frames:v") + 1], "432");
  assert.equal(args[args.indexOf("-t") + 1], "18");
  assert.ok(args.includes("aac") && args.includes("+faststart"));
  assert.ok(buildAssemblyArguments(paths, target).includes("-an"));
  assert.throws(() => buildAssemblyArguments(paths.slice(1), target), hasCode("INVALID_RENDER_INPUT"));
  assert.throws(() => buildStillArguments(source, target, 4), hasCode("INVALID_RENDER_INPUT"));
  if (process.platform === "win32") {
    const longPath = `C:\\Private Data\\${"nested\\".repeat(40)}movie.mp4`;
    assert.match(mediaCommandPath(longPath), /^\\\\\?\\/);
    assert.equal(mediaCommandPath(source), source);
  }
});

test("six-shot arguments derive durations, concat inputs, music index and fade from the selected template", () => {
  const source = "C:\\Private Data\\source & literal.png";
  const output = "C:\\Private Data\\final movie.mp4";
  const music = "C:\\Licensed Music\\bed & literal.wav";
  for (const templateId of ["DREAM_ROUTE", "HERO_OF_THE_DAY"] as const) {
    const timeline = getTimeline("six-shot", templateId);
    const expectedDuration = templateId === "HERO_OF_THE_DAY" ? 24 : 23;
    const expectedFrames = templateId === "HERO_OF_THE_DAY" ? [72, 72, 72, 192, 72, 96] : [72, 72, 48, 192, 72, 96];
    for (let index = 0; index < 6; index++) {
      const args = buildStillArguments(source, output, index, timeline);
      assert.equal(args[args.indexOf("-frames:v") + 1], String(expectedFrames[index]));
    }
    const paths = timeline.shotIds.map(id => `C:\\Private Data\\${id}.mp4`);
    const args = buildAssemblyArguments(paths, output, music, timeline);
    assert.deepEqual(args.flatMap((arg, index) => arg === "-i" ? [args[index + 1]] : []), [...paths, music]);
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.ok(filter.startsWith("[0:v:0][1:v:0][2:v:0][3:v:0][4:v:0][5:v:0]concat=n=6:v=1:a=0[v]"));
    assert.ok(filter.includes(`[6:a:0]aresample=48000,atrim=duration=${expectedDuration}`));
    assert.ok(filter.includes(`afade=t=out:st=${expectedDuration - 2}:d=2[music]`));
    assert.ok(filter.includes("[music]anull[a]"));
    assert.equal(args[args.indexOf("-frames:v") + 1], String(expectedDuration * 24));
    assert.equal(args[args.indexOf("-t") + 1], String(expectedDuration));
    const hero = buildHeroArguments(source, output, timeline);
    assert.equal(hero[hero.indexOf("-frames:v") + 1], "192");
    assert.ok(buildAssemblyArguments(paths, output, undefined, timeline).includes("-an"));
    assert.throws(() => buildAssemblyArguments(paths.slice(0, 4), output, music, timeline), hasCode("INVALID_RENDER_INPUT"));
    assert.throws(() => buildStillArguments(source, output, 6, timeline), hasCode("INVALID_RENDER_INPUT"));
  }
});

function probeFixture(audio = false, durationSeconds = 18) {
  return {
    streams: [
      {
        codec_type: "video", codec_name: "h264", width: 1280, height: 720,
        pix_fmt: "yuv420p", avg_frame_rate: "24/1", r_frame_rate: "24/1",
        nb_frames: String(durationSeconds * 24), nb_read_frames: String(durationSeconds * 24),
        duration: String(durationSeconds), sample_aspect_ratio: "1:1",
      },
      ...(audio ? [{ codec_type: "audio", codec_name: "aac", duration: String(durationSeconds) }] : []),
    ],
    format: { duration: String(durationSeconds), format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
  };
}

test("FFprobe extraction validates actual frames, duration, codecs, aspect ratio, and truthful audio", () => {
  const valid = parseProbeOutput(JSON.stringify(probeFixture()));
  assert.equal(valid.video?.frameCount, 432);
  assert.equal(valid.video?.frameRate, 24);
  assert.equal(validateRenderedMedia(valid, false), 18);
  assert.equal(validateRenderedMedia(parseProbeOutput(JSON.stringify(probeFixture(true))), true), 18);
  for (const mutate of [
    (probe: typeof valid) => { probe.video!.frameCount = 431; },
    (probe: typeof valid) => { probe.video!.durationSeconds = 17.99; },
    (probe: typeof valid) => { probe.video!.width = 1920; },
    (probe: typeof valid) => { probe.video!.height = 1080; },
    (probe: typeof valid) => { probe.video!.codec = "vp9"; },
    (probe: typeof valid) => { probe.video!.pixelFormat = "yuv444p"; },
    (probe: typeof valid) => { probe.video!.frameRate = 30; },
    (probe: typeof valid) => { probe.video!.sampleAspectRatio = "4:3"; },
    (probe: typeof valid) => { probe.video = null; },
    (probe: typeof valid) => { probe.videoStreamCount = 2; },
    (probe: typeof valid) => { probe.durationSeconds = null; },
    (probe: typeof valid) => { probe.formatName = "matroska,webm"; },
    (probe: typeof valid) => { probe.formatName = null; },
  ]) {
    const probe = structuredClone(valid);
    mutate(probe);
    assert.throws(() => validateRenderedMedia(probe, false), hasCode("RENDER_INVALID_OUTPUT"));
  }
  assert.throws(() => validateRenderedMedia(valid, true), hasCode("RENDER_INVALID_OUTPUT"));
  assert.throws(() => validateRenderedMedia(parseProbeOutput(JSON.stringify(probeFixture(true))), false), hasCode("RENDER_INVALID_OUTPUT"));
  assert.throws(() => parseProbeOutput("not json"), hasCode("RENDER_INVALID_OUTPUT"));
  assert.throws(() => parseProbeOutput("{}"), hasCode("RENDER_INVALID_OUTPUT"));
  const irregular = probeFixture();
  irregular.streams[0].avg_frame_rate = "0/0";
  irregular.streams[0].nb_read_frames = "N/A";
  irregular.streams[0].duration = "N/A";
  const fallback = parseProbeOutput(JSON.stringify(irregular));
  assert.equal(fallback.video?.frameRate, 24);
  assert.equal(fallback.video?.frameCount, 432);
  assert.equal(fallback.video?.durationSeconds, 18);
  irregular.streams[0].r_frame_rate = "24/0";
  irregular.streams[0].nb_frames = "432garbage";
  const invalid = parseProbeOutput(JSON.stringify(irregular));
  assert.equal(invalid.video?.frameRate, null);
  assert.equal(invalid.video?.frameCount, null);
});

test("FFprobe verifies six-shot frame counts and durations against the requested template, not the filename", () => {
  for (const templateId of ["DREAM_ROUTE", "HERO_OF_THE_DAY"] as const) {
    const timeline = getTimeline("six-shot", templateId);
    const expectedDuration = templateId === "HERO_OF_THE_DAY" ? 24 : 23;
    for (const audio of [false, true]) {
      const probe = parseProbeOutput(JSON.stringify(probeFixture(audio, expectedDuration)));
      assert.equal(validateRenderedMedia(probe, audio, timeline), expectedDuration);
      assert.throws(() => validateRenderedMedia(probe, audio), hasCode("RENDER_INVALID_OUTPUT"));
      for (const mutate of [
        (value: typeof probe) => { value.video!.frameCount! -= 1; },
        (value: typeof probe) => { value.video!.durationSeconds = 18; },
        (value: typeof probe) => { value.durationSeconds = 18; },
        (value: typeof probe) => { value.formatName = "matroska,webm"; },
        (value: typeof probe) => { value.audioStreamCount = audio ? 0 : 1; },
      ]) {
        const invalid = structuredClone(probe);
        mutate(invalid);
        assert.throws(() => validateRenderedMedia(invalid, audio, timeline), hasCode("RENDER_INVALID_OUTPUT"));
      }
      if (audio) {
        probe.audio!.durationSeconds = 18;
        assert.throws(() => validateRenderedMedia(probe, true, timeline), hasCode("RENDER_INVALID_OUTPUT"));
      }
    }
  }
});

test("process execution is shell-free, cancellable, timed, bounded, and never returns private stderr", async () => {
  const value = "C:\\Private path\\$(echo bad) & 'literal' %PATH%;";
  assert.equal(await runMediaCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1])", value], {
    label: "Argument test",
  }), value);
  await assert.rejects(runMediaCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    label: "Timeout test", timeoutMs: 50,
  }), hasCode("RENDER_TIMEOUT"));
  const controller = new AbortController();
  const running = runMediaCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    label: "Cancellation test", signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(running, hasCode("RENDER_CANCELLED"));
  await assert.rejects(runMediaCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(65536))"], {
    label: "Output limit test", outputLimitBytes: 100,
  }), hasCode("RENDER_FAILED"));
  await assert.rejects(runMediaCommand(process.execPath, [
    "-e", "process.stderr.write('C:\\\\Private\\\\customer-secret.png api-key=private-value\\nInvalid data found');process.exit(1)",
  ], { label: "Sanitization test" }), (error: unknown) => {
    assert.ok(error instanceof MovieError);
    assert.equal(error.code, "RENDER_FAILED");
    assert.match(error.message, /could not be decoded/);
    assert.doesNotMatch(error.message, /Private|customer-secret|private-value|api-key/);
    return true;
  });
});

test("renderer readiness fails for missing FFmpeg and ffprobe overrides without falling back", async () => {
  const config = configFor(resolve(".renderer-unused"));
  assert.equal((await createRenderer({ ...config, ffmpegPath: resolve("missing-ffmpeg.exe") }).ready()).available, false);
  assert.equal((await createRenderer({ ...config, ffprobePath: resolve("missing-ffprobe.exe") }).ready()).available, false);
});

async function createMediaFixture(root: string, storyFormat?: StoryFormat, templateId?: TemplateId) {
  await mkdir(root, { recursive: true });
  const input = inputFixture(storyFormat, templateId);
  const records = new Map<string, AssetRecord>();
  const paths = new Map<string, string>();
  const requestedIds: string[] = [];
  const events: Parameters<GenerationContext["report"]>[0][] = [];
  const warnings: string[] = [];
  const jobId = randomUUID();
  const controller = new AbortController();
  const context: GenerationContext = {
    jobId, ownerId: "synthetic-render-test", signal: controller.signal,
    media: {
      getAsset: async id => {
        const record = records.get(id);
        assert.ok(record, "Only fixture-owned assets may be read");
        return record;
      },
      readAsset: async id => {
        const path = paths.get(id);
        assert.ok(path);
        return readFile(path);
      },
      assetPath: async id => {
        requestedIds.push(id);
        const path = paths.get(id);
        assert.ok(path, "The renderer must resolve opaque IDs through the repository");
        return path;
      },
      saveAsset: async asset => {
        const id = randomUUID();
        const path = join(root, `${id} saved video.mp4`);
        await writeFile(path, asset.bytes);
        const record: AssetRecord = {
          id, ownerId: asset.ownerId, jobId: asset.jobId, kind: asset.kind, mime: asset.mime,
          filename: "opaque-test-asset", bytes: asset.bytes.length,
          width: asset.width ?? null, height: asset.height ?? null, createdAt: new Date().toISOString(),
        };
        records.set(id, record);
        paths.set(id, path);
        return record;
      },
    },
    report: async event => { events.push(event); },
    warn: async warning => { warnings.push(warning); },
    recordOperation: async () => { assert.fail("Renderer must not call a network provider"); },
    saveFrame: async () => { assert.fail("Renderer must not change approved storyboard frames"); },
  };
  for (let index = 0; index < input.frames.length; index++) {
    const width = [640, 240, 640, 720][index % 4];
    const height = [360, 360, 360, 240][index % 4];
    const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="${["#ce463a", "#399264", "#3860b8", "#a254bd"][index % 4]}"/>
      <circle cx="${width / 2}" cy="${height / 2}" r="65" fill="#f8d43c"/>
      <rect x="${width / 2 - 40}" y="${height / 2 - 20}" width="80" height="40" fill="#202020"/>
    </svg>`);
    // Deliberately use unrelated, extensionless names: the media repository
    // owns its storage format, and FFmpeg must sniff the actual image bytes.
    const path = join(root, `opaque media ${index} & [test] ' data`);
    await sharp(svg).png().toFile(path);
    paths.set(input.frames[index].assetId, path);
  }
  return { input, context, paths, records, requestedIds, events, warnings, controller };
}

async function assertFastStart(path: string) {
  const bytes = await readFile(path);
  let offset = 0;
  const boxes: string[] = [];
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    boxes.push(type);
    if (size < 8) break;
    offset += size;
  }
  assert.ok(boxes.includes("moov") && boxes.includes("mdat"));
  assert.ok(boxes.indexOf("moov") < boxes.indexOf("mdat"), "MP4 metadata must precede media for browser fast-start");
}

test("real local renderer produces exact baseline and hybrid MP4s and cleans only its own files", { timeout: 420_000 }, async t => {
  const root = resolve(`.renderer-test ${randomUUID()} & private`);
  assert.ok(ffmpeg);
  const config = configFor(join(root, "private data"));
  const sample = await createMediaFixture(root);
  const sentinelRoot = join(config.dataDir, "render-tmp", `${randomUUID()}-unrelated`);
  await mkdir(sentinelRoot, { recursive: true });
  await writeFile(join(sentinelRoot, "keep.txt"), "An unrelated job must not be removed");
  const assertClean = async () => {
    assert.deepEqual(await readdir(join(config.dataDir, "render-tmp")), [sentinelRoot.split(/[\\/]/).at(-1)]);
    assert.equal(await readFile(join(sentinelRoot, "keep.txt"), "utf8"), "An unrelated job must not be removed");
  };
  try {
    await t.test("baseline has 432 frames, 18 seconds, H.264, square-pixel 720p, fast-start and no audio", async () => {
      const renderer = createRenderer(config);
      assert.equal((await renderer.ready()).available, true);
      const result = await renderer.render(sample.input, sample.context);
      assert.equal(result.mode, "storyboard-motion");
      assert.equal(result.durationSeconds, 18);
      assert.equal(result.hasAudio, false);
      assert.equal(sample.warnings.length, 1);
      assert.match(sample.warnings[0], /silent/);
      assert.equal(sample.events.length, 5);
      assert.ok(sample.events.every(event => event.stage === "ASSEMBLING" && event.provider === "FFmpeg"));
      assert.deepEqual(sample.requestedIds, sample.input.frames.map(frame => frame.assetId));
      const record = sample.records.get(result.assetId)!;
      assert.equal(record.kind, "video");
      assert.equal(record.mime, "video/mp4");
      assert.equal(record.ownerId, sample.context.ownerId);
      assert.equal(record.jobId, sample.context.jobId);
      const path = sample.paths.get(result.assetId)!;
      assert.equal(validateRenderedMedia(await probeMedia(ffprobe.path, path, undefined, true), false), 18);
      await assertFastStart(path);
      await assertClean();
    });

    const music = join(root, "team-created synthetic tune & test.wav");
    const hero = join(root, "short synthetic hero with native audio.mp4");
    await runMediaCommand(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-c:a", "pcm_s16le", music,
    ], { label: "Synthetic test music" });
    await runMediaCommand(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=cyan:s=320x240:r=30:d=2",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=2",
      "-vf", "setsar=4/3", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "2", hero,
    ], { label: "Synthetic test hero" });

    await t.test("hybrid normalizes a short 30fps hero and loops a one-second licensed test bed to 18 seconds", async () => {
      const heroId = randomUUID();
      sample.paths.set(heroId, hero);
      sample.input.hero = { assetId: heroId, shotId: "shot_03", provider: "Google Veo", model: "Synthetic test fixture" };
      const warningsBefore = sample.warnings.length;
      const result = await createRenderer({ ...config, musicPath: music }).render(sample.input, sample.context);
      assert.equal(result.mode, "hybrid-video");
      assert.equal(result.durationSeconds, 18);
      assert.equal(result.hasAudio, true);
      assert.equal(sample.warnings.length, warningsBefore);
      const path = sample.paths.get(result.assetId)!;
      assert.equal(validateRenderedMedia(await probeMedia(ffprobe.path, path, undefined, true), true), 18);
      await assertFastStart(path);
      await assertClean();
    });

    await t.test("hybrid preserves native hero audio without a music bed", async () => {
      const warningsBefore = sample.warnings.length;
      const result = await createRenderer(config).render(sample.input, sample.context);
      assert.equal(result.mode, "hybrid-video");
      assert.equal(result.hasAudio, true);
      assert.equal(sample.warnings.length, warningsBefore);
      assert.equal(validateRenderedMedia(await probeMedia(ffprobe.path, sample.paths.get(result.assetId)!, undefined, true), true), 18);
      await assertClean();
    });

    await t.test("six-shot DREAM_ROUTE renders 552 frames and 23 seconds without audio", async () => {
      const six = await createMediaFixture(join(root, "six-shot baseline"), "six-shot");
      const result = await createRenderer(config).render(six.input, six.context);
      assert.equal(result.mode, "storyboard-motion");
      assert.equal(result.durationSeconds, 23);
      assert.equal(result.hasAudio, false);
      assert.deepEqual(six.events.filter(event => event.shotId).map(event => event.shotId),
        ["shot_01", "shot_02", "shot_03", "shot_04", "shot_05", "shot_06"]);
      assert.deepEqual(six.requestedIds, six.input.frames.map(frame => frame.assetId));
      const path = six.paths.get(result.assetId)!;
      const probe = await probeMedia(ffprobe.path, path, undefined, true);
      assert.equal(probe.video?.frameCount, 552);
      assert.equal(validateRenderedMedia(probe, false, getTimeline("six-shot", "DREAM_ROUTE")), 23);
      await assertFastStart(path);
      await assertClean();
    });

    await t.test("six-shot HERO_OF_THE_DAY renders 576 frames and 24 seconds with its fourth-shot hero and music", async () => {
      const six = await createMediaFixture(join(root, "six-shot hero"), "six-shot", "HERO_OF_THE_DAY");
      const heroId = randomUUID();
      six.paths.set(heroId, hero);
      six.input.hero = { assetId: heroId, shotId: "shot_04", provider: "Google Veo", model: "Synthetic test fixture" };
      const result = await createRenderer({ ...config, musicPath: music }).render(six.input, six.context);
      assert.equal(result.mode, "hybrid-video");
      assert.equal(result.durationSeconds, 24);
      assert.equal(result.hasAudio, true);
      assert.deepEqual(six.warnings, []);
      assert.deepEqual(six.events.filter(event => event.message.startsWith("Normalizing")).map(event => event.shotId), ["shot_04"]);
      const path = six.paths.get(result.assetId)!;
      const probe = await probeMedia(ffprobe.path, path, undefined, true);
      assert.equal(probe.video?.frameCount, 576);
      assert.equal(validateRenderedMedia(probe, true, getTimeline("six-shot", "HERO_OF_THE_DAY")), 24);
      for (const [time, isHero] of [[6.5, false], [9.5, true], [16.5, true], [17.5, false]] as const) {
        const metadata = await runMediaCommand(ffmpeg!, [
          "-v", "error", "-ss", String(time), "-i", path,
          "-vf", "crop=16:16:632:0,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-",
          "-frames:v", "1", "-f", "null", "-",
        ], { label: "Synthetic fourth-shot placement check" });
        const luminance = Number(metadata.match(/lavfi.signalstats.YAVG=([\d.]+)/)?.[1]);
        assert.ok(Number.isFinite(luminance), "FFmpeg must decode the sampled frame");
        assert.equal(luminance > 160 && luminance < 180, isHero, `Cyan hero placement at ${time}s`);
      }
      await assertFastStart(path);
      await assertClean();
    });

    await t.test("hero normalization strips native audio even when no replacement music is supplied", async () => {
      const normalized = join(root, "normalized hero.mp4");
      await runMediaCommand(ffmpeg!, buildHeroArguments(hero, normalized), { label: "Synthetic hero normalization" });
      const probe = await probeMedia(ffprobe.path, normalized, undefined, true);
      assert.equal(probe.video?.frameCount, 192);
      assert.equal(probe.video?.frameRate, 24);
      assert.equal(probe.video?.durationSeconds, 8);
      assert.equal(probe.video?.width, 1280);
      assert.equal(probe.video?.height, 720);
      assert.equal(probe.video?.sampleAspectRatio, "1:1");
      assert.equal(probe.audioStreamCount, 0);
      const pixels = await runMediaCommand(ffmpeg!, [
        "-v", "error", "-i", normalized, "-vf", "crop=2:2:0:360,format=rgb24",
        "-frames:v", "1", "-f", "rawvideo", "pipe:1",
      ], { label: "Synthetic aspect-ratio check" });
      assert.ok(pixels.length > 0);
      // The 320x240, SAR 4:3 source fills 16:9. The left edge must be cyan,
      // not black pillarboxing caused by incorrectly treating it as 4:3.
      assert.ok(Buffer.from(pixels).some(value => value > 100));
    });

    await t.test("invalid configured music fails explicitly and is not silently discarded", async () => {
      const recordCount = sample.records.size;
      for (const musicPath of [join(root, "missing.wav"), sample.paths.get(sample.input.frames[0].assetId)!]) {
        await assert.rejects(createRenderer({ ...config, musicPath }).render(sample.input, sample.context), hasCode("INVALID_MUSIC"));
        assert.equal(sample.records.size, recordCount);
        await assertClean();
      }
    });

    await t.test("invalid source decoding cleans intermediates without touching other jobs", async () => {
      const recordCount = sample.records.size;
      await writeFile(sample.paths.get(sample.input.frames[1].assetId)!, "This is not an image");
      await assert.rejects(createRenderer(config).render(sample.input, sample.context), hasCode("RENDER_FAILED"));
      assert.equal(sample.records.size, recordCount);
      await assertClean();
    });

    await t.test("cancelled renders never persist a result", async () => {
      const recordCount = sample.records.size;
      const duringRender = new AbortController();
      const context: GenerationContext = {
        ...sample.context, signal: duringRender.signal,
        report: async event => { if (event.shotId === "shot_02") duringRender.abort(); },
      };
      await assert.rejects(createRenderer(config).render(sample.input, context), hasCode("RENDER_CANCELLED"));
      assert.equal(sample.records.size, recordCount);
      await assertClean();
      sample.controller.abort();
      await assert.rejects(createRenderer(config).render(sample.input, sample.context), hasCode("RENDER_CANCELLED"));
      assert.equal(sample.records.size, recordCount);
      await assertClean();
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
