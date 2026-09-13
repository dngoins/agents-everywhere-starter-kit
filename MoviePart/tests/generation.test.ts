import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import type { AssetRecord, CharacterReference, ContinuityResult, DirectorOutput, MoviePlan, ProductReference, StoryboardFrame } from "../src/domain";
import { getTimeline, MovieError, type HeroMode, type TemplateId } from "../src/domain";
import type { GenerationContext, MovieConfig } from "../src/domain/services";
import { createOpenAIServices, type OpenAITransport } from "../src/providers/openai";
import { CHARACTER_PRESENTATION_INSTRUCTIONS, GENERIC_WARDROBE, UNKNOWN_WARDROBE, VISIBLE_ATTRIBUTES_INSTRUCTIONS } from "../src/references";
import { compileFramePrompt } from "../src/storyboard/compile";
import { generateApprovedFrame, normalizeFrame } from "../src/storyboard";
import { getTemplate } from "../src/templates";
import { CHARACTER_PRESENTATION_CONTINUITY_INSTRUCTIONS, CONTINUITY_INSTRUCTIONS, inspectContinuity, PRACTICAL_CONTINUITY_INSTRUCTIONS } from "../src/continuity";
import { SAFE_STORYBOARD_VARIATIONS } from "../src/storyboard/variations";

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

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function enableLiveFrames(f: Awaited<ReturnType<typeof fixture>>) {
  const records = new Map(f.frames.map(frame => [frame.assetId, structuredClone(frame)]));
  const saveFrame = f.context.saveFrame;
  f.context.getFrames = async () => structuredClone([...records.values()]);
  f.context.saveFrame = async frame => {
    const previous = records.get(frame.assetId);
    const saved = {
      ...structuredClone(frame),
      ...(previous?.designerDecision ? { designerDecision: previous.designerDecision } : {}),
    };
    records.set(frame.assetId, saved);
    await saveFrame(saved);
  };
  return records;
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

test("OpenAI animation hero storyboard and review never receive customer reference photos or appearance attributes", async () => {
  const f = await fixture();
  const plan: MoviePlan = { ...f.plan, videoProvider: "openai-sora" };
  const transport = client(pass, f.generated);
  const customerBytes = f.character.sourceImages.map(image => Buffer.from(f.assets.get(image.assetId)!.bytes).toString("base64"));
  transport.edit = async input => {
    assert.ok(Array.isArray(input.image));
    assert.equal(input.image.length, f.product.referenceImages.length);
    for (const image of input.image) {
      assert.ok("arrayBuffer" in image);
      assert.ok(!customerBytes.includes(Buffer.from(await image.arrayBuffer()).toString("base64")));
    }
    assert.match(input.prompt, /PRODUCT-ONLY/);
    const data = JSON.parse(input.prompt.split("\n").at(-1)!);
    assert.equal(data.locks.character, undefined);
    assert.equal(data.locks.wardrobe, undefined);
    return { created: 1, data: [{ b64_json: f.generated.toString("base64") }] };
  };
  transport.respond = async input => {
    const data = JSON.stringify(input.input);
    customerBytes.forEach(bytes => assert.ok(!data.includes(bytes)));
    assert.match(input.instructions!, /product continuity only/);
    assert.ok(!input.instructions!.includes(CHARACTER_PRESENTATION_CONTINUITY_INSTRUCTIONS), "product-only continuity must not request a human silhouette");
    return { id: "review-car", status: "completed", output_text: JSON.stringify(pass) };
  };
  const result = await generateApprovedFrame(config, transport, { ...f, plan, shot: plan.shots[2] }, f.context);
  assert.equal(result.continuity.verdict, "PASS");
});

test("practical approval accepts cosmetic-only model PASS at 0.55; strict still requires 0.7", async () => {
  const f = await fixture();
  for (const continuityPolicy of ["practical", "strict"] as const) {
    for (const confidence of [0.54, 0.55, 0.69, 0.7]) {
      const result: ContinuityResult = { verdict: "PASS", confidence, reasons: ["Only sleeve knit texture and small pouch placement differ; person, blue car and action match."] };
      const transport = client(result, f.generated);
      const respond = transport.respond;
      transport.respond = async (request, options) => {
        assert.ok(request.instructions?.startsWith(continuityPolicy === "practical" ? PRACTICAL_CONTINUITY_INSTRUCTIONS : CONTINUITY_INSTRUCTIONS));
        assert.equal(options.maxRetries, 0);
        return respond(request, options);
      };
      const reviewed = await inspectContinuity({ ...config, continuityPolicy }, transport, { ...f, shot: f.plan.shots[0] }, [], [], f.context);
      assert.equal(reviewed.verdict, confidence >= (continuityPolicy === "practical" ? 0.55 : 0.7) ? "PASS" : "RETRY");
    }
  }
  for (const verdict of ["RETRY", "REJECT"] as const) {
    const reviewed = await inspectContinuity({ ...config, continuityPolicy: "practical" },
      client({ verdict, confidence: 1, reasons: [verdict === "REJECT" ? "Unsafe unexpected content" : "Clearly wrong car"] }, f.generated),
      { ...f, shot: f.plan.shots[0] }, [], [], f.context);
    assert.equal(reviewed.verdict, verdict, "only an actual model PASS can be approved");
  }
});

test("both continuity policies permit intentional mild slimming without weakening identity, anatomy or safety checks", async () => {
  const f = await fixture();
  for (const continuityPolicy of ["practical", "strict"] as const) {
    for (const verdict of ["PASS", "RETRY", "REJECT"] as const) {
      const result: ContinuityResult = {
        verdict, confidence: 0.95,
        reasons: [verdict === "PASS" ? "Only the intentional mild silhouette adjustment differs."
          : verdict === "RETRY" ? "Visible facial appearance is clearly different." : "Unsafe content and distorted anatomy."],
      };
      const transport = client(result, f.generated);
      const respond = transport.respond;
      transport.respond = async (request, options) => {
        assert.ok(request.instructions?.startsWith(continuityPolicy === "practical" ? PRACTICAL_CONTINUITY_INSTRUCTIONS : CONTINUITY_INSTRUCTIONS));
        assert.ok(request.instructions?.includes(CHARACTER_PRESENTATION_INSTRUCTIONS));
        assert.ok(request.instructions?.includes(CHARACTER_PRESENTATION_CONTINUITY_INSTRUCTIONS));
        assert.match(request.instructions!, /intentional mild slimming alone is allowed and is not grounds for RETRY/);
        assert.match(request.instructions!, /natural anatomy, visible face\/hair\/wardrobe continuity, product consistency/);
        assert.match(request.instructions!, /all consent, identity and safety restrictions/);
        assert.match(request.instructions!, /Changed identity, distorted anatomy, extreme transformation or unsafe content is not an allowed silhouette adjustment/);
        assert.match(request.instructions!, /Do not alter original photographs or a frame explicitly kept by the designer/);
        assert.match(request.instructions!, /Do not infer weight, BMI or an ideal body size/);
        return respond(request, options);
      };
      const reviewed = await inspectContinuity({ ...config, continuityPolicy }, transport, { ...f, shot: f.plan.shots[0] }, [], [], f.context);
      assert.deepEqual(reviewed, result, "intentional presentation guidance must never override the model's actual verdict");
    }
  }
});

test("eight-attempt practical budget supports seven distinct corrective variations before approval", async () => {
  const f = await fixture();
  const transport = client(pass, f.generated);
  let reviews = 0;
  const prompts: string[] = [];
  transport.respond = async () => ({
    id: `review-${++reviews}`, status: "completed",
    output_text: JSON.stringify(reviews < 8 ? { verdict: "RETRY", reasons: ["Keep the original blue paint"], confidence: 0.9 } : pass),
  });
  const edit = transport.edit;
  transport.edit = async (request, options) => {
    prompts.push(request.prompt);
    assert.ok(Array.isArray(request.image));
    assert.equal(request.image.length, 4);
    assert.equal(options.maxRetries, 0);
    return edit(request, options);
  };
  const result = await generateApprovedFrame({ ...config, storyboardMaxAttempts: 8, continuityPolicy: "practical" },
    transport, { ...f, shot: f.plan.shots[0] }, f.context, undefined, ["Maintain the original planned action"]);
  assert.equal(result.continuity.verdict, "PASS");
  assert.equal(prompts.length, 8);
  assert.equal(new Set(f.frames.map(frame => frame.assetId)).size, 8);
  assert.equal(f.frames.filter(frame => frame.continuity.verdict === "RETRY").length, 7);
  const labels = f.events.map(event => /Safe composition variation: ([\w-]+)\./.exec(event.message)?.[1]).filter(Boolean);
  assert.equal(labels.length, 7);
  assert.equal(new Set(labels).size, 7);
  for (const [index, prompt] of prompts.entries()) {
    const data = JSON.parse(prompt.split("\n").at(-1)!);
    assert.equal(data.referenceOrder.length, 4);
    if (index === 0) {
      assert.deepEqual(data.correction, ["Maintain the original planned action"]);
    } else {
      assert.ok(data.correction.includes("Keep the original blue paint"));
      assert.ok(SAFE_STORYBOARD_VARIATIONS.some(variation => variation.label === labels[index - 1] && data.correction.includes(variation.instruction)));
    }
  }
});

test("practical retries stop at eight and never retry hard REJECT, network, billing or auth failures", async () => {
  const practical = { ...config, storyboardMaxAttempts: 8, continuityPolicy: "practical" as const };
  for (const verdict of ["RETRY", "REJECT"] as const) {
    const f = await fixture();
    const transport = client({ verdict, reasons: [verdict === "REJECT" ? "Unsafe unexpected content" : "Wrong car color"], confidence: 0.99 }, f.generated);
    let calls = 0;
    const edit = transport.edit;
    transport.edit = async (request, options) => { calls++; return edit(request, options); };
    await assert.rejects(generateApprovedFrame(practical, transport, { ...f, shot: f.plan.shots[0] }, f.context),
      (error: unknown) => error instanceof MovieError && error.code === "CONTINUITY_REJECTED");
    assert.equal(calls, verdict === "RETRY" ? 8 : 1);
    assert.equal(new Set(f.frames.map(frame => frame.assetId)).size, calls);
    assert.ok(f.frames.every(frame => frame.continuity.verdict !== "PASS"));
  }
  for (const failure of [new Error("Unknown network submission outcome"), new MovieError("OPENAI_CREDITS_EXHAUSTED", "Billing unavailable"), new MovieError("OPENAI_AUTH_FAILED", "Credentials unavailable")]) {
    const f = await fixture();
    const transport = client(pass, f.generated);
    let calls = 0;
    transport.edit = async () => { calls++; throw failure; };
    await assert.rejects(generateApprovedFrame(practical, transport, { ...f, shot: f.plan.shots[0] }, f.context), MovieError);
    assert.equal(calls, 1);
  }
});

test("configured attempt bounds are clamped and movie-first still generates only once without review", async () => {
  for (const [storyboardMaxAttempts, expected] of [[0, 1], [21, 20], [3.8, 3], [NaN, 2]]) {
    const f = await fixture();
    const transport = client(pass, f.generated);
    transport.edit = async () => { throw new Error("No paid provider"); };
    await assert.rejects(generateApprovedFrame({ ...config, storyboardMaxAttempts }, transport, { ...f, shot: f.plan.shots[0] }, f.context));
    assert.match(f.events[0].message, new RegExp(`attempt 1/${expected}`));
  }
  const f = await fixture();
  const transport = client(pass, f.generated);
  transport.respond = async () => assert.fail("movie-first must not review");
  let calls = 0;
  const edit = transport.edit;
  transport.edit = async (request, options) => { calls++; return edit(request, options); };
  const frame = await generateApprovedFrame({ ...config, storyboardMaxAttempts: 8 }, transport, { ...f, shot: f.plan.shots[0] }, f.context, undefined, [], false);
  assert.equal(calls, 1);
  assert.equal(frame.continuity.verdict, "NOT_REVIEWED");
});

test("corrective retries may continue beyond the recommended two minutes with normal provider timeouts", async t => {
  const f = await fixture();
  const transport = client(pass, f.generated);
  const startedAt = Date.now();
  let now = startedAt;
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  let reviews = 0;
  const edit = transport.edit;
  transport.edit = async (request, options) => {
    calls++;
    assert.equal(options.timeout, 180_000);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.signal?.aborted, false);
    return edit(request, options);
  };
  transport.respond = async (_request, options) => {
    reviews++;
    now += 180_000;
    assert.equal(options.timeout, 120_000);
    assert.equal(options.signal?.aborted, false);
    return {
      id: `soft-target-review-${reviews}`, status: "completed",
      output_text: JSON.stringify(reviews < 3 ? { verdict: "RETRY", reasons: ["Wrong paint"], confidence: 0.9 } : pass),
    };
  };
  const frame = await generateApprovedFrame({ ...config, storyboardMaxAttempts: 8 }, transport, { ...f, shot: f.plan.shots[0] }, f.context);
  assert.equal(calls, 3);
  assert.equal(frame.continuity.verdict, "PASS");
  assert.ok(Date.now() - startedAt > 120_000);
  assert.equal(f.controller.signal.aborted, false);
});

