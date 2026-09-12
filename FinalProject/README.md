# MagicPitch orchestration API

Local-first, consent-gated TypeScript/Hono service for Dwight's orchestration and DevOps workstream. `OriginalRepo` is reference-only; `RobotPart`, `MoviePart`, and the other team directories remain separately owned.

## What this demonstrates

- Authenticated session creation and scoped session/media access.
- Explicit consent before identification or image upload, synthetic roster selection, conversation context, and a structured ad brief.
- Bounded asynchronous media jobs, idempotent submission, revisioned polling, cancellation/revocation, and authorized MP4 byte ranges.
- A **developer harness**, not Tiya's customer UI, at <http://127.0.0.1:3101/dev>.
- An offline mock sequence using a synthetic PNG and a real, silent, one-second color-bar MP4. **This is not a generated personalized advertisement.**

This is not evidence of a working robot, consented live participant demo, Tiya media/UI integration, audiovisual browser acceptance, cloud deployment, or a measured sub-90-second live encounter. Optional real-provider configuration does not establish account access or successful external integration. Trigger.dev, Ambiguous scheduling, deployment automation, and a combined team launcher remain deferred.

Trigger and follow-up execution are explicitly unsupported settings: startup accepts only `JOB_PROVIDER=local` and `FOLLOWUP_PROVIDER=disabled`. Selecting Trigger or an enabled follow-up provider fails validation; no live implementation is implied.

Local Windows validation completed the typecheck/test/build/smoke chain and an extracted archive's runtime-only restore/smoke. The harness flow was also exercised through a simulated DOM against the compiled API, not a real browser. GitHub-hosted workflow runs, Linux execution, and manual audiovisual playback remain separate acceptance checks.

## Start locally

Use **Node 24.11.0 and npm 11.6.2**. Run every command below from `FinalProject`, not the repository root or `OriginalRepo`.

This is the explicitly selected FinalProject demo runtime, not the inherited starter's Node pin. It matches the service's package engines, lockfile workflow, and CI configuration.

```powershell
Set-Location FinalProject
npm ci
npm run verify
npm run dev
```

The defaults bind to `127.0.0.1:3101` and select mock providers; no provider key is needed. For optional overrides, copy `.env.example` to `.env` and keep it private. Do not copy credentials from another checkout. `npm run dev` loads this file when present.

When `DEMO_DEVICE_TOKEN` is empty, startup writes a generated token to `.runtime/device-token`. Only the pairing-file path is logged, not the token. In a separate **local** terminal:

```powershell
Get-Content .runtime\device-token | Set-Clipboard
```

Open `/dev`, paste the token into its password field, and create a session. Select a synthetic roster entry, review and check both consent boxes, then run the flow. Press Play when the color-bar preview appears. The harness acknowledges reveal after the video ends, not merely when a job says `ready`. Revoke the session when finished.

Do not paste pairing tokens into logs, screenshots, issues, URLs, or chat. The harness clears the device-token field and keeps only the session capability in memory. Reloading loses that credential; restart/expiry also requires a new session. The harness refuses live provider modes so its synthetic flow cannot accidentally invoke a paid provider.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run TypeScript API locally, with optional `.env`. |
| `npm run typecheck` | Check strict TypeScript contracts and implementation. |
| `npm test` | Recursively discover `test/**/*.test.ts`; run Node/tsx tests with explicit file arguments and an offline network guard. |
| `npm test -- test/core.test.ts --test-name-pattern "consent"` | Select a file and Node test-name filter; paths and options work on Windows and Linux. |
| `npm run build` | Emit the runnable service to `dist`. |
| `npm start` | Run the compiled service, with optional `.env`; build first. |
| `npm run smoke` | Start an owned compiled process on a free loopback port, verify the synthetic HTTP flow, and stop it. |
| `npm run verify` | Typecheck → tests → interface drift check → build → smoke. |
| `npm run package:demo` | Package an already-built allowlisted release into `artifacts/magicpitch-demo.tgz`. Requires OS `tar`. |
| `npm run interfaces:export` | Regenerate dependency-free types, JSON schemas, OpenAPI and examples from the executable contracts. |
| `npm run interfaces:check` | Reject stale generated handoff files and invalid local schema references. |
| `npm run interfaces:package` | Produce `artifacts/magicpitch-interfaces-v1.tgz` for Damian and Tiya. |

Smoke explicitly clears inherited provider credentials, selects mock/disabled/local modes, and preloads a built-in-only guard rejecting nonnumeric-loopback application connections through fetch and HTTP(S). This is a regression guard, not an OS firewall or a security sandbox. CI smoke simulates a reveal acknowledgement **after** verifying real fixture bytes; it does not observe video playback.

The root GitHub Actions workflow checks Windows and Linux with the same pinned toolchain and commands, without provider secrets. Linux additionally packages a short-retention allowlisted artifact. Workflow execution on GitHub must be observed separately; merely adding the workflow is not a green CI result.

## Packaged release

```powershell
npm run build
npm run package:demo
New-Item -ItemType Directory -Path artifacts\extracted-demo
tar -xzf artifacts\magicpitch-demo.tgz -C artifacts\extracted-demo
Set-Location artifacts\extracted-demo
npm ci --omit=dev
npm run smoke
npm start
```

Use a new extraction directory for each release. The archive includes the lockfile, compiled API/contracts, harness, synthetic fixtures, configuration examples, runbook, contract documentation, and built-in-only smoke scripts. It excludes `.env`, `.runtime`, session data, provider logs, customer media, `node_modules`, and development source/tests. Development scripts in the unchanged manifest require a source checkout and are not usable from this runtime-only archive.

## Integration and operations

- [Teammate interface bundle](interfaces/v1/README.md): self-contained handoff; [Damian](interfaces/v1/DAMIAN.md) and [Tiya](interfaces/v1/TIYA.md) have separate integration guides.
- [HTTP contracts](docs/contracts.md): versioned events, commands, result provenance, and client integration.
- [Runbook](docs/runbook.md): pairing, local recovery, packaging, retention, and live-integration gates.
- [Fixture provenance](fixtures/media/README.md): generation method and checksums.
- [Approved plan](PLAN.md): scope, ownership, phased dependencies, and deferred work.

In-memory sessions/jobs are deliberately single-process and non-durable. Never expose this local demo publicly or mistake a host binding change for production readiness.