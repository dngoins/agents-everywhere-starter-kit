import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AdBriefSchema, DEMO_PRODUCT } from "../src/contracts/index.js";
import { readConfig } from "../src/config.js";
import { createProviders } from "../src/providers/factory.js";
import { createOpenAIBriefProvider } from "../src/providers/openai.js";
import { createExaProfileProvider } from "../src/providers/exa.js";
import { createHttpMediaProvider } from "../src/providers/media.js";
import { ProviderFailure } from "../src/providers/http-client.js";
import { createMockBriefProvider } from "../src/providers/mock.js";
import type { BriefInput } from "../src/providers/interfaces.js";

const signal = () => new AbortController().signal;
const syntheticMetadata = { provenance: "mock_fixture", durationSeconds: 1 } as const;
async function cleanupDirectory(t: TestContext) {
  const artifacts = join(process.cwd(), "artifacts");
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "provider-test-"));
  t.after(() => rm(directory, { recursive: true, maxRetries: 10, retryDelay: 300 }));
  return directory;
}
function input(): BriefInput {
  return {
    briefId: randomUUID(), sessionId: randomUUID(),
    customer: { customerId: "demo-alex", displayName: "Alex", method: "manual", synthetic: true },
    context: { revision: 1, source: "conversation", preferences: ["Beach road trips"], profileUrl: "https://example.org/profile" },
    product: structuredClone(DEMO_PRODUCT),
  };
}

test("OpenAI requests strict output, excludes participant image/name and freezes server metadata", async (t) => {
  let requestBody: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requestBody = JSON.parse(String(init.body));
    return Response.json({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
        objective: "A synthetic car concept", scenes: [{ durationSeconds: 6, visual: "A concept car by the beach", onScreenText: "Synthetic concept" }],
      }) }] }],
    });
  });
  const source = input();
  const brief = await createOpenAIBriefProvider("fake-test-key", "test-model").create(source, signal());
  AdBriefSchema.parse(brief);
  assert.equal(brief.id, source.briefId);
  assert.equal(brief.provenance, "generated");
  assert.equal(brief.durationSeconds, 6);
  assert.equal(requestBody?.store, false);
  assert.equal(JSON.stringify(requestBody).includes("demo-alex"), false);
});

test("OpenAI invalid output fails unless labeled demo fallback is explicitly selected", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "incomplete", output: [] }));
  const source = input();
  await assert.rejects(createOpenAIBriefProvider("fake", "test").create(source, signal()), ProviderFailure);
  const providers = createProviders(readConfig({
    BRIEF_PROVIDER: "openai", OPENAI_API_KEY: "fake", MODEL: "test", ALLOW_DEMO_FALLBACKS: "true",
  }), new Uint8Array(), syntheticMetadata);
  const fallback = await providers.briefProvider.create(source, signal());
  assert.equal(fallback.provenance, "mock");
});

test("Exa fetches only the supplied source and preserves evidence without inferring interests", async (t) => {
  let body: { ids?: string[] } = {};
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    assert.equal(url, "https://api.exa.ai/contents");
    body = JSON.parse(String(init.body));
    return Response.json({ results: [
      { url: "https://example.org/profile", text: "Public demo profile content." },
      { url: "https://unrequested.example/profile", text: "Must not be used." },
    ] });
  });
  const source = input();
  const result = await createExaProfileProvider("fake-test-key").enrich(source, signal());
  assert.deepEqual(body.ids, [source.context.profileUrl]);
  assert.deepEqual(result.preferences, []);
  assert.deepEqual(result.citations, ["https://example.org/profile"]);
  assert.equal(result.evidence?.[0]?.excerpt, "Public demo profile content.");
});

test("private/credential-like profile URLs are rejected before any request", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not call"); });
  const source = input();
  for (const url of ["https://127.0.0.1/profile", "https://localhost/profile", "https://example.org/profile?token=private"]) {
    await assert.rejects(createExaProfileProvider("fake").enrich({
      ...source, context: { ...source.context, profileUrl: url },
    }, signal()), ProviderFailure);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("Exa failure is an error by default and explicit unavailable context when fallbacks are allowed", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("secret provider error", { status: 503 }));
  const source = input();
  await assert.rejects(createExaProfileProvider("fake").enrich(source, signal()), ProviderFailure);
  const providers = createProviders(readConfig({
    PROFILE_PROVIDER: "exa", EXA_API_KEY: "fake", ALLOW_DEMO_FALLBACKS: "true",
  }), new Uint8Array(), syntheticMetadata);
  const profile = await providers.profileProvider.enrich(source, signal());
  assert.equal(profile.provenance, "unavailable");
  assert.ok(profile.warnings.length);
  assert.deepEqual(profile.citations, []);
});

