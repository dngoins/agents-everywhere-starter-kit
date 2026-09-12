export class ProviderFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly acceptanceUncertain = false,
  ) {
    super(message);
    this.name = "ProviderFailure";
  }
}

export async function responseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel();
    throw new ProviderFailure("RESPONSE_TOO_LARGE", "Provider response exceeds the configured limit.");
  }
  if (!response.body) throw new ProviderFailure("EMPTY_RESPONSE", "Provider returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ProviderFailure("RESPONSE_TOO_LARGE", "Provider response exceeds the configured limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function fetchJson(
  url: URL | string,
  init: RequestInit,
  options: { signal: AbortSignal; timeoutMs: number; effectful?: boolean; maxBytes?: number },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
    });
  } catch {
    if (options.signal.aborted) throw options.signal.reason;
    throw new ProviderFailure("PROVIDER_UNREACHABLE", "Provider request failed or timed out.", true, options.effectful ?? false);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderFailure(
      "PROVIDER_HTTP_ERROR",
      `Provider returned HTTP ${response.status}.`,
      response.status === 429 || response.status >= 500,
      Boolean(options.effectful && response.status >= 500),
    );
  }
  try {
    const bytes = await responseBytes(response, options.maxBytes ?? 512_000);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure("PROVIDER_INVALID_RESPONSE", "Provider returned an invalid response.", false, options.effectful ?? false);
  }
}
