# Movie Magic handoff: Dwight / Damian

This folder contains **two distinct contract families**. Do not mix their endpoints or credentials.

| Contract | Caller | Destination |
|---|---|---|
| [`dwight/orchestrator.openapi.json`](dwight/orchestrator.openapi.json), [`dwight/types.d.ts`](dwight/types.d.ts) | Kiosk/tablet | Dwight orchestrator, port 3101, device/session capability |
| [`dwight/media-service.openapi.json`](dwight/media-service.openapi.json) | Dwight's backend | Tiya media service, port 3201, server-only media token |
| **`contracts.ts`** and **`client.ts`** | Trusted studio operator or standalone demo | Creator studio, port 3200, studio browser session or `MOVIE_API_TOKEN` |

For Dwight's integrated robot workflow, use the [authoritative Tiya handoff](dwight/TIYA.md). The rest of this page documents the standalone **creator-studio** API. Copy `contracts.ts` and optionally `client.ts` for that API only; both are independent of Next.js, OpenAI, Zod, and MoviePart's internal modules.

`contracts.ts` is the shared TypeScript transport interface. `client.ts` is a small `fetch` client for Node.js 22+ or a same-origin browser.

The studio now opts into `render_layout: "video-bookends"` alongside `enable_hero_video: true` and an explicit `video_provider`. This produces a **15-second** MP4: 3-second zoomed opening frame, 8-second generated clip, 4-second zoomed closing frame. Both stills come from the video's first/last frames, and there are no intermediate still-only shots. Native audio is aligned to 3–11 seconds. `JobView.renderLayout` and `result.renderLayout` identify this layout. Omitted `render_layout` preserves legacy behavior and durations; the director's four/six-reference plan remains unchanged in both layouts.

## Responsibilities

| Component | Responsibility |
|---|---|
| Dwight / Damian / robot | Obtain explicit consent, capture photos, supply the conversation/session ID, submit approved interests, and display the returned movie |
| Tiya / Movie Magic | Establish reusable visual references, direct four shots, generate/review storyboard frames, optionally animate one hero shot, and assemble the MP4 |
| Research component | Supply permitted structured interests; Movie Magic does not identify people or discover social profiles |
| Sales / calendar component | Decide whether to propose or schedule a test drive after the movie; not part of this API |

## Call sequence

1. `GET /api/movie-config`: discover available product IDs/templates and service readiness.
2. `POST /api/movie-assets`: upload one to four customer photos with explicit consent.
3. `POST /api/movie-jobs`: send the returned asset IDs, selected product, approved profile, and your session ID. Receive HTTP **202** and a job ID.
4. `GET /api/movie-jobs/{jobId}`: poll until `COMPLETED` or `FAILED`. Use `job.sessionId` to associate the result with the original conversation.
5. If completed, `GET /api/movie-assets/{job.result.assetId}` returns the actual MP4.

Do not send filesystem paths, customer image URLs, OpenAI keys, raw social pages, or prompts. Customer images must be uploaded first. No webhook delivery is implemented; `MovieCompletionEvent` reserves an event shape for a later transport.

## Authentication and hosting

The local service runs at **`http://127.0.0.1:3200`** and is loopback-only by default. Run the API and the separate worker from `MoviePart`.

- Same-origin demo browsers receive an HTTP-only session cookie from the configuration endpoint. Mutating requests must originate from the app.
- Trusted machine clients use `Authorization: Bearer <MOVIE_API_TOKEN>`. Configure this token privately on both services; do not embed it in frontend code, URLs, logs, or Git.
- Browser-owned assets/jobs and machine-owned assets/jobs are separate. Upload, submit, poll, and download using the same authentication identity.
- A robot on another device cannot reach this loopback service directly. Agree on authenticated hosting, trusted origins, and secure transport before exposing it; do not simply bind the credential-backed development server publicly.
- Native `<video src>` cannot attach the machine bearer token. Download through the authenticated client and use a Blob/object URL or an authenticated same-origin proxy.

## Minimal robot/server example

