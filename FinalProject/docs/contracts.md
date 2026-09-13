# MagicPitch integration contracts

This is Dwight's version-1 API boundary, not a claim that robot hardware or a media service already exists. The executable Zod schemas and TypeScript types are in `src\contracts\index.ts` (compiled to `dist\contracts\index.js` and `.d.ts`). `OriginalRepo` is unchanged.

## Authentication and session ownership

Start the service from `FinalProject`. Use the operator's device pairing token in `Authorization: Bearer <device token>` for `POST /v1/sessions`. The response is:

```json
{
  "sessionId": "<uuid>",
  "sessionToken": "<opaque capability>",
  "serverInstanceId": "<uuid>"
}
```

All subsequent `/v1/sessions/{sessionId}` requests, including images and MP4s, require `Authorization: Bearer <sessionToken>`. Never place capabilities in URLs, logs, git, prompts, or persistent browser storage. Device tokens do not grant access to an existing session.

The operator pairs a browser by entering the token. The development harness keeps the resulting session token in memory and fetches media into a Blob for playback. HTML video tags cannot supply arbitrary authorization headers. For Tiya's production UI, preserve this fetch/Blob approach or supply an authenticated same-origin gateway; do not remove media authorization.

Unrecognized sessions return 404; ended/expired sessions can return 410. A restart creates a new server instance and discards all sessions. The API is single-process, in-memory, and not a durable distributed job service.

## Robot and UI event envelope

`POST /v1/sessions/{id}/events`, with `Content-Type: application/json`:

```json
{
  "schemaVersion": 1,
  "eventId": "<new uuid>",
  "type": "consent_recorded",
  "payload": {
    "personalization": true,
    "capture": true,
    "enrichment": false
  }
}
```

| Type | Payload | Rule |
|---|---|---|
| `customer_detected` | `{}` | Presence only, before identity/capture; no automatic provider calls |
| `consent_recorded` | `{personalization, capture, enrichment}` booleans | Explicit grant; withdrawing a previously granted scope cancels and clears the session's private assets |
| `context_updated` | `{preferences: string[], profileUrl?: string}` | Confirmed preferences only; no edits while a provider operation/job is active |
| `media_revealed` | `{jobId: string}` | Send after actual playback, not after a status poll says ready |
| `session_cancelled` | `{}` | Abort/suppress work and revoke assets |

Events return a safe session snapshot plus `acknowledgement: {eventId, revision}`. An exact duplicate returns the original acknowledgement with the current snapshot. Reusing an event ID with different content returns 409.

Only explicitly synthetic `demo-alex` and `demo-sam` profiles are registered. Manual/QR/enrolled are transport labels, not a biometric implementation or an assertion of real enrollment. Damian must coordinate real enrolled-participant registration and permissions before a live demo; Dwight will not infer identity from a photo or search random people.

## Command surface

`POST /v1/sessions/{id}/commands/{name}` accepts strict JSON bodies and returns the relevant object directly.

| Name | Body | Result / preconditions |
|---|---|---|
| `identify_customer` | `{customerId: "demo-alex" or "demo-sam", method: "manual" or "qr" or "enrolled"}` | Customer profile, after personalization consent |
| `enrich_profile` | `{}` | Context; external Exa additionally requires enrichment consent and an explicit supplied public profile URL |
| `create_ad_brief` | `{productId: "demo-car"}` | AdBrief, with ID in `id`; confirmed nonempty preference context required |
| `start_media_job` | `{briefId: "<brief.id>", idempotencyKey: "<stable key>"}` | HTTP 202 with MediaJob; capture consent, registered image and current brief required |
| `get_media_status` | `{jobId: "<uuid>"}` | MediaJob; also available through GET below |
| `schedule_followup` | `{}` | HTTP 503: deliberately disabled, never a fabricated booking |

The idempotency key may contain letters, digits, `.`, `_`, `:`, `-`, and is at most 128 characters. Keep it stable when retrying a lost acknowledgement. Same key and brief return the same job; a changed payload returns 409. Creating another key is not a safe way to resolve an uncertain provider submission.

AdBrief metadata, confirmed preferences, product ID, and CTA are server-held. Providers supply structured storyboard content, not identity, authorization, arbitrary file paths, bookings, prices, or product specifications.

## Uploads, polling, and reveal

Upload an image with `POST /v1/sessions/{id}/assets`, raw bytes, and `Content-Type: image/png` or `image/jpeg`. The route is authenticated and bounded; the core verifies the image format header. Image decoding/normalization and real image generation belong to Tiya's media implementation. The result is `{assetId}`; the server registers it as the current session image.

Poll `GET /v1/sessions/{id}?afterRevision=N`. The response includes `state`, `revision`, `expiresAt`, safe customer/context/brief fields, `jobs`, and bounded `events`. If a cursor is too old or from a different history, `resetRequired` tells the client to replace its snapshot. A fresh GET without a cursor always returns a snapshot.

`GET /v1/sessions/{id}/jobs/{jobId}` is the read-only job endpoint. Job states are `queued`, `running`, `ready`, `failed`, `cancelled`, and `expired`. A terminal state cannot regress to progress. Clients must handle the safe `error` and `warnings` fields instead of waiting indefinitely.

A ready job includes:

```json
{
  "result": {
    "assetId": "<uuid>",
    "mimeType": "video/mp4",
    "provenance": "prerendered_fallback",
    "durationSeconds": 10,
    "byteLength": 4273110,
    "checksum": "69674967b142a7cd9f121df4aac8bb90d2f24274bae5d45d8841b5a337d41773"
  }
}
```

