import { readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MovieMagicClient } from "../integration/client";
import { parseCliOptions } from "../src/cli/options";
import { MovieError } from "../src/domain";

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(`Movie Magic operator client
  --check                              Inspect local readiness; no generation
  --template VELOCITY|TOMORROW_DRIVE|DREAM_ROUTE|HERO_OF_THE_DAY
  --format four-shot|six-shot           Classic default or Tiya's six-beat arc
  --mode LIKENESS|POV|PERSONALIZED       No customer photos in POV/PERSONALIZED
  --photo <path>                        Repeat for one to four consented photos
  --interests "dogs, Egypt" --name <name> --city <city>
  --product <catalog-id>                Defaults to the configured ready product
  --consent                            Required explicit permission
  --hero                               Optional paid Veo enhancement
  --output <new-file.mp4>               Download completed movie; never overwrite

Start npm run dev and npm run worker first.
Set MOVIE_API_TOKEN privately for machine access.
MOVIE_STUDIO_URL defaults to http://127.0.0.1:3200.
This is the creator-studio client, NOT Dwight's orchestrator or media-service API.`);
    return;
  }
  if (!process.env.MOVIE_API_TOKEN) {
    throw new MovieError("TOKEN_REQUIRED", "Configure MOVIE_API_TOKEN privately on the studio and this operator client.", 401);
  }
  const client = new MovieMagicClient({
    baseUrl: process.env.MOVIE_STUDIO_URL || "http://127.0.0.1:3200",
    token: process.env.MOVIE_API_TOKEN,
  });
  const config = await client.getConfig();
  if (options.check) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  const product = config.products.find(item => item.ready && (!options.product || item.id === options.product));
  if (!product || !config.providers.openai.available || !config.worker.available || !config.renderer.available) {
    throw new MovieError("STUDIO_NOT_READY", "The studio needs an authorized car pack, OpenAI configuration, worker and renderer. Run --check.", 503);
  }
  const consent = { likeness: true, personalization: true } as const;
  const photos: File[] = [];
  for (const filename of options.photos) {
    const info = await stat(filename);
    if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new MovieError("INVALID_PHOTO", "Each selected photo must be a file no larger than 10 MiB.", 400);
    const extension = path.extname(filename).toLowerCase();
    const mime = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : [".jpg", ".jpeg"].includes(extension) ? "image/jpeg" : null;
    if (!mime) throw new MovieError("INVALID_PHOTO", "Use JPEG, PNG or WebP customer photos.", 400);
    photos.push(new File([await readFile(filename)], path.basename(filename), { type: mime }));
  }
  const assets = photos.length ? (await client.uploadPhotos(photos, consent)).assets : [];
  const request = {
    schema_version: 1 as const, session_id: `operator-${randomUUID()}`, idempotency_key: randomUUID(),
    customer_reference_asset_ids: assets.map(asset => asset.id),
    primary_reference_asset_id: assets[0]?.id ?? null, consent, product_id: product.id,
    preferred_template: options.template, story_format: options.format, hero_mode: options.mode,
    enable_hero_video: options.hero,
    personalization_profile: {
      signals: options.interests.map(value => ({ value, source: "manual" as const, visualUseAllowed: true as const, confidence: null })),
      ...(options.name ? { customerFirstName: options.name } : {}),
      ...(options.city ? { city: options.city } : {}),
    },
  };
  console.log(`Submitting with idempotency key ${request.idempotency_key}.`);
  const accepted = await client.createJob(request);
  console.log(`Job ${accepted.job_id}. Keep this ID to resume polling after a disconnect.`);
  let last = "";
  const job = await client.waitForJob(accepted.job_id, {
    maxPolls: 900,
    onProgress(value) {
      const current = `${value.status}: ${value.events.at(-1)?.message ?? ""}`;
      if (current !== last) console.log(current);
      last = current;
    },
  });
  if (job.status !== "COMPLETED" || !job.result) throw new MovieError("MOVIE_FAILED", job.error?.message ?? "No completed movie was returned.");
  console.log(`${job.result.mode}, ${job.result.durationSeconds}s, audio: ${job.result.hasAudio}.`);
  if (options.output) {
    const movie = await client.downloadAsset(job.result.assetId);
    await writeFile(options.output, new Uint8Array(await movie.arrayBuffer()), { flag: "wx" });
    console.log("Movie saved to the requested new output file.");
  }
}

main().catch(error => {
  console.error(error instanceof MovieError ? `${error.code}: ${error.message}` : "The operator command failed. Check the arguments, private configuration, and local service.");
  process.exitCode = 1;
});
