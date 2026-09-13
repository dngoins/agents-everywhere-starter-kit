# Showroom runtime

`@magicpitch/showroom-runtime/browser` exports the single-source `LiveVoice`,
`LiveToolDispatcher`, `PadBot`, and injected `createFaceScanner`. It has no Node
imports, environment reads, credentials, business workflow, automatic speech
synthesis fallback, or camera/robot connection on import.

Pass `sessionFactory({sdp, identity, signal})`, `allowedTools`, `greetingContext`
and `readyContext` to `LiveVoice`. Session creation returns only
`{session:{id},transport:{type:"webrtc",sdp}}`; ready means both the answer and
matching `session.started` have arrived. The caller owns microphone permission
and its stream; voice clones tracks, and closes only its clones. The caller also
owns backend run termination/reconciliation. Transcript callbacks are deltas,
**not** final utterances or approval. Use authoritative tool/action receipts for
consent. The visible audio element remains the autoplay-recovery control.

`@magicpitch/showroom-runtime/server` exports `createLiveSessionRequest` and
`DEFAULT_LIVE_MODELS`. This is the original RobotPart Live payload, including
`store:false` and serialized Responses delegation. No audio voice preset,
turn-taking or interruption settings are invented. Provider secrets and network
requests belong exclusively to the application server.

`@magicpitch/showroom-runtime/assets` is Node-only. `prepareVisionAssets` copies
the consumer's installed MediaPipe WASM and downloads versioned public model
files to an explicit local directory. MoviePart runs `npm run assets:showroom`
to prepare `/showroom-models/wasm`, `/showroom-models/face_landmarker.task`, and
`/showroom-models/pose_landmarker_lite.task`; no camera images are sent to model
download servers. RobotPart retains `npm run assets` and `/vision` paths.

PadBot raw commands remain available for the standalone diagnostic application,
not the iPad or voice model. BLE write completion is never proof that the robot
moved or stopped. A browser/radio failure can prevent a stop write: keep a
physical stop procedure and an operator within reach.
