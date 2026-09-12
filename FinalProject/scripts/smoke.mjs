import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const deviceToken = randomBytes(32).toString("base64url");
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|NODE_OPTIONS|NODE_EXTRA_CA_CERTS/i.test(name)) delete env[name];
}
Object.assign(env, {
  HOST: "127.0.0.1", PORT: "0", MOCK_ONLY: "true",
  BRIEF_PROVIDER: "mock", PROFILE_PROVIDER: "mock", MEDIA_PROVIDER: "mock",
  JOB_PROVIDER: "local", FOLLOWUP_PROVIDER: "disabled", ALLOW_DEMO_FALLBACKS: "false",
  DEMO_DEVICE_TOKEN: deviceToken, ALLOWED_ORIGINS: "", ALLOWED_HOSTS: "127.0.0.1",
  OPENAI_API_KEY: "", MODEL: "", EXA_API_KEY: "", MEDIA_SERVICE_URL: "", MEDIA_SERVICE_TOKEN: "",
  SESSION_TTL_MS: "90000", JOB_TIMEOUT_MS: "10000",
  MAX_SESSIONS: "8", MAX_QUEUED_JOBS: "4", MAX_UPLOAD_BYTES: "5242880", MAX_MEDIA_BYTES: "20971520",
});

let child;
let base;
let session;
let failed = false;
let stage = "startup";
let networkBlocked = false;
let childError = false;
const diagnostics = [];
const deadline = Date.now() + 45_000;
const terminal = new Set(["ready", "failed", "cancelled", "expired"]);

function record(line) {
  try {
    const message = JSON.parse(line);
    if (message.event === "server_started" && message.host === "127.0.0.1" &&
        Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) {
      base = `http://127.0.0.1:${message.port}`;
    }
    if (message.event === "network_blocked") networkBlocked = true;
    // Never relay arbitrary stdout, provider messages, URLs, tokens, or payloads.
    const entry = {};
    for (const key of ["event", "code", "status", "method"]) {
      const value = message[key];
      if (typeof value === "number" || (typeof value === "string" && /^[A-Za-z0-9_:-]{1,80}$/.test(value))) {
        entry[key] = value;
      }
    }
    if (Object.keys(entry).length) diagnostics.push(entry);
    if (diagnostics.length > 30) diagnostics.shift();
  } catch { /* Non-JSON child output is deliberately excluded from diagnostics. */ }
}

function checkRunning() {
  assert.ok(Date.now() < deadline, "Smoke exceeded its overall deadline.");
  assert.ok(!childError && child?.exitCode === null && child?.signalCode === null, "Owned API process exited.");
  assert.ok(!networkBlocked, "Server attempted outbound networking.");
}

async function request(path, { method = "GET", token = session?.sessionToken, body, headers = {} } = {}) {
  checkRunning();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  checkRunning();
  return response;
}

async function json(path, options) {
  const response = await request(path, options);
  assert.ok(response.ok, `${stage}: unexpected HTTP ${response.status}.`);
  return response.json();
}

const sessionPath = () => `/v1/sessions/${session.sessionId}`;
const event = (type, payload) => json(`${sessionPath()}/events`, {
  method: "POST", body: { schemaVersion: 1, eventId: randomUUID(), type, payload },
});
const command = (name, body) => json(`${sessionPath()}/commands/${name}`, { method: "POST", body });

