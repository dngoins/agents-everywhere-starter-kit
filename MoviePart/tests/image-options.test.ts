import assert from "node:assert/strict";
import test from "node:test";
import { storyboardImageOptions } from "../src/providers/openai/image-options";

test("GPT Image 2 variants omit unsupported fidelity while retaining native 16:9 output", () => {
  for (const model of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare-2026-09-08", "gpt-image-2"]) {
    const options = storyboardImageOptions(model);
    assert.equal(Object.hasOwn(options, "input_fidelity"), false);
    assert.equal(options.size, "1536x864");
    assert.equal(options.quality, "high");
    assert.equal(options.output_format, "png");
  }
});

test("legacy models retain supported landscape sizes and only supported fidelity controls", () => {
  for (const model of ["gpt-image-1", "gpt-image-1.5", "gpt-image-1-2025-04-15", "gpt-image-1.5-2025-12-16"]) {
    assert.equal(storyboardImageOptions(model).input_fidelity, "high");
    assert.equal(storyboardImageOptions(model).size, "1536x1024");
  }
  for (const model of ["gpt-image-1-mini", "gpt-image-1-mini-2025-10-06"]) {
    assert.equal(Object.hasOwn(storyboardImageOptions(model), "input_fidelity"), false);
    assert.equal(storyboardImageOptions(model).size, "1536x1024");
  }
});
