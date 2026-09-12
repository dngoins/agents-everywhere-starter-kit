# Sales robot backend (local hackathon demo)

All implementation and test files for this task live in this directory. No root scaffold,
environment file, frontend, RobotLibrary, dependencies or Git branch was changed by this task.
Requires Node 24 and the dependencies already declared by the main agent. No real bookings,
image-generation API, camera, Bluetooth or motor control are implemented here.

## Entry points and configuration

- `index.ts`: `startServer()` loads the existing `RobotPart/.env` using Node's `loadEnvFile`
  and `new URL('../.env', import.meta.url)`, then listens on **127.0.0.1:8787**. Paths do not
  depend on the terminal working directory. Missing configuration permits the mock-only
  features; voice/expert return 503. Other startup errors are sanitized.
- `config.ts`: pure `configFromEnv(env)`; trims and lowercases model identifiers. Defaults:
  `gpt-live-1`, `gpt-5.6-luna`, `gpt-6-astra`. Only startup reads process configuration.
  A present API key makes `configured` true; this is NOT an authenticated capability check.
- `app.ts`: `createApp(options)` returns an Express app with `app.robot.store`,
  `app.robot.workflow` and async `app.robot.close()`; it does not listen or load `.env`.
- `server.ts`: `createRobotServer(options)` returns `app`, `httpServer`, `webSockets`,
  `listen(port = 8787)`, `heartbeat()` and idempotent async `close()`. `listen(0)` uses a
  temporary loopback port for tests. `close()` cancels timers, aborts provider work,
  invalidates customers, terminates sockets and closes HTTP connections.
- Injectable options: explicit `config`, `fetch`, `now: () => Date`, `rootDir`, `facesDir`,
  `moviesDir`, `distDir`, `production`, `movieAvailable`, `movieDelayMs` (default 5000),
  `schedule`, `providerTimeoutMs` (default 30000), `logBooking`, `allowedOrigins`,
  and `heartbeatMs` (server factory, default 30000).
- Production (`NODE_ENV=production` at startup) serves only `dist/` and the explicit demo
  movie route. SPA fallback is GET/HEAD HTML navigation only, never `/api`, `/ws`,
  `/newCustomerFace`, `/Movies` errors, dotfiles, `/Faces`, `/server`, `/RobotLibrary`, or
  `/node_modules`. Development leaves frontend serving to Vite. No root static mount.
- Use the main agent's existing scripts after dependencies are installed. The standalone
  backend test selection is `node --import tsx --test server/*.test.ts` from RobotPart.
  This task did **not** install dependencies or run project npm tests.

## HTTP contracts

Bodies are JSON unless marked multipart. Fields are strict: unknown fields, wrong booleans,
missing fields and malformed UUIDs produce 400. UUIDs normalize to lowercase.
All errors are `{error: string}` with application-authored messages, never raw errors.
Owner mismatch is 403, unknown customer 404, inactive customer/wrong stage/conflict 409.
Oversized JSON is 413; invalid/empty/oversized multipart image is 400.

| Route | Input | Success |
| --- | --- | --- |
| `GET /api/health` | None | 200 `{ok:true,demo:true}` |
| `GET /api/config` | None | 200 `{configured,models:{voice,regular,highend},timeZone:'America/New_York',demoMovieAvailable}` |
| `POST /newCustomerFace` | Multipart `image`, `clientId`, `customerId` | First save: 202 `{customerId,status:'processing'}`; duplicate: 202 processing or 200 ready/error |
| `GET /api/customers/:id?clientId=UUID` | Owner's tab UUID | 200 `{customerId,status,stage,movieUrl?,booking?}` |
| `DELETE /api/customers/:id` | `{clientId}` | 200 `{ok:true,customerId,active:false}`; repeated delete is idempotent |
| `POST /api/tools/:name` | `{clientId,customerId,args:{...}}` | 200 `{ok:true,stage,uiAction?,...result}` |
| `GET /api/test-drive/slots?customerId=UUID&clientId=UUID` | Both UUIDs | Exactly the `get_test_drive_slots` business result |
| `POST /api/test-drive/bookings` | `{customerId,clientId,slotId,car,confirmed}` | Exactly the `book_test_drive` business result (200, including retries) |
| `POST /api/voice/session` | `{clientId,customerId,sdp}` | 201 `{session:{id},transport:{type:'webrtc',sdp}}` |
| `GET /Movies/demo.mp4` | Optional Range header | 200/206, `video/mp4`; HEAD and suffix ranges supported; invalid range 416 |

