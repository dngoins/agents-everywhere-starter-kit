import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import type { AssetRecord, CharacterReference, ContinuityResult, DirectorOutput, MoviePlan, ProductReference, StoryboardFrame } from "../src/domain";
import { getTimeline, MovieError, type HeroMode, type TemplateId } from "../src/domain";
import type { GenerationContext, MovieConfig } from "../src/domain/services";
import { createOpenAIServices, type OpenAITransport } from "../src/providers/openai";
import { GENERIC_WARDROBE, UNKNOWN_WARDROBE, VISIBLE_ATTRIBUTES_INSTRUCTIONS } from "../src/references";
import { compileFramePrompt } from "../src/storyboard/compile";
import { generateApprovedFrame, normalizeFrame } from "../src/storyboard";
import { getTemplate } from "../src/templates";

const config: MovieConfig = { dataDir: ".movie-data", imageModel: "gpt-image-2.5-flare", veoModel: "veo-3.1-generate-preview" };
const pass: ContinuityResult = { verdict: "PASS", reasons: ["Visible attributes and vehicle match the supplied references."], confidence: 0.95 };
const attributes: CharacterReference["attributes"] = {
  face: "Visible oval contour", eyes: null, eyebrows: null, nose: null, mouth: null,
  hair: "Short dark hair", complexion: null, visibleProportions: null, wardrobe: "Blue jacket", accessories: [],
};

async function fixture() {
  const ownerId = "test-owner";
  const assets = new Map<string, { record: AssetRecord; bytes: Uint8Array }>();
  const frames: StoryboardFrame[] = [];
  const events: Parameters<GenerationContext["report"]>[0][] = [];
  const operations: string[] = [];
  const controller = new AbortController();
  const context: GenerationContext = {
    jobId: randomUUID(), ownerId, signal: controller.signal,
    media: {
      async getAsset(id) { const entry = assets.get(id); assert.ok(entry); return entry.record; },
      async readAsset(id) { const entry = assets.get(id); assert.ok(entry); return entry.bytes; },
      async assetPath() { throw new Error("Not used by generation"); },
      async saveAsset(input) {
        const record: AssetRecord = {
          ...input, id: randomUUID(), filename: "private", bytes: input.bytes.length,
          width: input.width ?? null, height: input.height ?? null, createdAt: new Date().toISOString(),
        };
        assets.set(record.id, { record, bytes: input.bytes });
        return record;
      },
    },
    async report(event) { events.push(event); },
    async warn() {},
    async recordOperation(_provider, id) { operations.push(id); },
    async saveFrame(frame) { frames.push(structuredClone(frame)); },
  };
  async function add(kind: AssetRecord["kind"], color: string) {
    return context.media.saveAsset({
      ownerId, jobId: null, kind, mime: "image/png",
      bytes: await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer(),
    });
  }
  const [primary, secondary, exterior, interior] = await Promise.all([
    add("customer", "#ff0000"), add("customer", "#00ff00"), add("product", "#0000ff"), add("product", "#ffffff"),
  ]);
  const character: CharacterReference & { primaryAssetId: string } = {
    id: randomUUID(), version: 1, primaryAssetId: primary.id, attributes,
    sourceImages: [{ assetId: secondary.id, role: "Additional angle", origin: "original" }, { assetId: primary.id, role: "Primary", origin: "original" }],
    consent: { likeness: true, personalization: true },
  };
  const product: ProductReference = {
    id: "demo-car", version: 1, name: "Demo vehicle", make: null, model: null, exteriorColor: "blue", interiorColor: "black",
    appearance: "Blue four-door reference vehicle", approvedClaims: [], usagePermission: "Test fixtures",
    referenceImages: [{ assetId: exterior.id, role: "exterior front", origin: "original" }, { assetId: interior.id, role: "interior cabin", origin: "original" }],
  };
  const output: DirectorOutput = {
    logline: "An original scenic journey", wardrobe: "Blue jacket", cinematicStyle: "Grounded cinematic",
    worldTransitions: "One continuous scenic route", personalizationUsed: [],
    shots: [
      { id: "shot_01", durationSeconds: 3 }, { id: "shot_02", durationSeconds: 3 },
      { id: "shot_03", durationSeconds: 8 }, { id: "shot_04", durationSeconds: 4 },
    ].map(timing => ({
      ...timing, id: timing.id as DirectorOutput["shots"][number]["id"],
      purpose: "Tell a coherent story", camera: "Medium tracking",
      action: "The consenting customer travels with the selected car", environment: "Scenic road", lighting: "Warm daylight",
      personalization: [], imagePrompt: "An original scene consistent with the references",
      motionPrompt: "Gentle continuous tracking movement", audioCues: [],
    })),
  };
  const plan: MoviePlan = {
    ...output, id: randomUUID(), characterId: character.id, productId: product.id, templateId: "DREAM_ROUTE", templateVersion: 1,
    referenceVersion: 1, durationSeconds: 18, aspectRatio: "16:9", heroShotId: "shot_03",
  };
  const generated = await sharp({ create: { width: 160, height: 100, channels: 3, background: "#bb8833" } }).png().toBuffer();
  return { context, controller, assets, frames, events, operations, character, product, plan, output, generated };
}

