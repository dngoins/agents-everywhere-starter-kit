import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  characterSchema, getTimeline, jobRequestSchema, moviePlanSchema, profileSchema,
  resolveHeroMode, resolveStoryFormat, type MoviePlan, type StoryFormat, type TemplateId,
} from "../src/domain";
import { compileShotBlock } from "../src/director/promptCompiler";
import { allTemplates, getBeatMetadata, getTemplate, templates } from "../src/templates";
import velocitySource from "../src/templates/tiya/velocity.json";
import tomorrowSource from "../src/templates/tiya/tomorrow-drive.json";
import heroSource from "../src/templates/tiya/hero-of-the-day.json";

const grammar = ["ordinary_moment", "the_spark", "crossing_over", "the_impossible", "mastery", "payoff"];
const templateIds: TemplateId[] = ["VELOCITY", "TOMORROW_DRIVE", "DREAM_ROUTE", "HERO_OF_THE_DAY"];
function plan(templateId: TemplateId, storyFormat: StoryFormat): MoviePlan {
  const timeline = getTimeline(storyFormat, templateId);
  return {
    id: randomUUID(), characterId: randomUUID(), productId: "car", templateId, templateVersion: 1, referenceVersion: 1,
    storyFormat, durationSeconds: timeline.durationSeconds, heroShotId: timeline.heroShotId, aspectRatio: "16:9",
    logline: "A warm journey", wardrobe: "Neutral", cinematicStyle: "Warm film", worldTransitions: "Scenic route", personalizationUsed: [],
    shots: timeline.shotIds.map((id, index) => ({
      id, durationSeconds: timeline.durations[index], purpose: "Narrative beat", camera: "Gentle tracking", action: "Continue journey",
      environment: "Scenic road", lighting: "Golden hour", personalization: [], imagePrompt: "Consistent frame", motionPrompt: "Gentle movement", audioCues: ["Road ambience"],
    })),
  };
}

test("defaults preserve classic three templates while configuration adds Hero of the Day", () => {
  assert.equal(resolveStoryFormat(), "four-shot");
  assert.equal(resolveHeroMode(), "LIKENESS");
  assert.deepEqual(templates.map(template => template.id), templateIds.slice(0, 3));
  assert.deepEqual(allTemplates.map(template => template.id), templateIds);
  for (const template of allTemplates) assert.equal(template.beats.length, 4);
  assert.match(getTemplate("HERO_OF_THE_DAY").source!.adaptation, /Four-shot condensation/);
  assert.match(getTemplate("HERO_OF_THE_DAY").beats[0], /small meaningful need/);
});

test("actual Tiya six-beat templates preserve camera, sound, visibility, palette and personality with provenance", () => {
  for (const [id, source] of [["VELOCITY", velocitySource], ["TOMORROW_DRIVE", tomorrowSource], ["HERO_OF_THE_DAY", heroSource]] as const) {
    const template = getTemplate(id, "six-shot");
    assert.deepEqual(template.sourceBeats, source.beats);
    assert.deepEqual(template.beats, source.beats.map(beat => beat.goal));
    assert.deepEqual(template.sourceBeats!.map(beat => beat.beat), grammar);
    assert.deepEqual(template.directorPersonality, source.director_personality);
    assert.deepEqual(template.cinematography, source.cinematography);
    assert.deepEqual(template.soundDesign, source.sound);
    assert.deepEqual(template.personalizationSlots, source.personalization_slots);
    assert.equal(template.source!.author, "Tiya");
    assert.ok(template.source!.files[0].startsWith("MoviePart/src/templates/"));
    assert.equal(template.sourceBeats![3].default_duration, 5, "archival timing stays intact");
    assert.equal(getTimeline("six-shot", id).durations[3], 8, "runtime hero is exactly eight seconds");
  }
  assert.equal(getTemplate("VELOCITY", "six-shot").sourceBeats![0].camera_hint, "eye-level medium shot, static, 35mm");
  assert.equal(getTemplate("HERO_OF_THE_DAY", "six-shot").sourceBeats![1].product_visible, false);
  assert.equal(getTemplate("TOMORROW_DRIVE", "six-shot").soundDesign!.tempo_bpm, 110);
});

test("Dream Route uses Tiya grammar for its own scenic story, not Hero's narrative", () => {
  const dream = getTemplate("DREAM_ROUTE", "six-shot");
  assert.deepEqual(dream.sourceBeats!.map(beat => beat.beat), grammar);
  assert.match(dream.source!.adaptation, /not a rename/);
  assert.match(dream.beats[3], /scenic drive.*without fantasy transitions/);
  assert.notDeepEqual(dream.beats, getTemplate("HERO_OF_THE_DAY", "six-shot").beats);
  assert.equal(dream.sourceBeats![2].default_duration, 2);
});

