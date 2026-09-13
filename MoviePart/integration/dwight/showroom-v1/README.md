# Showroom foundation contract

The browser-safe executable source is `src/contracts/showroom.ts` (re-exporting
`showroom-common.ts` and `studio.ts`) and `src/contracts/bridge.ts`. Both apps
import these source-local modules; portable consumers use generated
`interfaces/showroom-v1/types.d.ts`. Do not copy validators or import provider,
orchestrator, Node, or BLE modules into the browser. No new root workspace is
required. The separate voice/bridge runtime package is not part of this boundary.
Install FinalProject dependencies alongside MoviePart so its source-local Zod
imports resolve. Portable declarations contain no runtime validators; JSON Schema
cannot express all cross-field refinements and is not an authorization substitute.

These are implemented validators and **specified routes, not runtime handlers**.
Existing dedicated-media v1 contracts, routes and generated handoff remain
unchanged. The studio mode uses the complete MoviePart creator pipeline, not the
one-image renderer protocol.

## Public and operator routes

All paths below are relative to one fixed same-origin gateway on an iPad.
The gateway must not expose operator endpoints. Never embed loopback hosts,
provider keys, long-lived device credentials, or bearer tokens in URLs.

| Method/path | Auth | Input / output schema |
|---|---|---|
| POST `/v1/operator/kiosk-pairings` | operator device bearer | `KioskPairingInput` / `KioskPairing` |
| POST `/v1/kiosk/pair` | one-time expiring code | `KioskPairExchange` / `ShowroomSessionCreated` |
| GET `/v1/sessions/{id}/showroom` | session bearer | `ShowroomSnapshot` |
| POST `/v1/sessions/{id}/showroom/actions` | session bearer | `ShowroomAction` / `ShowroomSnapshot` |
| GET `/v1/sessions/{id}/showroom/catalog` | session bearer | `ShowroomCatalog` |
| POST `/v1/sessions/{id}/showroom/voice` | session bearer | `ShowroomVoiceSetupInput` / `ShowroomVoiceSetup` |
| DELETE `/v1/sessions/{id}/showroom/voice` | session bearer | 204 after voice termination |
| POST `/v1/sessions/{id}/showroom/references?expectedRevision=N&eventId=UUID` | session bearer | raw PNG/JPEG bytes / `ShowroomReferenceUploaded` |
| DELETE `/v1/sessions/{id}/showroom/references/{assetId}?expectedRevision=N&eventId=UUID` | session bearer | `ShowroomSnapshot` |
| GET `/v1/sessions/{id}/assets/{assetId}` | session bearer | bytes; existing single Range support |
| DELETE `/v1/sessions/{id}` | session bearer | 204 after revocation |
| POST `/v1/operator/bridges` | operator device bearer | `BridgeRegistrationInput` / `BridgePairing` |
| POST `/v1/bridges/{bridgeId}/pair` | one-time expiring code | `BridgePairInput` / `BridgeCredential` |
| POST `/v1/operator/bridges/{bridgeId}/operator-pairing` | operator device bearer | empty body / `OperatorPairing` |
| POST `/v1/bridges/{bridgeId}/operator-pair` | distinct one-time operator code | `OperatorPairInput` / `OperatorCredential` |
| POST `/v1/operator/bridges/{bridgeId}/lease` | operator device bearer | `BridgeLeaseInput` / `BridgeLease` |
| GET `/v1/bridges/{bridgeId}/commands?afterSequence=N` | bridge bearer | `BridgeCommandBatch` |
| POST `/v1/bridges/{bridgeId}/acknowledgements` | bridge bearer | `BridgeAcknowledgement` / 204 |
| POST `/v1/bridges/{bridgeId}/heartbeats` | bridge bearer | `BridgeHeartbeat` / 204 |
| WS `/v1/bridges/{bridgeId}/connect` | first one-time authenticate message | `BridgeClientMessage` / `BridgeServerMessage` |

