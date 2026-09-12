import { randomUUID } from "node:crypto";
import { MovieError, getTimeline, type CharacterReference, type MovieJob, type RenderResult } from "./domain";
import type {
  DirectorService, GenerationContext, MovieConfig, ReferenceService,
  RendererService, StoryboardService, VideoService,
} from "./domain/services";
import { getTemplate } from "./templates";
import { createOpenAIServices } from "./providers/openai";
import { createVeoService } from "./providers/google";
import { createRenderer } from "./render";

export interface PipelineServices {
  references: ReferenceService;
  director: DirectorService;
  storyboard: StoryboardService;
  video: VideoService;
  renderer: RendererService;
}

export async function executeMovie(
  job: MovieJob,
  context: GenerationContext,
  checkpoint: (patch: Partial<Pick<MovieJob, "character" | "plan" | "hero">>) => Promise<void>,
  config: MovieConfig,
  services?: PipelineServices,
): Promise<RenderResult> {
  const renderer = services?.renderer ?? createRenderer(config);
  const readiness = await renderer.ready();
  if (!readiness.available) throw new MovieError("RENDERER_UNAVAILABLE", readiness.message, 503);
  const { references, director, storyboard } = services ?? createOpenAIServices(config);
  const heroMode = job.request.hero_mode ?? "LIKENESS";
  const storyFormat = job.request.story_format ?? "four-shot";
  const timeline = getTimeline(storyFormat, job.request.preferred_template);
  let character: CharacterReference;
  if (heroMode === "LIKENESS") {
    if (!job.request.primary_reference_asset_id) throw new MovieError("INVALID_REFERENCE", "Likeness mode requires a primary customer photo.", 400);
    await context.report({ stage: "BUILDING_REFERENCES", message: "Reading the approved customer photos.", provider: "OpenAI" });
    character = await references.extract({
      assetIds: job.request.customer_reference_asset_ids,
      primaryAssetId: job.request.primary_reference_asset_id,
      consent: job.request.consent,
    }, context);
  } else {
    await context.report({ stage: "BUILDING_REFERENCES", message: `${heroMode === "POV" ? "First-person" : "Generic-driver"} mode: no customer photos are sent to generation providers.` });
    character = {
      id: randomUUID(), version: 1, primaryAssetId: null, sourceImages: [], consent: job.request.consent,
      attributes: {
        face: null, eyes: null, eyebrows: null, nose: null, mouth: null, hair: null, complexion: null,
        visibleProportions: null, wardrobe: null, accessories: [],
      },
    };
  }
  await checkpoint({ character });
  await context.report({ stage: "DIRECTING", message: `Planning ${timeline.shotIds.length} shots from your selected template.`, provider: "OpenAI" });
  const plan = await director.plan({
    character,
    product: job.product,
    profile: job.request.personalization_profile,
    template: getTemplate(job.request.preferred_template, storyFormat),
    storyFormat,
    heroMode,
  }, context);
  await checkpoint({ plan });
  const frames = await storyboard.generate({ plan, character, product: job.product }, context);
  let hero = null;
  if (job.request.enable_hero_video) {
    await context.report({ stage: "GENERATING_HERO", message: "Preparing the optional hero-video enhancement." });
    hero = await (services?.video ?? createVeoService(config)).generate({ plan, character, product: job.product, frames }, context);
    await checkpoint({ hero });
  }
  await context.report({ stage: "ASSEMBLING", message: `Assembling the ${timeline.shotIds.length}-shot advertisement.`, provider: "FFmpeg" });
  return renderer.render({ plan, frames, hero }, context);
}