test("HTTP media adapter submits once and fetches only its service's scoped MP4", async (t) => {
  const fixture = await readFile(new URL("../fixtures/media/mock-preview.mp4", import.meta.url));
  const image = await readFile(new URL("../fixtures/media/sample.png", import.meta.url));
  const paths: string[] = [];
  const jobId = randomUUID();
  const directory = await cleanupDirectory(t);
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    paths.push(url.pathname);
    assert.equal(init.redirect, "error");
    if (url.pathname === "/media/capabilities") return Response.json({ schemaVersion: 1, cancelByKey: true, deleteAssets: true });
    if (init.method === "DELETE") return Response.json({ status: "cancelled", assetsDeleted: true });
    if (url.pathname === "/media/jobs") {
      assert.equal(new Headers(init.headers).get("idempotency-key"), jobId);
      assert.equal(JSON.parse(String(init.body)).idempotencyKey, jobId);
      return Response.json({ providerJobId: "job-1" });
    }
    if (url.pathname === "/media/jobs/job-1") return Response.json({
      status: "ready", result: { assetPath: "assets/result-1.mp4", mimeType: "video/mp4", durationSeconds: 1 },
    });
    return new Response(fixture, { headers: { "content-type": "video/mp4" } });
  });
  const brief = await createMockBriefProvider().create(input(), signal());
  const media = await createHttpMediaProvider("http://127.0.0.1:3200/media", "fake", 1_000_000, directory).generate({
    jobId, idempotencyKey: "shared-client-key", brief, image: { bytes: image, mimeType: "image/png" },
  }, signal(), () => {});
  assert.deepEqual(paths, ["/media/capabilities", "/media/jobs", "/media/jobs/job-1", "/media/assets/result-1.mp4", `/media/jobs/by-key/${jobId}`]);
  assert.deepEqual(Buffer.from(media.bytes), fixture);
  assert.equal(media.provenance, "generated");
  assert.deepEqual(await readdir(directory), []);
});

test("uncertain media acceptance is not retried", async (t) => {
  let submissions = 0;
  const directory = await cleanupDirectory(t);
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    if (url.pathname === "/capabilities") return Response.json({ schemaVersion: 1, cancelByKey: true, deleteAssets: true });
    if (init.method === "DELETE") return Response.json({ status: "cancelled", assetsDeleted: true });
    submissions++;
    return Response.json({ unexpected: true });
  });
  const brief = await createMockBriefProvider().create(input(), signal());
  await assert.rejects(createHttpMediaProvider("http://127.0.0.1:3200", "fake", 1000, directory).generate({
    jobId: randomUUID(), idempotencyKey: randomUUID(), brief,
    image: { bytes: new Uint8Array([1]), mimeType: "image/png" },
  }, signal(), () => {}), (error: unknown) => {
    assert.ok(error instanceof ProviderFailure);
    assert.equal(error.acceptanceUncertain, true);
    return true;
  });
  assert.equal(submissions, 1);
  assert.deepEqual(await readdir(directory), []);
});

test("remote job keys are isolated across sessions using the same client key", async (t) => {
  const directory = await cleanupDirectory(t);
  const fixture = await readFile(new URL("../fixtures/media/mock-preview.mp4", import.meta.url));
  const keys: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    if (url.pathname === "/capabilities") return Response.json({ schemaVersion: 1, cancelByKey: true, deleteAssets: true });
    if (init.method === "DELETE") return Response.json({ status: "cancelled", assetsDeleted: true });
    if (init.method === "POST") {
      const key = new Headers(init.headers).get("idempotency-key")!;
      keys.push(key);
      return Response.json({ providerJobId: key });
    }
    if (url.pathname.startsWith("/jobs/")) return Response.json({
      status: "ready", result: { assetPath: "assets/result.mp4", mimeType: "video/mp4", durationSeconds: 1 },
    });
    return new Response(fixture, { headers: { "content-type": "video/mp4" } });
  });
  const provider = createHttpMediaProvider("http://127.0.0.1:3200", "fake", 10000, directory);
  for (let index = 0; index < 2; index++) {
    const brief = await createMockBriefProvider().create(input(), signal());
    await provider.generate({
      jobId: randomUUID(), idempotencyKey: "render-1", brief,
      image: { bytes: new Uint8Array([1]), mimeType: "image/png" },
    }, signal(), () => {});
  }
  assert.equal(new Set(keys).size, 2);
  assert.ok(keys.every((key) => key !== "render-1"));
});

