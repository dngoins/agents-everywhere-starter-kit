import assert from "node:assert/strict";
import test from "node:test";

// Launcher configuration is deliberately independent from either application's runtime.
const { integrationEnvironments, launchOptions } = await import("../scripts/kiosk-config.mjs");

test("kiosk launcher defaults to distinct loopback ports and validates overrides", () => {
  assert.deepEqual(launchOptions([]), { liveMedia: false, apiPort: 3101, uiPort: 3200, mediaPort: 3201 });
  assert.equal(launchOptions(["--ui-port", "3202"]).uiPort, 3202);
  assert.throws(() => launchOptions(["--ui-port", "3101"]), /distinct/);
  assert.throws(() => launchOptions(["--ui-port", "0"]), /port/);
  assert.throws(() => launchOptions(["--unknown"]), /Unsupported/);
});

test("offline kiosk mode isolates inherited credentials and configures the actual UI origin", () => {
  const environment = integrationEnvironments({
    options: launchOptions(["--ui-port", "3202"]),
    parent: { PATH: "test-path", OPENAI_API_KEY: "must-not-leak", GH_TOKEN: "must-not-leak", NODE_OPTIONS: "must-not-propagate" },
    finalEnv: { BRIEF_PROVIDER: "openai", PROFILE_PROVIDER: "exa", MEDIA_SERVICE_TOKEN: "ignored" },
    movieEnv: { OPENAI_API_KEY: "ignored", GOOGLE_API_KEY: "ignored" },
    deviceToken: "test-device-capability", mediaToken: "test-service-capability",
  });
  assert.equal(environment.api.MOCK_ONLY, "true");
  assert.equal(environment.api.MEDIA_PROVIDER, "mock");
  assert.equal(environment.api.ALLOWED_ORIGINS, "http://127.0.0.1:3101,http://127.0.0.1:3202");
  assert.equal(environment.api.OPENAI_API_KEY, "");
  assert.equal(environment.ui.OPENAI_API_KEY, "");
  assert.equal(environment.ui.GOOGLE_API_KEY, "");
  assert.equal(environment.ui.MEDIA_SERVICE_TOKEN, "");
  assert.equal(environment.ui.GH_TOKEN, undefined);
  assert.equal(environment.ui.NODE_OPTIONS, undefined);
  assert.equal(environment.ui.DEMO_DEVICE_TOKEN, undefined);
  assert.equal(environment.api.MEDIA_SERVICE_TOKEN, "");
});

test("live media is opt-in and forwards the provider key only to the media server", () => {
  const options = launchOptions(["--live-media"]);
  assert.throws(() => integrationEnvironments({ options, parent: {}, deviceToken: "device", mediaToken: "service" }), /MoviePart/);
  const env = integrationEnvironments({
    options, parent: {}, movieEnv: { OPENAI_API_KEY: "fake-test-only", OPENAI_IMAGE_MODEL: "chosen-model" },
    deviceToken: "device", mediaToken: "service",
  });
  assert.equal(env.api.MEDIA_PROVIDER, "http");
  assert.equal(env.api.MEDIA_SERVICE_TOKEN, env.media.MEDIA_SERVICE_TOKEN);
  assert.equal(env.media.OPENAI_API_KEY, "fake-test-only");
  assert.equal(env.ui.OPENAI_API_KEY, "");
  assert.equal(env.api.OPENAI_API_KEY, "");
  assert.equal(env.api.BRIEF_PROVIDER, "mock");
});