Schema names in this document omit the `Schema` suffix. Route errors use existing
`ApiErrorResponseSchema`: malformed input 400, unauthorized 401, scope/consent 403,
stale revision or changed idempotency payload 409, expired session 410, explicitly
disabled capability 503. Voice setup retains RobotPart's existing OpenAI Live SDP
exchange: input `{sdp,generation?}`, output `{sessionId,generation,session:{id},
transport:{type:"webrtc",sdp}}`. This is not a new client-secret credential flow.
SDP is bounded to 128 KiB UTF-8 and never logged. Generation rejects late replies
after reconnect/termination; the runtime retains existing voice/sound/settings.
Pairing codes must expire, be rate-limited and consumed atomically once. Browser
capabilities stay in memory and must not be logged or put into model prompts.

## Guided intake and approval

Every action has `{schemaVersion:1,eventId,expectedRevision,type,payload}`.
`eventId` deduplicates an exact retry; it is **not** concurrency control.
Check the original accepted payload before revision checks for an exact retry,
but return 409 for a changed payload or stale new mutation. Use
`assertExpectedRevision` for the latter.

`answer_proposed` accepts `ShowroomAnswer` (`field` = visitor, context, selection).
The visitor name is self-reported and session-local, never biometric roster
inference. Approved context has at most three explicitly approved signals.
`consent_recorded` stages a `consent` pending readback for new grants; it does not
grant consent by itself. Withdrawal must stop/clear affected work immediately,
without asking for approval to withdraw. `studio_requested` carries `{}` and
stages a server-assembled `StudioInput`, not client-supplied provider arguments.
`calendar_draft_proposed` accepts `{startTime,customerEmail}`; the server adds
configured staff, location and selected catalog product via the calendar owner.
`motion_requested` stages a bounded `MotionApproval`. None executes a side effect
until `action_confirmed` approves the exact current pending action.

`PendingAction` contains `{pendingActionId,expectedRevision,inputRevision,
confirmationFingerprint,readback,expiresAt,kind,payload}`. Its expected revision
is the session revision **after** publishing the pending readback.
`action_confirmed` payload is `{pendingActionId,confirmationFingerprint,
decision:"approve"|"reject",channel:"voice"|"touch"}`. The channel is provenance,
not proof that an approval was heard. The runtime must only submit confirmation
from an explicit visitor decision, not a model inference. Bind the SHA-256
fingerprint to canonical JSON of session ID, pending ID, kind, complete payload,
input revision, readback, and expiry. Compute and store it server-side; never
trust a client-computed fingerprint as authorization. Compare via
`assertPendingConfirmation` before side effects. Consume approvals atomically;
replayed approval IDs cannot produce another movie, invitation, or movement.

Changes to approved inputs invalidate pending approvals and previously accepted
inputs. Refresh consent/capture revision stamps only when the underlying consent
scope and owned capture set still cover the newly read-back input; otherwise
obtain consent/capture again. A generation job uses its deeply frozen
`AcceptedStudioSnapshot`, never the mutable current session fields.
`parseAcceptedStudioSnapshot` checks the current session/revision/consent and
server-supplied owned asset/catalog membership. The server additionally checks
current catalog/provider readiness and allowed combinations before accepting.

## Capture, playback and calendar

After informed capture and provider-transfer consent, collect one to four quiet
photos without per-photo confirmation. `CaptureSet` records owned asset IDs and
views (`front_face`, `half_body`, `profile`, `three_quarter`), with a primary ID
in the set. Upload authorization and ownership remain server checks.
`capture_set_recorded` attaches this set. Likeness mode requires the set and
likeness permission; POV/personalized adapters must not transfer photos.
The dedicated reference upload query requires a decimal safe-integer revision
and UUID event ID (`ShowroomReferenceUploadQuery` after HTTP query parsing).
Each <=5 MiB upload returns `{assetId,snapshot}`; preserve the same event ID and
bytes for a lost-response retry. Hash/dimensions/mime/ownership remain private
server metadata. Uploads are serialized, advance revision/inputRevision, and are
locked while an accepted job is active. The existing legacy `/assets` POST stays
unchanged for dedicated-media callers, not used by the showroom capture flow.
Deleting an unused reference for a retake requires the same query envelope and
returns the updated snapshot; references used by an accepted job are locked.

