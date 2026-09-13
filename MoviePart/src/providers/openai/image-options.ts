import type { ImageEditParamsNonStreaming } from "openai/resources/images";

type ImageOptions = Pick<ImageEditParamsNonStreaming, "size" | "quality" | "input_fidelity" | "output_format">;

export function storyboardImageOptions(model: string): ImageOptions {
  // GPT Image 2.x accepts native 16:9 sizes but rejects input_fidelity.
  // Only the supported 1/1.5 family receives that legacy control.
  const legacy = /^gpt-image-1(?:\.5|-mini)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
  const supportsFidelity = /^gpt-image-1(?:\.5)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
  return {
    size: legacy ? "1536x1024" : "1536x864",
    quality: "high",
    output_format: "png",
    ...(supportsFidelity ? { input_fidelity: "high" } : {}),
  };
}