test("storyboard pool keeps at most two image calls in flight and returns plan order", { timeout: 10_000 }, async () => {
  const f = await fixture();
  const transport = client(pass, f.generated);
  const secondApproved = gate();
  let active = 0;
  let peak = 0;
  const edit = transport.edit;
  transport.edit = async (request, options) => {
    const shotId = JSON.parse(request.prompt.split("\n").at(-1)!).shot.id;
    active++;
    peak = Math.max(peak, active);
    assert.ok(active <= 2);
    assert.ok(options.signal);
    if (shotId === "shot_01") await secondApproved.promise;
    try { return await edit(request, options); } finally { active--; }
  };
  const saveFrame = f.context.saveFrame;
  f.context.saveFrame = async frame => {
    await saveFrame(frame);
    if (frame.shotId === "shot_02" && frame.continuity.verdict === "PASS") secondApproved.release();
  };
  const frames = await createOpenAIServices({ ...config, storyboardConcurrency: 2 }, { transport }).storyboard.generate(f, f.context);
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(f.frames.find(frame => frame.continuity.verdict === "PASS")?.shotId, "shot_02");
  assert.deepEqual(frames.map(frame => frame.shotId), f.plan.shots.map(shot => shot.id));
  assert.ok(frames.every(frame => frame.continuity.verdict === "PASS"));
});

