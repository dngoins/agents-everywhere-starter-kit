# MagicPitch - Dwight Agent Orchestrator + DevOps Plan

Approved direction: standalone TypeScript API in `FinalProject`, with separate teammate-owned clients. Preserve `OriginalRepo`. The full planning discussion is retained in the Copilot session; this repository copy records the approved architecture and implementation gates.

## 1. Current Repository Assessment

The inherited starter is under `OriginalRepo`. It supplies Next/CopilotKit, a shared agent, Exa and Ambiguous reference integrations, a voice example, and Node/TypeScript tests. It did not supply a MagicPitch orchestrator, robot implementation, media service, kiosk UI, or CI pipeline. Team-part directories contained placeholders.

`FinalProject` now contains the independently runnable API, executable schemas, offline providers, job runner, synthetic media, development harness, tests and tooling. It does not import or alter the inherited starter.

Tiya's committed MoviePart kiosk and dedicated media service are now integrated
through `dev:kiosk` and cross-part HTTP tests. The older attached ZIP contains a
different creator-studio client, not the renderer. See
[MoviePart integration](docs/moviepart-integration.md) for exact startup, modes
and remaining live-provider/robot gates.

## 2. Dwight Scope

Dwight owns orchestration, contracts, typed configuration, provider boundaries, API integration, local job state, developer smoke/recovery, and CI/build/package automation. Damian owns robot/voice/capture. Tiya owns customer UI, image generation, FFmpeg/video, and reveal. Edilma owns scope, permissions, acceptance coordination and submission.

## 3. Proposed Architecture

Single long-running Node/Hono API -> consent/session state -> profile/brief providers -> bounded local media runner -> authorized MP4 result -> UI/robot playback acknowledgement. The development harness is not Tiya's kiosk design. P0 is local, in-memory, one process.

The selected reproducible runtime is Node 24.11.0 with npm 11.6.2, matching the inspected demo host and exceeding the starter's Node >=22 requirement. This makes the preliminary Node 22 proposal concrete without requiring a second runtime on the demo machine.

## 4. API and Event Contracts

See [contracts](docs/contracts.md) and `src\contracts\index.ts`.

Capabilities: `identify_customer`, `enrich_profile`, `create_ad_brief`, `start_media_job`, `get_media_status`, and an explicitly disabled `schedule_followup`.

Inputs: customer presence, scoped consent, confirmed context, reveal acknowledgement, cancellation. Every event is versioned and deduplicated; every media submission uses stable idempotency.

## 5. Data Models

Zod schemas define consent, synthetic customer profile, versioned context, product facts, immutable AdBrief, jobs, result provenance and typed errors. Session capabilities and image/video bytes never appear in snapshots or logs.

Only `demo-alex`, `demo-sam`, and the synthetic `demo-car` are registered today. Real participant enrollment/product assets require a separate agreed integration; labels such as `enrolled` are not face recognition.

## 6. Provider Strategy

Default: mock brief/profile/media, local jobs, disabled follow-up. Real provider selection requires explicit configuration.

Opt-in OpenAI supplies structured storyboard content. Opt-in Exa retrieves an explicitly supplied, separately consented public source without inferring preferences. The HTTP media adapter connects to Tiya's dedicated MoviePart service; live generation requires operator-provided credentials and renderer readiness.

Fallbacks are off by default and visibly labeled when enabled. Unknown media acceptance is never automatically retried. HTTP media requires cancellation/deletion capabilities and uses globally unique upstream job keys; failed cleanup retains private reconciliation metadata. Trigger and Ambiguous selections fail startup rather than silently pretending to work.

## 7. Golden Path

Pair device -> create session -> record presence/consent -> select roster identity -> confirm preferences -> upload image -> create immutable brief -> start idempotent media job -> poll -> retrieve MP4 bytes -> play -> acknowledge reveal -> revoke/cleanup.

Offline success proves the protocol using synthetic images/video. Live-demo success additionally requires the actual robot, participant permissions, personalized media, and customer UI.

## 8. Failure Paths

Missing consent blocks effects. Invalid identity requires reselection. Malformed provider outputs fail validation. Deadlines and cancellation suppress late completion. Queues, uploads, sessions and histories are bounded.

An explicitly selected synthetic fallback never becomes a claim of freshly personalized media. Process restart loses session/job memory. External copies and jobs are not guaranteed cancelled by a local abort.

## 9. DevOps / CI/CD Architecture

One isolated npm package/lock, strict NodeNext build, Node/tsx tests, compiled-process offline smoke, and a root GitHub Actions workflow. No Docker, cloud account, provider keys, database service or FFmpeg installation is required to run offline.

## 10. Pipeline Definition

Working directory: `FinalProject`.

| Stage | Command |
|---|---|
| Restore | `npm ci` |
| Typecheck | `npm run typecheck` |
| Unit/contract/HTTP tests | `npm test` |
| Runnable build | `npm run build` |
| Compiled offline smoke | `npm run smoke` |
| Combined gate | `npm run verify` |
| Allowlisted demo package | `npm run package:demo` |

The workflow targets Windows/Linux with the pinned toolchain. There is no invented lint command. CI uses synthetic fixtures and no provider secrets; deployment is not wired into PR validation.

## 11. Environment and Secret Strategy

Copy `.env.example` locally only when needed; `.env`, `.runtime`, build outputs, logs and private data are ignored. Provider keys remain server-side. A generated device token is stored in `.runtime\device-token`, not printed into logs or put in a URL.

Begin loopback-only. LAN mode requires explicit token, allowed hosts and origins. Browser capture may need trusted HTTPS. Exposed credentials must be rotated and replacements entered locally, never copied from chat into source.

## 12. Dwight Implementation Tasks

These task IDs correspond to the detailed session plan and task database. Effort is relative, not a completion-time promise.