### Images and customer lifecycle

The frontend generates a **per-tab client UUID** and a new customer UUID per visitor.
Connect `/ws?clientId=UUID` and register message listeners **before uploading**. WebSockets
do not require an existing customer, so the registration cannot race a completed upload.
Customer ownership is claimed synchronously after parsing the multipart fields, **before
sharp or disk awaits**. Same-client duplicates await the same save; other clients cannot
claim that record. Uploads never trust a filename or MIME type.

Images are capped at 5 MiB, decoded by sharp with a 40-million-pixel limit, auto-rotated,
resized inside 1600×1600 without enlargement, and re-encoded as JPEG without original
metadata. Single-frame JPEG/PNG/WebP/HEIF/AVIF/TIFF inputs are accepted where supported by
the installed sharp build; SVG, animation, empty, truncated and invalid images are rejected.
The final filename is `Faces/{customerId}.jpg`. Exclusive `wx` creation prevents overwrites,
including after process restart. A failed reserved upload retains its ownership/error record;
use a **fresh customer UUID** to submit a corrected image. Existing on-disk ID collisions
return 409, rather than silently adopting or replacing an earlier visitor's image.

Five seconds **after saving**, a timer checks `Movies/demo.mp4`, then sends only to sockets
with the owner's client ID:

- `{type:'movie.ready',customerId,movieUrl:'/Movies/demo.mp4'}`, or
- `{type:'movie.error',customerId,message:'The demo movie is unavailable. Please ask a sales representative for help.'}`.

Completed, active customers are replayed on reconnect (including movie errors). The timer
never offers or plays the video; stage stays `chat`. DELETE invalidates the customer,
cancels the timer and pending provider requests, and rejects stale tools, uploads and reads.
An in-flight disk lookup checks activity again before emitting. Invalid WebSocket IDs are
rejected at HTTP upgrade. Heartbeats use ping/pong, with termination on a missed interval.

## Shared tool/state contract

Initial stage is `chat`; positive flow is `movie_offer → watching → feedback → drive_offer
→ selecting → booked`. A negative movie/feedback/drive answer goes to **`declined`**, not
back to chat. Following/expert calls do not advance this flow.

| Tool | Exact args | Gate and result |
| --- | --- | --- |
| `offer_movie` | `{}` | Ready + chat → movie_offer; `uiAction:'offer_movie'`, `movieUrl` |
| `show_movie` | `{accepted:boolean}` | movie_offer; true → watching, `show_movie` + URL; false → declined, `decline_movie` |
| `movie_finished` | `{}` | **UI only**, watching → feedback; `feedback`; deliberately absent from model tools |
| `movie_feedback` | `{liked:boolean}` | feedback; true → drive_offer, `offer_test_drive`; false → declined, `decline_test_drive` |
| `test_drive_interest` | `{accepted:boolean}` | drive_offer; true → selecting, `show_slots`; false → declined, `decline_test_drive` |
| `get_test_drive_slots` | `{}` | selecting; refresh availability + `show_slots` |
| `book_test_drive` | `{slotId:string,car:'model3'\|'modely',confirmed:boolean}` | selecting, explicitly true, current offered slot; → booked, `booked` + booking |
| `follow_customer` | `{destination:'model3'\|'modely',confirmed:boolean}` | Explicit true, not watching; `follow_customer`, destination, safety message |
| `stop_following` | `{}` | Active customer; `stop_following` |
| `ask_vehicle_expert` | `{question:string,deepReasoning:boolean}` | Active customer, trimmed question 1–2000 chars; `{answer}` via Responses |

