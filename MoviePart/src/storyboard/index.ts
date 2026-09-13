import { toFile } from "openai";
import sharp from "sharp";
import { isOpenAIHero, moviePlanSchema, MovieError, type StoryboardFrame } from "../domain";
import type { GenerationContext, MovieConfig, StoryboardService } from "../domain/services";
import { inspectContinuity } from "../continuity";
import { providerFailure, rethrowCancellation, type OpenAITransport } from "../providers/openai/client";
import { storyboardImageOptions } from "../providers/openai/image-options";
import { loadOriginals, readImage } from "../references";
import { assertFrameInput, compileFramePrompt, type FrameInput } from "./compile";
import { isFrameApproved, selectStoryboardFrames } from "../domain/storyboard-state";
import { validateApprovedFrame } from "../jobs/retry";
import { pickStoryboardVariation, type StoryboardVariation } from "./variations";

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(maximum, Math.max(1, Math.floor(value)));
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError");
}

async function readDesignerChoice(context: GenerationContext, shotId: string, assetId?: string): Promise<{
  kept?: StoryboardFrame;
  current?: StoryboardFrame;
}> {
  if (!context.getFrames) return {};
  const frames = await context.getFrames();
  const selected = selectStoryboardFrames(frames, [shotId])[0];
  if (selected?.designerDecision?.action === "keep") {
    await validateApprovedFrame(selected, context);
    return { kept: selected };
  }
  // An older AI approval must not override the candidate currently being reviewed.
  return { current: assetId
    ? [...frames].reverse().find(frame => frame.shotId === shotId && frame.assetId === assetId)
    : selected };
}

export async function normalizeFrame(bytes: Uint8Array): Promise<Buffer> {
  try {
    const image = sharp(bytes, { limitInputPixels: 25_000_000 });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error("Invalid image");
    // Contain preserves proportions and all reference detail rather than stretching or cropping faces.
    return await image.rotate().resize(1280, 720, { fit: "contain", background: "#101010" }).flatten({ background: "#101010" }).png().toBuffer();
  } catch {
    throw new MovieError("INVALID_GENERATED_IMAGE", "The provider returned an invalid or oversized storyboard image.", 502);
  }
}

