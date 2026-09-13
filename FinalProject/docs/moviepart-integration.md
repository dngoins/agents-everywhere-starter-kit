# MoviePart integration

The attached `movie-magic-integration.zip` originally contained the creator-studio
`contracts.ts`, `client.ts`, and README only. Those `/api/movie-*` endpoints are
not Dwight's media-service protocol. The integrated kiosk uses
`MoviePart/integration/orchestrator-client.ts`; Dwight calls the dedicated
`MoviePart/src/media-service` API instead.

## Three components, two operating modes

| Component | Default address | Responsibility |
|---|---|---|
| FinalProject API | `http://127.0.0.1:3101` | Consent, session/identity/context, AdBrief, job, authorized result |
| Tiya kiosk | `http://127.0.0.1:3200/kiosk` | Pairing, permission controls, reference upload, progress and playback |
| Tiya media service | `http://127.0.0.1:3201` | Server-only rendering, cancellation, asset deletion |

**Offline kiosk mode** starts the real kiosk and orchestrator with explicitly
synthetic media. It does not start the studio worker or a fake live renderer.
The kiosk must show `mock_fixture` as a synthetic sample, not as the customer.

**Live media mode** additionally starts Tiya's real renderer, requires its private
OpenAI configuration and FFmpeg readiness, and disables synthetic fallback.
The reasoning brief remains deterministic and the product remains the synthetic
`demo-car-v1` concept. This launcher does not enable the creator studio's real
vehicle catalog or calendar actions.

## Install and start

From the repository root, using the FinalProject-pinned Node/npm versions:

```powershell
npm --prefix FinalProject ci
npm --prefix MoviePart ci
npm --prefix FinalProject run build
npm --prefix FinalProject run dev:kiosk
```

Dependencies belong to each part's own lockfile. No source imports between the
two running services are required. The launcher starts ordinary Node children
without installing anything or altering `.env` files.

If a teammate already owns port 3200:

```powershell
npm --prefix FinalProject run dev:kiosk -- --ui-port 3202
```

It configures the actual UI origin on the orchestrator automatically. Ports can
also be selected using `--api-port` and `--media-port`; set the kiosk's trusted
API origin to the selected API address. Occupied ports produce an error; existing
processes are not killed or reused.

The launcher generates a local pairing credential in
`FinalProject\.runtime\device-token`, never in logs or URLs. Copy it from your
own terminal:

```powershell
Get-Content .\FinalProject\.runtime\device-token | Set-Clipboard
```

In the kiosk, expand **Operator pairing**, confirm the trusted API address, and
select **Create a separate session** for the standalone demonstration. Paste the
device token. With a real robot, join its existing session through the trusted
bridge instead; creating a separate session does not attach the robot.

Save explicit personalization/capture permissions, choose a synthetic roster
entry, and confirm a preference. Create the brief, then upload the provided
`FinalProject\fixtures\media\sample.png` for an offline demonstration. Review the
brief, start media once, load and play the returned MP4 and end the session.

The kiosk now leads with the robot's smiling face. After pairing, **Let's begin**
speaks a permission invitation using an available local browser voice, then opens
the permission controls. **Continue without voice** is equally available; all
permissions remain unchecked until the participant selects and saves them.
**Hear this message** enables subsequent stage narration, while **Stop voice /
Mute voice** disables it. No microphone or paid voice API is used.

Mouth movement follows speech start/end, not a fake always-talking loop. Hidden
tabs, offscreen presentation, cancellation and video handoff stop narration.
Reduced motion and the face-motion pause control suppress the animated loops.
If the browser has no device-local English voice, captions and manual controls
continue to work. This narration is separate from Damian's future live audio
handoff; it does not make the robot-to-session integration complete.

The tablet owns `media_revealed` and acknowledges actual playback. Downloaded
media is authorized using the session capability and verified against its
checksum before a Blob URL is played.

Ctrl+C stops only the processes started by the launcher. Windows process-tree
termination may interrupt remote cleanup; inspect pending cleanup receipts before
another live render. The default 90-second session expiry remains enforced.

## Live media configuration

Configure `OPENAI_API_KEY` (and the image model available to the account, when
needed) privately in `MoviePart\.env`, then run:

```powershell
npm --prefix FinalProject run dev:kiosk -- --live-media
```

The launcher generates a separate server-to-server credential, passes it only to
the API and media service, and keeps a recovery copy at
`FinalProject\.runtime\media-service-token`. The UI never receives that token or a
provider key. The launcher keeps provider keys empty in the Next creator-studio
process even when media rendering is enabled.

Before starting the API, it requires authenticated media `/capabilities` readiness.
A missing key, renderer, or supported capability stops startup. No participant
image is submitted by readiness probes.

Media submissions use the globally unique job ID for the upstream idempotency
key. The adapter downloads the completed MP4 into its authorized local session,
then asks the renderer to cancel/delete its input/output artifacts. Cancellation
also uses this cleanup path. Unconfirmed deletion leaves metadata under
`FinalProject\.runtime\media-cleanup`; preserve and reconcile it using the private
service credential. Vendor retention/charges cannot be undone by local deletion.

Only consenting participant data may be used for a live call. Neither successful
offline integration nor a ready service is evidence of a successful live image
generation.

## Integration checks

```powershell
npm --prefix FinalProject run verify
npm --prefix FinalProject run test:moviepart
```

`test:moviepart` requires both packages installed. It uses the **actual**
MoviePart HTTP server, its durable media lifecycle and MP4 validation, Tiya's
OrchestratorClient, and Dwight's HTTP API on temporary loopback ports.

The success-path executor is explicitly injected only inside the test and copies
Tiya's labeled six-second synthetic sample. No fake-success mode is added to the
production media service. The tests cover pairing/CORS, consent, upload, immutable
briefs, idempotent media, actual MP4/checksum retrieval, renderer artifact deletion,
reveal acknowledgement, session revocation, active-render cancellation, and
missing-provider failure before photo transfer.

These are HTTP and media-container checks, not proof of camera/robot movement,
actual browser playback, or live OpenAI personalization. The creator-studio
`/api/movie-*` client from the ZIP remains a separate API and is not substituted
for this protocol.