```typescript
import { readFile } from "node:fs/promises";
import { MovieMagicClient } from "./client";
import type { MovieJobRequest } from "./contracts";

const movie = new MovieMagicClient({
  baseUrl: "http://127.0.0.1:3200",
  token: process.env.MOVIE_API_TOKEN,
});

const config = await movie.getConfig();
const product = config.products.find(item => item.ready);
if (!product || !config.providers.openai.available ||
    !config.worker.available || !config.renderer.available) {
  throw new Error("Movie Magic is not configured for generation yet.");
}

// These images belong to one consenting customer.
const photos = [
  new File([await readFile("front.jpg")], "front.jpg", { type: "image/jpeg" }),
  new File([await readFile("three-quarter.jpg")], "three-quarter.jpg", { type: "image/jpeg" }),
  new File([await readFile("full-body.jpg")], "full-body.jpg", { type: "image/jpeg" }),
];
const consent = { likeness: true, personalization: true } as const;
const { assets } = await movie.uploadPhotos(photos, consent);

const request: MovieJobRequest = {
  schema_version: 1,
  session_id: "robot-conversation-001",
  customer_reference_asset_ids: assets.map(asset => asset.id),
  primary_reference_asset_id: assets[0].id,
  consent,
  product_id: product.id,
  preferred_template: "TOMORROW_DRIVE",
  personalization_profile: {
    signals: [
      { value: "Egypt", source: "manual", visualUseAllowed: true, confidence: null },
      { value: "architecture", source: "manual", visualUseAllowed: true, confidence: null },
    ],
  },
  enable_hero_video: false,
  idempotency_key: crypto.randomUUID(),
};

// Persist request and accepted.job_id in your conversation state.
// If this POST has a transport failure, retry this SAME request/key.
const accepted = await movie.createJob(request);
const job = await movie.waitForJob(accepted.job_id, {
  onProgress: current => console.log(current.status),
});
if (job.status === "FAILED" || !job.result) {
  throw new Error(job.error?.message ?? "Movie completed without a playable result.");
}
const mp4 = await movie.downloadAsset(job.result.assetId);
// Send the Blob to the authorized player. In a browser:
// video.src = URL.createObjectURL(mp4);
// Revoke that object URL when playback is no longer needed.
```

## Upload format and limits

Multipart field `photos` repeats for each image. Field `consent` is JSON:

```json
{ "likeness": true, "personalization": true }
```

JPEG/PNG/WebP only; one to four photos; at most 10 MiB per image, 40 MiB for the complete request, and 25 megapixels per decoded image. Recommend three or four complementary views. The upload response preserves order, so the caller can choose which returned ID establishes the wardrobe.

Consent must be obtained from the person before transmitting images. Do not convert missing consent into `true` merely to satisfy the schema. Photos may be processed by OpenAI and, if hero video is enabled, Google.

## Rendering and failure semantics

- Templates: `VELOCITY`, `TOMORROW_DRIVE`, `DREAM_ROUTE`, and Tiya's `HERO_OF_THE_DAY`; omitted API selection defaults to `DREAM_ROUTE`.
- Zero to three approved interests. Manual signals use `confidence: null`.
- Omitted `story_format` preserves four shots, lasting **3 + 3 + 8 + 4 seconds**, for an **18-second, 16:9, 720p MP4**.
- Explicit `story_format: "six-shot"` uses Tiya's six-beat arc at **23 seconds** (3 + 3 + 2 + 8 + 3 + 4), or **24 seconds** for `HERO_OF_THE_DAY` (3 + 3 + 3 + 8 + 3 + 4).
- Omitted `hero_mode` means `LIKENESS`, requiring customer photos and a primary asset ID. `POV` and `PERSONALIZED` accept an empty asset array and `primary_reference_asset_id: null`; customer images are not sent to providers in either mode.
- Optional `personalization_profile.customerFirstName` and `city` are explicitly approved context, not inferred personal facts.
- `enable_hero_video` defaults to `false`. Baseline output is `storyboard-motion`: animated still frames, not falsely labeled generative video.
- Successful optional hero video produces `hybrid-video`. Its failure adds a warning and retains the approved still segment. The hero is shot three in classic format and shot four in six-shot format.
- `hasAudio` says whether the actual output contains audio. A sound plan alone does not mean audio was generated.
- Provider/continuity/rendering failures return `FAILED` with `error.code`, `error.stage`, and a controlled message. Existing artifacts remain inspectable.
- A client polling limit or disconnected browser does not imply a failed movie. Resume polling the existing job ID; do not create a second paid job.
- An identical request/key returns the existing job. The same key with different inputs is a conflict.
- Stage names can recur while individual shots are being generated and reviewed. Use `events` for detail, not a fabricated progress percentage.
- Deleting a terminal job is explicit: `DELETE /api/movie-jobs/{jobId}`. Active jobs cannot be deleted; unshared private artifacts are cleaned up with terminal jobs.

Full source-level fields and nullability are in `contracts.ts`. The endpoint implementation reuses these public response interfaces; runtime request validation stays on the Movie Magic server.

## Retry failed or missing studio shots

This is a **creator-studio** feature, not a change to Dwight's media-service protocol.

### Movie-first production

Set `production_mode: "movie-first"` only when explicitly choosing animated-image output. Omitting the field retains reviewed-storyboard API behavior; the web form defaults to reviewed storyboards and required Google Veo animation.

To finish an existing failed job without further continuity scoring, add `production_mode: "movie-first"` to its retry request below. That mode choice is part of the idempotency receipt; reuse the exact request on transport retry.

The job response reports `productionMode`, and `image-motion` result mode means an animated-image film. Once the validated MP4 exists it is available in `result`, including while status is `EXTRACTING_STORYBOARD`. The returned `frames` in this mode are **only** frames extracted from that MP4, tagged with `source: "extracted"`, `extractedAtSeconds`, and `continuity.verdict: "NOT_REVIEWED"`. They are not fabricated PASS results. Intermediate generation inputs remain private scene artifacts, not the displayed storyboard.