test("pool aborts and settles an in-flight sibling, preserves approvals and resumes only remaining shots", { timeout: 10_000 }, async () => {
  const f = await fixture();
  const transport = client(pass, f.generated);
  const thirdStarted = gate();
  const siblingAborted = gate();
  const releaseCleanup = gate();
  const submitted: string[] = [];
  let siblingSettled = false;
  const edit = transport.edit;
  transport.edit = async (request, options) => {
    const shotId = JSON.parse(request.prompt.split("\n").at(-1)!).shot.id;
    submitted.push(shotId);
    if (shotId === "shot_02") await thirdStarted.promise;
    if (shotId === "shot_03") {
      thirdStarted.release();
      assert.ok(options.signal);
      const signal = options.signal;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          siblingAborted.release();
          void releaseCleanup.promise.then(() => {
            siblingSettled = true;
            reject(new DOMException("Sibling cleanup completed", "AbortError"));
          });
        }, { once: true });
      });
    }
    return edit(request, options);
  };
  let reviews = 0;
  transport.respond = async () => ({
    id: `parallel-review-${++reviews}`, status: "completed",
    output_text: JSON.stringify(reviews === 1 ? pass : { verdict: "REJECT", reasons: ["Unsafe unexpected content"], confidence: 1 }),
  });
  const saveFrame = f.context.saveFrame;
  f.context.saveFrame = async function (frame) {
    assert.equal(this, f.context, "checkpoint calls must retain the original worker context");
    assert.equal(this.signal.aborted, false);
    await saveFrame(frame);
  };
  const services = createOpenAIServices({ ...config, storyboardMaxAttempts: 8, storyboardConcurrency: 2 }, { transport });
  let finished = false;
  const outcome = services.storyboard.generate(f, f.context).then(
    () => { finished = true; return undefined; },
    error => { finished = true; return error; },
  );
  await siblingAborted.promise;
  await Promise.resolve();
  assert.equal(finished, false, "service must wait for the paid sibling request to finish cleanup");
  assert.equal(siblingSettled, false);
  releaseCleanup.release();
  const error: unknown = await outcome;
  assert.ok(error instanceof MovieError);
  assert.equal(error.code, "CONTINUITY_REJECTED", "the rejection must not be hidden by sibling cancellation");
  assert.equal(siblingSettled, true);
  assert.deepEqual(submitted.slice().sort(), ["shot_01", "shot_02", "shot_03"]);
  assert.equal(f.controller.signal.aborted, false);
  const approved = f.frames.find(frame => frame.continuity.verdict === "PASS");
  assert.equal(approved?.shotId, "shot_01");
  assert.ok(f.frames.some(frame => frame.shotId === "shot_02" && frame.continuity.verdict === "REJECT"));

  const retryTransport = client(pass, f.generated);
  const retried: string[] = [];
  const retryEdit = retryTransport.edit;
  retryTransport.edit = async (request, options) => {
    retried.push(JSON.parse(request.prompt.split("\n").at(-1)!).shot.id);
    return retryEdit(request, options);
  };
  const frames = await createOpenAIServices({ ...config, storyboardConcurrency: 2 }, { transport: retryTransport })
    .storyboard.generate({ ...f, existingFrames: f.frames }, f.context);
  assert.deepEqual(retried.slice().sort(), ["shot_02", "shot_03", "shot_04"]);
  assert.equal(frames[0].assetId, approved!.assetId);
  assert.deepEqual(frames.map(frame => frame.shotId), f.plan.shots.map(shot => shot.id));
});

