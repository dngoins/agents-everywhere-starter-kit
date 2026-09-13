import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getMovieFormat, getRenderTimeline, getTimeline, MOVIE_DURATIONS, jobRequestSchema, renderResultSchema, validatePlan, type MoviePlan } from "../src/domain";
import { getTemplate, templates } from "../src/templates";

const profile = { signals: [{ value: "Egypt", source: "manual" as const, visualUseAllowed: true as const, confidence: null }] };
function plan(): MoviePlan {
  return {
    id: randomUUID(), characterId: randomUUID(), productId: "demo-car",
    templateId: "TOMORROW_DRIVE", templateVersion: 1, referenceVersion: 1,
    durationSeconds: 18, aspectRatio: "16:9", heroShotId: "shot_03",
    logline: "A drive toward a dream.", wardrobe: "Match primary photo.",
    cinematicStyle: "Warm cinema", worldTransitions: "Present to dream in shot three.",
    personalizationUsed: ["Egypt"],
    shots: (["shot_01", "shot_02", "shot_03", "shot_04"] as const).map((id, index) => ({
      id, durationSeconds: [3, 3, 8, 4][index], purpose: "Story beat",
      camera: "Tracking", action: "Driving", environment: "Desert", lighting: "Warm",
      personalization: ["Egypt"], imagePrompt: "Use references", motionPrompt: "Slow motion", audioCues: [],
    })),
  };
}

test("three distinct original templates each define four beats", () => {
  assert.deepEqual(templates.map(value => value.id), ["VELOCITY", "TOMORROW_DRIVE", "DREAM_ROUTE"]);
  assert.equal(new Set(templates.map(value => value.camera)).size, 3);
  templates.forEach(value => assert.equal(value.beats.length, 4));
  assert.match(getTemplate("TOMORROW_DRIVE").worldTransition, /transforms/);
});
test("director plans enforce timing and approved signals", () => {
  assert.equal(validatePlan(plan(), profile).durationSeconds, 18);
  const wrongDuration = plan();
  wrongDuration.shots[2].durationSeconds = 6;
  assert.throws(() => validatePlan(wrongDuration, profile), /four ordered shots/);
  const invented = plan();
  invented.shots[0].personalization = ["owns a golden retriever"];
  assert.throws(() => validatePlan(invented, profile), /unapproved/);
  const wrongOrder = plan();
  wrongOrder.shots.reverse();
  assert.throws(() => validatePlan(wrongOrder, profile), /ordered/);
});
test("API requires explicit consent and owned primary reference membership", () => {
  const id = randomUUID();
  const input = {
    schema_version: 1, session_id: "test", customer_reference_asset_ids: [id],
    primary_reference_asset_id: id, consent: { likeness: true, personalization: true },
    product_id: "demo-car", personalization_profile: profile, idempotency_key: randomUUID(),
  };
  const parsed = jobRequestSchema.parse(input);
  assert.equal(parsed.preferred_template, "DREAM_ROUTE");
  assert.equal(parsed.enable_hero_video, false);
  assert.equal(jobRequestSchema.safeParse({ ...input, consent: { likeness: false, personalization: true } }).success, false);
  assert.equal(jobRequestSchema.safeParse({ ...input, primary_reference_asset_id: randomUUID() }).success, false);
  assert.equal(jobRequestSchema.safeParse({ ...input, customer_reference_asset_ids: [id, id] }).success, false);
  assert.equal(jobRequestSchema.safeParse({ ...input, personalization_profile: { signals: Array(4).fill(profile.signals[0]) } }).success, false);
});

test("video bookends use a separate three-segment output timeline without changing the reference plan", () => {
  for (const format of ["four-shot", "six-shot"] as const) {
    for (const template of ["DREAM_ROUTE", "HERO_OF_THE_DAY"] as const) {
      const original = getTimeline(format, template);
      const output = getRenderTimeline(format, template, "video-bookends");
      assert.deepEqual(output.durations, [3, 8, 4]);
      assert.deepEqual(output.shotIds, [original.shotIds[0], original.heroShotId, original.shotIds.at(-1)]);
      assert.equal(output.durationSeconds, 15);
      assert.deepEqual(getRenderTimeline(format, template), original);
    }
  }
  assert.equal(renderResultSchema.parse({
    assetId: randomUUID(), mode: "hybrid-video", durationSeconds: 15, hasAudio: true, renderLayout: "video-bookends",
  }).renderLayout, "video-bookends");
});

test("video-bookend requests require actual generated video and cannot select image-motion fallback", () => {
  const id = randomUUID();
  const input = {
    schema_version: 1, session_id: "bookend-test", customer_reference_asset_ids: [id],
    primary_reference_asset_id: id, consent: { likeness: true, personalization: true },
    product_id: "demo-car", personalization_profile: profile, idempotency_key: randomUUID(),
    enable_hero_video: true, video_provider: "google-veo", render_layout: "video-bookends",
  };
  assert.equal(jobRequestSchema.parse(input).render_layout, "video-bookends");
  assert.equal(jobRequestSchema.safeParse({ ...input, enable_hero_video: false }).success, false);
  assert.equal(jobRequestSchema.safeParse({ ...input, video_provider: undefined }).success, false);
  assert.equal(jobRequestSchema.safeParse({ ...input, production_mode: "movie-first" }).success, false);
  assert.equal(jobRequestSchema.safeParse({ ...input, render_layout: "unknown" }).success, false);
  for (const duration of MOVIE_DURATIONS) {
    assert.equal(jobRequestSchema.parse({ ...input, movie_duration_seconds: duration }).movie_duration_seconds, duration);
    const selected = getMovieFormat(duration);
    const timeline = getRenderTimeline("six-shot", "DREAM_ROUTE", "video-bookends", duration);
    assert.equal(timeline.durationSeconds, duration);
    assert.equal(timeline.durations.reduce((sum, seconds) => sum + seconds, 0), duration);
    assert.equal(timeline.durations.length, selected.clipCount + 2);
    assert.ok(timeline.durations.slice(1, -1).every(seconds => seconds === 8));
  }
  for (const duration of [0, 14, 16, 24, 30, 15.5, "15"]) {
    assert.equal(jobRequestSchema.safeParse({ ...input, movie_duration_seconds: duration }).success, false);
  }
  assert.equal(jobRequestSchema.safeParse({ ...input, render_layout: undefined, movie_duration_seconds: 23 }).success, false);
});
