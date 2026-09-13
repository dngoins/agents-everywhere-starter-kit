import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import test from "node:test";
import { loadConfig } from "../src/server/config";

test("the example environment uses supported, secret-free settings and safe private/tool defaults", async () => {
  const example = parseEnv(await readFile(".env.example", "utf8"));
  const before = process.env;
  try {
    process.env = { ...example, NODE_ENV: "test" };
    const config = loadConfig();
    assert.equal(config.openaiKey, undefined);
    assert.equal(config.googleKey, undefined);
    assert.equal(config.apiToken, undefined);
    assert.equal(example.MEDIA_SERVICE_TOKEN, "");
    assert.equal(example.MOVIE_DATA_DIR, ".movie-data");
    assert.equal(config.ffmpegPath, undefined);
    assert.equal(config.ffprobePath, undefined);
    assert.equal(config.musicPath, undefined);
    assert.equal(example.FFMPEG_PATH, undefined, "Empty executable overrides must not disable media-service fallbacks");
    assert.equal(example.FFPROBE_PATH, undefined);
    assert.equal(config.visionModel, "gpt-6-astra");
    assert.equal(config.directorModel, "gpt-6-astra");
    assert.equal(config.imageModel, "gpt-image-2.5-flare");
    assert.equal(config.veoModel, "veo-3.1-generate-preview");
    assert.equal(config.storyboardMaxAttempts, 8);
    assert.equal(config.storyboardConcurrency, 2);
    assert.equal(example.MOVIE_STUDIO_URL, "http://127.0.0.1:3200");
    assert.equal(Number(example.MEDIA_SERVICE_PORT), 3201);
    assert.equal(Number(example.MEDIA_SERVICE_JOB_TIMEOUT_MS), 600000);
  } finally {
    process.env = before;
  }
});
