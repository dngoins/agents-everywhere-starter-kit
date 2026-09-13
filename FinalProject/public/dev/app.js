const element = (id) => document.getElementById(id);
const view = Object.fromEntries([
  "pair-form", "device-token", "pair", "flow-form", "customer", "preferences",
  "personalization", "capture", "run", "refresh", "status", "state", "revision",
  "provenance", "media-label", "preview", "events", "revoke",
].map((id) => [id, element(id)]));

let session;
let revision = 0;
let previewUrl;
let previewJob;
let busy = false;
let pollTimer;
let epoch = 0;
let flowAttempted = false;
let acknowledged = false;

function status(message, error = false) {
  view.status.textContent = `Synthetic workflow · ${message}`;
  view.status.dataset.error = String(error);
}

function controls() {
  view.pair.disabled = busy || Boolean(session);
  view["device-token"].disabled = Boolean(session);
  view.run.disabled = busy || !session || flowAttempted;
  view.refresh.disabled = busy || !session;
  view.revoke.disabled = busy || !session;
}

function clearPreview() {
  view.preview.pause();
  view.preview.removeAttribute("src");
  view.preview.load();
  view.preview.hidden = true;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = undefined;
  previewJob = undefined;
  acknowledged = false;
}

function clearSession() {
  epoch += 1;
  clearTimeout(pollTimer);
  clearPreview();
  session = undefined;
  revision = 0;
  flowAttempted = false;
  view.state.textContent = "—";
  view.revision.textContent = "—";
  view.provenance.textContent = "No media";
  view["media-label"].hidden = true;
  view["device-token"].value = "";
  view.personalization.checked = false;
  view.capture.checked = false;
  view.events.replaceChildren();
  controls();
}

async function request(path, { method = "GET", body, token = session?.sessionToken, headers = {} } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof Blob) ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    let code = `HTTP_${response.status}`;
    try {
      const result = await response.json();
      if (/^[A-Z0-9_]{1,80}$/.test(result.error?.code)) code = result.error.code;
    } catch { /* Keep the status-only fallback; do not render raw provider responses. */ }
    if (response.status === 401 || response.status === 410) clearSession();
    throw new Error(code);
  }
  return response;
}

const json = async (path, options) => (await request(path, options)).json();
const sessionPath = () => `/v1/sessions/${encodeURIComponent(session.sessionId)}`;
const event = (type, payload) => json(`${sessionPath()}/events`, {
  method: "POST", body: { schemaVersion: 1, eventId: crypto.randomUUID(), type, payload },
});
const command = (name, body) => json(`${sessionPath()}/commands/${name}`, { method: "POST", body });

async function action(callback) {
  if (busy) return;
  busy = true;
  controls();
  try { await callback(); } catch (error) {
    clearTimeout(pollTimer);
    const code = /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "CONNECTION_OR_CLIENT_ERROR";
    status(`${code}. Refresh to reconcile, or revoke and pair again. No paid job is retried automatically.`, true);
  } finally {
    busy = false;
    controls();
  }
}

async function loadPreview(job, generation) {
  if (previewJob?.jobId === job.jobId && previewUrl) return;
  const response = await request(`${sessionPath()}/assets/${encodeURIComponent(job.result.assetId)}`);
  if (response.headers.get("content-type")?.split(";")[0] !== "video/mp4") throw new Error("INVALID_MEDIA_TYPE");
  const blob = await response.blob();
  if (!session || generation !== epoch) return;
  if (blob.size !== job.result.byteLength) throw new Error("INCOMPLETE_MEDIA");
  clearPreview();
  previewUrl = URL.createObjectURL(blob);
  previewJob = job;
  view.preview.src = previewUrl;
  view.preview.hidden = false;
  const provenance = job.result.provenance;
  view.provenance.textContent = provenance;
  view["media-label"].textContent = provenance === "mock_fixture"
    ? "SYNTHETIC MOCK · Silent color bars, not personalized media."
    : provenance === "prerendered_fallback"
      ? "PRERECORDED DEMO · Prerecorded media, not generated for this customer."
      : "PROVIDER RESULT · Generated provenance reported by the API; independently verify content before a live demo.";
  view["media-label"].hidden = false;
  status("Media downloaded. Press Play; playback completion will acknowledge the reveal.");
}