test("four and six plans enforce exact counts, IDs, timing, total and dynamic hero", () => {
  for (const id of templateIds) {
    for (const format of ["four-shot", "six-shot"] as const) {
      const valid = plan(id, format);
      const timeline = getTimeline(format, id);
      assert.equal(moviePlanSchema.safeParse(valid).success, true);
      assert.deepEqual(timeline.durations, format === "four-shot" ? [3, 3, 8, 4] : id === "HERO_OF_THE_DAY" ? [3, 3, 3, 8, 3, 4] : [3, 3, 2, 8, 3, 4]);
      assert.equal(timeline.durationSeconds, format === "four-shot" ? 18 : id === "HERO_OF_THE_DAY" ? 24 : 23);
      assert.equal(timeline.heroShotId, format === "four-shot" ? "shot_03" : "shot_04");
      for (const invalid of [
        { ...valid, shots: valid.shots.slice(0, -1) },
        { ...valid, shots: [...valid.shots].reverse() },
        { ...valid, shots: valid.shots.map(shot => ({ ...shot, durationSeconds: 4 })) },
        { ...valid, durationSeconds: valid.durationSeconds + 1 },
        { ...valid, heroShotId: valid.heroShotId === "shot_03" ? "shot_04" : "shot_03" },
      ]) assert.equal(moviePlanSchema.safeParse(invalid).success, false);
    }
  }
});

test("required nullable primary and explicit hero modes enforce reference consent contracts", () => {
  const id = randomUUID();
  const request = {
    schema_version: 1, session_id: "session", product_id: "car", personalization_profile: { signals: [] },
    consent: { likeness: true, personalization: true }, idempotency_key: randomUUID(),
    customer_reference_asset_ids: [id], primary_reference_asset_id: id,
  };
  assert.equal(jobRequestSchema.safeParse(request).success, true);
  assert.equal(jobRequestSchema.safeParse({ ...request, customer_reference_asset_ids: [], primary_reference_asset_id: null }).success, false);
  for (const mode of ["POV", "PERSONALIZED"]) {
    const noPhoto = { ...request, hero_mode: mode, customer_reference_asset_ids: [], primary_reference_asset_id: null };
    assert.equal(jobRequestSchema.safeParse(noPhoto).success, true);
    assert.equal(jobRequestSchema.safeParse({ ...noPhoto, primary_reference_asset_id: undefined }).success, false);
    assert.equal(jobRequestSchema.safeParse({ ...noPhoto, primary_reference_asset_id: randomUUID() }).success, false);
    assert.equal(jobRequestSchema.safeParse({ ...noPhoto, customer_reference_asset_ids: [id, id] }).success, false);
    assert.equal(jobRequestSchema.safeParse({ ...noPhoto, consent: { likeness: true, personalization: false } }).success, false);
  }
  assert.equal(jobRequestSchema.safeParse({ ...request, hero_mode: "AUTO" }).success, false);
  assert.equal(jobRequestSchema.safeParse({ ...request, story_format: "five-shot" }).success, false);
  const neutral = {
    id: randomUUID(), version: 1, primaryAssetId: null, sourceImages: [], consent: request.consent,
    attributes: { face: null, eyes: null, eyebrows: null, nose: null, mouth: null, hair: null, complexion: null, visibleProportions: null, wardrobe: null, accessories: [] },
  };
  assert.equal(characterSchema.safeParse(neutral).success, true);
});

test("approved name/city are bounded and unapproved signals fail closed", () => {
  assert.equal(profileSchema.safeParse({ signals: [], customerFirstName: "a".repeat(80), city: "b".repeat(120) }).success, true);
  assert.equal(profileSchema.safeParse({ signals: [], customerFirstName: "a".repeat(81) }).success, false);
  assert.equal(profileSchema.safeParse({ signals: [], city: "b".repeat(121) }).success, false);
  assert.equal(profileSchema.safeParse({ signals: [{ value: "hiking", source: "manual", visualUseAllowed: false, confidence: null }] }).success, false);
});

test("Tiya compiler supplies every labeled block and honors product visibility and explicit face rules", () => {
  const movie = plan("HERO_OF_THE_DAY", "six-shot");
  for (const mode of ["LIKENESS", "POV", "PERSONALIZED"] as const) {
    movie.heroMode = mode;
    const block = compileShotBlock(movie, movie.shots[0]);
    for (const label of ["SHOT", "SUBJECT:", "ACTION:", "CAMERA:", "SETTING:", "LIGHTING:", "MOOD:", "STYLE:", "SOUND:", "CAR:"]) {
      assert.ok(block.includes(label));
    }
    assert.match(block, /ordinary_moment/);
    assert.match(block, /CAR:.*Not visible/);
    assert.match(block, /soft room tone/);
    assert.match(block, /warm amber, soft cream, muted teal shadows/);
    if (mode === "POV") assert.match(block, /no faces or reflections/);
    if (mode === "PERSONALIZED") assert.match(block, /never a customer likeness/);
  }
  assert.equal(getBeatMetadata("HERO_OF_THE_DAY", "four-shot", plan("HERO_OF_THE_DAY", "four-shot").shots[1])!.beat, "crossing_over");
});
