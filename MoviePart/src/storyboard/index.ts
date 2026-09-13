import { toFile } from "openai";
import sharp from "sharp";
import { moviePlanSchema, MovieError, type StoryboardFrame } from "../domain";
import type { GenerationContext, MovieConfig, StoryboardService } from "../domain/services";
import { inspectContinuity } from "../continuity";
import { providerFailure, rethrowCancellation, type OpenAITransport } from "../providers/openai/client";
import { storyboardImageOptions } from "../providers/openai/image-options";
import { loadOriginals, readImage } from "../references";
import { assertFrameInput, compileFramePrompt, type FrameInput } from "./compile";

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
): Promise<StoryboardFrame> {
  assertFrameInput(input);
  const shotId = input.endpoint === "end" ? `${input.shot.id}_end` : input.shot.id;
  const model = config.imageModel || "gpt-image-2.5-flare";
  const originals = await loadOriginals(input.character, input.product, context, /interior|cabin|dashboard|seat/i.test(`${input.shot.action} ${input.shot.environment}`), input.plan.heroMode);
  const references = supplementalAssetId
    ? [...originals, await readImage(supplementalAssetId, "supplement", "Approved shot start; composition only", context)]
    : originals;
  const image = await Promise.all(references.map((reference, index) => toFile(reference.bytes, `reference-${index + 1}.${reference.mime.split("/")[1]}`, { type: reference.mime })));
  let correction: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    context.signal.throwIfAborted();
    await context.report({ stage: "STORYBOARDING", provider: "OpenAI", shotId, message: `Generating reference-conditioned ${input.endpoint === "end" ? "hero end" : "storyboard"} frame (attempt ${attempt + 1}/2).` });
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
      continuity: { verdict: "REJECT", reasons: ["Continuity review has not completed."], confidence: 0 },
    };
    await context.saveFrame(frame);
    await context.report({ stage: "VALIDATING", provider: "OpenAI", shotId, message: "Reviewing visible continuity against original photos; not verifying identity." });
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
    if (frame.continuity.verdict === "PASS") return frame;
    if (frame.continuity.verdict === "REJECT" || attempt === 1) {
      throw new MovieError("CONTINUITY_REJECTED", `Visual continuity was not approved for ${shotId}. Generated evidence was retained; no more than two image submissions were made.`, 422);
    }
    correction = frame.continuity.reasons;
  }
  throw new MovieError("CONTINUITY_REJECTED", "Storyboard attempt budget exhausted.", 422);
}

export function createStoryboardService(config: MovieConfig, transport: OpenAITransport): StoryboardService {
  return {
    async generate(input, context) {
      if (!moviePlanSchema.safeParse(input.plan).success) throw new MovieError("INVALID_PLAN", "A complete timeline-matched plan is required before image generation.", 400);
      const frames: StoryboardFrame[] = [];
      for (const shot of input.plan.shots) {
        frames.push(await generateApprovedFrame(config, transport, { ...input, shot }, context));
      }
      return frames;
    },
  };
}
