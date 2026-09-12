# Damian - robot / voice integration

You own movement, camera, microphone, speaker, presence detection and conversation. Dwight owns the state machine, provider access and media job. Tiya owns rendering and visual reveal. Do not duplicate the orchestrator in the robot process.

## Your inputs and outputs

| You send to Dwight | You receive / consume |
|---|---|
| Customer presence, explicit consent, enrolled/manual/QR demo identity | Opaque session ID and capability, resolved customer |
| Confirmed preferences and optional supplied public-profile URL | Context and validated AdBrief |
| Consented PNG/JPEG bytes | Image asset ID |
| Idempotent start command | Job ID and asynchronous progress |
| Cancellation / consent withdrawal | Terminal status and invalidated private media |
| Actual robot playback acknowledgement, if the robot plays the MP4 | Shared `revealed` state |

## Connection and authentication

Default base: `http://127.0.0.1:3101`. On a separate robot device, `127.0.0.1` is the robot itself: use the API laptop's configured, authenticated LAN address instead. Coordinate allowed hosts/origins and secure transport with Dwight.

1. Pair the device: `POST /v1/sessions` with `Authorization: Bearer <device token>`.
2. Save the returned `sessionId` and `sessionToken` only for the current interaction.
3. For every session route, send `Authorization: Bearer <sessionToken>`, not the device token.
4. Share that session with the paired Tiya UI through the trusted bridge. Do not independently create a second session for the same interaction or place credentials in a URL.

## Minimal interaction sequence

All command/event requests use `Content-Type: application/json`. See `examples.json` for schema-validated payloads.

| Step | Endpoint suffix after `/v1/sessions/{id}` | Body |
|---|---|---|
| Presence | `POST /events` | `{schemaVersion:1,eventId:"<uuid>",type:"customer_detected",payload:{}}` |
| Consent | `POST /events` | `{schemaVersion:1,eventId:"<uuid>",type:"consent_recorded",payload:{personalization:true,capture:true,enrichment:false}}` |
| Identity | `POST /commands/identify_customer` | `{customerId:"demo-alex",method:"manual"}` |
| Preferences | `POST /events` | `{schemaVersion:1,eventId:"<uuid>",type:"context_updated",payload:{preferences:["Beach road trips"]}}` |
| Photo | `POST /assets` | Raw PNG/JPEG bytes with matching MIME instead of JSON |
| Brief | `POST /commands/create_ad_brief` | `{productId:"demo-car"}` |
| Start | `POST /commands/start_media_job` | `{briefId:"<returned brief.id>",idempotencyKey:"<stable key>"}` |
| Progress | `GET /jobs/{jobId}` or `GET ?afterRevision=N` | No request body |

The identity methods are `manual`, `qr`, and `enrolled`. They accept only the registered synthetic roster currently; they do not cause face recognition or enroll a real person. Do not submit an arbitrary detected name as if it were a registered identity.

Do not block conversation while rendering. A start acknowledgement is a job object, not a finished video. One media job runs at a time, with a bounded waiting queue.

## Voice-tool mapping

Use the six command definitions from `orchestrator.openapi.json` and the matching input types/schemas:

`identify_customer`, `enrich_profile`, `create_ad_brief`, `start_media_job`, `get_media_status`, `schedule_followup`.

`schedule_followup` currently returns 503 disabled. Do not announce a booking. Optional Exa enrichment requires separate enrichment consent and a supplied public HTTPS profile URL; the server does not search for unknown people.

Voice approval is not permission to invent new consent scopes. Capture/transfer the image only after the appropriate recorded grant.

## Completion and recovery

A ready job has `result.assetId`, MIME, length, checksum, duration and provenance. Fetch `/assets/{assetId}` with session auth, or let Tiya's already-paired UI fetch it. Announce whether the result is a synthetic preview, prerecorded fallback, or generated media.

Whichever device actually plays the result sends:

```json
{
  "schemaVersion": 1,
  "eventId": "<new uuid>",
  "type": "media_revealed",
  "payload": {"jobId": "<job uuid>"}
}
```

Coordinate one playback owner; do not acknowledge merely because bytes exist.

Reconnect by requesting a snapshot; discard old state when `resetRequired` is true. Duplicate an event only with the same event ID and same payload. Reuse the same idempotency key after losing a start response.

On 401, re-pair as appropriate; on 409, refresh state; on 410, begin a new consented session; on 429, wait for capacity. A failed/expired job is not successful rendering. An uncertain media submission requires provider-side reconciliation before another render.

`DELETE /v1/sessions/{id}` or `session_cancelled` stops/suppresses local work and causes the HTTP adapter to request renderer cancellation/deletion separately. Failed remote cleanup is recorded for operator reconciliation; local cancellation is not proof of vendor-side deletion. Hardware disconnect does not authorize autonomous movement; keep robot safety and movement fallback in your own implementation.
