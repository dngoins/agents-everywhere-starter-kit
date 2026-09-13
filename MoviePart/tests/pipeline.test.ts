import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { executeMovie, type PipelineServices } from "../src/pipeline";
import {
  type CharacterReference, type MovieJob, type MoviePlan, type StoryboardFrame,
  type JobStatus, type RenderResult, MovieError,
} from "../src/domain";
import type { GenerationContext } from "../src/domain/services";

function fixture(enableHero = false) {
  const photoId = randomUUID();
  const jobId = randomUUID();
  const character: CharacterReference = {
    id: randomUUID(), version: 1, sourceImages: [{ assetId: photoId, role: "front", origin: "original" }],
    primaryAssetId: photoId, consent: { likeness: true, personalization: true },
    attributes: { face: null, eyes: null, eyebrows: null, nose: null, mouth: null, hair: null, complexion: null, visibleProportions: null, wardrobe: "Source outfit", accessories: [] },
  };
  const plan: MoviePlan = {
    id: randomUUID(), characterId: character.id, productId: "demo", templateId: "DREAM_ROUTE",
    templateVersion: 1, referenceVersion: 1, durationSeconds: 18, aspectRatio: "16:9", heroShotId: "shot_03",
    logline: "A scenic drive", wardrobe: "Source outfit", cinematicStyle: "Warm", worldTransitions: "None", personalizationUsed: [],
    shots: (["shot_01", "shot_02", "shot_03", "shot_04"] as const).map((id, index) => ({
      id, durationSeconds: [3, 3, 8, 4][index], purpose: "Journey", camera: "Tracking",
      action: "Driving", environment: "Coast", lighting: "Day", personalization: [],
      imagePrompt: "References", motionPrompt: "Slow", audioCues: [],
    })),
  };
  const frames: StoryboardFrame[] = plan.shots.map(shot => ({
    shotId: shot.id, assetId: randomUUID(), continuity: { verdict: "PASS", reasons: [], confidence: 0.9 },
    provider: "Explicit test double", model: "test",
  }));
  const job: MovieJob = {
    id: jobId, ownerId: "test", request: {
      schema_version: 1, session_id: "robot-session", customer_reference_asset_ids: [photoId], primary_reference_asset_id: photoId,
      consent: { likeness: true, personalization: true }, product_id: "demo", personalization_profile: { signals: [] },
      preferred_template: "DREAM_ROUTE", enable_hero_video: enableHero, idempotency_key: randomUUID(),
    },
    product: {
      id: "demo", version: 1, name: "Synthetic test car", make: null, model: null, exteriorColor: "red",
      interiorColor: null, appearance: "Test shape", approvedClaims: [], usagePermission: "Generated test data",
      referenceImages: [0, 1].map(() => ({ assetId: randomUUID(), role: "exterior", origin: "original" })),
    },
    status: "RECEIVED", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    events: [], warnings: [], error: null, character: null, plan: null, frames: [], hero: null, result: null, operations: [],
  };
  const stages: JobStatus[] = [];
  const warnings: string[] = [];
  const checkpoints: object[] = [];
  const context: GenerationContext = {
    jobId, ownerId: "test", signal: new AbortController().signal,
    media: {
      getAsset: async () => { throw new Error("Unexpected media read in orchestration test"); },
      readAsset: async () => { throw new Error("Unexpected media read in orchestration test"); },
      assetPath: async () => { throw new Error("Unexpected media read in orchestration test"); },
      saveAsset: async () => { throw new Error("Unexpected media write in orchestration test"); },
    },
    report: async update => { stages.push(update.stage); },
    warn: async warning => { warnings.push(warning); },
    recordOperation: async () => {},
    saveFrame: async () => {},
  };
  let videoCalls = 0;
  const result: RenderResult = { assetId: randomUUID(), mode: "storyboard-motion", durationSeconds: 18, hasAudio: false };
  const services: PipelineServices = {
    references: { extract: async input => { assert.equal(input.primaryAssetId, photoId); return character; } },
    director: { plan: async input => { assert.equal(input.character.id, character.id); return plan; } },
    storyboard: { generate: async input => { assert.equal(input.plan.id, plan.id); return frames; } },
    video: { generate: async (_input, ctx) => { videoCalls++; await ctx.warn("Optional video unavailable; using approved still."); return null; } },
    renderer: {
      ready: async () => ({ available: true, message: "Test renderer" }),
      render: async input => { assert.equal(input.frames.length, 4); assert.equal(input.hero, null); return result; },
    },
  };
  return {
    services, stages, warnings, checkpoints, result, job, plan, frames, get videoCalls() { return videoCalls; },
    run: () => executeMovie(job, context, async patch => { checkpoints.push(patch); },
      { dataDir: "unused", imageModel: "test", veoModel: "test" }, services),
  };
}

