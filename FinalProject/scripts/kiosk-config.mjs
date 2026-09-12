import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

export async function optionalEnvironment(path) {
  try { return parseEnv(await readFile(path, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function port(value, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("Use a port between 1 and 65535.");
  return parsed;
}

export function launchOptions(args) {
  const result = { liveMedia: false, apiPort: 3101, uiPort: 3200, mediaPort: 3201 };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--live-media") { result.liveMedia = true; continue; }
    if (!["--api-port", "--ui-port", "--media-port"].includes(name)) throw new Error(`Unsupported option: ${name}`);
    const value = args[++index];
    if (!value) throw new Error(`Missing value for ${name}.`);
    const key = { "--api-port": "apiPort", "--ui-port": "uiPort", "--media-port": "mediaPort" }[name];
    result[key] = port(value);
  }
  if (new Set([result.apiPort, result.uiPort, result.mediaPort]).size !== 3) throw new Error("API, kiosk and media ports must be distinct.");
  return result;
}

export function integrationEnvironments({
  parent = process.env, finalEnv = {}, movieEnv = {}, options, deviceToken, mediaToken,
}) {
  const common = { ...parent };
  for (const key of Object.keys(common)) {
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|NODE_OPTIONS|NODE_EXTRA_CA_CERTS/i.test(key)) delete common[key];
  }
  const apiOrigin = `http://127.0.0.1:${options.apiPort}`;
  const uiOrigin = `http://127.0.0.1:${options.uiPort}`;
  const mediaOrigin = `http://127.0.0.1:${options.mediaPort}`;
  const blockedSecrets = {
    OPENAI_API_KEY: "", EXA_API_KEY: "", GOOGLE_API_KEY: "", GEMINI_API_KEY: "",
    OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "", MOVIE_API_TOKEN: "", MEDIA_SERVICE_TOKEN: "",
  };
  const api = {
    ...common, ...blockedSecrets,
    HOST: "127.0.0.1", PORT: String(options.apiPort),
    BRIEF_PROVIDER: "mock", PROFILE_PROVIDER: "mock",
    MEDIA_PROVIDER: options.liveMedia ? "http" : "mock",
    JOB_PROVIDER: "local", FOLLOWUP_PROVIDER: "disabled",
    ALLOW_DEMO_FALLBACKS: "false", MOCK_ONLY: options.liveMedia ? "false" : "true",
    DEMO_DEVICE_TOKEN: deviceToken,
    ALLOWED_HOSTS: "127.0.0.1,localhost",
    ALLOWED_ORIGINS: `${apiOrigin},${uiOrigin}`,
    MEDIA_SERVICE_URL: options.liveMedia ? mediaOrigin : "",
    MEDIA_SERVICE_TOKEN: options.liveMedia ? mediaToken : "",
    SESSION_TTL_MS: finalEnv.SESSION_TTL_MS || "90000",
    JOB_TIMEOUT_MS: finalEnv.JOB_TIMEOUT_MS || "60000",
  };
  // Keep creator-studio provider keys empty: this launcher opens only the kiosk.
  const ui = { ...common, ...blockedSecrets, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1" };
  const media = {
    ...common, ...blockedSecrets,
    OPENAI_API_KEY: options.liveMedia ? movieEnv.OPENAI_API_KEY || "" : "",
    OPENAI_IMAGE_MODEL: movieEnv.OPENAI_IMAGE_MODEL || "",
    MEDIA_SERVICE_TOKEN: options.liveMedia ? mediaToken : "",
    MEDIA_SERVICE_PORT: String(options.mediaPort),
    MOVIE_DATA_DIR: movieEnv.MOVIE_DATA_DIR || ".movie-data",
    ...(movieEnv.FFMPEG_PATH ? { FFMPEG_PATH: movieEnv.FFMPEG_PATH } : {}),
    ...(movieEnv.FFPROBE_PATH ? { FFPROBE_PATH: movieEnv.FFPROBE_PATH } : {}),
  };
  if (options.liveMedia && !media.OPENAI_API_KEY.trim()) {
    throw new Error("Live media requires OPENAI_API_KEY in MoviePart's private .env. Offline kiosk mode needs no provider credentials.");
  }
  return { api, ui, media, apiOrigin, uiOrigin, mediaOrigin };
}