### Required Google Veo hybrid video

Use `production_mode: "reviewed-storyboard"`, `enable_hero_video: true`, and `video_provider: "google-veo"`. The server needs a private `GEMINI_API_KEY` and a supported `VEO_MODEL`. The completed clip must be `hero.provider: "Google Veo"` and final output `hybrid-video`. Missing/failed animation blocks final output rather than falling back to image motion.

The OpenAI vision/director/image credentials remain separate from Google's key. The existing movie-service/orchestrator default prerecorded demo does not require either generation provider.

### Alternative OpenAI hybrid video

If explicitly selecting OpenAI's temporary video adapter, use `production_mode: "reviewed-storyboard"`, `enable_hero_video: true`, and `video_provider: "openai-sora"` for an approved-stills plus Sora-animation movie. `OPENAI_VIDEO_MODEL` is configured on the server (`sora-2-pro` by default). The plan records `videoProvider`, and the animated hero is deliberately car-only because the current Sora API prohibits real people and rejects human-face image references. The Sora API is scheduled to shut down September 24, 2026; no future-supported replacement is claimed.

All planned storyboard shots must pass before video submission. Sora output is saved as `hero.provider: "OpenAI Sora"` with its operation ID and must be present in a `hybrid-video` result. No video or a failed Sora operation means no completed slideshow substitute. Retry resumes a saved provider operation rather than charging for another video; an attempted submission without an operation ID is not automatically repeated.

Only legacy requests that enable a hero but omit `video_provider` retain optional Veo fallback. Explicit `google-veo` or `openai-sora` requests require real video. Do not silently relabel an older `image-motion` movie as a generated hybrid.

Missing scene visuals are generated once per explicit attempt, without critic-driven retries. Usable existing visuals and the saved plan are retained. If extraction alone fails, another retry reuses the encoded movie rather than rendering or generating it again.

### Reviewed-storyboard recovery

`GET /api/movie-jobs/{jobId}` includes `job.retry` with `attempt`, `eligible`, `approvedShots`, and `remainingShots`. A failed job with a saved director plan/reference can be retried using:

```http
POST /api/movie-jobs/{jobId}/retry
Content-Type: application/json

{
  "idempotency_key": "unique-retry-action-key",
  "expected_attempt": 0
}
```

Use the latest `job.retry.attempt` as `expected_attempt`. A successful response is HTTP 202 with `job_id`, `status`, `status_url`, and `retry_attempt`. The ID is unchanged. Resume polling that ID even if the UI had stopped polling its previous failed state.

```typescript
const job = await movie.getJob(jobId);
if (job.retry?.eligible) {
  // Only run following an explicit user decision; this may incur new API charges.
  const retry = {
    idempotency_key: crypto.randomUUID(),
    expected_attempt: job.retry.attempt,
  };
  const accepted = await movie.retryJob(job.id, retry);
  const recovered = await movie.waitForJob(accepted.job_id);
}
```

Persist/reuse the **same request** after a lost acknowledgement. It returns the same accepted retry even if that attempt later fails; another generation requires a fresh key and the new attempt counter after another explicit decision. A changed payload with the same key or a stale counter returns 409.

Requests are owner-authorized and may not supply replacement plans, frames, references, prompts, or product settings. The existing plan and passed images are immutable recovery inputs. Missing/corrupt approved artifacts, missing original consent, and absent worker/rendering prerequisites fail preflight without scheduling paid work.

In reviewed-storyboard mode the worker skips AI/designer-approved shots and includes the latest rejection reasons or designer note in the next attempt. The configurable concurrency defaults to two and per-shot attempt budget to eight; output remains in planned order. Previous errors/events/candidates remain saved. Final custom output stays unavailable until every required shot is approved and rendering completes. The two-minute timing target is advisory only.

## Designer frame decisions

Use `POST /api/movie-jobs/{jobId}/frames/{assetId}/decision` with:

```json
{
  "action": "keep",
  "note": "Image 2 is fine; keep it and move to image 3.",
  "idempotency_key": "designer-action-unique-key",
  "expected_revision": 0,
  "expected_attempt": 0,
  "resume": true
}
```

`action` is `keep` or `regenerate`. Take `expected_revision` from `job.reviewRevision` and `expected_attempt` from `job.retry.attempt`. Reuse the identical request/key after an uncertain response. The response contains the authoritative `{job}`; changed-payload key reuse or stale revisions return 409.

The request targets the exact displayed asset, not merely a shot number. Keep records `frame.designerDecision` and preserves the original `frame.continuity` assessment. Regenerate invalidates previous approvals for that shot without deleting them. With `resume: true`, a failed job is requeued atomically; an actively reviewed job observes the decision and continues without a second queued run.

`job.designerReviewAllowed` tells the client when creative decisions are allowed. The worker locks the selected storyboard before video/rendering, and the API rejects edits after that point or to completed output. An in-flight provider call may finish before the decision takes effect. Neither consent nor provider restrictions can be overridden by a designer note.