test("pool failure during reporting prevents sibling image submissions after the failure", { timeout: 10_000 }, async () => {
  const f = await fixture();
  const transport = client(pass, f.generated);
  const siblingReporting = gate();
  const allowSiblingReport = gate();
  const failure = new MovieError("CHECKPOINT_UNAVAILABLE", "Unable to report progress");
  const report = f.context.report;
  f.context.report = async event => {
    if (event.stage === "STORYBOARDING" && event.shotId === "shot_01") {
      await siblingReporting.promise;
      throw failure;
    }
    if (event.stage === "STORYBOARDING" && event.shotId === "shot_02") {
      siblingReporting.release();
      await allowSiblingReport.promise;
    }
    await report(event);
  };
  transport.edit = async () => assert.fail("no images may start once the pool failed");
  const pending = createOpenAIServices({ ...config, storyboardConcurrency: 2 }, { transport }).storyboard.generate(f, f.context);
  const rejection = assert.rejects(pending, error => error === failure);
  await siblingReporting.promise;
  // Let the first worker abort the pool before the other worker finishes reporting.
  await new Promise<void>(resolve => setImmediate(resolve));
  allowSiblingReport.release();
  await rejection;
});

test("all reused approvals are validated before paid work, even for a later shot", async () => {
  const f = await fixture();
  const approved = await generateApprovedFrame(config, client(pass, f.generated), { ...f, shot: f.plan.shots[3] }, f.context);
  f.assets.get(approved.assetId)!.bytes = Buffer.from("invalid saved image");
  const transport = client(pass, f.generated);
  transport.edit = async () => assert.fail("validate all saved approvals before generating an earlier missing shot");
  await assert.rejects(createOpenAIServices({ ...config, storyboardConcurrency: 2 }, { transport })
    .storyboard.generate({ ...f, existingFrames: [approved] }, f.context),
  (error: unknown) => error instanceof MovieError && error.code === "SAVED_FRAME_UNAVAILABLE");
});

