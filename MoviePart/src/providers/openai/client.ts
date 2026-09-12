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

export function providerFailure(error: unknown, code: string, action: string, signal: AbortSignal): MovieError {
  rethrowCancellation(error, signal);
  if (error instanceof MovieError) return error;
  const status = error instanceof OpenAI.APIError ? error.status : undefined;
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
