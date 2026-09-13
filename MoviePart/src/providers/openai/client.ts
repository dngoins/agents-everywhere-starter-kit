import OpenAI from "openai";
import type { ImageEditParamsNonStreaming, ImagesResponse } from "openai/resources/images";
import type { Response, ResponseCreateParamsNonStreaming, ResponseInputContent } from "openai/resources/responses/responses";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { MovieError } from "../../domain";
import type { GenerationContext, MovieConfig } from "../../domain/services";

export interface OpenAITransport {
  respond(input: ResponseCreateParamsNonStreaming, options: OpenAI.RequestOptions): Promise<Pick<Response, "id" | "status" | "output_text">>;
  edit(input: ImageEditParamsNonStreaming, options: OpenAI.RequestOptions): Promise<ImagesResponse & { _request_id?: string | null }>;
}

export function createOpenAITransport(config: MovieConfig): OpenAITransport {
  let client: OpenAI | undefined;
  const getClient = () => {
    if (!config.openaiKey) {
      throw new MovieError("OPENAI_NOT_CONFIGURED", "OpenAI is required for references, direction and storyboards. Configure OPENAI_API_KEY.", 503);
    }
    return client ??= new OpenAI({ apiKey: config.openaiKey, maxRetries: 0, timeout: 180_000 });
  };
  return {
    respond: (input, options) => getClient().responses.create(input, options),
    edit: (input, options) => getClient().images.edit(input, options),
  };
}

export function rethrowCancellation(error: unknown, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError")) throw error;
}

const accountFailures: Record<string, { code: string; guidance: string }> = {
  credit_balance_exhausted: {
    code: "OPENAI_CREDITS_EXHAUSTED",
    guidance: "The OpenAI organization has no prepaid API credits remaining. Add credits in OpenAI billing before creating another movie. Retrying or changing models will not restore the credit balance.",
  },
  organization_spend_limit_exceeded: {
    code: "OPENAI_ORGANIZATION_SPEND_LIMIT",
    guidance: "The OpenAI organization reached its enforced spend limit. Review the organization's billing limits before creating another movie.",
  },
  project_spend_limit_exceeded: {
    code: "OPENAI_PROJECT_SPEND_LIMIT",
    guidance: "The OpenAI project reached its enforced spend limit. Review this API key's project limits before creating another movie.",
  },
  organization_usage_limit_exceeded: {
    code: "OPENAI_ORGANIZATION_USAGE_LIMIT",
    guidance: "The OpenAI organization reached its approved usage limit. Request a higher limit from OpenAI before creating another movie.",
  },
  insufficient_quota: {
    code: "OPENAI_QUOTA_EXHAUSTED",
    guidance: "OpenAI reports insufficient API quota. Review the API organization's credits and project/organization limits before creating another movie. Automatic retries cannot resolve a billing limit.",
  },
};

export function providerFailure(error: unknown, code: string, action: string, signal: AbortSignal): MovieError {
  rethrowCancellation(error, signal);
  if (error instanceof MovieError) return error;
  const status = error instanceof OpenAI.APIError ? error.status : undefined;
  if (error instanceof OpenAI.APIError && status === 400) {
    if (error.code === "invalid_input_fidelity_model") {
      return new MovieError("OPENAI_UNSUPPORTED_IMAGE_OPTION",
        `${action} was rejected because the configured image model does not support input_fidelity. Update the image request options before trying again; this is not a quota problem.`, 502);
    }
    const parameter = ["size", "quality", "model", "image", "input_fidelity", "output_format"].includes(error.param ?? "")
      ? ` (${error.param})` : "";
    return new MovieError("OPENAI_INVALID_REQUEST",
      `${action} was rejected by OpenAI as an invalid request${parameter}. Check the configured model's supported parameters before trying again. No automatic resubmission was made.`, 502);
  }
  if (error instanceof OpenAI.APIError && status === 429) {
    const accountFailure = Object.hasOwn(accountFailures, error.code ?? "")
      ? accountFailures[error.code ?? ""]
      : error.type === "insufficient_quota" ? accountFailures.insufficient_quota : undefined;
    if (accountFailure) return new MovieError(accountFailure.code, `${action} failed. ${accountFailure.guidance}`, 502);
    if (error.code === "rate_limit_exceeded" || error.code === "slow_down" || error.type === "rate_limit_error") {
      const rawDelay = error.headers?.get("retry-after");
      const delay = rawDelay && /^\d+$/.test(rawDelay) ? Number(rawDelay) : null;
      const wait = delay !== null && delay > 0 && delay <= 86_400
        ? ` Wait at least ${delay} seconds before submitting another movie.`
        : " Wait before submitting another movie and reduce request frequency.";
      return new MovieError("OPENAI_RATE_LIMITED", `${action} was temporarily rate-limited by OpenAI.${wait} No automatic resubmission was made.`, 502);
    }
  }
  const hint = status === 401 || status === 403
    ? " Check provider credentials and model access."
    : status === 429 ? " Check provider quota and rate limits."
      : " No automatic resubmission was made; inspect the job before starting another paid request.";
  return new MovieError(code, `${action} failed.${hint}`, 502);
}

export async function structured<T>(
  transport: OpenAITransport,
  input: { model: string; name: string; schema: z.ZodType<T>; instructions: string; content: ResponseInputContent[] },
  context: GenerationContext,
): Promise<T> {
  context.signal.throwIfAborted();
  try {
    const response = await transport.respond({
      model: input.model,
      instructions: input.instructions,
      input: [{ role: "user", content: input.content }],
      text: { format: zodTextFormat(input.schema, input.name) },
      store: false,
      max_output_tokens: 8_000,
    }, { signal: context.signal, maxRetries: 0, timeout: 120_000 });
    if (response.id) await context.recordOperation("OpenAI", response.id);
    context.signal.throwIfAborted();
    if (response.status !== "completed" || !response.output_text) {
      throw new MovieError("INVALID_PROVIDER_OUTPUT", "OpenAI did not complete the required structured output; the request may have been refused.", 502);
    }
    return input.schema.parse(JSON.parse(response.output_text));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      throw new MovieError("INVALID_PROVIDER_OUTPUT", "OpenAI returned invalid structured data. No unvalidated content was accepted.", 502);
    }
    throw providerFailure(error, "OPENAI_REQUEST_FAILED", "OpenAI structured generation", context.signal);
  }
}
