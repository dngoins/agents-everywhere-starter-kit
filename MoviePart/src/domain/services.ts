import type {
  AssetRecord, CharacterReference, Consent, JobStatus, MoviePlan, PersonalizationProfile,
  ProductReference, RenderResult, SceneTemplate, StoryboardFrame, VideoArtifact, StoryFormat, HeroMode,
} from "./index";

export interface MovieConfig {
  dataDir: string;
  openaiKey?: string;
  visionModel?: string;
  directorModel?: string;
  imageModel: string;
  googleKey?: string;
  veoModel: string;
  apiToken?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  musicPath?: string;
}

export interface MediaRepository {
  getAsset(id: string): Promise<AssetRecord>;
  readAsset(id: string): Promise<Uint8Array>;
  assetPath(id: string): Promise<string>;
  saveAsset(input: {
    ownerId: string; jobId: string | null; kind: AssetRecord["kind"]; mime: string;
    bytes: Uint8Array; width?: number; height?: number;
  }): Promise<AssetRecord>;
}

export interface GenerationContext {
  jobId: string;
  ownerId: string;
  media: MediaRepository;
  signal: AbortSignal;
  report(update: { stage: JobStatus; message: string; provider?: string; shotId?: string }): Promise<void>;
  warn(message: string): Promise<void>;
  recordOperation(provider: string, id: string): Promise<void>;
  saveFrame(frame: StoryboardFrame): Promise<void>;
}

export interface ReferenceService {
  extract(input: { assetIds: string[]; primaryAssetId: string; consent: Consent }, context: GenerationContext): Promise<CharacterReference>;
}
export interface DirectorService {
  plan(input: {
    character: CharacterReference; product: ProductReference;
    profile: PersonalizationProfile; template: SceneTemplate; storyFormat?: StoryFormat; heroMode?: HeroMode;
  }, context: GenerationContext): Promise<MoviePlan>;
}
export interface StoryboardService {
  generate(input: { plan: MoviePlan; character: CharacterReference; product: ProductReference; existingFrames?: StoryboardFrame[] }, context: GenerationContext): Promise<StoryboardFrame[]>;
}
export interface VideoService {
  generate(input: {
    plan: MoviePlan; character: CharacterReference; product: ProductReference; frames: StoryboardFrame[];
  }, context: GenerationContext): Promise<VideoArtifact | null>;
}
export interface RendererService {
  ready(): Promise<{ available: boolean; message: string }>;
  render(input: { plan: MoviePlan; frames: StoryboardFrame[]; hero: VideoArtifact | null }, context: GenerationContext): Promise<RenderResult>;
}
