# Synthetic media provenance

These fixtures were created from mathematical color sources for MagicPitch's offline developer checks. They contain no people, faces, voices, participant data, customer recordings, starter recordings, trademarks, or product photographs. No third-party creative asset was reused.

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

Encoder versions may change binary checksums. If regenerated, review the actual decoded output and update this manifest plus the checksum/duration expectations in `scripts/smoke.mjs`. Do not replace either fixture with a participant asset. The service returns `mock_fixture` provenance for this MP4; a selected prerecorded recovery result must remain labeled `prerendered_fallback`.
