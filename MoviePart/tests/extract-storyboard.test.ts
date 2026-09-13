import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import ffmpeg from "ffmpeg-static";
import sharp from "sharp";
import {
  getTimeline, MovieError, storyboardFrameSchema,
  type AssetRecord, type MoviePlan, type RenderResult, type StoryboardFrame, type StoryFormat, type TemplateId,
} from "../src/domain";
import type { GenerationContext, MovieConfig } from "../src/domain/services";
import { extractStoryboard } from "../src/render/extract-storyboard";
import { mediaCommandPath } from "../src/render/paths";
import { runMediaCommand } from "../src/render/process";
import { LocalMediaRepository } from "../src/server/media";

const hasCode = (code: string) => (error: unknown) => error instanceof MovieError && error.code === code;
const colors = ["red", "lime", "blue", "yellow", "magenta", "cyan"];
const rgb = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255]];

function planFixture(storyFormat?: StoryFormat, templateId: TemplateId = "DREAM_ROUTE"): MoviePlan {
  const timeline = getTimeline(storyFormat, templateId);
  return {
    id: randomUUID(), characterId: randomUUID(), productId: "synthetic-extraction",
    templateId, templateVersion: 1, referenceVersion: 1, storyFormat,
    durationSeconds: timeline.durationSeconds, aspectRatio: "16:9", heroShotId: timeline.heroShotId,
    logline: "Synthetic finished movie", wardrobe: "None", cinematicStyle: "Solid colors",
    worldTransitions: "Hard cuts", personalizationUsed: [],
    shots: timeline.shotIds.map((id, index) => ({
      id, durationSeconds: timeline.durations[index], purpose: "Synthetic shot",
      camera: "Static", action: "None", environment: "Solid color", lighting: "Even",
      personalization: [], imagePrompt: "Must not be used", motionPrompt: "Must not be used", audioCues: [],
    })),
  };
}

async function fixture(root: string, plan = planFixture()) {
  const config: MovieConfig = { dataDir: join(root, "private data"), imageModel: "unused", veoModel: "unused" };
  await mkdir(config.dataDir, { recursive: true });
  const media = new LocalMediaRepository(config.dataDir);
  const jobId = randomUUID();
  const ownerId = "synthetic-extraction-owner";
  const controller = new AbortController();
  const events: Parameters<GenerationContext["report"]>[0][] = [];
  const warnings: string[] = [];
  const saved: AssetRecord[] = [];
  const checkpoints: StoryboardFrame[] = [];
  const order: string[] = [];
  const reads: string[] = [];
  const context: GenerationContext = {
    jobId, ownerId, signal: controller.signal,
    media: {
      getAsset: async id => { reads.push(id); return media.getAsset(id); },
      assetPath: async id => media.assetPath(id),
      readAsset: async () => assert.fail("The extractor must not load input photos or provider images"),
      saveAsset: async input => {
        const record = await media.saveAsset(input);
        saved.push(record);
        order.push(`asset:${record.id}`);
        return record;
      },
    },
    report: async event => { events.push(event); },
    warn: async message => { warnings.push(message); },
    recordOperation: async () => assert.fail("Extraction must not call a provider"),
    saveFrame: async frame => {
      assert.equal((await media.getAsset(frame.assetId)).kind, "storyboard");
      checkpoints.push(frame);
      order.push(`checkpoint:${frame.assetId}`);
    },
  };
  const sentinel = join(config.dataDir, "storyboard-tmp", "unrelated-job");
  await mkdir(sentinel, { recursive: true });
  await writeFile(join(sentinel, "keep.txt"), "Do not remove another job's files");
  const assertClean = async () => {
    assert.deepEqual(await readdir(join(config.dataDir, "storyboard-tmp")), [basename(sentinel)]);
    assert.equal(await readFile(join(sentinel, "keep.txt"), "utf8"), "Do not remove another job's files");
  };
  const storeMovie = async (bytes: Uint8Array, changes: Partial<Parameters<typeof media.saveAsset>[0]> = {}) => {
    const asset = await media.saveAsset({
      ownerId, jobId, kind: "video", mime: "video/mp4", bytes, width: 1280, height: 720, ...changes,
    });
    const movie: RenderResult = {
      assetId: asset.id, mode: "storyboard-motion", durationSeconds: plan.durationSeconds, hasAudio: false,
    };
    return movie;
  };
  return { config, plan, media, context, controller, events, warnings, saved, checkpoints, order, reads, assertClean, storeMovie };
}

