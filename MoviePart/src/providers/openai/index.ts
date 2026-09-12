import type { DirectorService, MovieConfig, ReferenceService, StoryboardService } from "../../domain/services";
import { createDirectorService } from "../../director";
import { createReferenceService } from "../../references";
import { createStoryboardService } from "../../storyboard";
import { createOpenAITransport, type OpenAITransport } from "./client";

export function createOpenAIServices(
  config: MovieConfig,
  dependencies: { transport?: OpenAITransport } = {},
): { references: ReferenceService; director: DirectorService; storyboard: StoryboardService } {
  const transport = dependencies.transport ?? createOpenAITransport(config);
  return {
    references: createReferenceService(config, transport),
    director: createDirectorService(config, transport),
    storyboard: createStoryboardService(config, transport),
  };
}

export type { OpenAITransport } from "./client";
