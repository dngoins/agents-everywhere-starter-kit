# Synthetic transport sample

`dwight-synthetic-sample.mp4` is a six-second, two-scene **offline synthetic sample**. It contains generated geometric artwork and a visible label, not a participant, a real vehicle, or a successful AI-provider response.

It is deliberately separate from the live media-service executor. Do not configure a transport that reports this file as `generated`. In Dwight's existing fixture provider, its provenance must be `mock_fixture` (or `prerendered_fallback` when explicitly used as prerecorded fallback).

Regenerate without provider credentials:

```powershell
node --import tsx scripts/media-sample.ts sample-fixtures\dwight-synthetic-sample.mp4
```

The source brief shape is in `integration\dwight\examples.json`. Live `demo-car-v1` rendering requires an OpenAI image-generation key and uses the brief's actual scene durations, on-screen copy, and CTA. No offline-success switch exists in the live service.