function client(output: unknown, generated: Uint8Array): OpenAITransport {
  return {
    async respond() { return { id: "response-offline", status: "completed", output_text: JSON.stringify(output) }; },
    async edit() { return { created: 1, data: [{ b64_json: Buffer.from(generated).toString("base64") }], _request_id: "image-offline" }; },
  };
}

test("reference extraction sends primary photo bytes first, strict schema, consent and no sensitive fields", async () => {
  const f = await fixture();
  let calls = 0;
  const transport = client(attributes, f.generated);
  transport.respond = async (request, options) => {
    calls++;
    assert.equal(options.maxRetries, 0);
    assert.equal(request.store, false);
    assert.equal(request.text?.format?.type, "json_schema");
    if (request.text?.format?.type === "json_schema") {
      assert.equal(request.text.format.strict, true);
      assert.equal(request.text.format.schema.additionalProperties, false);
      const schema = JSON.stringify(request.text.format.schema);
      assert.ok(!schema.includes('"ethnicity"'));
    }
    const serialized = JSON.stringify(request.input);
    const primaryBytes = f.assets.get(f.character.primaryAssetId)!.bytes;
    assert.ok(serialized.includes(Buffer.from(primaryBytes).toString("base64")));
    for (const forbidden of ["ethnicity", "nationality", "religion", "health", "income", "identity"]) {
      assert.ok(VISIBLE_ATTRIBUTES_INSTRUCTIONS.includes(forbidden));
    }
    return { id: "extract-offline", status: "completed", output_text: JSON.stringify(attributes) };
  };
  const result = await createOpenAIServices(config, { transport }).references.extract({
    assetIds: f.character.sourceImages.map(image => image.assetId), primaryAssetId: f.character.primaryAssetId, consent: f.character.consent,
  }, f.context);
  assert.equal(calls, 1);
  assert.equal(result.sourceImages[0].assetId, f.character.primaryAssetId);
  assert.equal(result.attributes.eyes, null);
  assert.deepEqual(result.consent, f.character.consent);
});

test("extraction refuses sensitive extra output keys instead of accepting an expanded schema", async () => {
  const f = await fixture();
  const references = createOpenAIServices(config, { transport: client({ ...attributes, ethnicity: "not allowed" }, f.generated) }).references;
  await assert.rejects(references.extract({
    assetIds: [f.character.primaryAssetId], primaryAssetId: f.character.primaryAssetId, consent: f.character.consent,
  }, f.context), (error: unknown) => error instanceof MovieError && error.code === "INVALID_PROVIDER_OUTPUT");
});

test("invalid primary selection is rejected before a provider request", async () => {
  const f = await fixture();
  const transport = client(attributes, f.generated);
  transport.respond = async () => { assert.fail("must not request"); };
  await assert.rejects(createOpenAIServices(config, { transport }).references.extract({
    assetIds: [f.character.primaryAssetId], primaryAssetId: randomUUID(), consent: f.character.consent,
  }, f.context), /primary/);
});