async function refresh() {
  if (!session) return;
  const generation = epoch;
  const snapshot = await json(`${sessionPath()}?afterRevision=${revision}`);
  if (!session || generation !== epoch) return;
  if (snapshot.serverInstanceId !== session.serverInstanceId) {
    clearSession();
    throw new Error("SERVER_RESTARTED");
  }
  view.state.textContent = snapshot.state;
  view.revision.textContent = String(snapshot.revision);
  if (snapshot.resetRequired) view.events.replaceChildren();
  for (const item of snapshot.events) {
    const line = document.createElement("li");
    line.textContent = `r${item.revision} · ${item.type}`;
    view.events.append(line);
  }
  while (view.events.children.length > 30) view.events.firstElementChild.remove();
  revision = snapshot.revision;
  const job = snapshot.jobs.at(-1);
  if (job?.status === "ready" && job.result) await loadPreview(job, generation);
  else if (job && ["failed", "cancelled", "expired"].includes(job.status)) {
    status(`Media job ${job.status}. Revoke and start a new synthetic session to recover.`, true);
  }
  clearTimeout(pollTimer);
  if (job && ["queued", "running"].includes(job.status)) {
    status(`Media job ${job.status}. Waiting for the local runner…`);
    pollTimer = setTimeout(() => { void action(refresh); }, 700);
  }
}

view["pair-form"].addEventListener("submit", (input) => {
  input.preventDefault();
  void action(async () => {
    const token = view["device-token"].value.trim();
    view["device-token"].value = "";
    const ready = await json("/readyz", { token: null });
    if (ready.providers?.brief !== "mock" || ready.providers?.profile !== "mock" ||
        ready.providers?.media !== "mock" || ready.providers?.job !== "local" ||
        ready.providers?.followup !== "disabled") {
      throw new Error("HARNESS_REQUIRES_OFFLINE_MOCK_MODES");
    }
    session = await json("/v1/sessions", { method: "POST", token, body: {} });
    epoch += 1;
    status("Paired. Review both consent checkboxes, then run the synthetic flow.");
    await refresh();
  });
});

view["flow-form"].addEventListener("submit", (input) => {
  input.preventDefault();
  if (!session || !view.personalization.checked || !view.capture.checked) return;
  void action(async () => {
    flowAttempted = true;
    await event("customer_detected", {});
    await event("consent_recorded", { personalization: true, capture: true, enrichment: false });
    await command("identify_customer", { customerId: view.customer.value, method: "manual" });
    const sample = await (await request("/dev/sample.png", { token: null })).blob();
    await json(`${sessionPath()}/assets`, { method: "POST", body: sample, headers: { "Content-Type": "image/png" } });
    await event("context_updated", { preferences: [view.preferences.value.trim()] });
    await command("enrich_profile", {});
    const brief = await command("create_ad_brief", { productId: "demo-car" });
    await command("start_media_job", { briefId: brief.id, idempotencyKey: crypto.randomUUID() });
    await refresh();
  });
});

view.refresh.addEventListener("click", () => { void action(refresh); });
view.revoke.addEventListener("click", () => {
  void action(async () => {
    await request(sessionPath(), { method: "DELETE" });
    clearSession();
    status("Session revoked. Local preview and in-memory credentials cleared.");
  });
});
function acknowledgeReveal() {
  if (!session || !previewJob || acknowledged) return;
  if (busy) {
    const generation = epoch;
    setTimeout(() => { if (generation === epoch) acknowledgeReveal(); }, 100);
    return;
  }
  void action(async () => {
    await event("media_revealed", { jobId: previewJob.jobId });
    acknowledged = true;
    await refresh();
    status("Playback-ended acknowledgement recorded. This proves only local demo playback, not customer-specific generation.");
  });
}
view.preview.addEventListener("ended", acknowledgeReveal);
view.preview.addEventListener("error", () => {
  if (previewUrl) status("The browser could not decode this preview. No reveal was acknowledged.", true);
});
window.addEventListener("pagehide", clearSession);
controls();
