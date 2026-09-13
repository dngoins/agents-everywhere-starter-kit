import { randomInt } from "node:crypto";

export interface StoryboardVariation {
  readonly label: string;
  readonly instruction: string;
}

const cameras = [
  ["eye-level", "Use an eye-level camera within the planned viewpoint."],
  ["lower-angle", "Try a slightly lower camera height within the planned viewpoint."],
  ["higher-angle", "Try a slightly higher camera height within the planned viewpoint."],
  ["lateral-angle", "Try a small lateral camera shift or three-quarter position only if the planned viewpoint permits it."],
] as const;

const compositions = [
  ["medium", "Use clear medium framing with enough context to read the essential action."],
  ["wide", "Widen the framing slightly to show the essential action and its immediate setting clearly."],
  ["closer", "Move the framing moderately closer without hiding the essential action or required vehicle details."],
  ["balanced", "Use balanced off-center framing while keeping the essential action unobstructed."],
  ["simple", "Simplify background clutter while preserving the same setting and essential action."],
] as const;

const locks = "This is a composition-only correction. Keep the same planned plot, essential action, coherent world, person, car, main paint color and outfit. Preserve all original references as authoritative; never replace or omit them. Preserve consent, real-person restrictions, safety rules and the selected hero mode (including POV, no-likeness and product-only restrictions). Never add people, expose a forbidden face, change product specifications, or evade moderation. If a camera variation conflicts with these locks, keep the locked viewpoint.";

// Twenty distinct combinations cover even the maximum nineteen corrective retries.
export const SAFE_STORYBOARD_VARIATIONS: readonly StoryboardVariation[] = Object.freeze(
  cameras.flatMap(([cameraLabel, camera]) => compositions.map(([compositionLabel, composition]) => Object.freeze({
    label: `${cameraLabel}-${compositionLabel}`,
    instruction: `${camera} ${composition} ${locks}`,
  }))),
);

export function pickStoryboardVariation(
  usedLabels: ReadonlySet<string>,
  chooseIndex: (upperBound: number) => number = upperBound => randomInt(upperBound),
): StoryboardVariation | undefined {
  const available = SAFE_STORYBOARD_VARIATIONS.filter(variation => !usedLabels.has(variation.label));
  if (!available.length) return undefined;
  const index = chooseIndex(available.length);
  if (!Number.isInteger(index) || index < 0 || index >= available.length) {
    throw new RangeError("The storyboard variation chooser must return an available index.");
  }
  return available[index];
}