export async function generateApprovedFrame(
  config: MovieConfig,
  transport: OpenAITransport,
  input: FrameInput,
  context: GenerationContext,
  supplementalAssetId?: string,
  initialCorrections: string[] = [],
  review = true,
): Promise<StoryboardFrame> {
  assertFrameInput(input);
  context.signal.throwIfAborted();
  const shotId = input.endpoint === "end" ? `${input.shot.id}_end` : input.shot.id;
  const model = config.imageModel || "gpt-image-2.5-flare";
  const maxAttempts = review ? boundedInteger(config.storyboardMaxAttempts, 2, 20) : 1;
  const originals = await loadOriginals(input.character, input.product, context, /interior|cabin|dashboard|seat/i.test(`${input.shot.action} ${input.shot.environment}`), isOpenAIHero(input.plan, input.shot.id) ? "PERSONALIZED" : input.plan.heroMode);
  const references = supplementalAssetId
    ? [...originals, await readImage(supplementalAssetId, "supplement", "Approved shot start; composition only", context)]
    : originals;
  const image = await Promise.all(references.map((reference, index) => toFile(reference.bytes, `reference-${index + 1}.${reference.mime.split("/")[1]}`, { type: reference.mime })));
  let correction = [...initialCorrections];
  const usedVariations = new Set<string>();
  let variation: StoryboardVariation | undefined;
  let lastAssetId: string | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    context.signal.throwIfAborted();
    await context.report({ stage: "STORYBOARDING", provider: "OpenAI", shotId, message: review
      ? `Generating reference-conditioned ${input.endpoint === "end" ? "hero end" : "storyboard"} frame (attempt ${attempt + 1}/${maxAttempts}).${variation ? ` Safe composition variation: ${variation.label}.` : ""}`
      : "Creating one reference-based scene visual for the movie; no continuity approval loop." });
    const beforeAttempt = await readDesignerChoice(context, shotId, lastAssetId);
    if (beforeAttempt.kept) return beforeAttempt.kept;
    if (beforeAttempt.current?.designerDecision?.action === "regenerate") {
      correction = [...beforeAttempt.current.continuity.reasons, beforeAttempt.current.designerDecision.note, ...(variation ? [variation.instruction] : [])];
    }
    context.signal.throwIfAborted();
    let encoded: string | undefined;
    try {
      const response = await transport.edit({
        model, prompt: compileFramePrompt(input, references, correction), image, n: 1,
        ...storyboardImageOptions(model),
      }, { signal: context.signal, maxRetries: 0, timeout: 180_000 });
      if (response._request_id) await context.recordOperation("OpenAI Images", response._request_id);
      encoded = response.data?.[0]?.b64_json;
    } catch (error) {
      // No blind retries: a timeout/network error may have already incurred a paid submission.
      throw providerFailure(error, "STORYBOARD_GENERATION_FAILED", `Image generation for ${shotId}`, context.signal);
    }
    if (!encoded || encoded.length > 70_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new MovieError("INVALID_GENERATED_IMAGE", `No usable image bytes were returned for ${shotId}.`, 502);
    }
    const raw = Buffer.from(encoded, "base64");
    let bytes: Buffer;
    try {
      bytes = await normalizeFrame(raw);
    } catch (error) {
      const evidence = await context.media.saveAsset({ ownerId: context.ownerId, jobId: context.jobId, kind: "storyboard", mime: "application/octet-stream", bytes: raw });
      await context.saveFrame({ shotId, assetId: evidence.id, provider: "OpenAI", model, continuity: { verdict: "REJECT", reasons: ["Generated image bytes could not be decoded."], confidence: 1 } });
      throw error;
    }
    const asset = await context.media.saveAsset({ ownerId: context.ownerId, jobId: context.jobId, kind: "storyboard", mime: "image/png", bytes, width: 1280, height: 720 });
    const frame: StoryboardFrame = {
      shotId, assetId: asset.id, provider: "OpenAI", model,
      source: "generated",
      continuity: review
        ? { verdict: "REJECT", reasons: ["Continuity review has not completed."], confidence: 0 }
        : { verdict: "NOT_REVIEWED", reasons: ["Movie-first scene visual; no continuity approval was requested."], confidence: 0 },
    };
    lastAssetId = frame.assetId;
    await context.saveFrame(frame);
    if (review) {
      await context.report({ stage: "VALIDATING", provider: "OpenAI", shotId, message: "Reviewing visible continuity against original photos; not verifying identity." });
      const beforeReview = await readDesignerChoice(context, shotId, frame.assetId);
      if (beforeReview.kept) return beforeReview.kept;
      try {
        frame.continuity = await inspectContinuity(config, transport, input, originals, [{
          assetId: asset.id, kind: "supplement", origin: "generated", role: `${shotId} candidate`,
          mime: "image/png", bytes,
        }], context);
      } catch (error) {
        rethrowCancellation(error, context.signal);
        frame.continuity = { verdict: "REJECT", reasons: ["Continuity review could not be completed."], confidence: 0 };
        await context.saveFrame(frame);
        if (error instanceof MovieError) {
          throw new MovieError(error.code, `The ${shotId} image was retained, but its continuity review failed. ${error.message}`, error.httpStatus);
        }
        throw new MovieError("CONTINUITY_UNAVAILABLE", `The ${shotId} image was retained, but its continuity review failed.`, 502);
      }
      await context.saveFrame(frame);
    }
    const afterReview = await readDesignerChoice(context, shotId, frame.assetId);
    if (afterReview.kept) return afterReview.kept;
    const decision = afterReview.current?.designerDecision;
    if (decision?.action !== "regenerate" && (!review || frame.continuity.verdict === "PASS")) return frame;
    if (frame.continuity.verdict === "REJECT" || attempt === maxAttempts - 1) {
      throw new MovieError("CONTINUITY_REJECTED", `Visual continuity was not approved for ${shotId}. Generated evidence was retained; ${attempt + 1} of at most ${maxAttempts} image submissions were made in this attempt.`, 422);
    }
    context.signal.throwIfAborted();
    variation = pickStoryboardVariation(usedVariations);
    if (!variation) throw new MovieError("CONTINUITY_REJECTED", "Safe storyboard variations were exhausted. Generated evidence was retained.", 422);
    usedVariations.add(variation.label);
    correction = [...frame.continuity.reasons, ...(decision?.action === "regenerate" ? [decision.note] : []), variation.instruction];
  }
  throw new MovieError("CONTINUITY_REJECTED", "Storyboard attempt budget exhausted.", 422);
}