test("orchestrator persists references and plan and renders baseline without calling video", async () => {
  const sample = fixture();
  assert.deepEqual(await sample.run(), sample.result);
  assert.equal(sample.videoCalls, 0);
  assert.equal(sample.checkpoints.length, 2);
  assert.deepEqual(sample.stages, ["BUILDING_REFERENCES", "DIRECTING", "ASSEMBLING"]);
});
test("optional video failure still renders a truthful baseline", async () => {
  const sample = fixture(true);
  assert.equal((await sample.run()).mode, "storyboard-motion");
  assert.equal(sample.videoCalls, 1);
  assert.equal(sample.warnings.length, 1);
  assert.deepEqual(sample.checkpoints.at(-1), { hero: null });
});
test("renderer preflight fails before a paid reference service runs", async () => {
  const sample = fixture();
  sample.services.renderer.ready = async () => ({ available: false, message: "FFmpeg missing" });
  sample.services.references.extract = async () => { assert.fail("Must not make a paid call"); };
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "RENDERER_UNAVAILABLE");
});

test("OpenAI hybrid requires a genuine Sora clip and cannot fall back to still-image motion", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "openai-sora";
  sample.plan.videoProvider = "openai-sora";
  let rendered = false;
  sample.services.renderer.render = async () => { rendered = true; return sample.result; };
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "ANIMATION_REQUIRED");
  assert.equal(rendered, false);
});

test("approved stills and the Sora animation are both required in the final hybrid output", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "openai-sora";
  sample.plan.videoProvider = "openai-sora";
  const clip = { assetId: randomUUID(), shotId: "shot_03" as const, provider: "OpenAI Sora" as const, model: "sora-2", operationId: "video_test" };
  sample.services.video.generate = async input => {
    assert.ok(input.frames.every(frame => frame.continuity.verdict === "PASS"));
    assert.equal(input.plan.videoProvider, "openai-sora");
    return clip;
  };
  sample.services.renderer.render = async input => {
    assert.equal(input.frames.length, 4);
    assert.deepEqual(input.hero, clip);
    return { ...sample.result, mode: "hybrid-video" };
  };
  assert.equal((await sample.run()).mode, "hybrid-video");
  assert.deepEqual(sample.checkpoints.at(-1), { hero: clip });
});

test("an existing Sora operation is resumed, while uncertain untracked submissions fail closed", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "openai-sora";
  sample.plan.videoProvider = "openai-sora";
  sample.job.heroAttempted = true;
  sample.services.video.generate = async () => assert.fail("Untracked submissions must not be repeated");
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "SORA_SUBMISSION_UNCERTAIN");
  sample.job.operations.push({ provider: "OpenAI Sora", id: "video_existing" });
  sample.services.video.generate = async input => {
    assert.equal(input.operationId, "video_existing");
    throw new MovieError("SORA_PENDING", "Existing operation still running");
  };
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "SORA_PENDING");
});

test("explicit Veo selection fails rather than completing a slideshow when animation is unavailable", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "google-veo";
  sample.plan.videoProvider = "google-veo";
  sample.services.renderer.render = async () => assert.fail("Required animation must not fall back to stills");
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "ANIMATION_REQUIRED");
});

test("explicit Veo selection combines an actual provider clip with approved stills", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "google-veo";
  sample.plan.videoProvider = "google-veo";
  const clip = { assetId: randomUUID(), shotId: "shot_03" as const, provider: "Google Veo" as const, model: "veo-3.1-generate-preview" };
  sample.services.video.generate = async () => clip;
  sample.services.renderer.render = async input => {
    assert.deepEqual(input.hero, clip);
    assert.equal(input.frames.length, 4);
    return { ...sample.result, mode: "hybrid-video" };
  };
  assert.equal((await sample.run()).mode, "hybrid-video");
});
