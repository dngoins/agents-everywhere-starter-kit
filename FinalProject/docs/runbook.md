# MagicPitch local operator runbook

## Scope and readiness

This runbook covers Dwight's local orchestration service and **developer harness**. The baseline is an offline synthetic contract demonstration, not a finished customer kiosk or live team demo. Alex/Sam, the uploaded PNG, the concept product, and the color-bar MP4 are synthetic. Mock/fallback media must never be described as newly generated personalized advertising.

Real robot voice/capture, Tiya's customer UI and renderer, consented participant assets, tablet networking, and observed browser playback require their own integration acceptance. OpenAI/Exa/media HTTP settings, when available, are opt-in; code/configuration alone is not evidence of an external call passing. Trigger.dev, Ambiguous follow-ups, cloud deployment, and release publishing remain deferred. There is no calendar booking in the baseline.

Startup explicitly rejects unsupported job/follow-up settings. Only `JOB_PROVIDER=local` and `FOLLOWUP_PROVIDER=disabled` are accepted; selecting Trigger or an enabled follow-up provider does not activate a hidden adapter.

## Before starting

1. Work inside `FinalProject`. Preserve `OriginalRepo` and every teammate-owned directory.
2. Check `node --version` is `v24.11.0` and `npm --version` is `11.6.2`. Match the checked-in lockfile; do not delete it to bypass install failures.
3. Run `npm ci`, then `npm run verify`. No model/provider credentials are needed.
4. Ensure `fixtures/media/mock-preview.mp4` and `sample.png` are the synthetic fixtures documented in their README. Never replace them with a customer asset.
5. Keep `.env`, `.runtime`, local session data, and participant media out of source control, artifacts, screenshots, and issue logs.

To make local settings explicit, copy `.env.example` to `.env` with `Copy-Item .env.example .env` in PowerShell. Use `BRIEF_PROVIDER=mock`, `PROFILE_PROVIDER=mock`, `MEDIA_PROVIDER=mock`, `JOB_PROVIDER=local`, `FOLLOWUP_PROVIDER=disabled`, and `MOCK_ONLY=true`. Leave `ALLOW_DEMO_FALLBACKS=false` unless deliberately rehearsing a separately labeled recovery path.

## Launch and pair

1. Run `npm run dev`, or `npm run build` followed by `npm start` for compiled execution.
2. Confirm the startup event reports loopback `127.0.0.1` and the intended port (default `3101`). `GET /healthz` reports process health. `GET /readyz` reports selected modes, not external-provider success.
3. If no `DEMO_DEVICE_TOKEN` was configured, read `.runtime/device-token` locally. Startup logs only the pairing-file path, never the generated token. A startup-generated pairing token changes after a restart. File-mode restrictions alone are not a guarantee of Windows ACL privacy; keep the worktree under the operator's account and never share this file.
4. Open `http://127.0.0.1:3101/dev`. Paste the token into the password field. It is used once for session creation and not persisted by the harness.
5. Select Alex or Sam, confirm only synthetic preferences, and explicitly check both consent boxes. The harness records personalization/capture consent, with enrichment consent false.
6. Run the sequence. The service identifies the synthetic roster entry, accepts the synthetic PNG, records context, creates a deterministic brief, and queues mock media.
7. Press Play. Confirm the video is silent color bars. Only the browser's playback-ended event acknowledges the reveal. An API/CI acknowledgement is not audiovisual evidence.
8. Revoke the session. Its capability and assets stop working; the harness removes its Blob URL and credentials.

The default session lifetime is 90 seconds. Pair when ready to run. If it expires, pair again rather than replaying an old session. The state, revision, provenance, and sanitized transition log are visible in the harness. The harness refuses non-mock provider modes to avoid accidental paid calls.

## Pairing and access boundaries

- A device token creates sessions; a different, scoped session token authorizes that session's reads, commands, uploads, and media.
- No credentials belong in query strings. HTML video elements cannot add bearer headers: clients fetch authorized media bytes, create a Blob URL, and revoke it after use.
- Browser mutation requests must use a trusted exact origin. Configure `ALLOWED_ORIGINS` for the actual origin; never use wildcard CORS as a workaround.
- Node/device clients may omit `Origin`, but still require bearer authorization. CORS is not authentication.
- Refreshing the page discards the in-memory session credential and preview. It does not synchronously delete server assets; sessions expire, or an authorized client can explicitly revoke them.
- Restarting creates a new server instance and loses all in-memory sessions/jobs. Interrupted work is not durably resumed and must not be silently submitted again.

## Recovery

