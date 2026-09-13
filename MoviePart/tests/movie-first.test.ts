import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import {
  getTimeline, type AssetRecord, type CharacterReference, type MovieJob, type MoviePlan,
  type StoryboardFrame,
} from "../src/domain";
import type { GenerationContext, MovieConfig } from "../src/domain/services";
import { createOpenAIServices, type OpenAITransport } from "../src/providers/openai";
import { executeMovie, type PipelineServices } from "../src/pipeline";
import { validateRenderInput } from "../src/render";
import { jobView } from "../src/server/api";
import { MovieRecovery } from "../src/components/movie-recovery";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

async function fixture() {
  const jobId = randomUUID();
  const ownerId = "movie-first-test";
  const saved = new Map<string, { asset: AssetRecord; bytes: Uint8Array }>();
  const sceneFrames: StoryboardFrame[] = [];
  const extracted: StoryboardFrame[] = [];
  const events: string[] = [];
  const context: GenerationContext = {
    jobId, ownerId, signal: new AbortController().signal,
    media: {
      async getAsset(id) { const value = saved.get(id); assert.ok(value); return value.asset; },
      async readAsset(id) { const value = saved.get(id); assert.ok(value); return value.bytes; },
      async assetPath() { throw new Error("Not used by in-memory test"); },
      async saveAsset(input) {
        const asset: AssetRecord = {
          id: randomUUID(), ownerId: input.ownerId, jobId: input.jobId, kind: input.kind,
          mime: input.mime, filename: "test", bytes: input.bytes.length, width: input.width ?? null,
          height: input.height ?? null, createdAt: new Date().toISOString(),
        };
        saved.set(asset.id, { asset, bytes: input.bytes });
        return asset;
      },
    },
    report: async update => { events.push(update.stage); },
    warn: async () => {},
    recordOperation: async () => {},
    saveFrame: async frame => { extracted.push(frame); },
    saveSceneFrame: async frame => { sceneFrames.push(frame); },
  };
  const png = await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#306090" } }).png().toBuffer();
  const photo = await context.media.saveAsset({ ownerId, jobId: null, kind: "customer", mime: "image/png", bytes: png });
  const productPhotos = await Promise.all([0, 1].map(() => context.media.saveAsset({
    ownerId: "shared:catalog", jobId: null, kind: "product", mime: "image/png", bytes: png,
  })));
  const character: CharacterReference = {
    id: randomUUID(), version: 1, primaryAssetId: photo.id, sourceImages: [{ assetId: photo.id, origin: "original", role: "primary" }],
    consent: { likeness: true, personalization: true },
    attributes: { face: null, eyes: null, eyebrows: null, nose: null, mouth: null, hair: null, complexion: null,
      visibleProportions: null, wardrobe: "Source clothes", accessories: [] },
  };
  const timeline = getTimeline();
  const plan: MoviePlan = {
    id: randomUUID(), characterId: character.id, productId: "test-car", templateId: "DREAM_ROUTE", templateVersion: 1,
    referenceVersion: 1, durationSeconds: 18, aspectRatio: "16:9", heroShotId: "shot_03",
    wardrobe: "Source clothes", logline: "A test journey", cinematicStyle: "Warm", worldTransitions: "None",
    personalizationUsed: [],
    shots: timeline.shotIds.map((id, index) => ({
      id, durationSeconds: timeline.durations[index], purpose: "Journey", camera: "Tracking", action: "Drive",
      environment: "Coast", lighting: "Evening", personalization: [], imagePrompt: "Use references",
      motionPrompt: "Gentle move", audioCues: [],
    })),
  };
  const prior = await context.media.saveAsset({ ownerId, jobId, kind: "storyboard", mime: "image/png", bytes: png, width: 1280, height: 720 });
  const frame: StoryboardFrame = {
    shotId: "shot_01", assetId: prior.id, provider: "OpenAI", model: "test",
    continuity: { verdict: "RETRY", reasons: ["Cosmetic mismatch"], confidence: 0.9 },
  };
  const job: MovieJob = {
    id: jobId, ownerId, status: "RECEIVED", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    request: {
      schema_version: 1, session_id: "test", idempotency_key: randomUUID(), customer_reference_asset_ids: [photo.id],
      primary_reference_asset_id: photo.id, consent: character.consent, product_id: "test-car",
      preferred_template: "DREAM_ROUTE", personalization_profile: { signals: [] }, enable_hero_video: false,
    },
    productionMode: "movie-first",
    product: { id: "test-car", version: 1, name: "Synthetic test", make: null, model: null, exteriorColor: "red", interiorColor: "black",
      appearance: "Test car", approvedClaims: [], usagePermission: "Synthetic test assets",
      referenceImages: productPhotos.map((asset, index) => ({ assetId: asset.id, origin: "original", role: index ? "interior" : "exterior" })) },
    events: [], warnings: [], operations: [], error: null, character, plan, frames: [frame], result: null, hero: null,
  };
  const config: MovieConfig = { dataDir: "unused", imageModel: "gpt-image-2.5-flare", veoModel: "test" };
  let reviews = 0;
  const edits: string[] = [];
  const transport: OpenAITransport = {
    async respond() { reviews++; throw new Error("Movie-first must not call the continuity critic"); },
    async edit(input) {
      assert.equal(input.model, config.imageModel);
      const data = JSON.parse(input.prompt.split("\n").at(-1)!);
      edits.push(data.shot.id);
      return { created: 1, data: [{ b64_json: png.toString("base64") }] };
    },
  };
  return { job, plan, frame, config, context, png, edits, events, sceneFrames, extracted,
    get reviews() { return reviews; }, storyboard: createOpenAIServices(config, { transport }).storyboard };
}