| Task | Priority / effort | Owner / files | Dependency | Success / test method |
|---|---|---|---|---|
| DW-APP-01 | P0 / M | Dwight; `src\contracts`, `docs\contracts.md` | Team contract review | Strict schemas and matching robot/media fixtures |
| DW-DEVOPS-01 | P0 / M | Dwight; manifest/lock/runtime/ignore/tsconfigs | None | Clean restore and runnable build |
| DW-APP-02 | P0 / M | Dwight; `src\orchestrator` | Contracts/toolchain | Consent/session state, isolation, expiry tests |
| DW-APP-03 | P0 / S | Dwight; mock brief provider | Session/context | Deterministic validated immutable brief |
| DW-APP-04 | P0 / L | Dwight; local job lifecycle/assets | Brief/synthetic fixture | Bounded idempotent job and retrievable media |
| DW-APP-05 | P0 / M | Dwight; `src\http`, harness | State/jobs | Authenticated commands, polling, upload/reveal |
| DW-DEVOPS-02 | P0 / M | Dwight; tests/smoke scripts | API | Compiled offline process flow without external requests |
| DW-DEVOPS-03 | P1 / M | Dwight; root workflow | Reproducible scripts | PR/main/manual Windows/Linux validation |
| DW-DEVOPS-04 | P0 / M | Dwight; config/auth/startup/docs | API/toolchain | Explicit modes, safe defaults, pairing and LAN gates |
| DW-APP-06 | P0-demo / L | Dwight integrates Damian/Tiya | Real teammate interfaces/assets | Actual robot -> personalized MP4 -> observed playback |
| DW-APP-07 | P1 / M | Dwight; OpenAI adapter/tests | Brief interface/account | Structured output and error/fallback tests; live opt-in separately |
| DW-APP-08 | P1 / M | Dwight; Exa adapter/tests | Context/consent/account | Supplied-source evidence, no inferred identity/interests |
| DW-APP-09 | P1 / L | Dwight; future Trigger adapter | Reachable renderer/assets/project | Same lifecycle, proven reconciliation, local fallback |
| DW-APP-10 | P0 / M | Dwight; state/errors/logging | API/jobs | Cancellation, timeout, output validation, fallback and redaction tests |
| DW-DEVOPS-05 | P0/P1 / M | Dwight; package/runbook | Offline gate | Extracted package starts; private data excluded |
| DW-DEVOPS-06 | P1 conditional / M | Dwight; future Trigger deploy | Actual Trigger integration | Protected task deployment and local recovery |
| DW-APP-11 | P2 / L | Dwight; future Ambiguous adapter | Live demo/permissions | Immutable approval, real record read-back, no blind write retry |
| DW-DEVOPS-07 | P2 / L | Dwight; future cloud deployment | Proven need/auth/durability | Protected release and tested local recovery |

## 13. Timeline

Use dependency gates: architecture freeze -> offline foundation -> complete mock workflow -> real teammate integration -> optional intelligence -> optional async provider -> feature freeze -> recovery rehearsal -> release handoff.

Do not treat the original hackathon window as a guarantee that missing hardware/media/UI can be delivered by Dwight alone.

## 14. Testing Strategy

Unit/state tests, strict contract fixtures, bounded provider-response tests, authenticated HTTP tests, compiled-process mock smoke and explicit child-process cleanup. Provider tests use controlled responses, never paid APIs.

CI acknowledgement is simulated. Manual acceptance must observe actual audiovisual playback, confirm the correct participant/product, and measure the requested under-90-second demo criterion.

## 15. Merge Strategy

Keep the current app-managed branch. Dwight owns FinalProject API/contracts/manifests and root CI; do not edit Damian/Tiya parts. Integrate schemas and fixtures first, then robot, then media/UI, then optional providers. Re-run the same smoke after each merge. Do not rewrite unrelated starter code or reset teammates' work.

## 16. Deployment Strategy

No cloud deployment is required now. Use the loopback API, then authenticated local-network access. Cloud Run remains gated on a genuine need plus private asset storage, authentication, durable state and an appropriate long-running worker model. Trigger workers cannot read laptop-local files automatically.

## 17. Demo Recovery Plan

Use the [runbook](docs/runbook.md). Keep a known-good local build, deterministic brief, local runner, synthetic MP4 and developer harness. Failed real submissions require reconciliation rather than duplicate work. No false claims of booking, personalized generation, hardware operation or green CI.

## 18. Demo Readiness Checklist

Offline gate: clean install/build, secret-safe config, authenticated flow, byte-valid synthetic MP4, honest provenance, cancellation/expiry, smoke and reproducible startup.

Live gate: real enrolled consent, camera/voice/robot events, real customer image and product assets, personalized render, Tiya UI playback, robot acknowledgement, recovery rehearsal and measured interaction limit. These are separate gates.

## 19. Risks / Blockers

Critical: actual teammate implementations and permitted demo assets are absent. High: live provider availability, secure tablet connectivity, uncertain media acceptance, and mistaking mocks for personalization. Medium: cross-platform runtime/build drift and shared-file conflicts.

No supplied live API key has been saved or used. Exa/OpenAI/HTTP-media adapters require operator configuration and separately consented live validation. The workflow file is not evidence of a completed GitHub run until pushed/executed.

## 20. Recommended Implementation Order

Contracts/toolchain -> session/context -> deterministic brief -> local jobs/assets -> authenticated API -> compiled offline smoke -> CI/package -> actual teammate integration -> OpenAI/Exa live acceptance -> optional Trigger -> recovery/freeze -> optional Ambiguous/cloud.

Protect consent, authorization, idempotency, truthful provenance and offline smoke. Cut cloud, Ambiguous, Trigger and optional enrichment before those foundations.
