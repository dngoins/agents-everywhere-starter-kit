import assert from "node:assert/strict";
import test from "node:test";
import { responseBytes, fetchJson, ProviderFailure } from "../src/providers/http-client.js";

test("provider bodies enforce advertised and actual size", async () => {
  await assert.rejects(responseBytes(new Response("too large", { headers: { "content-length": "1000" } }), 10), ProviderFailure);
  await assert.rejects(responseBytes(new Response("too large"), 2), ProviderFailure);
  assert.equal(new TextDecoder().decode(await responseBytes(new Response("ok"), 2)), "ok");
});

test("provider errors redact payloads and mark uncertain submissions", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("sensitive-token-must-not-escape", { status: 503 }));
  await assert.rejects(fetchJson("https://provider.invalid", { method: "POST" }, {
    signal: new AbortController().signal, timeoutMs: 100, effectful: true,
  }), (error: unknown) => {
    assert.ok(error instanceof ProviderFailure);
    assert.equal(error.acceptanceUncertain, true);
    assert.equal(error.message.includes("sensitive-token"), false);
    return true;
  });
});
