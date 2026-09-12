import test from "node:test";
import assert from "node:assert/strict";
import { parseCliOptions } from "../src/cli/options";

test("CLI preserves explicit consent and never silently uses private demo photos", () => {
  assert.equal(parseCliOptions(["--check"]).check, true);
  assert.throws(() => parseCliOptions([]), /consent/);
  assert.throws(() => parseCliOptions(["--consent"]), /photo/);
  assert.throws(() => parseCliOptions(["--consent", "--mode", "POV", "--photo", "private.jpg"]), /Do not supply/);
});
test("CLI accepts Tiya's opt-in story and hero modes with approved context", () => {
  const options = parseCliOptions(["--consent", "--template", "HERO_OF_THE_DAY", "--format", "six-shot", "--mode", "PERSONALIZED", "--interests", "dogs, Egypt, dogs"]);
  assert.equal(options.format, "six-shot");
  assert.equal(options.template, "HERO_OF_THE_DAY");
  assert.deepEqual(options.interests, ["dogs", "Egypt"]);
  assert.throws(() => parseCliOptions(["--consent", "--mode", "POV", "--interests", "a,b,c,d"]), /at most three/);
});