test("saved approvals are reused without generation or another continuity review", async () => {
  const f = await fixture();
  const original = await createOpenAIServices(config, { transport: client(pass, f.generated) }).storyboard.generate(f, f.context);
  const transport = client(pass, f.generated);
  transport.edit = async () => assert.fail("must reuse approvals");
  transport.respond = async () => assert.fail("must not re-review approvals");
  const frames = await createOpenAIServices({ ...config, storyboardConcurrency: 2 }, { transport })
    .storyboard.generate({ ...f, existingFrames: f.frames }, f.context);
  assert.deepEqual(frames, original);
});

test("designer-kept frames are reused without rewriting their original AI verdict", async () => {
  for (const productionMode of ["reviewed-storyboard", "movie-first"] as const) {
    const f = await fixture();
    const original = await createOpenAIServices(config, { transport: client(pass, f.generated) }).storyboard.generate(f, f.context);
    const kept: StoryboardFrame = {
      ...original[0],
      continuity: { verdict: "RETRY", reasons: ["Minor pouch placement difference"], confidence: 0.8 },
      designerDecision: { action: "keep", note: "The cosmetic difference is acceptable.", at: new Date().toISOString() },
    };
    const existingFrames = [kept, ...original.slice(1)];
    const before = structuredClone(existingFrames);
    const transport = client(pass, f.generated);
    transport.edit = async () => assert.fail("designer-kept frame must not regenerate");
    transport.respond = async () => assert.fail("designer-kept frame must not be re-reviewed");
    const frames = await createOpenAIServices({ ...config, storyboardConcurrency: 2 }, { transport }).storyboard.generate({
      ...f, existingFrames, ...(productionMode === "movie-first" ? { productionMode } : {}),
    }, f.context);
    assert.deepEqual(frames, before);
    assert.deepEqual(existingFrames, before);
    assert.equal(frames[0].continuity.verdict, "RETRY");
    assert.ok(f.events.some(event => /designer-kept frame; the original AI verdict is unchanged/.test(event.message)));
  }
});

