import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { jobRequestSchema, validatePlan, type MoviePlan } from "../src/domain";
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