test("abort after acceptance invokes independently bounded remote cleanup", async (t) => {
  const directory = await cleanupDirectory(t);
  const controller = new AbortController();
  let deleted = false;
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    if (url.pathname === "/capabilities") return Response.json({ schemaVersion: 1, cancelByKey: true, deleteAssets: true });
    if (init.method === "POST") return Response.json({ providerJobId: "remote-1" });
    if (init.method === "DELETE") {
      assert.equal(init.signal?.aborted, false);
      deleted = true;
      return Response.json({ status: "cancelled", assetsDeleted: true });
    }
    controller.abort(new Error("Consent revoked"));
    throw controller.signal.reason;
  });
  const brief = await createMockBriefProvider().create(input(), signal());
  await assert.rejects(createHttpMediaProvider("http://127.0.0.1:3200", "fake", 10000, directory).generate({
    jobId: randomUUID(), idempotencyKey: "render-1", brief,
    image: { bytes: new Uint8Array([1]), mimeType: "image/png" },
  }, controller.signal, () => {}));
  assert.equal(deleted, true);
  assert.deepEqual(await readdir(directory), []);
});

test("polling failures preserve uncertainty, retry only reads and request cleanup", async (t) => {
  const directory = await cleanupDirectory(t);
  let submissions = 0;
  let polls = 0;
  let deleted = false;
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    if (url.pathname === "/capabilities") return Response.json({ schemaVersion: 1, cancelByKey: true, deleteAssets: true });
    if (init.method === "POST") { submissions++; return Response.json({ providerJobId: "remote-1" }); }
    if (init.method === "DELETE") { deleted = true; return Response.json({ status: "cancelled", assetsDeleted: true }); }
    polls++;
    return new Response("unavailable", { status: 503 });
  });
  const brief = await createMockBriefProvider().create(input(), signal());
  await assert.rejects(createHttpMediaProvider("http://127.0.0.1:3200", "fake", 10000, directory).generate({
    jobId: randomUUID(), idempotencyKey: "render-1", brief,
    image: { bytes: new Uint8Array([1]), mimeType: "image/png" },
  }, signal(), () => {}), (error: unknown) => {
    assert.ok(error instanceof ProviderFailure);
    assert.equal(error.acceptanceUncertain, true);
    return true;
  });
  assert.equal(submissions, 1);
  assert.equal(polls, 2);
  assert.equal(deleted, true);
});

test("failed cleanup leaves only a safe recovery receipt and blocks successful completion", async (t) => {
  const directory = await cleanupDirectory(t);
  const jobId = randomUUID();
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    if (url.pathname === "/capabilities") return Response.json({ schemaVersion: 1, cancelByKey: true, deleteAssets: true });
    if (init.method === "POST") return Response.json({ providerJobId: "remote-1" });
    if (init.method === "DELETE") return new Response("secret", { status: 503 });
    return Response.json({ status: "failed" });
  });
  const brief = await createMockBriefProvider().create(input(), signal());
  await assert.rejects(createHttpMediaProvider("http://127.0.0.1:3200", "fake-secret-key", 10000, directory).generate({
    jobId, idempotencyKey: "render-1", brief,
    image: { bytes: new Uint8Array([1]), mimeType: "image/png" },
  }, signal(), () => {}), (error: unknown) => {
    assert.ok(error instanceof ProviderFailure);
    assert.equal(error.code, "MEDIA_CLEANUP_UNCERTAIN");
    return true;
  });
  const receipt = JSON.parse(await readFile(join(directory, `${jobId}.json`), "utf8"));
  assert.deepEqual(Object.keys(receipt).sort(), ["cleanupRequired", "jobId", "mediaBase", "providerJobId"]);
  assert.equal(receipt.providerJobId, "remote-1");
  assert.equal(JSON.stringify(receipt).includes("fake-secret-key"), false);
});