test("movie-first reuses a cosmetic RETRY visual, generates remaining scenes once and never calls continuity", async () => {
  const f = await fixture();
  const frames = await f.storyboard.generate({
    plan: f.plan, character: f.job.character!, product: f.job.product,
    existingFrames: f.job.frames, productionMode: "movie-first",
  }, { ...f.context, saveFrame: f.context.saveSceneFrame! });
  assert.equal(frames.length, 4);
  assert.equal(frames[0].assetId, f.frame.assetId);
  assert.deepEqual(f.edits, ["shot_02", "shot_03", "shot_04"]);
  assert.equal(f.reviews, 0);
  assert.ok(frames.slice(1).every(frame => frame.continuity.verdict === "NOT_REVIEWED"));
  assert.equal(f.extracted.length, 0);
  assert.equal(f.sceneFrames.length, 3);
  assert.throws(() => validateRenderInput({ plan: f.plan, frames, hero: null }, f.job.id), /PASS/);
  assert.doesNotThrow(() => validateRenderInput({ plan: f.plan, frames, hero: null, productionMode: "movie-first" }, f.job.id));
  assert.throws(() => validateRenderInput({ plan: f.plan, frames: frames.slice(0, 2), hero: null, productionMode: "movie-first" }, f.job.id), /one approved storyboard frame/);
});

test("encoded movie is checkpointed before extraction and returned without artificial PASS verdicts", async () => {
  const f = await fixture();
  const order: string[] = [];
  const services: PipelineServices = {
    references: { extract: async () => assert.fail("Saved reference should be reused") },
    director: { plan: async () => assert.fail("Saved plan should be reused") },
    storyboard: f.storyboard,
    video: { generate: async () => assert.fail("No video provider was selected") },
    renderer: {
      ready: async () => ({ available: true, message: "Test" }),
      render: async input => {
        order.push("render");
        assert.equal(input.productionMode, "movie-first");
        assert.equal(input.frames.length, 4);
        const asset = await f.context.media.saveAsset({ ownerId: f.job.ownerId, jobId: f.job.id, kind: "video", mime: "video/mp4", bytes: new Uint8Array([1]) });
        return { assetId: asset.id, durationSeconds: 18, hasAudio: false, mode: "image-motion" };
      },
    },
    extract: async (_config, plan, movie, context) => {
      order.push("extract");
      assert.deepEqual(order, ["render", "checkpoint", "extract"]);
      assert.ok(movie.assetId);
      const frames: StoryboardFrame[] = plan.shots.map((shot, index) => ({
        shotId: shot.id, assetId: randomUUID(), source: "extracted", extractedAtSeconds: index,
        provider: "FFmpeg", model: "frame-extraction", continuity: { verdict: "NOT_REVIEWED", reasons: [], confidence: 0 },
      }));
      for (const frame of frames) await context.saveFrame(frame);
      return frames;
    },
  };
  const movie = await executeMovie(f.job, f.context, async patch => {
    assert.ok(patch.result);
    order.push("checkpoint");
    f.job.result = patch.result!;
  }, f.config, services);
  assert.equal(movie.mode, "image-motion");
  assert.equal(f.reviews, 0);
  assert.equal(f.extracted.length, 4);
  assert.ok(f.events.includes("EXTRACTING_STORYBOARD"));
  const view = jobView({ ...f.job, status: "COMPLETED", frames: [...f.job.frames, ...f.extracted] });
  assert.deepEqual(view.result, movie);
  assert.equal(view.frames.length, 4);
  assert.ok(view.frames.every(frame => frame.source === "extracted" && frame.continuity.verdict === "NOT_REVIEWED"));
});

test("movie-first UI offers one clear production action instead of another continuity retry loop", async () => {
  const f = await fixture();
  const view = jobView({ ...f.job, status: "FAILED" });
  const html = renderToStaticMarkup(createElement(MovieRecovery, {
    job: view, retrying: false, disabled: false, onRetry() {}, onMakeMovie() {},
  }));
  assert.match(html, /Make movie from this plan/);
  assert.match(html, /No continuity score or approval is required/);
  assert.match(html, /not fully generated moving footage/);
  assert.doesNotMatch(html, /Retry failed and remaining shots/);
});