test("director owns immutable metadata and validates the fixed four-shot timeline", async () => {
  const f = await fixture();
  const director = createOpenAIServices(config, { transport: client(f.output, f.generated) }).director;
  const result = await director.plan({ character: f.character, product: f.product, profile: { signals: [] }, template: getTemplate("DREAM_ROUTE") }, f.context);
  assert.equal(result.characterId, f.character.id);
  assert.equal(result.productId, f.product.id);
  assert.equal(result.templateId, "DREAM_ROUTE");
  assert.deepEqual(result.shots.map(shot => shot.durationSeconds), [3, 3, 8, 4]);
  assert.equal(result.durationSeconds, 18);
});

test("director rejects changed duration, unauthorized personalization, changed wardrobe and unknown fields", async () => {
  const f = await fixture();
  const cases = [
    { ...f.output, shots: f.output.shots.map((shot, index) => index === 2 ? { ...shot, durationSeconds: 7 } : shot) },
    { ...f.output, personalizationUsed: ["invented interest"] },
    { ...f.output, wardrobe: "Invented red suit" },
    { ...f.output, characterId: randomUUID() },
  ];
  for (const output of cases) {
    const director = createOpenAIServices(config, { transport: client(output, f.generated) }).director;
    await assert.rejects(director.plan({ character: f.character, product: f.product, profile: { signals: [] }, template: getTemplate("DREAM_ROUTE") }, f.context),
      (error: unknown) => error instanceof MovieError && error.code === "INVALID_PLAN");
  }
});

test("unseen wardrobe remains unknown and cannot be invented by the director", async () => {
  const f = await fixture();
  const character = { ...f.character, attributes: { ...f.character.attributes, wardrobe: null } };
  const input = { character, product: f.product, profile: { signals: [] }, template: getTemplate("DREAM_ROUTE") };
  await assert.rejects(createOpenAIServices(config, { transport: client(f.output, f.generated) }).director.plan(input, f.context),
    (error: unknown) => error instanceof MovieError && error.code === "INVALID_PLAN");
  const result = await createOpenAIServices(config, { transport: client({ ...f.output, wardrobe: UNKNOWN_WARDROBE }, f.generated) }).director.plan(input, f.context);
  assert.equal(result.wardrobe, UNKNOWN_WARDROBE);
});

test("invalid or mismatched storyboard plans fail before any paid image submission", async () => {
  const f = await fixture();
  const transport = client(pass, f.generated);
  transport.edit = async () => assert.fail("must validate before submitting");
  const services = createOpenAIServices(config, { transport });
  for (const plan of [{ ...f.plan, shots: [] }, { ...f.plan, characterId: randomUUID() }]) {
    await assert.rejects(services.storyboard.generate({ ...f, plan }, f.context),
      (error: unknown) => error instanceof MovieError && error.code === "INVALID_PLAN");
  }
});

test("every image submission includes all original customer/product bytes and disables SDK retries", async () => {
  const f = await fixture();
  const transport = client(pass, f.generated);
  let calls = 0;
  transport.edit = async (request, options) => {
    calls++;
    assert.equal(options.maxRetries, 0);
    assert.equal(request.model, "gpt-image-2.5-flare");
    assert.equal(request.size, "1536x864");
    assert.equal(Object.hasOwn(request, "input_fidelity"), false);
    assert.ok(Array.isArray(request.image));
    const uploads = request.image;
    assert.equal(uploads.length, 4);
    const expected = [f.character.primaryAssetId, f.character.sourceImages[0].assetId, ...f.product.referenceImages.map(image => image.assetId)];
    for (let i = 0; i < uploads.length; i++) {
      const upload = uploads[i];
      assert.ok("arrayBuffer" in upload);
      assert.deepEqual(Buffer.from(await upload.arrayBuffer()), Buffer.from(f.assets.get(expected[i])!.bytes));
    }
    return { created: 1, data: [{ b64_json: f.generated.toString("base64") }] };
  };
  const frames = await createOpenAIServices(config, { transport }).storyboard.generate(f, f.context);
  assert.equal(calls, 4);
  assert.equal(frames.length, 4);
  assert.ok(frames.every(frame => frame.continuity.verdict === "PASS"));
  assert.equal(f.frames.filter(frame => frame.continuity.verdict === "PASS").length, 4);
  for (const frame of frames) {
    assert.ok(f.events.some(event => event.stage === "VALIDATING" && event.shotId === frame.shotId));
    const metadata = await sharp(await f.context.media.readAsset(frame.assetId)).metadata();
    assert.equal(metadata.width, 1280);
    assert.equal(metadata.height, 720);
  }
});

