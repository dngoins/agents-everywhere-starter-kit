import assert from "node:assert/strict";
import test from "node:test";
import { CONTINUITY_INSTRUCTIONS, PRACTICAL_CONTINUITY_INSTRUCTIONS } from "../src/continuity";
import { pickStoryboardVariation, SAFE_STORYBOARD_VARIATIONS } from "../src/storyboard/variations";

test("practical instructions tolerate cosmetic changes without weakening story, consent or safety locks", () => {
  assert.match(PRACTICAL_CONTINUITY_INSTRUCTIONS, /PASS when the only issues are these cosmetic differences/);
  assert.match(PRACTICAL_CONTINUITY_INSTRUCTIONS, /clothing knit\/texture, sleeve folds, small prop or pouch placement/);
  assert.match(PRACTICAL_CONTINUITY_INSTRUCTIONS, /lighting\/background variation and camera-angle differences/);
  assert.match(PRACTICAL_CONTINUITY_INSTRUCTIONS, /coherent world, not exact pixels/);
  assert.match(PRACTICAL_CONTINUITY_INSTRUCTIONS, /Unknown or occluded features are not proof of a mismatch/);
  assert.match(PRACTICAL_CONTINUITY_INSTRUCTIONS, /wrong person's visible appearance, wrong car or main paint color, missing essential action/);
  assert.match(PRACTICAL_CONTINUITY_INSTRUCTIONS, /REJECT serious unsafe, unexpected or moderated content/);
  assert.match(PRACTICAL_CONTINUITY_INSTRUCTIONS, /Never relax consent, real-person appearance restrictions or safety rules/);
  assert.match(PRACTICAL_CONTINUITY_INSTRUCTIONS, /not a real customer's appearance/);
  assert.match(PRACTICAL_CONTINUITY_INSTRUCTIONS, /absence of faces is REQUIRED, including all reflections/);
  assert.match(CONTINUITY_INSTRUCTIONS, /RETRY for a correctable mismatch or inadequate visibility/);
  assert.notEqual(PRACTICAL_CONTINUITY_INSTRUCTIONS, CONTINUITY_INSTRUCTIONS);
});

test("safe camera and composition variations never repeat and permit deterministic index selection", () => {
  const used = new Set<string>();
  const availableSizes: number[] = [];
  assert.ok(SAFE_STORYBOARD_VARIATIONS.length >= 19);
  for (const expected of SAFE_STORYBOARD_VARIATIONS) {
    const variation = pickStoryboardVariation(used, size => { availableSizes.push(size); return 0; });
    assert.equal(variation, expected);
    assert.ok(!used.has(variation.label));
    used.add(variation.label);
    assert.match(variation.instruction, /same planned plot, essential action, coherent world, person, car, main paint color and outfit/);
    assert.match(variation.instruction, /all original references as authoritative; never replace or omit them/);
    assert.match(variation.instruction, /consent, real-person restrictions, safety rules and the selected hero mode/);
    assert.match(variation.instruction, /POV, no-likeness and product-only restrictions/);
    assert.match(variation.instruction, /Never add people, expose a forbidden face, change product specifications, or evade moderation/);
  }
  assert.deepEqual(availableSizes, SAFE_STORYBOARD_VARIATIONS.map((_, index) => SAFE_STORYBOARD_VARIATIONS.length - index));
  assert.equal(pickStoryboardVariation(used, () => assert.fail("no random draw after exhaustion")), undefined);
  assert.equal(pickStoryboardVariation(new Set(), size => size - 1), SAFE_STORYBOARD_VARIATIONS.at(-1));
});

test("variation chooser rejects invalid indexes and defaults to a known safe preset", () => {
  for (const invalid of [-1, 0.5, NaN, SAFE_STORYBOARD_VARIATIONS.length]) {
    assert.throws(() => pickStoryboardVariation(new Set(), () => invalid), RangeError);
  }
  assert.ok(SAFE_STORYBOARD_VARIATIONS.includes(pickStoryboardVariation(new Set())!));
});
