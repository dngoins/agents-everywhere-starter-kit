import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import { z } from "zod";
import { MovieError } from "../src/domain";
import type { GenerationContext } from "../src/domain/services";
import { providerFailure, structured, type OpenAITransport } from "../src/providers/openai/client";

function apiError(code: string, type = "insufficient_quota", retryAfter?: string) {
  return OpenAI.APIError.generate(429, {
    error: { code, type, message: "private-provider-message", param: "private-parameter" },
  }, undefined, new Headers(retryAfter ? { "retry-after": retryAfter } : undefined));
}
const signal = () => new AbortController().signal;

test("exhausted API credits explain billing, not a model or temporary rate-limit problem", () => {
  const error = providerFailure(apiError("credit_balance_exhausted"), "REQUEST_FAILED", "OpenAI structured generation", signal());
  assert.equal(error.code, "OPENAI_CREDITS_EXHAUSTED");
  assert.match(error.message, /no prepaid API credits/);
  assert.match(error.message, /Add credits/);
  assert.match(error.message, /changing models will not restore/);
  assert.doesNotMatch(error.message, /private-provider|private-parameter|temporarily rate/);
});

test("specific spend and usage limits take precedence over the broad quota type", () => {
  const expectations = [
    ["project_spend_limit_exceeded", "OPENAI_PROJECT_SPEND_LIMIT"],
    ["organization_spend_limit_exceeded", "OPENAI_ORGANIZATION_SPEND_LIMIT"],
    ["organization_usage_limit_exceeded", "OPENAI_ORGANIZATION_USAGE_LIMIT"],
    ["insufficient_quota", "OPENAI_QUOTA_EXHAUSTED"],
    ["future_billing_code", "OPENAI_QUOTA_EXHAUSTED"],
  ];
  for (const [providerCode, expected] of expectations) {
    const error = providerFailure(apiError(providerCode), "REQUEST_FAILED", "Image generation", signal());
    assert.equal(error.code, expected);
    assert.doesNotMatch(error.message, /private-provider|private-parameter/);
  }
});

test("temporary throttling uses only bounded numeric Retry-After guidance", () => {
  const rate = providerFailure(apiError("rate_limit_exceeded", "rate_limit_error", "15"), "REQUEST_FAILED", "Reference analysis", signal());
  assert.equal(rate.code, "OPENAI_RATE_LIMITED");
  assert.match(rate.message, /at least 15 seconds/);
  assert.doesNotMatch(rate.message, /billing|credits/);
  for (const header of ["private-value", "999999999999999999999", "0"]) {
    const error = providerFailure(apiError("slow_down", "rate_limit_error", header), "REQUEST_FAILED", "Reference analysis", signal());
    assert.equal(error.code, "OPENAI_RATE_LIMITED");
    assert.doesNotMatch(error.message, /private-value|999999|at least 0/);
  }
});

test("unknown errors stay sanitized and explicit cancellation still propagates", () => {
  const error = providerFailure(new Error("private-key-or-photo"), "REQUEST_FAILED", "Generation", signal());
  assert.doesNotMatch(error.message, /private-key-or-photo/);
  assert.equal(error.code, "REQUEST_FAILED");
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => providerFailure(apiError("credit_balance_exhausted"), "REQUEST_FAILED", "Generation", controller.signal), { name: "AbortError" });
});

test("image parameter rejection is distinguished from quota without leaking raw provider messages", () => {
  const error = OpenAI.APIError.generate(400, {
    error: { code: "invalid_input_fidelity_model", type: "image_generation_user_error", param: "input_fidelity", message: "private-provider-message" },
  }, undefined, new Headers());
  const result = providerFailure(error, "STORYBOARD_GENERATION_FAILED", "Image generation for shot_01", signal());
  assert.equal(result.code, "OPENAI_UNSUPPORTED_IMAGE_OPTION");
  assert.match(result.message, /does not support input_fidelity/);
  assert.doesNotMatch(result.message, /private-provider-message|Check provider quota/);
  for (const parameter of ["size", "private-parameter"]) {
    const rejected = OpenAI.APIError.generate(400, {
      error: { code: "invalid_value", param: parameter, message: "private-provider-message" },
    }, undefined, new Headers());
    const diagnosed = providerFailure(rejected, "STORYBOARD_GENERATION_FAILED", "Image generation", signal());
    assert.equal(diagnosed.code, "OPENAI_INVALID_REQUEST");
    assert.doesNotMatch(diagnosed.message, /private-parameter|private-provider-message/);
    if (parameter === "size") assert.match(diagnosed.message, /\(size\)/);
  }
});

test("structured reference failure exposes the specific account issue without retries or artifact claims", async () => {
  let calls = 0;
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected artifact access"); };
  const context: GenerationContext = {
    jobId: "test", ownerId: "test", signal: signal(),
    media: { getAsset: unexpected, readAsset: unexpected, assetPath: unexpected, saveAsset: unexpected },
    report: unexpected, warn: unexpected, recordOperation: unexpected, saveFrame: unexpected,
  };
  const transport: OpenAITransport = {
    async respond(_input, options) {
      calls++;
      assert.equal(options.maxRetries, 0);
      throw apiError("credit_balance_exhausted");
    },
    edit: unexpected,
  };
  await assert.rejects(structured(transport, {
    model: "test-model", name: "test", schema: z.object({ ready: z.boolean() }).strict(),
    instructions: "Offline test", content: [{ type: "input_text", text: "No customer data." }],
  }, context), (error: unknown) => error instanceof MovieError && error.code === "OPENAI_CREDITS_EXHAUSTED");
  assert.equal(calls, 1);
});