async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // Node's Windows implementation terminates only this child PID for SIGTERM.
  child.kill("SIGTERM");
  await Promise.race([new Promise((done) => child.once("exit", done)), delay(3_000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([new Promise((done) => child.once("exit", done)), delay(2_000, undefined, { ref: false })]);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, "Owned API process did not terminate.");
}

const watchdog = setTimeout(() => {
  failed = true;
  console.error(JSON.stringify({ event: "smoke_failed", stage, code: "DEADLINE_EXCEEDED" }));
  child?.kill("SIGKILL");
  process.exitCode = 1;
}, 50_000);

try {
  const png = await readFile(resolve(root, "fixtures", "media", "sample.png"));
  const mp4 = await readFile(resolve(root, "fixtures", "media", "mock-preview.mp4"));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG fixture signature.");
  assert.equal(mp4.subarray(4, 8).toString("ascii"), "ftyp", "MP4 fixture signature.");
  assert.equal(createHash("sha256").update(png).digest("hex"),
    "b61b45c69462e4ddc37c1a92bc23e81e8646d0aa026544abbb590a9fd431a72c",
    "PNG must match the reviewed synthetic fixture.");
  assert.equal(createHash("sha256").update(mp4).digest("hex"),
    "7c585ba34069ed9b254869bec3c2dab16a7c436736d167aee4820bceff393e69",
    "MP4 must match the independently decoded synthetic fixture.");
  child = spawn(process.execPath, ["--import", "./scripts/offline-network-guard.mjs", "dist/server.js"], {
    cwd: root, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  child.once("error", () => { childError = true; });
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop().slice(-4096);
      for (const line of lines) record(line);
    });
  }
  while (!base) { checkRunning(); await delay(50); }
  assert.equal((await json("/healthz", { token: null })).status, "ok");
  const ready = await json("/readyz", { token: null });
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.providers, { brief: "mock", profile: "mock", media: "mock", job: "local", followup: "disabled" });

  stage = "auth and browser assets";
  assert.equal((await request("/v1/sessions", { method: "POST", token: null, body: {} })).status, 401);
  assert.equal((await request("/v1/sessions", {
    method: "POST", token: deviceToken, body: {}, headers: { Origin: "https://untrusted.invalid" },
  })).status, 403);
  for (const path of ["/dev", "/dev/app.js", "/dev/styles.css", "/dev/sample.png"]) {
    assert.ok((await request(path, { token: null })).ok, "Developer harness asset unavailable.");
  }
  session = await json("/v1/sessions", { method: "POST", token: deviceToken, body: {}, headers: { Origin: base } });
  assert.ok(session.sessionId && session.sessionToken && session.serverInstanceId, "Missing session credentials.");
  assert.notEqual(session.sessionToken, deviceToken);
  assert.equal((await request(sessionPath(), { token: null })).status, 401);
  assert.equal((await request(sessionPath(), { token: deviceToken })).status, 401);
  await event("customer_detected", {});

  stage = "consent gates";
  assert.equal((await request(`${sessionPath()}/assets`, {
    method: "POST", body: png, headers: { "Content-Type": "image/png" },
  })).status, 403);
  assert.equal((await request(`${sessionPath()}/commands/identify_customer`, {
    method: "POST", body: { customerId: "demo-alex", method: "manual" },
  })).status, 403);
  await event("consent_recorded", { personalization: true, capture: true, enrichment: false });

  stage = "synthetic golden path";
  await command("identify_customer", { customerId: "demo-alex", method: "manual" });
  const image = await json(`${sessionPath()}/assets`, {
    method: "POST", body: png, headers: { "Content-Type": "image/png" },
  });
  assert.ok(image.assetId);
  await event("context_updated", { preferences: ["beach road trips"] });
  await command("enrich_profile", {});
  const brief = await command("create_ad_brief", { productId: "demo-car" });
  assert.equal(brief.provenance, "mock");
  const input = { briefId: brief.id, idempotencyKey: randomUUID() };
  const started = await command("start_media_job", input);
  const duplicate = await command("start_media_job", input);
  assert.equal(duplicate.jobId, started.jobId, "Idempotency must reuse the existing media job.");
  let job = started;
  while (!terminal.has(job.status)) {
    await delay(50);
    job = await command("get_media_status", { jobId: started.jobId });
  }
  assert.equal(job.status, "ready", "Synthetic job must reach ready.");
  assert.equal(job.result?.provenance, "mock_fixture", "Mock media must retain truthful provenance.");
  assert.equal(job.result.mimeType, "video/mp4");
  assert.equal(job.result.durationSeconds, 1);

  stage = "authenticated media and ranges";
  const mediaPath = `${sessionPath()}/assets/${job.result.assetId}`;
  assert.equal((await request(mediaPath, { token: null })).status, 401);
  const media = await request(mediaPath);
  assert.equal(media.headers.get("content-type"), "video/mp4");
  const bytes = Buffer.from(await media.arrayBuffer());
  assert.deepEqual(bytes, mp4, "Delivered media must be the actual synthetic fixture.");
  assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp");
  assert.equal(job.result.byteLength, bytes.length);
  assert.equal(job.result.checksum, createHash("sha256").update(bytes).digest("hex"));
  const range = await request(mediaPath, { headers: { Range: "bytes=0-31" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 0-31/${bytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 32));

  stage = "reveal acknowledgement and revoke";
  const beforeReveal = await json(sessionPath());
  assert.equal(beforeReveal.state, "media_ready");
  assert.equal(beforeReveal.jobs.length, 1);
  await event("media_revealed", { jobId: job.jobId });
  const revealed = await json(`${sessionPath()}?afterRevision=${beforeReveal.revision}`);
  assert.equal(revealed.state, "revealed");
  assert.ok(revealed.revision > beforeReveal.revision);
  assert.ok((await request(sessionPath(), { method: "DELETE" })).ok);
  assert.ok([401, 404, 410].includes((await request(mediaPath)).status), "Revocation must deny media access.");
  assert.ok([401, 404, 410].includes((await request(sessionPath())).status), "Revocation must deny session access.");
  checkRunning();
} catch (error) {
  failed = true;
  console.error(JSON.stringify({
    event: "smoke_failed", stage,
    code: error instanceof assert.AssertionError ? "ASSERTION_FAILED" : "REQUEST_OR_STARTUP_FAILED",
    diagnostics,
  }));
} finally {
  try { await stopChild(); } catch {
    failed = true;
    console.error(JSON.stringify({ event: "smoke_failed", stage: "cleanup", code: "CHILD_NOT_STOPPED" }));
  }
  clearTimeout(watchdog);
}
if (failed || networkBlocked) {
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    event: "smoke_passed",
    checks: "compiled API, auth, consent, mock flow, idempotency, MP4 bytes, range, simulated reveal, revocation, child cleanup",
    audiovisualPlaybackVerified: false,
  }));
}