test("designer regeneration overrides AI PASS in both modes and adds the note without changing references or plan", async () => {
  for (const productionMode of ["reviewed-storyboard", "movie-first"] as const) {
    const f = await fixture();
    const original = await createOpenAIServices(config, { transport: client(pass, f.generated) }).storyboard.generate(f, f.context);
    const note = "Use a slightly wider composition while retaining the planned action.";
    const redo: StoryboardFrame = {
      ...original[0],
      designerDecision: { action: "regenerate", note, at: new Date().toISOString() },
    };
    const existingFrames = [redo, ...original.slice(1)];
    const before = structuredClone({ existingFrames, plan: f.plan, character: f.character, product: f.product });
    const transport = client(pass, f.generated);
    const edit = transport.edit;
    let calls = 0;
    transport.edit = async (request, options) => {
      calls++;
      const data = JSON.parse(request.prompt.split("\n").at(-1)!);
      assert.equal(data.shot.id, redo.shotId);
      assert.deepEqual(data.correction, [...redo.continuity.reasons, note]);
      assert.equal(data.locks.product.exteriorColor, f.product.exteriorColor);
      assert.equal(data.locks.wardrobe, f.plan.wardrobe);
      assert.ok(Array.isArray(request.image));
      const expected = [f.character.primaryAssetId, f.character.sourceImages[0].assetId, ...f.product.referenceImages.map(image => image.assetId)];
      assert.equal(request.image.length, expected.length);
      for (const [index, image] of request.image.entries()) {
        assert.ok("arrayBuffer" in image);
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(f.assets.get(expected[index])!.bytes));
      }
      return edit(request, options);
    };
    if (productionMode === "movie-first") transport.respond = async () => assert.fail("movie-first must not review");
    const frames = await createOpenAIServices({ ...config, storyboardConcurrency: 2 }, { transport }).storyboard.generate({
      ...f, existingFrames, ...(productionMode === "movie-first" ? { productionMode } : {}),
    }, f.context);
    assert.equal(calls, 1);
    assert.notEqual(frames[0].assetId, redo.assetId);
    assert.equal(frames[0].designerDecision, undefined);
    assert.equal(frames[0].continuity.verdict, productionMode === "movie-first" ? "NOT_REVIEWED" : "PASS");
    assert.deepEqual(frames.slice(1), original.slice(1));
    assert.deepEqual({ existingFrames, plan: f.plan, character: f.character, product: f.product }, before);
  }
});

test("designer-kept images are validated before any new paid work", async () => {
  const f = await fixture();
  const original = await generateApprovedFrame(config, client(pass, f.generated), { ...f, shot: f.plan.shots[3] }, f.context);
  const kept: StoryboardFrame = {
    ...original,
    continuity: { verdict: "RETRY", reasons: ["Minor texture difference"], confidence: 0.8 },
    designerDecision: { action: "keep", note: "Keep this composition.", at: new Date().toISOString() },
  };
  f.assets.get(kept.assetId)!.bytes = Buffer.from("corrupted kept image");
  const transport = client(pass, f.generated);
  transport.edit = async () => assert.fail("validate kept images before generating any missing shot");
  await assert.rejects(createOpenAIServices({ ...config, storyboardConcurrency: 2 }, { transport })
    .storyboard.generate({ ...f, existingFrames: [kept] }, f.context),
  (error: unknown) => error instanceof MovieError && error.code === "SAVED_FRAME_UNAVAILABLE");
});

test("a live keep prevents the next image call and validates the kept file", async () => {
  const f = await fixture();
  const input = { ...f, shot: f.plan.shots[0] };
  const original = await generateApprovedFrame(config, client(pass, f.generated), input, f.context);
  const records = enableLiveFrames(f);
  const kept: StoryboardFrame = {
    ...original, continuity: { verdict: "RETRY", reasons: ["Minor sleeve difference"], confidence: 0.8 },
    designerDecision: { action: "keep", note: "This image is fine; move to the next shot.", at: new Date().toISOString() },
  };
  records.set(kept.assetId, kept);
  const transport = client(pass, f.generated);
  transport.edit = async () => assert.fail("a live keep must prevent another image submission");
  transport.respond = async () => assert.fail("a live keep must prevent another review");
  const frame = await generateApprovedFrame({ ...config, storyboardMaxAttempts: 8 }, transport, input, f.context);
  assert.deepEqual(frame, kept);
  f.assets.get(kept.assetId)!.bytes = Buffer.from("invalid kept file");
  await assert.rejects(generateApprovedFrame(config, transport, input, f.context),
    (error: unknown) => error instanceof MovieError && error.code === "SAVED_FRAME_UNAVAILABLE");
});

test("a live keep just before review skips that paid review", async () => {
  const f = await fixture();
  const records = enableLiveFrames(f);
  const report = f.context.report;
  f.context.report = async event => {
    await report(event);
    if (event.stage === "VALIDATING") {
      const candidate = [...records.values()].at(-1)!;
      records.set(candidate.assetId, {
        ...candidate, designerDecision: { action: "keep", note: "Use this image.", at: new Date().toISOString() },
      });
    }
  };
  const transport = client(pass, f.generated);
  transport.respond = async () => assert.fail("a designer keep before review must avoid that request");
  const result = await generateApprovedFrame(config, transport, { ...f, shot: f.plan.shots[0] }, f.context);
  assert.equal(result.designerDecision?.action, "keep");
  assert.equal(result.continuity.verdict, "REJECT", "the pre-review AI state must not be changed to PASS by a human choice");
  assert.match(result.continuity.reasons[0], /review has not completed/);
});

