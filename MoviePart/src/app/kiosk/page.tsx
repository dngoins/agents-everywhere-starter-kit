"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import type { SessionCreated } from "../../../integration/dwight/types";
import { DEFAULT_ORCHESTRATOR_URL } from "../../../integration/orchestrator-client";
import { currentJob, KioskController, provenanceLabel } from "../../kiosk/controller";
import { robotPrompt } from "../../kiosk/robot-guide";
import { RobotFace } from "../../components/robot-face";
import styles from "./kiosk.module.css";

export default function KioskPage() {
  const [controller] = useState(() => new KioskController());
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const [base, setBase] = useState(DEFAULT_ORCHESTRATOR_URL);
  const [pairMode, setPairMode] = useState<"join" | "create">("join");
  const [trusted, setTrusted] = useState(false);
  const [deviceToken, setDeviceToken] = useState("");
  const [bridge, setBridge] = useState<SessionCreated>({ sessionId: "", sessionToken: "", serverInstanceId: "" });
  const [preferences, setPreferences] = useState("");
  const setup = useRef<HTMLDetailsElement>(null);
  const sessionControls = useRef<HTMLDetailsElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const snapshot = state.snapshot;
  const job = currentJob(snapshot);
  const brief = snapshot?.brief;
  const active = state.connection === "active";
  const locked = !active || !!state.busy;
  const editingLocked = locked || state.startAttempted || !!job;
  const permitted = controller.canUseMedia();
  const paired = !["unpaired", "terminal"].includes(state.connection);
  const waiting = job?.status === "queued" || job?.status === "running";
  const ready = job?.status === "ready" && !!job.result;
  const jobStopped = job && ["failed", "cancelled", "expired"].includes(job.status);
  const contextRevision = snapshot?.context?.revision;
  const currentBrief = !!brief && brief.contextRevision === contextRevision;
  const prompt = robotPrompt(state);

  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => { setPreferences(""); }, [state.generation]);
  useEffect(() => {
    setPreferences(snapshot?.context?.preferences.join("\n") ?? "");
  }, [contextRevision, snapshot?.customer?.customerId]); // Preferences are confirmed by session context, not the poll cursor.

  useEffect(() => {
    const element = video.current;
    return () => {
      if (element) {
        element.pause();
        element.removeAttribute("src");
        element.load();
      }
    };
  }, [state.movieUrl]);

  useEffect(() => {
    if (state.movieUrl) document.getElementById("robot-stage")?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [state.movieUrl]);

  function openSetup() {
    if (setup.current) {
      setup.current.open = true;
      setup.current.scrollIntoView({ block: "nearest", behavior: "auto" });
      setup.current.querySelector<HTMLInputElement>("input")?.focus();
    }
  }

  function openControls(target = "participant-controls") {
    if (sessionControls.current) sessionControls.current.open = true;
    requestAnimationFrame(() => {
      const section = document.getElementById(target);
      section?.scrollIntoView({ block: "start", behavior: "auto" });
      section?.focus({ preventScroll: true });
    });
  }

  function robotAction() {
    if (prompt.action === "connect") { openSetup(); return; }
    if (prompt.action === "load") { void controller.loadMovie(); return; }
    const target = prompt.action === "permissions" ? "robot-permissions"
      : prompt.action === "preferences" ? "robot-preferences"
      : prompt.action === "photo" ? "robot-photo"
      : prompt.action === "brief" || prompt.action === "create" ? "brief-heading"
      : "participant-controls";
    openControls(target);
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!trusted || paired) return;
    const input = pairMode === "create" ? deviceToken : { ...bridge };
    setDeviceToken("");
    setBridge({ sessionId: "", sessionToken: "", serverInstanceId: "" });
    await controller.connect(base, input);
    if (controller.getState().connection === "active" && setup.current) setup.current.open = false;
  }

  function cancel() {
    if (video.current) {
      video.current.pause();
      video.current.removeAttribute("src");
      video.current.load();
    }
    void controller.cancel();
  }

  const status = !paired ? "Connect to begin"
    : state.connection === "cancelling" ? "Ending this session"
    : state.connection === "cleanup_failed" ? "Cleanup needs attention"
    : !active ? "Connection paused"
    : jobStopped ? `Movie ${job.status}`
    : ready ? "Your preview is ready"
    : waiting ? "Your movie is being prepared"
    : brief ? "Review your concept"
    : "Let’s make it yours";

  return (
    <main className={styles.kiosk}>
      <button className={styles.skipLink} onClick={() => openControls()}>Skip to participant controls</button>
      <header className={styles.header}>
        <Link className={styles.wordmark} href="/" aria-label="Movie Magic creator studio">
          <span className={styles.mark} aria-hidden="true">m</span> Movie Magic<span aria-hidden="true">.</span>
        </Link>
        <nav aria-label="Workspace" className={styles.navigation}>
          <Link href="/">Creator studio</Link>
          <span aria-current="page">Showroom tablet</span>
        </nav>
      </header>

      <section className={styles.intro} aria-labelledby="kiosk-title">
        <div>
          <h1 id="kiosk-title">Your showroom preview</h1>
          <p>A short car concept, shaped by the preferences you choose to share.</p>
        </div>
        {paired && <button className={styles.endButton} onClick={cancel} disabled={state.connection === "cancelling"}>
          {state.connection === "cleanup_failed" ? "Retry server cleanup" : state.connection === "cancelling" ? "Ending session…" : "End session & clear media"}
        </button>}
      </section>

      <details ref={setup} className={styles.setup}>
        <summary>
          <span>Operator pairing</span>
          <span className={styles.connection}>{active ? "Connected to Dwight" : paired ? "Connection needs attention" : "Not connected"}</span>
        </summary>
        <div className={styles.setupContent}>
          <p>Join the robot’s existing session through the trusted bridge. Creating a new session here does not attach the robot.
            Refreshing this page forgets the capability; rejoin the same session rather than starting a new customer.</p>
          <form onSubmit={connect} autoComplete="off">
            <fieldset disabled={paired}>
              <legend className={styles.srOnly}>Orchestrator pairing</legend>
              <label className={styles.field}>
                <span>Trusted orchestrator origin</span>
                <input type="url" value={base} onChange={event => { setBase(event.target.value); setTrusted(false); }} required spellCheck={false} />
              </label>
              <p className={styles.help}>Default: API laptop loopback, port 3101. On a separate tablet use the laptop’s trusted HTTPS origin,
                not 127.0.0.1. LAN HTTP is blocked. The media service on port 3201 is not a tablet endpoint.</p>
              <label className={styles.check}>
                <input type="checkbox" checked={trusted} onChange={event => setTrusted(event.target.checked)} required />
                <span>I have verified this address with the operator. It is safe to send this session’s capability here.</span>
              </label>
              <div className={styles.pairModes}>
                <label className={styles.check}><input type="radio" name="pairMode" checked={pairMode === "join"} onChange={() => { setPairMode("join"); setDeviceToken(""); }} /><span>Join existing session <small>Recommended with the robot</small></span></label>
                <label className={styles.check}><input type="radio" name="pairMode" checked={pairMode === "create"} onChange={() => { setPairMode("create"); setBridge({ sessionId: "", sessionToken: "", serverInstanceId: "" }); }} /><span>Create a separate session <small>Standalone tablet demo only</small></span></label>
              </div>
              {pairMode === "join" ? <div className={styles.bridgeFields}>
                {(["sessionId", "sessionToken", "serverInstanceId"] as const).map(key => (
                  <label className={styles.field} key={key}>
                    <span>{{ sessionId: "Session ID", sessionToken: "Session token", serverInstanceId: "Server instance ID" }[key]}</span>
                    <input type="password" value={bridge[key]} required autoComplete="off" spellCheck={false}
                      minLength={key === "sessionToken" ? 24 : 36} maxLength={key === "sessionToken" ? 256 : 36}
                      onChange={event => setBridge({ ...bridge, [key]: event.target.value })} />
                  </label>
                ))}
              </div> : <label className={styles.field}>
                <span>Device pairing token</span>
                <input type="password" value={deviceToken} onChange={event => setDeviceToken(event.target.value)} required minLength={24} maxLength={256} autoComplete="off" spellCheck={false} />
              </label>}
              <p className={styles.help}>Paste only from the trusted bridge. Tokens remain in memory, never in URLs or browser storage.
                Do not enter a media-service token or provider key.</p>
              <button className={styles.primary} disabled={!trusted} type="submit">{pairMode === "join" ? "Join trusted session" : "Create standalone session"}</button>
            </fieldset>
          </form>
          <p className={styles.help}>Reveal owner: this tablet. It sends <code>media_revealed</code> after actual video playback begins.
            Damian’s robot should not send a duplicate reveal for this flow.</p>
        </div>
      </details>

      {(state.error || state.networkError || state.notice || state.revealError) && (
        <section className={styles.messages} aria-label="Session messages">
          {state.error && <p className={styles.error} role="alert">{state.error}</p>}
          {state.networkError && <div className={styles.error} role="status"><p>{state.networkError}</p>
            {state.connection === "offline" && <button className={styles.secondary} onClick={() => controller.retryConnection()}>Retry connection</button>}
          </div>}
          {state.notice && <p className={styles.notice} role="status">{state.notice}</p>}
          {state.revealError && <div className={styles.error} role="alert"><p>{state.revealError}</p>
            <button className={styles.secondary} disabled={!active || !state.movieUrl} onClick={() => void controller.retryReveal()}>Retry playback acknowledgement</button>
          </div>}
        </section>
      )}

      <div id="robot-stage">
        <RobotFace prompt={prompt} sessionKey={`${state.generation}:${snapshot?.sessionId ?? ""}`}
          disabled={!!state.busy || (paired && !active)}
          onAction={robotAction} onControls={() => openControls()}>
          {state.movieUrl && (
            <>
              {ready && <p className={styles.provenance}>{provenanceLabel(job.result!.provenance)}</p>}
              <video ref={video} src={state.movieUrl} controls playsInline preload="metadata"
                aria-label="Authorized showroom concept movie" onPlaying={() => controller.onPlaying()} onError={() => controller.playbackError()} />
            </>
          )}
        </RobotFace>
        {state.movieUrl && <div className={styles.playbackNote} aria-live="polite">
          <span>{state.reveal === "acknowledged" ? "Playback confirmed to the orchestrator."
            : state.reveal === "sending" ? "Confirming actual playback…"
            : state.reveal === "failed" ? "Playback acknowledgement needs a retry."
            : "Press play. Reveal is acknowledged only when playback starts."}</span>
          {job?.result && <span>{job.result.durationSeconds} seconds · MP4</span>}
        </div>}
      </div>

      <details ref={sessionControls} className={styles.sessionControls}>
        <summary>Permissions, preferences & movie controls</summary>
        <p className={styles.help}>The robot will guide you here when needed. You can review or change permissions at any time. Spoken prompts never grant permission.</p>
      <div className={styles.workspace}>
        <aside className={styles.controls} id="participant-controls" tabIndex={-1} aria-label="Participant controls">
          <section className={styles.participant}>
            <h2>{snapshot?.customer ? `For ${snapshot.customer.displayName}` : "You’re in control"}</h2>
            <p>{snapshot?.customer ? "Synthetic customer profile · selected by the orchestrator" : "Nothing is captured until you give permission."}</p>
          </section>

          <section className={styles.controlSection} id="robot-permissions" tabIndex={-1} aria-label="Your permission">
            <h3><span>1</span> Your permission</h3>
            <p className={styles.help}>Choose what this session may use. Unchecking a media permission stops local capture and playback immediately; save to tell the orchestrator.</p>
            <fieldset disabled={locked}>
              <legend className={styles.srOnly}>Explicit permissions</legend>
              <label className={styles.check}>
                <input type="checkbox" checked={state.consent.personalization} onChange={event => controller.setConsent("personalization", event.target.checked)} />
                <span>Personalize my concept<small>Use the selected customer and confirmed preferences.</small></span>
              </label>
              <label className={styles.check}>
                <input type="checkbox" checked={state.consent.capture} onChange={event => controller.setConsent("capture", event.target.checked)} />
                <span>Use a reference photo<small>Allow capture, upload and processing for this session.</small></span>
              </label>
              <label className={styles.check}>
                <input type="checkbox" checked={state.consent.enrichment} onChange={event => controller.setConsent("enrichment", event.target.checked)} />
                <span>Allow profile enrichment <small>Optional. This tablet does not request enrichment itself.</small></span>
              </label>
              <button className={styles.secondary} onClick={() => void controller.saveConsent()}>Save permissions</button>
            </fieldset>
            <p className={styles.permissionState}>{snapshot?.consent
              ? `Server permissions: personalization ${snapshot.consent.personalization ? "on" : "off"} · photo ${snapshot.consent.capture ? "on" : "off"} · enrichment ${snapshot.consent.enrichment ? "on" : "off"}`
              : "No permissions recorded yet."}</p>
          </section>

          <section className={styles.controlSection} id="robot-preferences" tabIndex={-1} aria-label="Customer and preferences">
            <h3><span>2</span> Customer & preferences</h3>
            <p className={styles.help}>Use the robot’s selection, or select a synthetic demo customer here. No face recognition is performed by this tablet.</p>
            <div className={styles.customerChoices}>
              {(["demo-alex", "demo-sam"] as const).map(id => (
                <button key={id} className={snapshot?.customer?.customerId === id ? styles.selectedCustomer : styles.secondary}
                  aria-pressed={snapshot?.customer?.customerId === id}
                  disabled={editingLocked || !snapshot?.consent?.personalization}
                  onClick={() => void controller.identify(id)}>{id === "demo-alex" ? "Alex" : "Sam"}</button>
              ))}
            </div>
            <form onSubmit={event => { event.preventDefault(); void controller.confirmPreferences(preferences); }}>
              <label className={styles.field}>
                <span>What would you like in your concept?</span>
                <textarea value={preferences} onChange={event => setPreferences(event.target.value)} rows={3} maxLength={4020}
                  placeholder={"For example: beach road trips\nOne preference per line"}
                  disabled={editingLocked || !snapshot?.customer} aria-describedby="preferences-help" />
              </label>
              <p className={styles.help} id="preferences-help">Up to 20 preferences, 200 characters each. Confirm these before making the brief.</p>
              <button type="submit" className={styles.secondary} disabled={editingLocked || !snapshot?.customer}>Confirm preferences</button>
            </form>
            {snapshot?.context && <div className={styles.confirmed}>
              <strong>Confirmed preferences</strong>
              {snapshot.context.preferences.length ? <ul>{snapshot.context.preferences.map((preference, index) => <li key={index}>{preference}</li>)}</ul> : <p>No additional preferences.</p>}
              <small>Context revision {snapshot.context.revision} · conversation</small>
            </div>}
          </section>

          <section className={styles.controlSection} id="robot-photo" tabIndex={-1} aria-label="Reference photo">
            <h3><span>3</span> Reference photo</h3>
            <p className={styles.help}>{brief ? "Your brief is ready. Take or choose one permitted photo, then upload it." : "Confirm preferences and create the brief on the right before choosing a photo."}
              {" "}This uses the device’s camera/file picker, not a live camera or microphone stream.</p>
            {state.photoUrl && <img className={styles.reference} src={state.photoUrl} alt="Your selected session reference" />}
            <label className={styles.fileField}>
              <span>Take or choose a photo</span>
              <input key={`${state.generation}-${state.photoVersion}`} type="file" accept="image/png,image/jpeg" capture="user"
                disabled={editingLocked || !permitted || !currentBrief}
                onChange={event => { const file = event.currentTarget.files?.[0]; if (file) controller.selectPhoto(file); event.currentTarget.value = ""; }} />
            </label>
            <p className={styles.help}>PNG or JPEG · up to 5 MiB. Selecting a photo does not upload it.</p>
            <button className={styles.secondary} disabled={editingLocked || !permitted || !state.photoUrl || !!state.uploadedId}
              onClick={() => void controller.uploadPhoto()}>{state.uploadedId ? "Reference uploaded" : "Upload reference"}</button>
          </section>
        </aside>

        <section className={styles.screening} aria-labelledby="screening-title">
          <div className={styles.screeningHeading}>
            <h2 id="screening-title">{status}</h2>
            <span className={styles.demoLabel}>Synthetic product demo</span>
          </div>
          {ready && !state.movieUrl && <button className={styles.primary} disabled={locked || !permitted} onClick={() => void controller.loadMovie()}>Load movie</button>}

          {job && <section className={styles.progress} aria-labelledby="progress-heading">
            <h3 id="progress-heading">Movie progress</h3>
            <div className={styles.jobStatus} role="status"><strong>{job.status}</strong><span>{job.stage || "No stage reported"}</span></div>
            <p className={styles.help}>Reported by Dwight · {job.attempts} attempt{job.attempts === 1 ? "" : "s"}. {waiting ? "Keep this session open, or end it to request cancellation." : "This job is no longer waiting to finish."}</p>
            {job.error && <p className={styles.error} role="alert">{job.error.code}: {job.error.message}</p>}
            {job.warnings.length > 0 && <ul className={styles.warnings}>{job.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
          </section>}

          <section className={styles.brief} aria-labelledby="brief-heading">
            <div className={styles.briefHeading}>
              <div><h3 id="brief-heading" tabIndex={-1}>The concept brief</h3><p className={styles.help}>Demo car · synthetic concept, not a production vehicle</p></div>
              <button className={styles.secondary} disabled={editingLocked || !permitted || !snapshot?.customer || !snapshot.context}
                onClick={() => void controller.createBrief()}>{brief ? "Refresh brief" : "Create brief"}</button>
            </div>
            {brief ? <>
              <p className={styles.objective}>{brief.objective}</p>
              <p className={styles.help}>{brief.provenance === "mock" ? "Synthetic mock brief" : "Generated brief"} · {brief.templateId} · context revision {brief.contextRevision}</p>
              <div className={styles.briefPreferences}><strong>Approved preferences in this brief</strong>
                <p>{brief.audiencePreferences.length ? brief.audiencePreferences.join(" · ") : "No additional preferences."}</p>
              </div>
              <ol className={styles.scenes}>{brief.scenes.map((scene, index) => <li key={index}>
                <div className={styles.sceneHeader}><strong>Scene {index + 1}</strong><span>{scene.durationSeconds} sec</span></div>
                <p>{scene.visual}</p><blockquote>{scene.onScreenText}</blockquote>
              </li>)}</ol>
              <div className={styles.cta}><strong>Call to action</strong><p>{brief.callToAction}</p></div>
              <div className={styles.createArea}>
                <button className={styles.primary}
                  disabled={locked || !permitted || !state.uploadedId || !!job || brief.contextRevision !== contextRevision}
                  onClick={() => void controller.startMedia()}>{state.startAttempted && !job ? "Retry same movie request" : "Create this movie"}</button>
                <p className={styles.help}>{state.startAttempted && !job
                  ? "The acknowledgement is uncertain. Retry reuses the same key and reference; it does not request a second render."
                  : state.uploadedId ? "Uses this brief and the latest reference uploaded by this tablet." : "Upload your reference on the left to continue."}</p>
              </div>
            </> : <p className={styles.emptyBrief}>Your confirmed preferences will become a short sequence of scenes. You’ll see the copy, timing and call to action here before any movie request.</p>}
          </section>
        </section>
      </div>
      </details>
      <div className={styles.activity} role="status" aria-live="polite">{state.busy ? `${state.busy}…` : active ? "Session connected. You can end it at any time." : "No automatic session creation. Your guide controls pairing."}</div>
      <footer className={styles.footer}><span>Movie Magic · Showroom tablet</span><span>Separate from the creator workbench · refresh requires trusted rejoining</span></footer>
    </main>
  );
}
