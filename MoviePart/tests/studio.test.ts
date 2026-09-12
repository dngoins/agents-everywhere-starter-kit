import test from "node:test";
import assert from "node:assert/strict";
import { mainStoryboardFrames } from "../src/lib/storyboard-view";
import type { StoryboardFrame } from "../integration/contracts";
import { creationBlockers, selectableProducts } from "../src/lib/studio-readiness";

test("studio shows four current frames, not extra hero end frames or rejected attempts", () => {
  const frame = (shotId: string, assetId: string): StoryboardFrame => ({
    shotId, assetId, continuity: { verdict: "PASS", reasons: [], confidence: 0.9 }, provider: "test", model: "test",
  });
  const result = mainStoryboardFrames([
    frame("shot_01", "old"), frame("shot_02", "two"), frame("shot_03", "three"),
    frame("shot_04", "four"), frame("shot_01", "new"), frame("shot_03_end", "end"),
  ]);
  assert.deepEqual(result.map(value => value.assetId), ["new", "two", "three", "four"]);
  assert.equal(mainStoryboardFrames([]).length, 0);
});
test("six-shot view keeps all narrative frames and excludes supplemental end frames", () => {
  const ids = ["shot_01", "shot_02", "shot_03", "shot_04", "shot_05", "shot_06"];
  const frames: StoryboardFrame[] = [...ids, "shot_04_end"].map(shotId => ({
    shotId, assetId: shotId, continuity: { verdict: "PASS", reasons: [], confidence: 1 }, provider: "test", model: "test",
  }));
  assert.deepEqual(mainStoryboardFrames(frames, ids).map(frame => frame.shotId), ids);
});

test("both real vehicle choices remain selectable before the server configuration loads", () => {
  assert.deepEqual(selectableProducts(null).map(product => product.name), ["Tesla Model Y", "Toyota Tundra Hybrid"]);
  assert.ok(selectableProducts(null).every(product => !product.ready));
});

test("creation explains every missing prerequisite instead of silently disabling the button", () => {
  const missing = creationBlockers({
    config: null, productId: "tesla-model-y", needsPhotos: true,
    photoCount: 0, generationConsent: false, personalizationConsent: false,
  });
  assert.equal(missing.length, 5);
  assert.match(missing.join(" "), /exterior and interior/);
  assert.match(missing.join(" "), /Reconnect/);
  assert.deepEqual(creationBlockers({
    config: {
      products: [{ id: "tesla-model-y", name: "Tesla Model Y", ready: true }], templates: [],
      providers: { openai: { available: true, message: "Ready" }, veo: { available: false, message: "Optional" } },
      worker: { available: true, message: "Ready" }, renderer: { available: true, message: "Ready" },
    },
    productId: "tesla-model-y", needsPhotos: false, photoCount: 0,
    generationConsent: true, personalizationConsent: true,
  }), []);
});
