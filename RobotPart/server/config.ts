export const TIME_ZONE = 'America/New_York' as const;

export interface ServerConfig {
  apiKey: string;
  models: { voice: string; regular: string; highend: string };
}

// Pure: importing this module (or the app) never reads process.env or .env.
export function configFromEnv(env: Record<string, string | undefined> = {}): ServerConfig {
  const model = (value: string | undefined, fallback: string): string =>
    (value?.trim() || fallback).toLowerCase();
  return {
    apiKey: env.OPENAI_API_KEY?.trim() || '',
    models: {
      voice: model(env.VOICE_MODEL, 'gpt-live-1'),
      regular: model(env.REGULAR_MODEL, 'gpt-5.6-luna'),
      highend: model(env.HIGHEND_MODEL, 'gpt-6-astra'),
    },
  };
}