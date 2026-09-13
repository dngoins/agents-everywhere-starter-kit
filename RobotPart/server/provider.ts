import { z } from 'zod';
import type { ServerConfig } from './config.js';
import { HttpError } from './errors.js';
import { backendWorkflowPrompt, expertInstructions, voiceInstructions } from './prompts.js';
import { modelTools } from './tools.js';
import { createLiveSessionRequest } from '@magicpitch/showroom-runtime/server';

export const sdpSchema = z.string().min(1).max(128 * 1024)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 128 * 1024 && /^v=0(?:\r?\n|$)/.test(value),
    'Invalid SDP offer');

const liveAnswerSchema = z.object({
  session: z.object({ id: z.string().min(1).max(512) }),
  transport: z.object({ type: z.literal('webrtc'), sdp: sdpSchema }),
});

export type LiveAnswer = z.infer<typeof liveAnswerSchema>;
export type FetchLike = typeof globalThis.fetch;

export class OpenAIProvider {
  private readonly shutdown = new AbortController();
  private readonly config: ServerConfig;
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  constructor(config: ServerConfig, fetcher: FetchLike = globalThis.fetch, timeoutMs = 30_000) {
    this.config = config;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }

  close(): void {
    this.shutdown.abort();
  }

  private async post(path: string, body: unknown, label: string, customerSignal: AbortSignal): Promise<unknown> {
    if (!this.config.apiKey) throw new HttpError(503, 'Voice and vehicle expert services are not configured.');
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    timer.unref();
    const signal = AbortSignal.any([customerSignal, this.shutdown.signal, timeout.signal]);
    try {
      signal.throwIfAborted();
      const response = await this.fetcher(`https://api.openai.com/v1/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      });
      if (!response.ok) {
        // Do not parse, log or forward upstream error bodies (including API-key errors).
        await response.body?.cancel().catch(() => undefined);
        const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
        throw new HttpError(status, `${label} failed (HTTP ${status}).`);
      }
      const result: unknown = await response.json();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (customerSignal.aborted || this.shutdown.signal.aborted) {
        throw new HttpError(409, 'Customer is inactive or the server is closing.');
      }
      if (timeout.signal.aborted) throw new HttpError(504, `${label} timed out.`);
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, `${label} is temporarily unavailable.`);
    } finally {
      clearTimeout(timer);
    }
  }

  async createLive(sdp: string, signal: AbortSignal): Promise<LiveAnswer> {
    const offer = sdpSchema.parse(sdp);
    const raw = await this.post('live/sessions', createLiveSessionRequest({
      sdp: offer,
      voiceModel: this.config.models.voice,
      reasoningModel: this.config.models.regular,
      instructions: voiceInstructions,
      delegationInstructions: backendWorkflowPrompt,
      tools: modelTools,
    }), 'Live session creation', signal);
    const parsed = liveAnswerSchema.safeParse(raw);
    if (!parsed.success || JSON.stringify(parsed.data).includes(this.config.apiKey)) {
      throw new HttpError(502, 'Live session creation returned an invalid response.');
    }
    // Zod strips provider extras at BOTH object levels; never return client secrets/config.
    return parsed.data;
  }

  async askExpert(question: string, deepReasoning: boolean, signal: AbortSignal): Promise<string> {
    const raw = await this.post('responses', {
      model: deepReasoning ? this.config.models.highend : this.config.models.regular,
      instructions: expertInstructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text: question }] }],
      store: false,
      max_output_tokens: 350,
    }, 'Vehicle expert', signal);
    const parsed = z.object({
      output: z.array(z.object({
        type: z.string(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
      })),
    }).safeParse(raw);
    if (!parsed.success) throw new HttpError(502, 'Vehicle expert returned an invalid response.');
    const answer = parsed.data.output.filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text ?? '').join('\n').trim();
    if (!answer || answer.includes(this.config.apiKey)) {
      throw new HttpError(502, 'Vehicle expert could not provide a verified answer.');
    }
    return answer.length <= 1200 ? answer : `${answer.slice(0, 1199)}…`;
  }
}