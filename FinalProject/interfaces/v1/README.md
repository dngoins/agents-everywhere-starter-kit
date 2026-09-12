# MagicPitch v1 - teammate handoff

Send this entire directory, or `magicpitch-interfaces-v1.tgz`, to Damian and Tiya. It contains no application implementation, npm dependencies, participant photos, generated customer media, or credentials.

| Recipient / need | Start here |
|---|---|
| Damian: robot events and voice-tool calls | [DAMIAN.md](DAMIAN.md) |
| Tiya: customer UI and media renderer | [TIYA.md](TIYA.md) |
| TypeScript integration | `types.d.ts` - dependency-free type declarations |
| Any language / request validation | `contracts.schema.json` - JSON Schema 2020-12 definitions |
| Orchestrator HTTP client generation | `orchestrator.openapi.json` - OpenAPI 3.1 |
| Media-service implementation | `media-service.openapi.json` - separate OpenAPI 3.1 service |
| Valid example payloads | `examples.json` - only synthetic fixture data |
| Version/source correspondence | `manifest.json` - source and generated-file SHA-256 hashes |

Keep both OpenAPI documents beside `contracts.schema.json`: their references are relative. `media-service.openapi.json` describes the service Tiya needs to supply; it is not another base URL implemented by the orchestrator.

Manifest text hashes use LF-normalized content so the same contract is recognized on Windows and Linux. Archive checksums still apply to the exact archive bytes.

## Shared ground rules

- `schemaVersion` is 1. IDs are opaque UUIDs unless a particular schema says otherwise.
- Use the same session across the robot and UI. The session creator passes the ID and session capability through the trusted paired bridge; there is no public session discovery endpoint.
- Device pairing, session access, and media-service credentials are different scopes. Never send a long-lived provider key to a browser.
- Consent is explicit and server-enforced. Detection does not identify a stranger, scrape a profile, capture a picture, or start media.
- `ready` is not `revealed`. A UI acknowledges only after actual playback.
- Read and display provenance. `mock_fixture` is a synthetic preview, not generated customer media.
- Keep media submission keys stable across retries. Do not create another paid job to resolve an uncertain acknowledgement.
- Restart/expiry invalidates sessions. The current local runner is not durable or horizontally scalable.

The runtime also enforces rules JSON Schema cannot express: state transitions, ownership, consent, idempotency, bounded queues, URL policy, cancellation, and the sum of storyboard scene durations. JSON schema/type validation alone does not authorize an action.

## Updating this bundle

Dwight generates it from the executable contracts:

```text
npm --prefix FinalProject run interfaces:export
npm --prefix FinalProject run interfaces:check
npm --prefix FinalProject run interfaces:package
```

Do not manually edit generated `.json` or `types.d.ts` files. Agree a contract change with Dwight, update the source schema, and regenerate. The three Markdown guides are maintained documentation.

## Current integration limits

The API and synthetic workflow are implemented. Real robot hardware, real participant enrollment, Tiya's kiosk/media pipeline, Trigger.dev, and Ambiguous scheduling are not supplied by this bundle. Only synthetic `demo-alex` / `demo-sam` and `demo-car` are registered. Agree real enrollment/product provisioning before using this for a live participant.