test("retry budget is two submissions total and retains both rejected frame artifacts", async () => {
  const f = await fixture();
  const transport = client({ verdict: "RETRY", reasons: ["Wrong vehicle color"], confidence: 0.9 }, f.generated);
  let calls = 0;
  const edit = transport.edit;
  transport.edit = async (request, options) => { calls++; return edit(request, options); };
  await assert.rejects(generateApprovedFrame(config, transport, { ...f, shot: f.plan.shots[0] }, f.context),
    (error: unknown) => error instanceof MovieError && error.code === "CONTINUITY_REJECTED");
  assert.equal(calls, 2);
  assert.equal(new Set(f.frames.map(frame => frame.assetId)).size, 2);
  assert.equal(f.frames.filter(frame => frame.continuity.verdict === "RETRY").length, 2);
});

test("a correctable continuity mismatch is retried once with original references retained", async () => {
  const f = await fixture();
  const transport = client(pass, f.generated);
  let reviews = 0;
  transport.respond = async () => ({
    id: `review-${++reviews}`, status: "completed",
    output_text: JSON.stringify(reviews === 1 ? { verdict: "RETRY", reasons: ["Keep blue paint"], confidence: 0.9 } : pass),
  });
  const prompts: string[] = [];
  const edit = transport.edit;
  transport.edit = async (request, options) => { prompts.push(request.prompt); return edit(request, options); };
  const result = await generateApprovedFrame(config, transport, { ...f, shot: f.plan.shots[0] }, f.context);
  assert.equal(result.continuity.verdict, "PASS");
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes("Keep blue paint"));
});

test("hard rejection and ambiguous network errors are never automatically resubmitted", async () => {
  const f = await fixture();
  const transport = client({ verdict: "REJECT", reasons: ["Serious mismatch"], confidence: 0.9 }, f.generated);
  let calls = 0;
  const edit = transport.edit;
  transport.edit = async (request, options) => { calls++; return edit(request, options); };
  await assert.rejects(generateApprovedFrame(config, transport, { ...f, shot: f.plan.shots[0] }, f.context), /not approved/);
  assert.equal(calls, 1);
  calls = 0;
  transport.edit = async () => { calls++; throw new Error("secret-token private-reference-detail"); };
  await assert.rejects(generateApprovedFrame(config, transport, { ...f, shot: f.plan.shots[1] }, f.context), (error: unknown) => {
    assert.ok(error instanceof MovieError);
    assert.ok(!error.message.includes("secret-token"));
    assert.equal(error.code, "STORYBOARD_GENERATION_FAILED");
    return true;
  });
  assert.equal(calls, 1);
});

test("review outages and corrupt generated images retain rejected evidence without claiming approval", async () => {
  for (const corrupt of [false, true]) {
    const f = await fixture();
    const transport = client(pass, corrupt ? Buffer.from("not an image") : f.generated);
    transport.respond = async () => { throw new Error("private provider details"); };
    await assert.rejects(generateApprovedFrame(config, transport, { ...f, shot: f.plan.shots[0] }, f.context), MovieError);
    assert.ok(f.frames.length > 0);
    assert.ok(f.frames.every(frame => frame.continuity.verdict === "REJECT"));
  }
});