Following's exact message is: “Following is camera-based only while customer faces robot;
stop if face lost; no mapped navigation.” No arbitrary motor tool exists. A successful
show_movie clears the backend's following flag; the frontend **must stop actual motion
before playback**, on face loss, on stop, and when replacing/deleting a customer.

### Retry semantics

Successful one-way actions have per-customer receipts keyed by tool name and validated
arguments. Same-stage retries return the original result with `replayed:true`; retries of
an earlier stage return only `{ok:true,stage:<current>,replayed:true}`, **no obsolete UI
action**. The browser should deduplicate provider call IDs and should not repeat speech or
playback for `replayed:true`. Repeating an accepted drive interest while selecting refreshes
tomorrow's slots rather than replaying yesterday's availability. A repeated follow for the
current destination has no UI action; stop then follow starts a new following action.

There is no `callId` field in the requested HTTP contract. Business receipts enforce
one-shot state/booking idempotence; the frontend remains responsible for data-channel call
IDs. A matching booking retry returns the original booking even after midnight. A different
car or slot after booking returns 409. Booking commit and receipt creation are synchronous,
so concurrent UI and model calls cannot double-book. Exactly once per successful commit,
the logger receives `TODO: communicate mock all-day test drive with sales team` and the
booking object only. No image/credential data is logged, and no sales communication occurs.

### Availability and all-day assumption

Availability is `{date,timeZone,slots,demo:true}` with three slots
`{id,startAt,returnAt,label}`. Selecting results include those fields flat **and** under
`availability` for convenient UI consumption, plus `{ok:true,stage,uiAction:'show_slots'}`.
Slot IDs are opaque to the browser (internally customer/date/hour). Three unique hours from
09:00 through 16:00 are deterministically pseudo-random per customer/date and sorted.

“Tomorrow” is the next **calendar** day in `America/New_York`, including weekends; it is
not next-business-day scheduling. Luxon handles midnight and DST. “All-day” is a **demo
assumption: selected pickup until 18:00 Eastern that same date**, made explicit in every
slot and booking's `returnAt` and in confirmation prompts. Refresh/retry regenerates the
date at Eastern midnight. Booking rechecks tomorrow and requires a currently offered ID.

Booking shape: `{id,customerId,slotId,car,startAt,returnAt,timeZone,demo:true}`.

## Live API / frontend integration

Only actual invocation of voice/expert endpoints calls OpenAI; upload, movie timer, config,
tools other than expert, and booking are local. The Live request uses native fetch to
**`https://api.openai.com/v1/live/sessions`**, never Realtime. Its JSON is exactly
`{session:{model,instructions,store:false,delegation:{type:'responses',responses:{model,
instructions,tools,tool_choice:'auto',parallel_tool_calls:false}}},transport:{type:'webrtc',sdp}}`.
Tools are strict JSON schemas generated from the same Zod schemas used for HTTP validation.
The normal delegated backend is REGULAR; HIGHEND is used only when the optional vehicle
expert explicitly receives `deepReasoning:true`. Expert requests go to `/v1/responses`,
use demo-grounded instructions, disable storage, and return at most 1200 answer characters.

SDP must start `v=0` followed by a newline (or end), be nonempty and at most 128 KiB UTF-8.
Provider calls have a 30-second timeout and **no automatic retries**. Identical SDP creation
requests share a promise/result, including failures, to avoid accidental duplicate billed
initialization. An intentional new handshake requires a new SDP. Identical expert questions
likewise reuse their result/failure for that customer. Provider failure status is preserved
when 400–599; network/invalid output returns 502, timeout 504, unconfigured 503, inactive 409.
Provider response extras and raw error messages never go to HTTP responses or logs.

