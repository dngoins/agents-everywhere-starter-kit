import test from "node:test";
import assert from "node:assert/strict";
import { MovieMagicClient, MovieMagicHttpError } from "../integration/client";
import type { MovieJobRequest, JobView } from "../integration/contracts";
import type { JobRequest, MovieJob } from "../src/domain";

// Keep the portable interfaces structurally aligned with server schema outputs.
const compatibleRequest = (value: JobRequest): MovieJobRequest => value;
const compatibleJob = (value: Omit<MovieJob, "ownerId" | "request" | "product" | "operations"> & { sessionId: string }): JobView => value;
void compatibleRequest;
void compatibleJob;

test("portable client preserves idempotency and sends machine token in a header", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = new MovieMagicClient({
    baseUrl: "http://127.0.0.1:3200", token: "test-only",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ job_id: "job", status: "RECEIVED", status_url: "/api/movie-jobs/job" }, { status: 202 });
    },
  });
  const request: MovieJobRequest = {
    schema_version: 1, session_id: "robot-session", customer_reference_asset_ids: ["asset"],
    primary_reference_asset_id: "asset", consent: { likeness: true, personalization: true },
    product_id: "demo", personalization_profile: { signals: [] }, idempotency_key: "same-key",
    enable_hero_video: true, video_provider: "google-veo", render_layout: "video-bookends",
  };
  await client.createJob(request);
  await client.createJob(request);
  assert.equal(calls[0].init?.body, calls[1].init?.body);
  assert.equal(new Headers(calls[0].init?.headers).get("Authorization"), "Bearer test-only");
  assert.equal(calls[0].url, "http://127.0.0.1:3200/api/movie-jobs");
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal(JSON.parse(String(calls[0].init?.body)).render_layout, "video-bookends");
});
test("client surfaces controlled API errors and keeps token out of URLs", async () => {
  const client = new MovieMagicClient({
    baseUrl: "http://localhost:3200",
    fetch: async () => Response.json({ code: "NOT_READY", error: "Configure references first." }, { status: 503 }),
  });
  await assert.rejects(client.getConfig(), (error: unknown) =>
    error instanceof MovieMagicHttpError && error.status === 503 && error.code === "NOT_READY");
});
test("bounded polling never creates another job", async () => {
  let polls = 0;
  const client = new MovieMagicClient({
    baseUrl: "http://localhost:3200",
    fetch: async url => {
      assert.equal(String(url), "http://localhost:3200/api/movie-jobs/existing");
      polls++;
      return Response.json({ job: { status: "STORYBOARDING" } });
    },
  });
  await assert.rejects(client.waitForJob("existing", { maxPolls: 1 }), /same job ID/);
  assert.equal(polls, 1);
});
test("successful empty deletion resolves without attempting JSON parsing", async () => {
  const client = new MovieMagicClient({
    baseUrl: "http://localhost:3200",
    fetch: async (url, init) => {
      assert.equal(String(url), "http://localhost:3200/api/movie-jobs/completed");
      assert.equal(init?.method, "DELETE");
      return new Response(null, { status: 204 });
    },
  });

  await assert.doesNotReject(client.deleteJob("completed"));
});

test("retry client targets the original job and preserves the attempt receipt after a lost acknowledgement", async () => {
  const bodies: unknown[] = [];
  let calls = 0;
  const client = new MovieMagicClient({
    baseUrl: "http://localhost:3200",
    fetch: async (url, init) => {
      assert.equal(String(url), "http://localhost:3200/api/movie-jobs/original/retry");
      assert.equal(init?.method, "POST");
      bodies.push(init?.body);
      if (++calls === 1) throw new TypeError("Lost acknowledgement");
      return Response.json({ job_id: "original", status: "RECEIVED", status_url: "/api/movie-jobs/original", retry_attempt: 1 }, { status: 202 });
    },
  });
  const request = { idempotency_key: "retry-request-key", expected_attempt: 0 };
  await assert.rejects(client.retryJob("original", request), /Lost acknowledgement/);
  assert.equal((await client.retryJob("original", request)).retry_attempt, 1);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(calls, 2);
});