test("frame compiler is deterministic and generated normalization does not stretch content", async () => {
  const f = await fixture();
  const input = { ...f, shot: f.plan.shots[0] };
  assert.equal(compileFramePrompt(input, []), compileFramePrompt(input, []));
  const square = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const result = await sharp(await normalizeFrame(square)).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => result.data.subarray((y * 1280 + x) * result.info.channels, (y * 1280 + x) * result.info.channels + 3);
  assert.deepEqual([...pixel(0, 360)], [16, 16, 16]);
  assert.deepEqual([...pixel(640, 360)], [255, 0, 0]);
});

test("cancellation propagates and factories do not call unconfigured providers implicitly", async () => {
  const f = await fixture();
  f.controller.abort();
  await assert.rejects(generateApprovedFrame(config, client(pass, f.generated), { ...f, shot: f.plan.shots[0] }, f.context), { name: "AbortError" });
  const services = createOpenAIServices(config);
  assert.ok(services.references && services.director && services.storyboard);
});

test("six-shot director schema and server metadata follow each template's exact runtime timeline", async () => {
  for (const templateId of ["VELOCITY", "TOMORROW_DRIVE", "DREAM_ROUTE", "HERO_OF_THE_DAY"] as TemplateId[]) {
    const f = await fixture();
    const timeline = getTimeline("six-shot", templateId);
    const output = {
      ...f.output,
      shots: timeline.shotIds.map((id, index) => ({ ...f.output.shots[0], id, durationSeconds: timeline.durations[index] })),
    };
    const transport = client(output, f.generated);
    const respond = transport.respond;
    transport.respond = async (request, options) => {
      assert.equal(request.text?.format?.type, "json_schema");
      if (request.text?.format?.type === "json_schema") {
        assert.equal(request.text.format.strict, true);
        const schema = request.text.format.schema as { properties: { shots: { minItems: number; maxItems: number; items: { additionalProperties: boolean } } } };
        assert.equal(schema.properties.shots.minItems, 6);
        assert.equal(schema.properties.shots.maxItems, 6);
        assert.equal(schema.properties.shots.items.additionalProperties, false);
      }
      const serialized = JSON.stringify(request.input);
      for (const reference of [...f.character.sourceImages, ...f.product.referenceImages]) {
        assert.ok(serialized.includes(Buffer.from(f.assets.get(reference.assetId)!.bytes).toString("base64")));
      }
      return respond(request, options);
    };
    const input = { character: f.character, product: f.product, profile: { signals: [] }, template: getTemplate(templateId, "six-shot"), storyFormat: "six-shot" as const };
    const plan = await createOpenAIServices(config, { transport }).director.plan(input, f.context);
    assert.equal(plan.heroShotId, "shot_04");
    assert.equal(plan.durationSeconds, templateId === "HERO_OF_THE_DAY" ? 24 : 23);
    assert.deepEqual(plan.shots.map(shot => shot.durationSeconds), timeline.durations);
    for (const invalid of [
      { ...output, shots: output.shots.slice(0, 4) },
      { ...output, shots: output.shots.map((shot, index) => ({ ...shot, durationSeconds: index === 3 ? 5 : shot.durationSeconds })) },
      { ...output, shots: [...output.shots].reverse() },
      { ...output, storyFormat: "four-shot" },
    ]) {
      await assert.rejects(createOpenAIServices(config, { transport: client(invalid, f.generated) }).director.plan(input, f.context),
        (error: unknown) => error instanceof MovieError && error.code === "INVALID_PLAN");
    }
  }
});

