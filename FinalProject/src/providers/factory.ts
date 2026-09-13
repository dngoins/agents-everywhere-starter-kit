import type { Config } from "../config.js";
import type { BriefProvider, MediaProvider, ProfileProvider } from "./interfaces.js";
import { createMockBriefProvider, createMockProfileProvider } from "./mock.js";
import { createOpenAIBriefProvider } from "./openai.js";
import { createExaProfileProvider } from "./exa.js";
import { createHttpMediaProvider } from "./media.js";
import { ProviderFailure } from "./http-client.js";
import { DEMO_MEDIA, createPrerecordedDemoProvider } from "./demo-media.js";

type FixtureMetadata = Readonly<{
  provenance: "mock_fixture" | "prerendered_fallback";
  durationSeconds: number;
}>;

export function createProviders(config: Config, fixture: Uint8Array, metadata: FixtureMetadata = DEMO_MEDIA) {
  const { provenance, durationSeconds } = metadata;
  const mockMedia: MediaProvider = metadata === DEMO_MEDIA
    ? createPrerecordedDemoProvider(fixture, config.MAX_MEDIA_BYTES)
    : {
      name: "mock",
      async generate(_input, signal, progress) {
        signal.throwIfAborted();
        progress("rendering");
        return { bytes: fixture, mimeType: "video/mp4", provenance, durationSeconds };
      },
    };
  const mockBrief = createMockBriefProvider();
  let briefProvider: BriefProvider = mockBrief;
  if (config.BRIEF_PROVIDER === "openai") {
    if (!config.OPENAI_API_KEY || !config.MODEL) throw new Error("Missing OpenAI configuration.");
    const live = createOpenAIBriefProvider(config.OPENAI_API_KEY, config.MODEL);
    briefProvider = {
      name: live.name,
      async create(input, signal) {
        try { return await live.create(input, signal); } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof ProviderFailure) || !config.ALLOW_DEMO_FALLBACKS) throw error;
          return mockBrief.create(input, signal);
        }
      },
    };
  }
  let profileProvider: ProfileProvider = createMockProfileProvider();
  if (config.PROFILE_PROVIDER === "exa") {
    if (!config.EXA_API_KEY) throw new Error("Missing Exa configuration.");
    const live = createExaProfileProvider(config.EXA_API_KEY);
    profileProvider = {
      name: live.name,
      async enrich(input, signal) {
        try { return await live.enrich(input, signal); } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof ProviderFailure) || !config.ALLOW_DEMO_FALLBACKS) throw error;
          return { preferences: [], citations: [], provenance: "unavailable", warnings: ["Exa enrichment failed. Continue with the participant's confirmed conversation preferences."] };
        }
      },
    };
  }
  let mediaProvider = mockMedia;
  if (config.MEDIA_PROVIDER === "http") {
    if (!config.MEDIA_SERVICE_URL || !config.MEDIA_SERVICE_TOKEN) throw new Error("Missing media service configuration.");
    mediaProvider = createHttpMediaProvider(config.MEDIA_SERVICE_URL, config.MEDIA_SERVICE_TOKEN, config.MAX_MEDIA_BYTES);
  }
  return {
    briefProvider, profileProvider, mediaProvider, fallbackMediaProvider: mockMedia,
  };
}