export function createStoryboardService(config: MovieConfig, transport: OpenAITransport): StoryboardService {
  return {
    async generate(input, context) {
      if (!moviePlanSchema.safeParse(input.plan).success) throw new MovieError("INVALID_PLAN", "A complete timeline-matched plan is required before image generation.", 400);
      for (const shot of input.plan.shots) assertFrameInput({ ...input, shot });
      const saved = selectStoryboardFrames(input.existingFrames ?? [], input.plan.shots.map(shot => shot.id));
      const movieFirst = input.productionMode === "movie-first";
      const reusable = (frame: StoryboardFrame) => isFrameApproved(frame) ||
        (movieFirst && frame.designerDecision?.action !== "regenerate" && frame.continuity.verdict !== "REJECT");
      // Reject a missing saved approval before spending on any later shot.
      for (const frame of saved.filter(reusable)) {
        await validateApprovedFrame(frame, context, !movieFirst);
      }
      const frames: StoryboardFrame[] = new Array(input.plan.shots.length);
      const pool = new AbortController();
      const poolContext: GenerationContext = {
        ...context,
        signal: AbortSignal.any([context.signal, pool.signal]),
        // Checkpoints use the original worker context, not the sibling-cancellation signal.
        saveFrame: frame => context.saveFrame(frame),
      };
      let nextShot = 0;
      const errors: unknown[] = [];
      async function worker(): Promise<void> {
        try {
          while (nextShot < input.plan.shots.length) {
            poolContext.signal.throwIfAborted();
            const index = nextShot++;
            const shot = input.plan.shots[index];
            const prior = saved.find(frame => frame.shotId === shot.id);
            if (prior && reusable(prior)) {
              frames[index] = prior;
              await poolContext.report({ stage: "STORYBOARDING", shotId: shot.id, message: prior.designerDecision?.action === "keep"
                ? "Reusing this designer-kept frame; the original AI verdict is unchanged. No generation or review charge."
                : movieFirst
                  ? "Reusing a saved scene visual for movie assembly; no new generation or continuity review."
                  : "Reusing this approved storyboard frame; no generation or review charge." });
              continue;
            }
            const corrections = [
              ...(prior?.continuity.reasons ?? []),
              ...(prior?.designerDecision?.action === "regenerate" ? [prior.designerDecision.note] : []),
            ];
            frames[index] = await generateApprovedFrame(
              config, transport, { ...input, shot }, poolContext, undefined, corrections, !movieFirst,
            );
          }
        } catch (error) {
          errors.push(error);
          pool.abort();
        }
      }
      const concurrency = Math.min(input.plan.shots.length, boundedInteger(config.storyboardConcurrency, 1, 4));
      await Promise.allSettled(Array.from({ length: concurrency }, () => worker()));
      if (errors.length) throw errors.find(error => !isCancellation(error)) ?? errors[0];
      return frames;
    },
  };
}