`playback_started` and `playback_ended` carry `{jobId,assetId,playbackId}` and refer
to actual media element playback/end, not readiness polling or button presses.
Check the currently accepted ready job/owned asset; a stale callback cannot
advance a newer job. `CalendarDraft` wraps `{draftId,inputRevision,appointment}`.
The immutable `appointment` includes all attendees, subject, location and product
and exactly 60 elapsed minutes with an IANA time zone. Full attendee/time details
must be in the readback. The calendar service's confirmation ID is the pending
action ID. Reject non-60-minute calendar configuration for showroom use.
`uncertain` means reconcile the saved receipt; never retry with a new ID.
Ready studio results include required `checksum` (lowercase SHA-256) and
`byteLength` for authorized playback integrity. `ShowroomSnapshot.mode` and
`ShowroomCatalog.mode` explicitly distinguish `studio` from operator-selected
`fixture` mode. Fixture execution uses a registered local fixture and reports
`provenance:"mock_fixture"`, never a generated claim or a studio failure fallback.
Accepted input remains `mode:"studio"` as the approved creator-pipeline intent;
execution mode is server-configured, not chosen by client/model input.

## Windows bridge safety

The operator issues pairing codes and leases; bridge credentials only consume
commands and report acknowledgements/heartbeats. Session credentials only request
authorized intents, not arbitrary BLE writes or lease changes. A bridge is
paired to one short-lived session lease generation; ordered command IDs,
sequence numbers and expiries prevent delayed/replayed movement after reconnect.
Use `BRIDGE_LIMITS`: low-speed pulses <=500 ms, <=4 pulses and <=2000 ms cumulative
per framing action, >=1000 ms cooldown, command TTL <=2000 ms, lease <=30000 ms.
Neither lease renewal nor reconnect resets a framing action's cumulative budget.

Commands include normalized single-person framing data, never photos/audio.
The readback binds stable `MotionApproval` intent, goal, low speed, pulse length,
lease ID and generation, not a perishable tracking sample. Approval publishes a
short-lived `motionGrant` in the snapshot with grant ID, session/input revision,
expiry and cumulative limits. `motion_execution_requested` submits
`{grantId,tracking}` using a newly captured sample. The server verifies current
grant/consent/lease/budget, combines its stored intent with the fresh sample into
`MotionIntent`, then calls the bridge broker. Exact action retries must not
dispatch twice. Stop, changed inputs and lease loss revoke the grant.
`BridgeStatus.leaseId` and `leaseExpiresAt` expose safe identity/expiry only, not
operator authority. Never extend tracking freshness to cover a spoken readback.
Motion needs current consent, operator arming, explicit rear clearance, a fresh
foreground connected bridge heartbeat, and tracking age <=1000 ms at execution.
The bridge rechecks generation, sequence, TTL, tracking and local budgets before
writing, with a local <=1000 ms watchdog and independently scheduled Stop.
Acknowledgements use `write_completed`/`stop_written`/`rejected` with
`physicalExecution:"unverified"`; a BLE write is not evidence of physical motion.

`stop_requested` is immediate and never pending. After authentication, Stop must
not be blocked by stale revisions, lease expiry, command ordering, or exhausted
movement budgets. Local Stop remains available without the server. A stop
preempts queued movement and disconnect/hidden-page/lease loss also stop locally.
All physical movement and live providers remain disabled in automated tests.
Local setup can issue a distinct one-time operator code to the Windows browser,
redeemed into an in-memory short-lived `OperatorCredential` with
`purpose:"bridge:lease"`, bound to one bridge. It cannot register/pair other
bridges or access customer sessions. A bridge connection token cannot be used as
an operator token. WS `state` includes bridgeId/generation/lastSequence even when
lease is null, so an operator can explicitly arm against the current generation.

## Extension boundaries

Studio designer decisions/retry/cancellation and Calendar OAuth/provider receipt
types stay with their existing owners. Add explicit versioned schemas if a new
public action is needed; do not add arbitrary JSON fields or speculative enums.
The transport schema alone cannot verify authority, timestamps against now,
real catalog readiness, spoken intent, physical clearance, or provider success.
