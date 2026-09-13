import assert from "node:assert/strict";
import test from "node:test";
import { productionTiming } from "../src/lib/production-timing";
import type { JobView } from "../integration/contracts";

const start = Date.parse("2026-09-13T04:00:00Z");
function job(status: JobView["status"] = "STORYBOARDING"): JobView {
  return {
    id: "test", sessionId: "session", status, createdAt: new Date(start).toISOString(),
    updatedAt: new Date(start + 180_000).toISOString(), events: [], warnings: [], error: null,
    character: null, plan: null, frames: [], hero: null, result: null,
  };
}

test("two minutes is an advisory timer and never changes job status or media", () => {
  const working = job();
  const before = structuredClone(working);
  assert.equal(productionTiming(working, start + 119_000)?.overTarget, false);
  const afterTarget = productionTiming(working, start + 181_000);
  assert.deepEqual(afterTarget, { elapsedSeconds: 181, label: "3:01", overTarget: true, terminal: false });
  assert.deepEqual(working, before);
});

test("terminal production timing freezes and a retry starts a new advisory interval", () => {
  assert.equal(productionTiming(job("COMPLETED"), start + 800_000)?.label, "3:00");
  const retried = job();
  retried.events.push({ at: new Date(start + 300_000).toISOString(), stage: "RECEIVED", message: "Explicit retry", provider: null, shotId: null });
  assert.equal(productionTiming(retried, start + 305_000)?.label, "0:05");
  assert.equal(productionTiming(null, start), null);
});