The metadata above illustrates the user-provided default demo, not fixed contract values. Fetch the bytes using `GET /v1/sessions/{id}/assets/{assetId}` with session authorization. Single byte ranges are supported.

`mock_fixture` identifies the synthetic color-bar test video, not a personalized ad. `prerendered_fallback` must be presented as prerecorded; it is now also the default offline demo's provenance, not necessarily evidence of a provider failure. The explicitly selected offline demo works with `ALLOW_DEMO_FALLBACKS=false`; failed-provider recovery remains a separate opt-in. `generated` indicates the selected real media adapter's output; real audiovisual correctness still requires live integration acceptance.

Only the immutable local demo provider, registered privately after validating the supplied asset, may return prerecorded media as a primary result. Provider names, copied metadata, and lookalike provider objects do not grant that capability. The guard rejecting unsolicited prerecorded output from HTTP/other primary providers remains in place. No wire-contract or provenance-enum change is required.

The default supplied MP4 retains its original audio and bytes. Its ten-second video duration is reported even though the unchanged mock brief totals six seconds; its audio/container tail ends at 10.026667 seconds. It does not execute the brief or generate media for the selected customer. Display **PRERECORDED DEMO · Prerecorded media, not generated for this customer.** Do not infer a generation provider or depicted identity from the supplied file. Historical synthetic examples in the frozen interface bundle remain valid examples, not a description of the current default asset.

`DELETE /v1/sessions/{id}` cancels local work, clears assets, and invalidates the capability. The HTTP adapter separately requests renderer cancellation/deletion. Failed remote cleanup leaves an ignored recovery receipt; local cancellation does not prove removal of all third-party copies.

## Tiya's optional HTTP media service

The `MEDIA_PROVIDER=http` adapter implements this proposed protocol. Tiya can implement it or agree a boundary adapter; no changes are made to `MoviePart`.

Configure an operator-controlled `MEDIA_SERVICE_URL` base and `MEDIA_SERVICE_TOKEN`. Non-loopback destinations require HTTPS. The service must be reachable from the API host, not merely from Tiya's development shell.

Before sending an image, the adapter requires authenticated `GET {base}/capabilities` to return `{"schemaVersion":1,"cancelByKey":true,"deleteAssets":true}`. This is a required implementation capability, not a flag to claim without supporting the cleanup endpoint.

`POST {base}/jobs` has bearer service authorization and an `Idempotency-Key` header. Body:

```json
{
  "schemaVersion": 1,
  "jobId": "<MagicPitch uuid>",
  "idempotencyKey": "<same MagicPitch job UUID>",
  "brief": {},
  "image": {
    "mimeType": "image/png",
    "base64": "<consented image bytes>"
  }
}
```

`brief` is the complete validated AdBrief, not an empty object. The adapter uses the globally unique MagicPitch job UUID for both the upstream idempotency header and body, not the session-local client key. This prevents cross-customer key collisions. The media service must deduplicate that key and respond promptly with `{providerJobId: "<opaque letters/digits/underscore/hyphen ID>"}`; rendering continues separately.

`GET {base}/jobs/{providerJobId}` returns one of:

```json
{"status":"queued"}
```

```json
{"status":"running","stage":"rendering"}
```

```json
{"status":"ready","result":{"assetPath":"assets/result-123.mp4","mimeType":"video/mp4","durationSeconds":12}}
```

```json
{"status":"failed"}
```

Accepted progress stages are `accepted`, `preparing`, `generating`, `rendering`, `encoding`, and `finalizing`. The result path must match `assets/<letters-digits-underscore-hyphen>.mp4`, relative to the same configured base. Arbitrary provider URLs/redirects are rejected. The download requires the same service bearer token, correct MP4 MIME, and a bounded body.

The adapter submits once and polls; only transient read failures are retried, once within the job deadline. If reconciliation is uncertain, the local job fails explicitly and fallback is suppressed.

Implement authenticated `DELETE {base}/jobs/by-key/{jobId}`. Cancel/tombstone that globally unique key (including if POST acceptance is still unknown), stop its render, and delete renderer-held input/output assets. A delayed POST must not resurrect a cancelled key. Return `{"status":"cancelled","assetsDeleted":true}` only after cleanup, idempotently.

The adapter requests cleanup with a separate bounded signal on failure/cancellation and after downloading the completed MP4 into local authorized storage. Before transfer it writes a private `.runtime\media-cleanup\<jobId>.json` receipt containing only IDs and the configured service base. Successful cleanup removes it; a failure leaves it and emits a safe `media_cleanup_pending` event. Inspect/reconcile these receipts before another render or after restart. There is no automatic recovery console; do not delete an unresolved receipt to hide failure. External model-vendor retention remains a separately disclosed limitation.

## Provider and device limitations

OpenAI structured brief mode sends approved product facts, confirmed preferences, and optionally retrieved source evidence; it does not send the participant image/name for reasoning. Image generation stays with Tiya.

Exa mode retrieves only the supplied public HTTPS page through `/contents`, filters responses back to that source, and returns evidence/citations. It does not identify a stranger or infer interests. Preferences remain conversation-confirmed. URLs with credentials, queries, fragments, private IPs or local hostnames are rejected.

Browser origins and Host headers are checked. LAN exposure additionally requires explicit device credentials and exact allowed origins/hosts. Browser camera/microphone on a tablet may require trusted HTTPS. Neither CORS nor possessing a device token substitutes for per-session authorization.

Trigger.dev, Ambiguous, cloud deployment, actual robot hardware, real customer enrollment, and the final kiosk UI remain separate gated work.