async function syntheticMovie(root: string, plan: MoviePlan, audio = false): Promise<Buffer> {
  assert.ok(ffmpeg);
  let startFrame = 0;
  const filters: string[] = [];
  for (let index = 0; index < plan.shots.length; index++) {
    const frames = plan.shots[index].durationSeconds * 24;
    const midpoint = startFrame + frames / 2;
    filters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=${colors[index]}:t=fill:enable='between(n,${startFrame},${startFrame + frames - 1})'`);
    // This white marker exists for exactly one frame, distinguishing the
    // true midpoint from a keyframe, shot boundary, or neighboring frame.
    filters.push(`drawbox=x=608:y=328:w=64:h=64:color=white:t=fill:enable='eq(n,${midpoint})'`);
    startFrame += frames;
  }
  const output = join(root, `${randomUUID()} & colored movie.mp4`);
  await runMediaCommand(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", `color=c=black:s=1280x720:r=24:d=${plan.durationSeconds}`,
    ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${plan.durationSeconds}`] : []),
    "-vf", [...filters, "setsar=1"].join(","),
    "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-crf", "0", "-pix_fmt", "yuv420p",
    "-frames:v", String(plan.durationSeconds * 24), "-t", String(plan.durationSeconds),
    ...(audio ? ["-c:a", "aac"] : ["-an"]),
    "-movflags", "+faststart", mediaCommandPath(output),
  ], { label: "Synthetic exact-midpoint movie", timeoutMs: 60_000 });
  const bytes = await readFile(output);
  await rm(output);
  return bytes;
}

