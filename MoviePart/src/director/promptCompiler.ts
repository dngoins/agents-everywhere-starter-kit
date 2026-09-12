/**
 * Adapted from Tiya ZIP MoviePart/src/director/promptCompiler.ts.
 * Preserve its SHOT / SUBJECT / ACTION / CAMERA / SETTING / LIGHTING / MOOD /
 * STYLE / SOUND / CAR block while using this application's validated contracts.
 */
import { resolveHeroMode, type MoviePlan, type ProductReference, type ShotPlan } from "../domain";
import { getBeatMetadata, getTemplate } from "../templates";

export function compileShotBlock(plan: MoviePlan, shot: ShotPlan, product?: ProductReference): string {
  const template = getTemplate(plan.templateId, plan.storyFormat);
  const beat = getBeatMetadata(plan.templateId, plan.storyFormat, shot);
  const mode = resolveHeroMode(plan.heroMode);
  const subject = mode === "POV"
    ? "First-person viewpoint; anonymous hands only, no faces or reflections."
    : mode === "PERSONALIZED"
      ? "Generic non-identifiable back-view protagonist or silhouette, never a customer likeness."
      : "Consenting subject from all original customer reference photos, primary-photo wardrobe.";
  return [
    `SHOT ${Number(shot.id.slice(-2))} — ${beat?.beat ?? shot.purpose} — duration ${shot.durationSeconds}s — aspect ${plan.aspectRatio}`,
    `SUBJECT:  ${subject}`,
    `ACTION:   ${shot.action}`,
    `CAMERA:   ${shot.camera}`,
    `SETTING:  ${shot.environment}`,
    `LIGHTING: ${shot.lighting}`,
    `MOOD:     ${template.tone}`,
    `STYLE:    ${plan.cinematicStyle}${template.cinematography ? `; palette ${template.cinematography.color_palette}` : ""}`,
    `SOUND:    ${shot.audioCues.join(", ")}${beat ? `; ${beat.sound_hint}` : ""}`,
    `CAR:      ${beat?.product_visible === false ? "Not visible in this beat; do not add the vehicle." : `Exact reference-backed vehicle${product ? `: ${product.appearance}` : ""}; no unapproved claims.`}`,
  ].join("\n");
}
