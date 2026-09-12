import { parseArgs } from "node:util";
import { z } from "zod";
import { MovieError } from "../domain";

const optionsSchema = z.object({
  template: z.enum(["VELOCITY", "TOMORROW_DRIVE", "DREAM_ROUTE", "HERO_OF_THE_DAY"]),
  format: z.enum(["four-shot", "six-shot"]),
  mode: z.enum(["LIKENESS", "POV", "PERSONALIZED"]),
  interests: z.string(),
  name: z.string().max(80),
  city: z.string().max(120),
  product: z.string(),
  photos: z.array(z.string()).max(4),
  consent: z.boolean(),
  hero: z.boolean(),
  check: z.boolean(),
  help: z.boolean(),
  output: z.string().optional(),
});

export function parseCliOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      template: { type: "string", default: "VELOCITY" },
      format: { type: "string", default: "four-shot" },
      mode: { type: "string", default: "LIKENESS" },
      interests: { type: "string", default: "" },
      name: { type: "string", default: "" },
      city: { type: "string", default: "" },
      product: { type: "string", default: "" },
      photo: { type: "string", multiple: true, default: [] },
      consent: { type: "boolean", default: false },
      hero: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      output: { type: "string" },
    },
  });
  const { photo, ...rest } = values;
  const options = optionsSchema.parse({ ...rest, photos: photo });
  const interests = [...new Set(options.interests.split(",").map(value => value.trim()).filter(Boolean))];
  if (interests.length > 3 || interests.some(value => value.length > 100)) {
    throw new MovieError("INVALID_INTERESTS", "Supply at most three interests, each at most 100 characters.", 400);
  }
  if (!options.check && !options.help) {
    if (!options.consent) throw new MovieError("CONSENT_REQUIRED", "Add --consent only after obtaining permission for generation and personalization.", 400);
    if (options.mode === "LIKENESS" && !options.photos.length) {
      throw new MovieError("PHOTOS_REQUIRED", "Likeness mode requires one to four --photo paths.", 400);
    }
    if (options.mode !== "LIKENESS" && options.photos.length) {
      throw new MovieError("UNUSED_PHOTOS", "Do not supply customer photos for first-person or generic-driver mode.", 400);
    }
  }
  return { ...options, interests };
}