test("live keeps during AI review win without overwriting the returned AI verdict", async () => {
  for (const verdict of ["RETRY", "REJECT"] as const) {
    const f = await fixture();
    const records = enableLiveFrames(f);
    const transport = client(pass, f.generated);
    let calls = 0;
    const edit = transport.edit;
    transport.edit = async (request, options) => { calls++; return edit(request, options); };
    transport.respond = async () => {
      const candidate = [...records.values()].at(-1)!;
      records.set(candidate.assetId, {
        ...candidate, designerDecision: { action: "keep", note: "Approved by the designer.", at: new Date().toISOString() },
      });
      return { id: "live-reviewed-keep", status: "completed", output_text: JSON.stringify({ verdict, reasons: ["Visible wardrobe mismatch"], confidence: 0.9 }) };
    };
    const result = await generateApprovedFrame({ ...config, storyboardMaxAttempts: 8 }, transport, { ...f, shot: f.plan.shots[0] }, f.context);
    assert.equal(calls, 1);
    assert.equal(result.designerDecision?.action, "keep");
    assert.equal(result.continuity.verdict, verdict);
    assert.deepEqual(result, records.get(result.assetId));
  }
});

test("a keep received between attempts stops the corrective image submission", async () => {
  const f = await fixture();
  const records = enableLiveFrames(f);
  const transport = client({ verdict: "RETRY", reasons: ["Minor detail mismatch"], confidence: 0.8 }, f.generated);
  let calls = 0;
  const edit = transport.edit;
  transport.edit = async (request, options) => { calls++; return edit(request, options); };
  const report = f.context.report;
  f.context.report = async event => {
    await report(event);
    if (event.stage === "STORYBOARDING" && event.message.includes("attempt 2/")) {
      const candidate = [...records.values()].at(-1)!;
      records.set(candidate.assetId, {
        ...candidate, designerDecision: { action: "keep", note: "Keep image two and move on.", at: new Date().toISOString() },
      });
    }
  };
  const frame = await generateApprovedFrame({ ...config, storyboardMaxAttempts: 8 }, transport, { ...f, shot: f.plan.shots[0] }, f.context);
  assert.equal(calls, 1);
  assert.equal(frame.continuity.verdict, "RETRY");
  assert.equal(frame.designerDecision?.action, "keep");
});

test("live regenerate overrides a new AI PASS, refreshes the note and retains the attempt cap", async () => {
  const f = await fixture();
  const records = enableLiveFrames(f);
  const transport = client(pass, f.generated);
  const firstNote = "Try a lower camera.";
  const latestNote = "Instead use a slightly wider composition.";
  let reviews = 0;
  transport.respond = async () => {
    reviews++;
    if (reviews === 1) {
      const candidate = [...records.values()].at(-1)!;
      records.set(candidate.assetId, {
        ...candidate, designerDecision: { action: "regenerate", note: firstNote, at: new Date().toISOString() },
      });
    }
    return { id: `live-regenerate-${reviews}`, status: "completed", output_text: JSON.stringify(pass) };
  };
  const report = f.context.report;
  f.context.report = async event => {
    await report(event);
    if (event.stage === "STORYBOARDING" && event.message.includes("attempt 2/")) {
      const candidate = [...records.values()].at(-1)!;
      records.set(candidate.assetId, {
        ...candidate, designerDecision: { action: "regenerate", note: latestNote, at: new Date().toISOString() },
      });
    }
  };
  const prompts: string[] = [];
  const edit = transport.edit;
  transport.edit = async (request, options) => { prompts.push(request.prompt); return edit(request, options); };
  const result = await generateApprovedFrame({ ...config, storyboardMaxAttempts: 8 }, transport, { ...f, shot: f.plan.shots[0] }, f.context);
  assert.equal(prompts.length, 2);
  const correction = JSON.parse(prompts[1].split("\n").at(-1)!).correction;
  assert.ok(correction.includes(latestNote));
  assert.ok(!correction.includes(firstNote), "an updated note must replace a stale designer instruction");
  assert.ok(SAFE_STORYBOARD_VARIATIONS.some(variation => correction.includes(variation.instruction)));
  const rejectedByDesigner = [...records.values()].find(frame => frame.designerDecision?.action === "regenerate");
  assert.ok(rejectedByDesigner);
  assert.equal(rejectedByDesigner.continuity.verdict, "PASS");
  assert.notEqual(result.assetId, rejectedByDesigner.assetId);
  assert.equal(result.designerDecision, undefined);
});