test("POV and PERSONALIZED omit customer bytes and actual attributes from director, image and continuity payloads", async () => {
  for (const heroMode of ["POV", "PERSONALIZED"] as HeroMode[]) {
    const f = await fixture();
    const timeline = getTimeline("six-shot", "VELOCITY");
    const customerBytes = f.character.sourceImages.map(reference => Buffer.from(f.assets.get(reference.assetId)!.bytes).toString("base64"));
    const forbidden = ["Visible oval contour", "Short dark hair", "Blue jacket", ...customerBytes];
    const output = {
      ...f.output, wardrobe: GENERIC_WARDROBE,
      shots: timeline.shotIds.map((id, index) => ({ ...f.output.shots[0], id, durationSeconds: timeline.durations[index] })),
    };
    let directing = true;
    let reviews = 0;
    let images = 0;
    const transport = client(output, f.generated);
    const readAsset = f.context.media.readAsset;
    f.context.media.readAsset = async id => {
      assert.ok(!f.character.sourceImages.some(reference => reference.assetId === id), "customer photos must never even be read in a no-likeness mode");
      return readAsset(id);
    };
    transport.respond = async request => {
      const serialized = JSON.stringify(request);
      for (const value of forbidden) assert.ok(!serialized.includes(value), `Private appearance leaked: ${value.slice(0, 24)}`);
      assert.match(request.instructions ?? "", heroMode === "POV" ? /Never show any faces.*reflections/ : /generic protagonist seen only from behind/i);
      if (!directing) {
        reviews++;
        assert.match(request.instructions ?? "", /do not demand a vehicle/);
        assert.match(serialized, /productVisible/);
      }
      return { id: "offline-mode", status: "completed", output_text: JSON.stringify(directing ? output : pass) };
    };
    transport.edit = async request => {
      images++;
      for (const value of forbidden) assert.ok(!request.prompt.includes(value));
      assert.match(request.prompt, /SUBJECT:/);
      assert.match(request.prompt, /CAR:/);
      assert.ok(Array.isArray(request.image));
      assert.equal(request.image.length, 2);
      for (const upload of request.image) {
        assert.ok("arrayBuffer" in upload);
        assert.ok(!customerBytes.includes(Buffer.from(await upload.arrayBuffer()).toString("base64")));
      }
      return { created: 1, data: [{ b64_json: f.generated.toString("base64") }] };
    };
    const services = createOpenAIServices(config, { transport });
    const plan = await services.director.plan({
      ...f, profile: { signals: [], customerFirstName: "Avery", city: "Seattle" },
      template: getTemplate("VELOCITY", "six-shot"), storyFormat: "six-shot", heroMode,
    }, f.context);
    assert.equal(plan.heroMode, heroMode);
    directing = false;
    const frames = await services.storyboard.generate({ ...f, plan }, f.context);
    assert.equal(images, 6);
    assert.equal(reviews, 6);
    assert.deepEqual(frames.map(frame => frame.shotId), timeline.shotIds);
  }
});

test("explicit no-likeness plans work with empty references; likeness never silently switches mode", async () => {
  const f = await fixture();
  const character: CharacterReference = { ...f.character, sourceImages: [], primaryAssetId: null };
  const transport = client({ ...f.output, wardrobe: GENERIC_WARDROBE }, f.generated);
  const services = createOpenAIServices(config, { transport });
  const input = { character, product: f.product, profile: { signals: [] }, template: getTemplate("DREAM_ROUTE") };
  assert.equal((await services.director.plan({ ...input, heroMode: "POV" }, f.context)).heroMode, "POV");
  await assert.rejects(services.director.plan(input, f.context), /LIKENESS requires/);
  await assert.rejects(createOpenAIServices(config).director.plan({ ...input, heroMode: "POV" }, f.context),
    (error: unknown) => error instanceof MovieError && error.code === "OPENAI_NOT_CONFIGURED");
});

test("director permits only approved names/cities and approved personalization signals", async () => {
  const f = await fixture();
  const profile = { signals: [{ value: "hiking", source: "manual" as const, visualUseAllowed: true as const, confidence: null }], customerFirstName: "Avery", city: "Seattle" };
  const output = {
    ...f.output, personalizationUsed: ["Avery", "Seattle", "hiking"],
    shots: f.output.shots.map(shot => ({ ...shot, personalization: ["Avery", "Seattle", "hiking"] })),
  };
  const input = { ...f, profile, template: getTemplate("DREAM_ROUTE") };
  assert.deepEqual((await createOpenAIServices(config, { transport: client(output, f.generated) }).director.plan(input, f.context)).personalizationUsed, output.personalizationUsed);
  await assert.rejects(createOpenAIServices(config, { transport: client(output, f.generated) }).director.plan({ ...input, profile: { signals: profile.signals } }, f.context), /unapproved/);
});