test("actual MP4 extraction preserves four/six-shot timing, exact midpoint pixels, provenance and checkpoints", { timeout: 180_000 }, async t => {
  const root = resolve(`.extraction-test ${randomUUID()} & private`);
  await mkdir(root);
  try {
    for (const [format, template, expectedTimes, audio] of [
      ["four-shot", "DREAM_ROUTE", [1.5, 4.5, 10, 16], false],
      ["six-shot", "DREAM_ROUTE", [1.5, 4.5, 7, 12, 17.5, 21], false],
      ["six-shot", "HERO_OF_THE_DAY", [1.5, 4.5, 7.5, 13, 18.5, 22], true],
    ] as const) {
      await t.test(`${format} ${template}${audio ? " with audio" : ""}`, async () => {
        const sample = await fixture(join(root, `${format}-${template}`), planFixture(format, template));
        const movie = await sample.storeMovie(await syntheticMovie(root, sample.plan, audio));
        movie.hasAudio = audio;
        assert.deepEqual(sample.saved, []);
        assert.deepEqual(sample.checkpoints, []);
        const frames = await extractStoryboard(sample.config, sample.plan, movie, sample.context);
        assert.deepEqual(frames.map(frame => frame.shotId), sample.plan.shots.map(shot => shot.id));
        assert.deepEqual(frames.map(frame => frame.extractedAtSeconds), expectedTimes);
        assert.deepEqual(sample.checkpoints, frames);
        assert.deepEqual(sample.order, frames.flatMap(frame => [`asset:${frame.assetId}`, `checkpoint:${frame.assetId}`]));
        assert.deepEqual(sample.reads, [movie.assetId]);
        assert.deepEqual(sample.warnings, []);
        assert.equal(sample.events.length, frames.length);
        assert.ok(sample.events.every(event => event.stage === "EXTRACTING_STORYBOARD" && event.provider === "FFmpeg"));
        assert.deepEqual(sample.events.map(event => event.shotId), frames.map(frame => frame.shotId));
        let start = 0;
        for (let index = 0; index < frames.length; index++) {
          const frame = storyboardFrameSchema.parse(frames[index]);
          assert.equal(frame.source, "extracted");
          assert.equal(frame.provider, "FFmpeg");
          assert.equal(frame.model, "frame-extraction");
          assert.deepEqual(frame.continuity, {
            verdict: "NOT_REVIEWED", reasons: ["Extracted from the finished movie; not a continuity approval."], confidence: 0,
          });
          assert.ok(frame.extractedAtSeconds !== undefined);
          assert.ok(frame.extractedAtSeconds >= start && frame.extractedAtSeconds < start + sample.plan.shots[index].durationSeconds);
          assert.ok(frame.extractedAtSeconds < movie.durationSeconds);
          assert.ok(Number.isInteger(frame.extractedAtSeconds * 24));
          const asset: AssetRecord = sample.saved[index];
          assert.equal(asset.kind, "storyboard");
          assert.equal(asset.mime, "image/png");
          assert.equal(asset.ownerId, sample.context.ownerId);
          assert.equal(asset.jobId, sample.context.jobId);
          assert.equal(asset.width, 1280);
          assert.equal(asset.height, 720);
          assert.ok(asset.bytes > 0 && asset.bytes <= 10 * 1024 * 1024);
          const decoded = await sharp(await sample.media.readAsset(asset.id)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
          assert.equal(decoded.info.width, 1280);
          assert.equal(decoded.info.height, 720);
          const pixel = (x: number, y: number) => [...decoded.data.subarray((y * 1280 + x) * 3, (y * 1280 + x) * 3 + 3)];
          assert.ok(pixel(40, 40).every((value, channel) => Math.abs(value - rgb[index][channel]) <= 4), `Expected ${colors[index]} for ${frame.shotId}`);
          assert.ok(pixel(640, 360).every(value => value >= 250), `The marker exists only at the exact midpoint ${frame.extractedAtSeconds}s`);
          start += sample.plan.shots[index].durationSeconds;
        }
        await sample.assertClean();
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid plans and movie descriptors are rejected before any repository access or decoding", async () => {
  const root = resolve(`.extraction-validation-${randomUUID()}`);
  const sample = await fixture(root);
  try {
    const movie: RenderResult = { assetId: randomUUID(), mode: "storyboard-motion", durationSeconds: 18, hasAudio: false };
    for (const mutate of [
      (plan: MoviePlan) => { plan.shots.pop(); },
      (plan: MoviePlan) => { plan.shots.reverse(); },
      (plan: MoviePlan) => { plan.shots[1].id = "shot_01"; },
      (plan: MoviePlan) => { plan.shots[0].durationSeconds = 4; },
      (plan: MoviePlan) => { plan.shots[3].durationSeconds = -1; },
      (plan: MoviePlan) => { plan.heroShotId = "shot_04"; },
      (plan: MoviePlan) => { plan.durationSeconds = 23; },
    ]) {
      const plan = structuredClone(sample.plan);
      mutate(plan);
      await assert.rejects(extractStoryboard(sample.config, plan, movie, sample.context), hasCode("INVALID_STORYBOARD_EXTRACTION_INPUT"));
    }
    await assert.rejects(extractStoryboard(sample.config, sample.plan, { ...movie, assetId: "..\\outside" }, sample.context), hasCode("INVALID_STORYBOARD_EXTRACTION_INPUT"));
    await assert.rejects(extractStoryboard(sample.config, sample.plan, { ...movie, durationSeconds: 23 }, sample.context), hasCode("RENDER_INVALID_OUTPUT"));
    await assert.rejects(extractStoryboard(sample.config, sample.plan, movie, { ...sample.context, jobId: "..\\outside" }), hasCode("INVALID_STORYBOARD_EXTRACTION_INPUT"));
    for (const path of ["https://example.invalid/ffmpeg", "\\\\server\\ffmpeg.exe", "ffmpeg\nbad", " "]) {
      await assert.rejects(extractStoryboard({ ...sample.config, ffmpegPath: path }, sample.plan, movie, sample.context), hasCode("RENDERER_UNAVAILABLE"));
    }
    assert.deepEqual(sample.reads, []);
    assert.deepEqual(sample.saved, []);
    assert.deepEqual(sample.checkpoints, []);
    await sample.assertClean();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only a valid, owned, local finished MP4 can produce output; failures and cancellation clean owned work", { timeout: 120_000 }, async t => {
  const root = resolve(`.extraction-failures-${randomUUID()}`);
  const sample = await fixture(root);
  try {
    const bytes = await syntheticMovie(root, sample.plan);
    const movie = await sample.storeMovie(bytes);
    await t.test("missing movie and mismatched owner, job, kind or MIME never produce a storyboard", async () => {
      await assert.rejects(extractStoryboard(sample.config, sample.plan, { ...movie, assetId: randomUUID() }, sample.context), hasCode("ASSET_NOT_FOUND"));
      for (const changes of [
        { ownerId: "another-owner" }, { jobId: randomUUID() }, { jobId: null },
        { kind: "storyboard" as const }, { mime: "image/png" },
      ]) {
        const foreign = await sample.storeMovie(bytes, changes);
        await assert.rejects(extractStoryboard(sample.config, sample.plan, foreign, sample.context), hasCode("ASSET_NOT_FOUND"));
      }
    });
    await t.test("corrupt, missing and empty movie files cannot be trusted based on metadata", async () => {
      const corrupt = await sample.storeMovie(Buffer.from("not an MP4"));
      await assert.rejects(extractStoryboard(sample.config, sample.plan, corrupt, sample.context), hasCode("RENDER_FAILED"));
      const empty = await sample.storeMovie(Buffer.alloc(0));
      await assert.rejects(extractStoryboard(sample.config, sample.plan, empty, sample.context), hasCode("RENDER_INVALID_OUTPUT"));
      const missing = await sample.storeMovie(bytes);
      await rm(await sample.media.assetPath(missing.assetId));
      await assert.rejects(extractStoryboard(sample.config, sample.plan, missing, sample.context), hasCode("RENDER_FAILED"));
    });
    await t.test("actual duration and audio must match the plan and result", async () => {
      await assert.rejects(extractStoryboard(sample.config, sample.plan, { ...movie, hasAudio: true }, sample.context), hasCode("RENDER_INVALID_OUTPUT"));
      const six = planFixture("six-shot");
      await assert.rejects(extractStoryboard(sample.config, six, { ...movie, durationSeconds: 23 }, sample.context), hasCode("RENDER_INVALID_OUTPUT"));
    });
    await t.test("repository paths cannot escape the private data root or name a network input", async () => {
      const outside = join(root, "outside-managed-data.mp4");
      await writeFile(outside, bytes);
      for (const path of [outside, "https://example.invalid/movie.mp4", "\\\\server\\movie.mp4", "relative.mp4"]) {
        const context: GenerationContext = { ...sample.context, media: { ...sample.context.media, assetPath: async () => path } };
        await assert.rejects(extractStoryboard(sample.config, sample.plan, movie, context), hasCode("RENDER_INVALID_OUTPUT"));
      }
    });
    assert.deepEqual(sample.saved, []);
    assert.deepEqual(sample.checkpoints, []);
    assert.deepEqual(sample.events, []);
    await sample.assertClean();
    await t.test("an already aborted request does not even look up the movie", async () => {
      const reads = sample.reads.length;
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(extractStoryboard(sample.config, sample.plan, movie, { ...sample.context, signal: controller.signal }), hasCode("RENDER_CANCELLED"));
      assert.equal(sample.reads.length, reads);
    });
    await t.test("aborting an active extraction saves no frames and preserves unrelated intermediates", async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await assert.rejects(extractStoryboard(sample.config, sample.plan, movie, {
          ...sample.context, signal: controller.signal,
          report: async () => { timer = setTimeout(() => controller.abort(), 10); },
        }), hasCode("RENDER_CANCELLED"));
      } finally {
        clearTimeout(timer);
      }
      assert.deepEqual(sample.saved, []);
      assert.deepEqual(sample.checkpoints, []);
      await sample.assertClean();
    });
    await t.test("a failed checkpoint stops extraction after its saved asset and cleans intermediates", async () => {
      await assert.rejects(extractStoryboard(sample.config, sample.plan, movie, {
        ...sample.context, saveFrame: async () => { throw new Error("Synthetic checkpoint failure"); },
      }), hasCode("RENDER_FAILED"));
      assert.equal(sample.saved.length, 1);
      assert.deepEqual(sample.checkpoints, []);
      await sample.assertClean();
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