test("repeated live regenerate requests cannot exceed the configured image attempt cap", async () => {
  const f = await fixture();
  const records = enableLiveFrames(f);
  const transport = client(pass, f.generated);
  let calls = 0;
  const edit = transport.edit;
  transport.edit = async (request, options) => { calls++; return edit(request, options); };
  transport.respond = async () => {
    const candidate = [...records.values()].at(-1)!;
    records.set(candidate.assetId, {
      ...candidate, designerDecision: { action: "regenerate", note: "Try another safe composition.", at: new Date().toISOString() },
    });
    return { id: "always-regenerate", status: "completed", output_text: JSON.stringify(pass) };
  };
  await assert.rejects(generateApprovedFrame({ ...config, storyboardMaxAttempts: 2 }, transport, { ...f, shot: f.plan.shots[0] }, f.context),
    (error: unknown) => error instanceof MovieError && error.code === "CONTINUITY_REJECTED");
  assert.equal(calls, 2);
  assert.equal(records.size, 2);
  assert.ok([...records.values()].every(frame => frame.continuity.verdict === "PASS" && frame.designerDecision?.action === "regenerate"));
});

test("stale unrelated AI approvals and another shot's keep cannot override a current failed candidate", async () => {
  const f = await fixture();
  const input = { ...f, shot: f.plan.shots[0] };
  const earlier = await generateApprovedFrame(config, client(pass, f.generated), input, f.context);
  const records = enableLiveFrames(f);
  const otherShot: StoryboardFrame = {
    ...earlier, assetId: randomUUID(), shotId: f.plan.shots[1].id,
    designerDecision: { action: "keep", note: "Only keep this other shot.", at: new Date().toISOString() },
  };
  records.set(otherShot.assetId, otherShot);
  const transport = client({ verdict: "RETRY", reasons: ["Wrong vehicle color"], confidence: 0.9 }, f.generated);
  let calls = 0;
  const edit = transport.edit;
  transport.edit = async (request, options) => { calls++; return edit(request, options); };
  await assert.rejects(generateApprovedFrame(config, transport, input, f.context),
    (error: unknown) => error instanceof MovieError && error.code === "CONTINUITY_REJECTED");
  assert.equal(calls, 2);
});

test("a designer can keep an earlier candidate while another candidate is under review", async () => {
  const f = await fixture();
  const input = { ...f, shot: f.plan.shots[0] };
  const earlier = await generateApprovedFrame(config, client(pass, f.generated), input, f.context);
  const records = enableLiveFrames(f);
  const transport = client(pass, f.generated);
  transport.respond = async () => {
    records.set(earlier.assetId, {
      ...earlier, designerDecision: { action: "keep", note: "The earlier composition was better.", at: new Date().toISOString() },
    });
    return { id: "use-earlier", status: "completed", output_text: JSON.stringify({ verdict: "RETRY", reasons: ["Wrong car"], confidence: 0.9 }) };
  };
  const result = await generateApprovedFrame(config, transport, input, f.context);
  assert.equal(result.assetId, earlier.assetId);
  assert.equal(result.designerDecision?.action, "keep");
  assert.equal(records.size, 2, "the in-flight image must still be retained as evidence");
});

test("live movie-first regeneration does not silently return the discarded visual or exceed one submission", async () => {
  const f = await fixture();
  const records = enableLiveFrames(f);
  const saveFrame = f.context.saveFrame;
  f.context.saveFrame = async frame => {
    await saveFrame(frame);
    records.set(frame.assetId, {
      ...frame, designerDecision: { action: "regenerate", note: "Use another composition.", at: new Date().toISOString() },
    });
  };
  const transport = client(pass, f.generated);
  transport.respond = async () => assert.fail("movie-first must not review");
  let calls = 0;
  const edit = transport.edit;
  transport.edit = async (request, options) => { calls++; return edit(request, options); };
  await assert.rejects(generateApprovedFrame({ ...config, storyboardMaxAttempts: 8 }, transport, { ...f, shot: f.plan.shots[0] }, f.context, undefined, [], false),
    (error: unknown) => error instanceof MovieError && error.code === "CONTINUITY_REJECTED");
  assert.equal(calls, 1);
  assert.equal([...records.values()][0].continuity.verdict, "NOT_REVIEWED");
});
