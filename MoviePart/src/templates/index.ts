import velocity from "./velocity.json";
import tomorrow from "./tomorrow-drive.json";
import dream from "./dream-route.json";
import tiyaVelocity from "./tiya/velocity.json";
import tiyaTomorrow from "./tiya/tomorrow-drive.json";
import tiyaHero from "./tiya/hero-of-the-day.json";
import { resolveStoryFormat, templateSchema, type SceneTemplate, type ShotPlan, type StoryFormat, type TemplateId } from "../domain";

export const templates = [velocity, tomorrow, dream].map(value => templateSchema.parse(value));

// Source: Tiya ZIP, MoviePart/src/templates/*.json. Preserve source timing/metadata;
// the runtime timeline extends the_impossible to eight seconds for the Veo workflow.
function importTiya(source: typeof tiyaHero, file: string, worldTransition: string): SceneTemplate {
  return templateSchema.parse({
    id: source.template_id, version: 1, name: source.display_name, description: source.promise,
    storyFormat: "six-shot", tone: source.director_personality.tone.join(", "),
    camera: source.cinematography.camera, worldTransition,
    beats: source.beats.map(beat => beat.goal), sound: source.sound.music_style,
    source: { author: "Tiya", files: [`MoviePart/src/templates/${file}`], adaptation: "Original six-beat grammar; hero beat extended from 5 to 8 seconds. No generated taglines, unapproved claims or unsafe public-road stunts." },
    sourceBeats: source.beats, directorPersonality: source.director_personality,
    cinematography: source.cinematography, soundDesign: source.sound, personalizationSlots: source.personalization_slots,
  });
}
const heroSix = importTiya(tiyaHero, "hero-of-the-day.json", "A quiet need leads to a warm, physically coherent journey and a small emotional payoff.");
const dreamSix = templateSchema.parse({
  ...importTiya(tiyaHero, "hero-of-the-day.json", dream.worldTransition),
  id: "DREAM_ROUTE", name: dream.name, description: dream.description, tone: dream.tone, camera: dream.camera,
  source: { author: "Tiya + Movie Magic", files: ["MoviePart/src/templates/hero-of-the-day.json", "MoviePart/src/templates/dream-route.json"], adaptation: "Movie Magic's existing scenic lifestyle narrative mapped onto Tiya's six-beat grammar; not a rename of Hero of the Day." },
  beats: [
    "Prepare for a personally meaningful activity in a quiet ordinary moment, before the car appears.",
    "A glimpse of an approved interest inspires a scenic destination and the exact selected car comes into view.",
    "Load a permitted activity object, enter the unchanged vehicle and fasten the seatbelt.",
    "A beautiful eight-second scenic drive connects preparation to the personally relevant destination without fantasy transitions.",
    "Arrive, park safely and gather the meaningful object for the approved activity.",
    "Enjoy a small meaningful lifestyle moment with the same car in a warm, grounded hero composition.",
  ],
  sourceBeats: tiyaHero.beats.map((beat, index) => ({
    ...beat, default_duration: index === 2 ? 2 : beat.default_duration,
    product_visible: index !== 0, personalization_slot: [null, "hobby", "meaningful object", "destination", "hobby", null][index],
  })),
});
const sixTemplates = [
  importTiya(tiyaVelocity, "velocity.json", "One controlled closed course; stylized speed through camera and light, never reckless public-road driving."),
  importTiya(tiyaTomorrow, "tomorrow-drive.json", "Grey present transforms explicitly in the_impossible, then resolves into a golden imagined future."),
  dreamSix, heroSix,
];
const heroFour = templateSchema.parse({
  ...heroSix, storyFormat: "four-shot",
  source: { ...heroSix.source!, adaptation: "Four-shot condensation: ordinary moment + small need; grabbing keys; eight-second journey; arrival + emotional payoff." },
  beats: [
    "A quiet ordinary moment reveals a small meaningful need; no vehicle is visible yet.",
    "Choose to act, take the keys and enter the same selected car; a permitted object motivates the trip.",
    "An eight-second warm, measured journey carries the protagonist through coherent weather, light and road.",
    "Arrive for a small emotional win, then reveal the exact car in a clean warm hero frame.",
  ],
});
export const allTemplates = [...templates, heroFour];

export function getTemplate(id: TemplateId, format?: StoryFormat): SceneTemplate {
  const template = (resolveStoryFormat(format) === "six-shot" ? sixTemplates : allTemplates).find(value => value.id === id);
  if (!template) throw new Error(`Unknown scene template: ${id}`);
  return template;
}

export function getBeatMetadata(templateId: TemplateId, format: StoryFormat | undefined, shot: ShotPlan) {
  const template = getTemplate(templateId, format);
  const index = Number(shot.id.slice(-2)) - 1;
  if (resolveStoryFormat(format) === "six-shot") return template.sourceBeats?.[index];
  if (templateId === "HERO_OF_THE_DAY") return template.sourceBeats?.[[0, 2, 3, 5][index]];
  return undefined;
}
