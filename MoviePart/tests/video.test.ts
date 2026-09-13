import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { GenerateVideosOperation, type GenerateVideosParameters } from "@google/genai";
import type { AssetRecord, CharacterReference, MoviePlan, ProductReference, StoryboardFrame } from "../src/domain";
import { getTimeline, MovieError } from "../src/domain";
import { GENERIC_WARDROBE } from "../src/references";
import type { GenerationContext, MovieConfig } from "../src/domain/services";
import { createVeoService, type VeoDependencies, type VeoTransport } from "../src/providers/google";
import { downloadVeoVideo } from "../src/video/download";

const config: MovieConfig = {
  dataDir: ".movie-data", imageModel: "gpt-image-2.5-flare", veoModel: "veo-3.1-generate-preview",
  googleKey: "offline-test-only",
};
const pass = { verdict: "PASS" as const, reasons: ["Visible continuity supported"], confidence: 0.95 };
const operation = (fields: Partial<GenerateVideosOperation>) => Object.assign(new GenerateVideosOperation(), fields);

async function fixture() {
  const ownerId = "test-owner";
  const controller = new AbortController();
  const warnings: string[] = [];
  const records: AssetRecord[] = [];
  const entries = new Map<string, Uint8Array>();
  const sequence: string[] = [];
  const context: GenerationContext = {
    jobId: randomUUID(), ownerId, signal: controller.signal,
    media: {
      async getAsset(id) { const value = records.find(record => record.id === id); assert.ok(value); return value; },
      async readAsset(id) { const value = entries.get(id); assert.ok(value); return value; },
      async assetPath() { throw new Error("Offline review is injected"); },
      async saveAsset(input) {
        const record: AssetRecord = {
          ...input, bytes: input.bytes.length, id: randomUUID(), filename: "private-test",
          width: input.width ?? null, height: input.height ?? null, createdAt: new Date().toISOString(),
        };
        records.push(record); entries.set(record.id, input.bytes);
        return record;
      },
    },
    async report() {},
    async warn(message) { warnings.push(message); },
    async saveFrame() {},
    async recordOperation(provider, id) { sequence.push(`record:${provider}:${id}`); },
  };
  const image = await sharp({ create: { width: 16, height: 9, channels: 3, background: "#884433" } }).png().toBuffer();
  const save = (kind: AssetRecord["kind"]) => context.media.saveAsset({ ownerId, jobId: null, kind, mime: "image/png", bytes: image });
  const [photo, carA, carB, first, last] = await Promise.all([save("customer"), save("product"), save("product"), save("storyboard"), save("storyboard")]);
  const character: CharacterReference = {
    id: randomUUID(), version: 1, primaryAssetId: photo.id, sourceImages: [{ assetId: photo.id, role: "Primary", origin: "original" }],
    consent: { likeness: true, personalization: true },
    attributes: { face: null, eyes: null, eyebrows: null, nose: null, mouth: null, hair: null, complexion: null, visibleProportions: null, wardrobe: "Blue jacket", accessories: [] },
  };
  const product: ProductReference = {
    id: "demo", version: 1, name: "Demo vehicle", make: null, model: null, exteriorColor: "blue", interiorColor: null,
    appearance: "Blue sedan", approvedClaims: [], usagePermission: "Offline test fixture",
    referenceImages: [{ assetId: carA.id, role: "exterior", origin: "original" }, { assetId: carB.id, role: "interior", origin: "original" }],
  };
  const plan: MoviePlan = {
    id: randomUUID(), characterId: character.id, productId: product.id, templateId: "DREAM_ROUTE", templateVersion: 1, referenceVersion: 1,
    durationSeconds: 18, aspectRatio: "16:9", heroShotId: "shot_03", wardrobe: "Blue jacket", logline: "A scenic journey",
    cinematicStyle: "Warm", worldTransitions: "Continuous route", personalizationUsed: [],
    shots: (["shot_01", "shot_02", "shot_03", "shot_04"] as const).map((id, index) => ({
      id, durationSeconds: [3, 3, 8, 4][index], purpose: "Journey", camera: "Tracking", action: "Scenic driving",
      environment: "Road", lighting: "Warm daylight", personalization: [], imagePrompt: "Consistent frame", motionPrompt: "Gentle tracking", audioCues: [],
    })),
  };
  const frames: StoryboardFrame[] = [{ shotId: "shot_03", assetId: first.id, continuity: pass, provider: "OpenAI", model: config.imageModel }];
  const transport: VeoTransport = {
    async generate() { sequence.push("generate"); return operation({ name: "models/veo/operations/offline", done: false }); },
    async poll() {
      sequence.push("poll");
      return operation({ name: "models/veo/operations/offline", done: true, response: { generatedVideos: [{ video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/offline:download", mimeType: "video/mp4" } }] } });
    },
  };
  const dependencies: VeoDependencies = {
    transport,
    async endFrame(input, _context, start) {
      assert.equal(input.endpoint, "end");
      assert.equal(start, first.id);
      assert.equal(input.character.primaryAssetId, photo.id);
      assert.equal(input.product.referenceImages.length, 2);
      return { ...frames[0], shotId: "shot_03_end", assetId: last.id };
    },
    async review() { sequence.push("review"); return pass; },
    async download() { sequence.push("download"); return Buffer.from("explicit offline MP4 fixture"); },
    async wait() {},
  };
  return { input: { plan, character, product, frames }, context, controller, warnings, records, entries, sequence, transport, dependencies, first, last };
}

test("missing Veo key and unsupported models fall back without paid calls", async () => {
  const f = await fixture();
  f.dependencies.endFrame = async () => assert.fail("no end frame should be generated");
  assert.equal(await createVeoService({ ...config, googleKey: undefined }, f.dependencies).generate(f.input, f.context), null);
  assert.equal(await createVeoService({ ...config, veoModel: "veo-2.0-generate-001" }, f.dependencies).generate(f.input, f.context), null);
  assert.equal(f.warnings.length, 2);
  assert.equal(f.sequence.length, 0);
});

test("Veo uses supported first/last byte inputs, exactly eight seconds, no SDK retries and records operation before polling", async () => {
  const f = await fixture();
  let submitted: GenerateVideosParameters | undefined;
  const original = f.transport.generate;
  f.transport.generate = async request => { submitted = request; return original(request); };
  const result = await createVeoService(config, f.dependencies).generate(f.input, f.context);
  assert.ok(result);
  assert.equal(result.shotId, "shot_03");
  assert.equal(result.provider, "Google Veo");
  assert.ok(submitted);
  assert.equal(submitted.config?.durationSeconds, 8);
  assert.equal(submitted.config?.aspectRatio, "16:9");
  assert.equal(submitted.config?.resolution, "720p");
  assert.equal(submitted.config?.httpOptions?.retryOptions?.attempts, 1);
  assert.equal(submitted.config?.referenceImages, undefined, "referenceImages cannot be combined with first/last frames");
  assert.equal(submitted.image?.imageBytes, Buffer.from(f.entries.get(f.first.id)!).toString("base64"));
  assert.equal(submitted.config?.lastFrame?.imageBytes, Buffer.from(f.entries.get(f.last.id)!).toString("base64"));
  assert.deepEqual(f.sequence, ["generate", "record:Google Veo:models/veo/operations/offline", "poll", "download", "review"]);
  assert.equal(f.records.find(record => record.id === result.assetId)?.kind, "video");
  assert.deepEqual(f.warnings, []);
});

test("six-shot Veo selects shot_04 and its matching end frame, preserving explicit no-likeness modes", async () => {
  for (const heroMode of ["POV", "PERSONALIZED"] as const) {
    const f = await fixture();
    const timeline = getTimeline("six-shot", "HERO_OF_THE_DAY");
    f.input.plan = {
      ...f.input.plan, storyFormat: "six-shot", templateId: "HERO_OF_THE_DAY", heroMode,
      wardrobe: GENERIC_WARDROBE, durationSeconds: timeline.durationSeconds, heroShotId: timeline.heroShotId,
      shots: timeline.shotIds.map((id, index) => ({ ...f.input.plan.shots[0], id, durationSeconds: timeline.durations[index] })),
    };
    f.input.character.attributes.face = "Private customer face sentinel";
    f.input.frames = [{ ...f.input.frames[0], shotId: "shot_04" }];
    const privatePhoto = f.input.character.primaryAssetId!;
    const customerBytes = await sharp({ create: { width: 16, height: 9, channels: 3, background: "#aaff00" } }).png().toBuffer();
    f.entries.set(privatePhoto, customerBytes);
    f.dependencies.endFrame = async input => {
      assert.equal(input.shot.id, "shot_04");
      assert.equal(input.plan.heroMode, heroMode);
      return { ...f.input.frames[0], shotId: "shot_04_end", assetId: f.last.id };
    };
    let submissions = 0;
    const generate = f.transport.generate;
    f.transport.generate = async request => {
      submissions++;
      assert.equal(request.config?.durationSeconds, 8);
      const serialized = JSON.stringify(request);
      assert.ok(!serialized.includes(customerBytes.toString("base64")));
      assert.ok(!serialized.includes("Private customer face sentinel"));
      assert.ok(!serialized.includes("Blue jacket"));
      assert.match(request.prompt!, heroMode === "POV" ? /Never show any faces.*reflections/ : /generic protagonist seen only from behind/i);
      return generate(request);
    };
    const result = await createVeoService(config, f.dependencies).generate(f.input, f.context);
    assert.equal(result?.shotId, "shot_04");
    assert.equal(submissions, 1);
    f.dependencies.endFrame = async () => ({ ...f.input.frames[0], shotId: "shot_03_end", assetId: f.last.id });
    assert.equal(await createVeoService(config, f.dependencies).generate(f.input, f.context), null);
    assert.equal(submissions, 1, "wrong endpoint must not be submitted");
  }
});

test("Veo bounded polling stops without resubmitting its paid operation", async () => {
  const f = await fixture();
  let polls = 0;
  f.transport.poll = async () => { polls++; return operation({ name: "models/veo/operations/offline", done: false }); };
  const result = await createVeoService(config, { ...f.dependencies, maxPolls: 2 }).generate(f.input, f.context);
  assert.equal(result, null);
  assert.equal(polls, 2);
  assert.equal(f.sequence.filter(value => value === "generate").length, 1);
  assert.match(f.warnings[0], /polling window/);
});

test("Veo resumes a saved operation without generating images or submitting another video", async () => {
  const f = await fixture();
  const operationId = "models/veo-3.1-generate-preview/operations/existing";
  f.input.plan.videoProvider = "google-veo";
  f.dependencies.endFrame = async () => assert.fail("Do not regenerate the approved endpoint");
  f.transport.generate = async () => assert.fail("Do not submit another paid video");
  const poll = f.transport.poll;
  f.transport.poll = async input => {
    assert.equal(input.operation.name, operationId);
    return poll(input);
  };
  const result = await createVeoService(config, f.dependencies).generate({ ...f.input, operationId }, f.context);
  assert.equal(result?.provider, "Google Veo");
  assert.equal(result?.model, "veo-3.1-generate-preview");
  assert.deepEqual(f.sequence, ["poll", "download", "review"]);
});

test("required Veo preserves a safe review failure instead of reporting that animation was not generated", async () => {
  const f = await fixture();
  f.input.plan.videoProvider = "google-veo";
  f.dependencies.review = async () => { throw new MovieError("OPENAI_CREDITS_EXHAUSTED", "Review needs OpenAI credits.", 502); };
  await assert.rejects(createVeoService(config, f.dependencies).generate(f.input, f.context),
    (error: unknown) => error instanceof MovieError && error.code === "OPENAI_CREDITS_EXHAUSTED");
  assert.deepEqual(f.warnings, ["Review needs OpenAI credits."]);
  assert.ok(f.records.some(asset => asset.kind === "video"), "Keep the generated clip when review fails");
});

test("Veo uses the configured practical review threshold and rejects invalid resume identifiers without calls", async () => {
  const f = await fixture();
  f.input.plan.videoProvider = "google-veo";
  f.dependencies.review = async () => ({ ...pass, confidence: 0.6 });
  assert.ok(await createVeoService({ ...config, continuityPolicy: "practical" }, f.dependencies).generate(f.input, f.context));
  await assert.rejects(createVeoService({ ...config, continuityPolicy: "strict" }, f.dependencies).generate(f.input, f.context),
    (error: unknown) => error instanceof MovieError && error.code === "VEO_CONTINUITY_REJECTED");
  const calls = f.sequence.length;
  await assert.rejects(createVeoService(config, f.dependencies).generate({ ...f.input, operationId: "https://unexpected.example/video" }, f.context),
    (error: unknown) => error instanceof MovieError && error.code === "INVALID_VEO_OPERATION");
  assert.equal(f.sequence.length, calls);
});

test("Veo rejection, missing operation IDs, network errors and review rejection all warn and fall back", async () => {
  for (const variant of ["rejected", "missing-id", "network", "review"] as const) {
    const f = await fixture();
    if (variant === "rejected") f.transport.generate = async () => operation({ name: "operation-offline", done: true, error: { message: "private-provider-details" } });
    if (variant === "missing-id") f.transport.generate = async () => operation({ done: false });
    if (variant === "network") f.transport.generate = async () => { throw new Error("private-provider-details"); };
    if (variant === "review") f.dependencies.review = async () => ({ verdict: "REJECT", reasons: ["Changed vehicle"], confidence: 0.9 });
    assert.equal(await createVeoService(config, f.dependencies).generate(f.input, f.context), null);
    assert.equal(f.warnings.length, 1);
    assert.ok(!f.warnings[0].includes("private-provider-details"));
    if (variant === "review") assert.ok(f.records.some(record => record.kind === "video"));
  }
});

test("a rejected hero end frame never reaches Veo generation", async () => {
  const f = await fixture();
  f.dependencies.endFrame = async () => ({ ...f.input.frames[0], shotId: "shot_03_end", continuity: { verdict: "REJECT", reasons: ["Drift"], confidence: 0.9 } });
  assert.equal(await createVeoService(config, f.dependencies).generate(f.input, f.context), null);
  assert.equal(f.sequence.length, 0);
});

test("Veo marks submission only after endpoint preparation and before the video request", async () => {
  const f = await fixture();
  const endFrame = f.dependencies.endFrame!;
  f.dependencies.endFrame = async (...args) => {
    assert.ok(!f.sequence.includes("submission-started"));
    return endFrame(...args);
  };
  f.context.beforeVideoSubmission = async () => { f.sequence.push("submission-started"); };
  const generate = f.transport.generate;
  f.transport.generate = async input => {
    assert.equal(f.sequence.at(-1), "submission-started");
    return generate(input);
  };
  assert.ok(await createVeoService(config, f.dependencies).generate(f.input, f.context));
  assert.equal(f.sequence.filter(value => value === "submission-started").length, 1);

  const failed = await fixture();
  failed.dependencies.endFrame = async () => { throw new MovieError("CONTINUITY_REJECTED", "Endpoint is not approved."); };
  failed.context.beforeVideoSubmission = async () => assert.fail("Preparation must not mark a paid video attempt");
  failed.transport.generate = async () => assert.fail("No video request before endpoint approval");
  assert.equal(await createVeoService(config, failed.dependencies).generate(failed.input, failed.context), null);
});

test("Veo reuses an approved saved endpoint and never submits when its durable guard fails", async () => {
  const f = await fixture();
  f.input.plan.videoProvider = "google-veo";
  const bytes = await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#884433" } }).png().toBuffer();
  const saved = await f.context.media.saveAsset({
    ownerId: f.context.ownerId, jobId: f.context.jobId, kind: "storyboard", mime: "image/png",
    bytes, width: 1280, height: 720,
  });
  f.context.getFrames = async () => [{ ...f.input.frames[0], shotId: "shot_03_end", assetId: saved.id }];
  f.dependencies.endFrame = async () => assert.fail("Do not regenerate an approved end frame");
  f.context.beforeVideoSubmission = async () => { throw new MovieError("STORE_BUSY", "The store is busy.", 503); };
  await assert.rejects(createVeoService(config, f.dependencies).generate(f.input, f.context),
    (error: unknown) => error instanceof MovieError && error.code === "STORE_BUSY");
  assert.equal(f.sequence.length, 0, "No provider submission when checkpointing fails");
  f.context.beforeVideoSubmission = async () => {};
  assert.ok(await createVeoService(config, f.dependencies).generate(f.input, f.context));
  assert.equal(f.sequence.filter(value => value === "generate").length, 1);
});

test("invalid hero timing or a missing approved still prevents submissions", async () => {
  const f = await fixture();
  f.input.plan.shots[2].durationSeconds = 7;
  assert.equal(await createVeoService(config, f.dependencies).generate(f.input, f.context), null);
  assert.equal(f.sequence.length, 0);
});

test("internal Veo timeout falls back, but explicit cancellation propagates", async () => {
  const f = await fixture();
  f.transport.generate = async request => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      request.config?.abortSignal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Internal deadline", "AbortError")); }, { once: true });
    });
    return operation({});
  };
  assert.equal(await createVeoService(config, { ...f.dependencies, timeoutMs: 5 }).generate(f.input, f.context), null);
  assert.equal(f.warnings.length, 1);
  f.controller.abort();
  await assert.rejects(createVeoService(config, f.dependencies).generate(f.input, f.context), { name: "AbortError" });
});

test("downloads reject arbitrary initial hosts and redirects before sending credentials", async () => {
  let calls = 0;
  const request: typeof fetch = async (_input, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "private-key");
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://attacker.example/steal" } });
  };
  await assert.rejects(downloadVeoVideo("https://attacker.example/fake.mp4", "private-key", new AbortController().signal, request), /host/);
  assert.equal(calls, 0);
  await assert.rejects(downloadVeoVideo("https://generativelanguage.googleapis.com/v1beta/files/test:download", "private-key", new AbortController().signal, request), /URL/);
  assert.equal(calls, 1);
});

test("downloads strip the API key when redirecting to official signed storage URLs", async () => {
  let calls = 0;
  const request: typeof fetch = async (_input, init) => {
    calls++;
    if (calls === 1) return new Response(null, { status: 302, headers: { location: "https://storage.googleapis.com/official/video.mp4?signature=test" } });
    assert.equal(new Headers(init?.headers).has("x-goog-api-key"), false);
    return new Response("video bytes", { headers: { "content-type": "video/mp4" } });
  };
  const bytes = await downloadVeoVideo("https://generativelanguage.googleapis.com/v1beta/files/test:download", "private-key", new AbortController().signal, request);
  assert.equal(Buffer.from(bytes).toString(), "video bytes");
  assert.equal(calls, 2);
});

test("downloads reject oversized payloads and non-video media", async () => {
  const cases: Record<string, string>[] = [{ "content-type": "text/html" }, { "content-type": "video/mp4", "content-length": String(100 * 1024 * 1024) }];
  for (const headers of cases) {
    const request: typeof fetch = async () => new Response("bad", { headers });
    await assert.rejects(downloadVeoVideo("https://generativelanguage.googleapis.com/v1beta/files/test:download", "private-key", new AbortController().signal, request));
  }
});
