# Tiya - UI and media integration

You have two distinct interfaces: **the kiosk UI calls Dwight's orchestrator**, and **Dwight calls your media-rendering service**. Do not mix their URLs or credentials.

## A. Kiosk / tablet client

Use `orchestrator.openapi.json`, `types.d.ts` and `examples.json`.

Default local API: `http://127.0.0.1:3101`. A separate tablet needs the API laptop's authenticated LAN address; coordinate exact origins, pairing and HTTPS with Dwight. Browser camera/microphone may require trusted HTTPS.

Pair using `POST /v1/sessions` with the device token, or receive the current session from Damian through the trusted bridge. All session routes require the returned session capability. The robot and UI must use the same session.

| UI responsibility | API |
|---|---|
| Show explicit consent controls | `POST /v1/sessions/{id}/events`, type `consent_recorded` |
| Display selected customer and confirmed preferences | Snapshot fields `customer` / `context` |
| Capture/upload only with permission | `POST .../assets`, raw PNG/JPEG |
| Create/inspect brief | `POST .../commands/create_ad_brief`, response `AdBrief.id` |
| Start once / retry safely | `POST .../commands/start_media_job`, stable idempotency key |
| Show truthful progress | `GET .../jobs/{jobId}` or revisioned snapshot |
| Download authorized result | `GET .../assets/{result.assetId}` |
| Confirm actual playback | `POST .../events`, type `media_revealed`, payload `{jobId}` |
| Cancel / revoke | `DELETE /v1/sessions/{id}` |

Never expose a provider key or service token to the browser. An HTML `<video src>` cannot add a bearer header. Fetch the asset with session authorization, create a Blob URL, play it, then revoke the Blob URL when it is no longer needed. The development harness demonstrates this but is not a required UI design.

Ready result provenance must be visible: `mock_fixture` is a synthetic sample, `prerendered_fallback` is prerecorded, and `generated` is real-adapter output. Do not acknowledge reveal before playback or claim the color-bar fixture contains the customer.

Poll/reconnect from `revision`; replace state when `resetRequired` is true. Handle terminal failures, expiry and cancellation instead of leaving a spinner. A restart discards sessions.

## B. Your asynchronous media service

Use the separate `media-service.openapi.json`.

Dwight configures `MEDIA_SERVICE_URL` and server-only `MEDIA_SERVICE_TOKEN`. That URL must be reachable from Dwight's API process. This handoff contains the contract, not a renderer or deployment.

Before sending participant data, Dwight calls authenticated `GET {mediaBase}/capabilities`. Return `{"schemaVersion":1,"cancelByKey":true,"deleteAssets":true}` only if the cleanup behavior below is implemented. An incompatible renderer is rejected before photo transfer.

### 1. Accept a job before rendering

`POST {mediaBase}/jobs` receives `Authorization: Bearer <media service token>` and `Idempotency-Key: <key>`.

Body type: **`MediaSubmitRequest`**:

```text
schemaVersion: 1
jobId: Dwight's UUID
idempotencyKey: the same globally unique MagicPitch jobId, matching the header
brief: complete AdBrief
image:
  mimeType: image/png or image/jpeg
  base64: consented image bytes
```

`examples.json.mediaSubmission` contains a complete valid synthetic example.

Return **`MediaAcceptance`** promptly:

```json
{"providerJobId":"render-123"}
```

Deduplicate by idempotency key and payload. Dwight replaces the session-local client key with the globally unique job ID before contacting your service. This prevents two customers who both use `render-1` from receiving each other's media. Same command must refer to the same render, not charge for a second generation. Reject reuse with changed payload. Persist the association between your ID, Dwight's job ID and the key so uncertain acknowledgements can be reconciled.

### 2. Expose progress

`GET {mediaBase}/jobs/{providerJobId}` uses the same service auth and returns **`MediaServiceStatus`**:

```json
{"status":"running","stage":"rendering"}
```

States: `queued`, `running`, `ready`, `failed`. Progress stages: `accepted`, `preparing`, `generating`, `rendering`, `encoding`, `finalizing`.

Do not return ready until a valid downloadable MP4 exists. Do not send raw provider logs/credentials as errors; `{"status":"failed"}` is sufficient for this protocol.

### 3. Return the MP4

```json
{
  "status": "ready",
  "result": {
    "assetPath": "assets/render-123.mp4",
    "mimeType": "video/mp4",
    "durationSeconds": 12
  }
}
```

`assetPath` is a relative path matching `assets/<letters-digits-underscore-hyphen>.mp4`. Dwight downloads it from the same configured media base with the service token. Arbitrary absolute URLs and redirects are not accepted. Return `Content-Type: video/mp4`; respect the configured size limit.

The AdBrief has scene descriptions, on-screen copy, confirmed preferences, a template ID, total duration and CTA. Scene durations must sum to the total. The current `demo-car-v1` is a synthetic concept contract; agree real product assets/template capabilities before rendering a real customer ad.

### 4. Cancel and remove renderer-held assets

Implement authenticated, idempotent `DELETE {mediaBase}/jobs/by-key/{jobId}`. Stop the render, remove its uploaded image/result assets, and tombstone the key so that a delayed in-flight POST cannot start that cancelled job afterward. This must also work before a provider job ID is known.

Return `{"status":"cancelled","assetsDeleted":true}` only after your service has completed that cleanup. Do not acknowledge success if work/assets remain.

Dwight calls this endpoint on local cancellation/expiry/failure and after successfully downloading a completed MP4 into the session's authorized local asset store. Cleanup uses a separate bounded signal, not the already-aborted render signal. On failure, Dwight retains a private recovery receipt with job IDs/service base only and refuses to report successful media completion.

The receipt and your idempotency records must support manual reconciliation after a process restart. This contract covers renderer-held work/assets; disclose and separately handle any image-model vendor's retention or cancellation limitations.

## What to deliver back to Dwight

Provide the reachable media base URL, a privately transferred service credential, the actual start/build commands, supported template/assets, a sample valid MP4, and request/status fixture examples matching this bundle. Do not send keys or participant photos through source control.

For the UI, provide its origin/start command and confirm whether the tablet captures media or only displays it. Agree with Damian which device sends `media_revealed`.

Your code remains in your owned part/UI location. No changes to `OriginalRepo`, the orchestrator, or robot movement are required to implement these interfaces.