| Symptom | Safe action |
| --- | --- |
| Install/version mismatch | Use the exact Node/npm pair and run `npm ci`. Preserve the lockfile and working tree; do not run unpinned repair installs. |
| Compile or test failure | Run the reported command locally. Inspect the smallest relevant change. Do not claim readiness or reset unrelated work. |
| Port already in use | Stop the known API process with Ctrl+C in its terminal, or use an unused configured port. Do not terminate processes by name. Smoke uses port zero to avoid conflicts. |
| Pairing fails / `401` | Re-read the local token after restart; create a new session. Device credentials do not authorize session routes. |
| Origin/host rejected | Match the exact configured host and origin. Do not remove auth or allow arbitrary origins. |
| Consent denied | Check that permission was recorded for this session before identification/upload; do not bypass it or infer consent from detection. |
| Job or request timeout | Refresh status first. Preserve the original idempotency key when reconciling submission. Do not blindly retry a potentially paid render. |
| Job failed / cancelled / expired | Display the actual terminal state. For the synthetic harness, revoke and start a new session; do not relabel failure as generated success. |
| Ready but video does not play | Check authorized MIME/bytes/range behavior and browser decode support. Do not send a reveal acknowledgement until real playback occurs. |
| Media fixture missing | Restore only the documented synthetic fixture, verify its checksum and rebuild. Never rename arbitrary text to `.mp4`. |
| Server restarted | New server instance means old capabilities are invalid. Re-pair and deliberately restart the flow; no automatic job replay. |
| Optional provider unavailable | Return to the explicit offline profile for rehearsal. Any deliberately selected prerecorded fallback must remain visibly labeled. |
| `media_cleanup_pending` / cleanup receipt exists | Inspect `.runtime\media-cleanup` metadata locally. With the configured service credential, reconcile `DELETE {MEDIA_SERVICE_URL}/jobs/by-key/{jobId}` until the renderer confirms cancellation and asset deletion. Keep unresolved receipts; do not submit another render or claim remote deletion. |
| External call appears in offline checks | Treat `OUTBOUND_NETWORK_DENIED` as a failure. Fix provider selection or the test; do not remove the guard to make checks green. |
| Harness loses network | Use Refresh after connection recovers. Revoke/re-pair if state cannot be reconciled; the harness never automatically repeats a media submission. |
| Need a stable local build | Use a previously verified allowlisted archive and exact runtime. Do not present this as proof that current CI or live integration passed. |

Stop a foreground server with Ctrl+C. The smoke runner owns one child Node process, applies deadline/request timeouts, and signals only that process in `finally`; Windows uses Node's child-PID termination semantics. It never kills all Node processes.

## Offline checks and their limits

`npm run verify` runs typechecking, recursive Node/tsx tests, compilation, and compiled-process HTTP smoke. The smoke checks no-auth denial, untrusted origins, consent before capture, actual PNG upload, synthetic selection/context/brief, job idempotency, ready provenance, exact MP4/checksum, a byte range, simulated reveal, revocation, and child cleanup.

Smoke removes inherited provider credentials and explicitly selects mocks. The test runner and spawned smoke API preload `scripts/offline-network-guard.mjs`, which rejects nonnumeric-loopback fetch/HTTP(S) destinations and prevents automatic fetch redirects. It is an application regression guard, not an OS network isolation guarantee; native addons, direct socket APIs, or malicious test code are out of scope.

No FFmpeg installation is required to run these checks: the small fixture is already generated and independently decoded during development. CI does not decode frames, inspect visual quality, operate robot hardware, or observe a browser. An actual manual playback rehearsal is a separate gate.

## Package and restore

1. From the source checkout run `npm run verify`, then `npm run package:demo`.
2. Review `artifacts/magicpitch-demo.sha256` and inspect `tar -tzf artifacts\magicpitch-demo.tgz`. The script compares archive contents with its explicit file allowlist.
3. Extract to a new directory, then run `npm ci --omit=dev`, `npm run smoke`, and `npm start` there.
4. Keep only a known-good, verified archive for recovery. Use the unchanged package/lock pair. Runtime dependencies are restored, not copied across OSes.

The package includes compiled JavaScript/contracts, package/lock files, runtime pins, `.env.example`, the developer harness, the two synthetic fixtures and provenance README, contract/runbook documentation, and smoke/guard scripts. It never includes `.env`, `.runtime`, customer media, broad fixture directories, provider logs, caches, `node_modules`, or source tests. Packaging removes only its own known `artifacts/demo-package` staging directory.

GitHub Actions uses read-only permissions, no provider secrets, and Windows/Linux jobs. A successful Linux job uploads only the allowlisted archive/checksum with seven-day retention. No deployment, calendar action, or remote service mutation is performed. Observe a real workflow run before asserting that GitHub CI is green.

## Before any LAN or live-team rehearsal

- Damian supplies the versioned robot/voice/capture contract and controls physical safety. Dwight's harness does not move a robot or access a camera.
- Tiya supplies the real media submission/status contract, UI, licensed product/template assets, MP4, and reveal acknowledgement.
- Record actual participant permissions; obtain separate enrichment permission before any profile lookup. Unknown-person identification and unsolicited scraping are out of scope.
- Bind beyond loopback only deliberately, with a strong device token, explicit trusted hosts/origins, restricted firewall/network access, and working client authorization.
- Tablet/browser camera or microphone usually requires trusted HTTPS. Do not weaken browser security or publish tokens to bypass this.
- Observe a consenting live session through actual playback, disconnection recovery, cancellation, and cleanup. Measure latency rather than claiming the less-than-90-second goal from mock timing.
- Document any external provider's retention/deletion limitations. Local revocation cannot prove removal of external copies.
- The HTTP renderer must advertise cancellation/deletion capabilities and implement the idempotent cancellation-by-job-key endpoint described in `docs/contracts.md`. The adapter attempts cleanup even after an abort and retains failed-cleanup receipts across restarts.
- Public/cloud hosting requires real auth and durable private sessions/assets/jobs; the in-memory local queue is not horizontally scalable.
