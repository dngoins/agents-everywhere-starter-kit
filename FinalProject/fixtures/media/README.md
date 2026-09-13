# Demo and test media provenance

## Default: user-provided prerecorded demo

`default-demo.mp4` was supplied by the user as `WhatsApp Video 2026-09-12 at 16.18.20.mp4` and explicitly authorized as the default movie instead of the color bars. It is copied byte-for-byte, including audio, without re-encoding. Label it **USER-PROVIDED PRERECORDED DEMO**, not newly generated customer media. The user reported a ChatGPT source; the file metadata does not independently establish the generating provider, depicted identities, or licensing.

| File | Content | Format | SHA-256 |
| --- | --- | --- | --- |
| `default-demo.mp4` | User-supplied prerecorded example; **not generated for the current customer or brief** | 1280 × 720, 24 fps, 10.000 seconds of H.264 video, AAC audio, 10.026667-second container; 4,273,110 bytes | `69674967b142a7cd9f121df4aac8bb90d2f24274bae5d45d8841b5a337d41773` |

The immutable runtime manifest is `src/providers/demo-media.ts`, compiled to `dist/providers/demo-media.js` for runtime-only releases. The server, smoke runner, and packager share it and validate the file's signature, length, and SHA-256. The API reports `durationSeconds: 10` (video duration) and `provenance: "prerendered_fallback"` in both the default mock mode and an explicitly enabled recovery path. The small audio tail is under one 24 fps frame. No FFmpeg/FFprobe runtime dependency is added.

The prerecorded clip does not execute the synthetic six-second brief or use the session's uploaded PNG/preferences. Selection of the offline demo does not require enabling failed-provider recovery (`ALLOW_DEMO_FALLBACKS`).

## Synthetic fixtures: tests only for the color-bar MP4

The following two fixtures were created from mathematical color sources for MagicPitch's offline developer checks. They contain no people, faces, voices, participant data, customer recordings, starter recordings, trademarks, or product photographs. No third-party creative asset was reused for these synthetic fixtures. These claims do not describe the supplied default demo above. `mock-preview.mp4` remains unchanged for isolated/negative test coverage; `sample.png` remains the harness's synthetic upload.

| File | Content | Format | SHA-256 |
| --- | --- | --- | --- |
| `mock-preview.mp4` | Silent SMPTE-style color bars; **not a personalized advertisement** | 320 × 180, 24 frames, 1 second, H.264, yuv420p, fast-start MP4; 2,880 bytes | `7c585ba34069ed9b254869bec3c2dab16a7c436736d167aee4820bceff393e69` |
| `sample.png` | Solid teal rectangle; **not a customer photo** | 160 × 90 RGB PNG; 313 bytes | `b61b45c69462e4ddc37c1a92bc23e81e8646d0aa026544abbb590a9fd431a72c` |

Generated using the generation-only FFmpeg binary distributed by `@ffmpeg-installer/win32-x64@4.1.0`. The downloaded tooling was removed after generation and is not a runtime or CI dependency. Both files were decoded successfully by FFmpeg locally. CI checks the MP4 bytes/container, length, checksum, authorized retrieval, and byte ranges; it does not prove visual playback in a browser.

Equivalent regeneration commands (from `FinalProject`, when a separately managed FFmpeg executable is available):

```text
ffmpeg -f lavfi -i "smptebars=size=320x180:rate=24" -t 1 -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart -metadata "comment=MagicPitch synthetic color bars; no people, no personalized content." fixtures/media/mock-preview.mp4
ffmpeg -f lavfi -i "color=c=0x397a85:size=160x90" -frames:v 1 fixtures/media/sample.png
```

Encoder versions may change binary checksums. If regenerated, review the actual decoded output and update this documentation plus the synthetic checksum expectations in `scripts/smoke.mjs` (PNG) and `test/demo-media.test.ts` (MP4). Do not replace either synthetic fixture with a participant asset. Tests explicitly inject `mock_fixture` provenance and a one-second duration for the color-bar MP4; the default runtime and prerecorded recovery result use the separate supplied asset and remain labeled `prerendered_fallback`.