The frontend creates the data channel before the offer and waits for `session.started`.
Then it triggers the greeting using `session.instructions.append` with `delegation_id:null`.
Do not send `session.start` on WebRTC. Send movie readiness as quiet
`session.thinking.append` context with `delegation_id:null`; the regular backend calls
offer_movie at a natural pause before the spoken video-consent question. No photo-consent
prompt is requested for this staged demo. Video/follow/booking consent is still required.

For nested `response.event` → `response.output_item.done` function calls, the browser
deduplicates `call_id`, executes the matching HTTP tool, sends `response.item.create` with
`item:{type:'function_call_output',call_id,output:JSON.stringify(result)}`, then sends
`response.create` after all pending results. Those two events do **not** take delegation_id.
Only a video ended event in the UI may call movie_finished. Frontend must reject model calls
to this name even though the local HTTP route exists for the UI.

Verified in the official [Live session schema](https://developers.openai.com/api/reference/resources/live/primary-websocket.md):
omitting `client.data_channel.allowed_client_events` and `allowed_server_events` preserves
**allow-all**. Thus no explicit permission configuration is necessary for
`session.instructions.append`, `session.thinking.append`, `response.item.create` or
`response.create`. This deliberately follows the requested trusted-local-client demo.
Also consulted [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live),
[delegation](https://developers.openai.com/api/docs/guides/live-delegation), and
[server controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live).

## Validation and limitations

- `availability.test.ts`: stable hours, canonical models, Eastern midnight/year rollover,
  spring/fall DST and repeated autumn hour.
- `customers.test.ts`: actual JPEG rotation/resize, invalid files and limits, concurrent
  ownership, no overwrites, custom/default delay, missing movie, WebSocket isolation/replay,
  invalid upgrades, heartbeat, cancellation during save/lookup and cleanup.
- `workflow.test.ts`: all gates/consents, declines, stale retries, follow/stop, shared aliases,
  stable/rolled slots, concurrent booking, idempotence and one TODO log.
- `provider.test.ts`: exact Live body/route, strict model tool list, SDP boundary, canonical
  model selection, fake Responses expert, safe API/network errors, timeout and stale replies.
- `app.test.ts`: config/health, MP4 ranges/HEAD, production fallback, private-path protection,
  development behavior, malformed requests and origin rejection.
- `test-helpers.ts`: generated image fixtures, isolated OS temporary directories with
  cleanup, controllable scheduler, ephemeral real HTTP/WS servers, injected fake fetch.
  Tests never load project `.env` or call OpenAI/robot hardware.
- Dependency-free TypeScript stripping + JavaScript syntax parsing passed for all 17 TS
  files. Editor diagnostics were empty. **Runtime tests and strict typechecking remain
  unverified until the main agent installs the declared dependencies.**
- Customer state, booking records, receipts and provider results are **in-memory and
  process-local**, not durable or multi-process safe. Restart requires a new customer ID.
  Face JPEGs remain on disk after DELETE; arrange manual demo-data retention/cleanup. An
  interrupted process can leave an exclusively created file, which is never overwritten.
- UUID binding isolates normal tabs but is not login/authentication; a client that obtains
  both UUIDs can impersonate the tab. Origin checks and loopback binding are local-demo
  protections, not production authorization or rate limiting. Do not expose this service.
- Frontend owns WebRTC audio and existing Live-session closure: send `session.close`, wait
  for `session.closed`, then release peer/microphone resources. DELETE/close aborts pending
  backend requests, but cannot finalize an already-established remote Live session. A
  canceled initialization may still have reached/billed the provider; no automatic retry.
- State gates cannot independently prove spoken consent in this trusted-client design.
  Frontend must honor confirmation flags, UI-only completion, `replayed`, and stale customer
  rejection. Prompt-grounded expert answers are not verified specs or pricing guarantees.
