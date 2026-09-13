"use client";

import { useEffect, useRef, useState } from "react";
import type { AssetView, ConfigView, JobView } from "../domain/http";
import { getTimeline, type HeroMode, type JobRequest, type JobStatus, type StoryFormat, type TemplateId } from "../domain";
import { allTemplates as templates, getTemplate } from "../templates";
import { mainStoryboardFrames } from "../lib/storyboard-view";
import { MovieMagicClient } from "../../integration/client";
import { CarReferences } from "../components/car-references";
import { creationBlockers, selectableProducts } from "../lib/studio-readiness";
import type { MovieRetryRequest } from "../../integration/contracts";
import { MovieRecovery } from "../components/movie-recovery";

const stageLabels: Record<JobStatus, string> = {
  RECEIVED: "Queued for the studio",
  BUILDING_REFERENCES: "Establishing your reference",
  DIRECTING: "Directing your story",
  STORYBOARDING: "Creating the storyboard",
  VALIDATING: "Reviewing visual continuity",
  GENERATING_HERO: "Animating your hero shot",
  ASSEMBLING: "Assembling your movie",
  COMPLETED: "Your movie is ready",
  FAILED: "This take needs attention",
};
const terminal = (job: JobView | null) => job?.status === "COMPLETED" || job?.status === "FAILED";
const mediaUrl = (id: string) => `/api/movie-assets/${encodeURIComponent(id)}`;

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return body as T;
}

function FrameIcon() {
  return <svg viewBox="0 0 64 48" fill="none" aria-hidden="true">
    <rect x="8" y="7" width="48" height="34" rx="3" stroke="currentColor" />
    <path d="m10 34 14-13 11 9 8-6 12 11" stroke="currentColor" />
    <circle cx="43" cy="17" r="4" stroke="currentColor" />
  </svg>;
}

export default function MovieStudio() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [error, setError] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [primary, setPrimary] = useState(0);
  const [product, setProduct] = useState("tesla-model-y");
  const [template, setTemplate] = useState<TemplateId>("TOMORROW_DRIVE");
  const [storyFormat, setStoryFormat] = useState<StoryFormat>("four-shot");
  const [heroMode, setHeroMode] = useState<HeroMode>("LIKENESS");
  const [firstName, setFirstName] = useState("");
  const [city, setCity] = useState("");
  const [interests, setInterests] = useState(["", "", ""]);
  const [likeness, setLikeness] = useState(false);
  const [personalization, setPersonalization] = useState(false);
  const [hero, setHero] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showBlockers, setShowBlockers] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const [pollRevision, setPollRevision] = useState(0);
  const retryInFlight = useRef(false);
  const pendingRetry = useRef<{ jobId: string; request: MovieRetryRequest } | null>(null);
  const pendingRequest = useRef<JobRequest | null>(null);
  const uploading = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = submitting || retrying || Boolean(jobId && !terminal(job));
  const ready = Boolean(config?.providers.openai.available && config.worker.available && config.renderer.available && config.products.some(item => item.id === product && item.ready));
  const products = selectableProducts(config);
  const blockers = creationBlockers({
    config, productId: product, needsPhotos: heroMode === "LIKENESS", photoCount: files.length,
    generationConsent: likeness, personalizationConsent: personalization,
  });

  async function refreshConfig() {
    try {
      const value = await requestJson<ConfigView>("/api/movie-config");
      setConfig(value);
      setProduct(current => current || value.products.find(item => item.ready)?.id || value.products[0]?.id || "");
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load the studio configuration.");
    }
  }

  useEffect(() => {
    void refreshConfig();
    setJobId(localStorage.getItem("movie-magic:last-job"));
  }, []);

  useEffect(() => {
    const urls = files.map(file => URL.createObjectURL(file));
    setThumbnails(urls);
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, [files]);

  useEffect(() => {
    if (!jobId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function poll() {
      try {
        const result = await requestJson<{ job: JobView }>(`/api/movie-jobs/${jobId}`, { signal: controller.signal });
        if (disposed) return;
        setJob(result.job);
        setError("");
        if (!terminal(result.job)) timer = setTimeout(poll, 2000);
      } catch (failure) {
        if (disposed) return;
        setError(failure instanceof Error ? failure.message : "Could not retrieve this movie.");
        // A disconnected browser must not submit a second billable job to recover.
        timer = setTimeout(poll, 5000);
      }
    }
    void poll();
    return () => { disposed = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [jobId, pollRevision]);

  function changed() { pendingRequest.current = null; }

  function chooseFiles(selected: FileList | null) {
    if (!selected) return;
    const next = Array.from(selected);
    if (next.length < 1 || next.length > 4 || next.some(file => file.size > 10 * 1024 * 1024)) {
      setError("Choose 1–4 photos, each no larger than 10 MiB.");
      return;
    }
    changed();
    setFiles(next);
    setPrimary(0);
    setError("");
  }

  async function createMovie() {
    if (uploading.current || busy) return;
    setShowBlockers(true);
    if (blockers.length) {
      document.getElementById("creation-requirements")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    uploading.current = true;
    setSubmitting(true);
    setError("");
    try {
      let body = pendingRequest.current;
      if (!body) {
        let assets: AssetView[] = [];
        if (heroMode === "LIKENESS") {
          const form = new FormData();
          files.forEach(file => form.append("photos", file));
          form.append("consent", JSON.stringify({ likeness, personalization }));
          const uploaded = await requestJson<{ assets: AssetView[] }>("/api/movie-assets", { method: "POST", body: form });
          if (!uploaded.assets[primary] || uploaded.assets.length !== files.length) throw new Error("The upload returned an incomplete reference set.");
          assets = uploaded.assets;
        }
        body = {
          schema_version: 1,
          session_id: `studio-${crypto.randomUUID()}`,
          customer_reference_asset_ids: assets.map(asset => asset.id),
          primary_reference_asset_id: assets[primary]?.id ?? null,
          consent: { likeness: true, personalization: true },
          product_id: product,
          preferred_template: template,
          story_format: storyFormat,
          hero_mode: heroMode,
          personalization_profile: {
            ...(firstName.trim() ? { customerFirstName: firstName.trim() } : {}),
            ...(city.trim() ? { city: city.trim() } : {}),
            signals: [...new Set(interests.map(value => value.trim()).filter(Boolean))].map(value => ({
              value, source: "manual", visualUseAllowed: true, confidence: null,
            })),
          },
          enable_hero_video: hero,
          idempotency_key: crypto.randomUUID(),
        };
        pendingRequest.current = body;
      }
      const result = await requestJson<{ job_id: string }>("/api/movie-jobs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      localStorage.setItem("movie-magic:last-job", result.job_id);
      setJob(null);
      setJobId(result.job_id);
      setRetryError("");
      pendingRetry.current = null;
      pendingRequest.current = null;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not submit your movie.");
    } finally {
      uploading.current = false;
      setSubmitting(false);
    }
  }

  async function retryMovie() {
    if (!job || !job.retry?.eligible || busy || retryInFlight.current) return;
    retryInFlight.current = true;
    setRetrying(true);
    setRetryError("");
    const client = new MovieMagicClient({ baseUrl: window.location.origin });
    if (pendingRetry.current?.jobId !== job.id) {
      pendingRetry.current = {
        jobId: job.id, request: { idempotency_key: crypto.randomUUID(), expected_attempt: job.retry.attempt },
      };
    }
    try {
      await client.retryJob(job.id, pendingRetry.current.request);
      // Keep the receipt until the authoritative job read succeeds. A lost
      // response must not authorize a second billable retry.
      const updated = await client.getJob(job.id);
      setJob(updated);
      pendingRetry.current = null;
    } catch (failure) {
      setRetryError(failure instanceof Error ? failure.message : "Could not request the retry. The saved plan and shots remain available.");
    } finally {
      setRetrying(false);
      retryInFlight.current = false;
      setPollRevision(value => value + 1);
    }
  }

  async function deleteMovie() {
    if (!job || busy || !terminal(job) || !window.confirm("Delete this movie and its unshared private files? This cannot be undone.")) return;
    try {
      await new MovieMagicClient({ baseUrl: window.location.origin }).deleteJob(job.id);
      setJob(null);
      setJobId(null);
      pendingRetry.current = null;
      setRetryError("");
      localStorage.removeItem("movie-magic:last-job");
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not delete this movie.");
    }
  }

  const selectedTemplate = getTemplate(template, storyFormat);
  const timeline = getTimeline(job?.plan?.storyFormat ?? storyFormat, job?.plan?.templateId ?? template);
  const shotIds = job?.plan?.shots.map(shot => shot.id) ?? timeline.shotIds;
  const storyboardFrames = mainStoryboardFrames(job?.frames ?? [], shotIds);
  const approvedCount = storyboardFrames.filter(frame => frame.continuity.verdict === "PASS").length;
  const completeMovie = job?.status === "COMPLETED" && approvedCount === shotIds.length ? job.result : null;
  return <div className="studio">
    <header className="masthead">
      <a href="/" className="wordmark" aria-label="Movie Magic home"><span className="mark">m<span>m</span></span> movie magic<span className="wordmark-dot">.</span></a>
      <div className="masthead-right"><a className="text-button" href="/kiosk">Open showroom kiosk ↗</a><span className="edition">MAGICPITCH / THE PERSONAL FILM STUDIO</span><span className={`setup-pill ${ready ? "is-ready" : ""}`}><i />{ready ? "Studio ready" : "Setup required"}</span></div>
    </header>

    <main>
      <section className="intro">
        <div><p className="eyebrow">THE NEXT GREAT CAR STORY IS YOURS</p><h1>You. In the <em>driver’s seat.</em></h1><p className="intro-copy">Your photos. Your personality. A little movie magic.<br />Turn a test drive of the imagination into your own cinematic moment.</p></div>
        <div className="format-stamp"><span>{timeline.durationSeconds}</span><div>SECONDS<br />{shotIds.length === 6 ? "SIX" : "FOUR"} SHOTS<br />ONE ORIGINAL STORY</div></div>
      </section>

      <div className="workspace">
        <aside className="brief-panel" aria-label="Your movie brief">
          <div className="panel-heading"><span className="eyebrow">THE CREATIVE BRIEF</span><span className="small-muted">01 — 03</span></div>
          <fieldset disabled={busy}>
            <section className="brief-section">
              <h2><span className="step">01</span>Meet the lead</h2>
              <label className="field-label" htmlFor="hero-mode">HOW YOU APPEAR</label>
              <select id="hero-mode" value={heroMode} onChange={event => {
                changed(); setHeroMode(event.target.value as HeroMode); setLikeness(false);
                setFiles([]); setPrimary(0);
              }}>
                <option value="LIKENESS">Likeness — your approved photos</option>
                <option value="POV">First-person — no face or photos</option>
                <option value="PERSONALIZED">Personalized — a generic driver</option>
              </select>
              {heroMode === "LIKENESS" ? <>
              <p className="field-help">That’s you. Add 3–4 photos from different angles. Choose a primary photo for your outfit.</p>
              <input ref={fileInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={event => chooseFiles(event.target.files)} aria-label="Upload customer reference photos" />
              {thumbnails.length ? <div className="photo-grid">{thumbnails.map((url, index) =>
                <button key={url} type="button" className={`photo ${primary === index ? "selected" : ""}`} onClick={() => { changed(); setPrimary(index); }} aria-label={`Use photo ${index + 1} as primary`} aria-pressed={primary === index}>
                  {/* Local object URLs are user-selected previews, not remote image sources. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={`Your reference photo ${index + 1}`} /><span>{primary === index ? "PRIMARY" : `0${index + 1}`}</span>
                </button>)}</div> :
                <button className="upload-zone" type="button" onClick={() => fileInput.current?.click()}><span className="upload-symbol">+</span><strong>Add your photos</strong><span>JPG, PNG or WebP · Up to 10 MiB each</span></button>}
              {files.length > 0 && <button className="text-button" type="button" onClick={() => fileInput.current?.click()}>Replace photos <span aria-hidden="true">↗</span></button>}
              </> : <p className="field-help">{heroMode === "POV" ? "The camera takes the driver's point of view. Your face is not depicted." : "A generic driver is seen from behind or in silhouette. This does not recreate your likeness."} No customer photo is uploaded or sent to a generation provider.</p>}
              <div className="consent-block">
                <label><input type="checkbox" checked={likeness} onChange={event => { changed(); setLikeness(event.target.checked); }} /><span>{heroMode === "LIKENESS" ? `I have permission to use this person's likeness and send these photos to OpenAI${hero ? " and Google" : ""} for generation.` : `I approve this ${heroMode === "POV" ? "first-person" : "generic-driver"} advertisement being generated by OpenAI${hero ? " and Google" : ""}, without representing my actual face.`}</span></label>
                <label><input type="checkbox" checked={personalization} onChange={event => { changed(); setPersonalization(event.target.checked); }} /><span>I approve using the interests I provide in this advertisement.</span></label>
              </div>
            </section>
            <section className="brief-section">
              <h2><span className="step">02</span>Choose your car</h2>
              <label className="field-label" htmlFor="car">REFERENCE-BACKED VEHICLE</label>
              <select id="car" value={product} onChange={event => { changed(); setProduct(event.target.value); }}>
                <option value="">Select a reference-backed car</option>
                {products.map(item => <option key={item.id} value={item.id}>{item.name}{!item.ready ? " — add references" : ""}</option>)}
              </select>
              <div className="vehicle-choices" role="group" aria-label="Choose a reference-backed car">
                {products.map(item => <button type="button" key={item.id} aria-pressed={item.id === product} className={item.id === product ? "selected" : ""} onClick={() => { changed(); setProduct(item.id); }}>
                  <strong>{item.name}</strong><span>{item.ready ? "Reference pack ready" : "Add exterior + interior photos"}</span>
                </button>)}
              </div>
              {!config && <p className="field-help">Car choices are available. Reconnect to the studio before saving references or generating.</p>}
              <CarReferences productId={product} ready={!!config?.products.find(item => item.id === product)?.ready} onSaved={refreshConfig} />
              <label className="field-label interests-label">A FEW THINGS YOU LOVE <span>OPTIONAL</span></label>
              <div className="interests">{interests.map((value, index) => <input key={index} aria-label={`Personalization interest ${index + 1}`} value={value} maxLength={100} placeholder={["e.g. coastal drives", "e.g. architecture", "e.g. dogs"][index]} onChange={event => { changed(); setInterests(current => current.map((entry, at) => at === index ? event.target.value : entry)); }} />)}</div>
              <p className="field-help">Small details, not a new identity. Up to three interests, supplied by you.</p>
              <div className="interests personal-context">
                <label htmlFor="first-name" className="field-label">FIRST NAME <span>OPTIONAL</span></label>
                <input id="first-name" value={firstName} maxLength={80} placeholder="Your approved first name" onChange={event => { changed(); setFirstName(event.target.value); }} />
                <label htmlFor="customer-city" className="field-label">CITY <span>OPTIONAL</span></label>
                <input id="customer-city" value={city} maxLength={120} placeholder="An approved setting" onChange={event => { changed(); setCity(event.target.value); }} />
              </div>
            </section>
            <section className="brief-section template-section">
              <h2><span className="step">03</span>Set the direction</h2>
              <label className="field-label" htmlFor="story-format">STORY FORMAT</label>
              <select id="story-format" value={storyFormat} onChange={event => { changed(); setStoryFormat(event.target.value as StoryFormat); }}>
                <option value="four-shot">Classic · four shots · 18 seconds</option>
                <option value="six-shot">Tiya's story arc · six shots · {template === "HERO_OF_THE_DAY" ? "24" : "23"} seconds</option>
              </select>
              <div className="template-options" role="group" aria-label="Movie template">{templates.map((item, index) =>
                <button key={item.id} type="button" className={`template-option ${template === item.id ? "selected" : ""}`} aria-pressed={template === item.id} onClick={() => { changed(); setTemplate(item.id); }}>
                  <span className="template-index">0{index + 1}</span><span><strong>{item.name}</strong><small>{item.description}</small></span><span className="radio-dot" />
                </button>)}</div>
              <label className="hero-toggle"><input type="checkbox" checked={hero} disabled={!config?.providers.veo.available} onChange={event => { changed(); setHero(event.target.checked); setLikeness(false); }} /><span><strong>Add a Veo hero shot</strong><small>Optional paid enhancement. Your movie still renders if video generation is unavailable.</small></span></label>
            </section>
          </fieldset>
          <div className="create-area">
            <button className="create-button" onClick={() => void createMovie()} disabled={busy} aria-describedby="creation-requirements">{submitting ? "Preparing your references…" : busy ? "Your film is in production…" : "Create my movie"}<span aria-hidden="true">{busy ? "◌" : "↗"}</span></button>
            <div id="creation-requirements" className={`creation-requirements ${showBlockers ? "expanded" : ""}`} aria-live="polite">
              {!busy && blockers.length > 0 && <>
                <strong>{showBlockers ? "Complete these steps to create your movie" : `${blockers.length} setup steps remaining`}</strong>
                {showBlockers ? <ul>{blockers.map(message => <li key={message}>{message}</li>)}</ul> : <p>Click Create to see exactly what is missing. No paid request will start until everything is ready.</p>}
                <button type="button" className="text-button" onClick={() => void refreshConfig()}>Refresh server readiness</button>
              </>}
              {!busy && blockers.length === 0 && <strong>References, permissions and studio services are ready.</strong>}
            </div>
            <p>Original photos stay private. Paid generation starts only when you create.</p>
          </div>
        </aside>

        <section className="screening-room" aria-label="Movie preview and progress">
          <div className="screening-heading"><div><p className="eyebrow">YOUR PRIVATE SCREENING ROOM</p><h2>{job ? stageLabels[job.status] : "The story starts here."}</h2></div><span className="ratio-tag">16:9 / HD</span></div>
          <div className={`cinema-screen ${completeMovie ? "has-video" : ""}`}>
            {completeMovie ? <video key={completeMovie.assetId} controls preload="metadata" src={mediaUrl(completeMovie.assetId)} aria-label="Your completed personalized movie" /> : <div className="screen-empty">
              <div className="screen-guide corner-tl" /><div className="screen-guide corner-tr" /><div className="screen-guide corner-bl" /><div className="screen-guide corner-br" />
              <span className="screen-kicker">{job?.status === "FAILED" ? "INCOMPLETE STORYBOARD" : job ? "IN THE MAKING" : "CAST YOURSELF"}</span>
              <div className="screen-title">{job ? (job.plan?.logline || stageLabels[job.status]) : <>A familiar face.<br />An entirely new <em>perspective.</em></>}</div>
              <span className="screen-caption">{job ? `${approvedCount} of ${shotIds.length} storyboard frames approved` : `${selectedTemplate.name.toUpperCase()} · AN ORIGINAL MOVIE MAGIC FILM`}</span>
              <span className="screen-bottom">REFERENCE-LED. PERSONALLY DIRECTED.</span>
            </div>}
          </div>
          {completeMovie && <div className="result-bar"><span><i />{completeMovie.mode === "hybrid-video" ? "Hybrid film · one Veo hero shot" : "Storyboard-motion film"} · {completeMovie.durationSeconds.toFixed(1)}s{!completeMovie.hasAudio ? " · No audio" : ""}</span><a href={mediaUrl(completeMovie.assetId)} download="my-movie.mp4">Download film ↗</a></div>}

          {error && <div className="notice error" role="alert"><strong>Something needs your attention</strong><p>{error}</p>{jobId && !job && <button className="text-button" onClick={() => { setJobId(null); localStorage.removeItem("movie-magic:last-job"); }}>Stop watching this job</button>}</div>}
          {job?.error && <div className="notice error" role="alert"><strong>{stageLabels[job.error.stage]}</strong><p>{job.error.message}</p><small>Your saved plan and artifacts remain below. {job.retry?.eligible ? "Retry this movie to keep approved work, or create a new take to change its brief." : "A new take requires an explicit submission."}</small></div>}
          {job && <MovieRecovery job={job} retrying={retrying} disabled={busy} onRetry={() => void retryMovie()} />}
          {retryError && <div className="notice error" role="alert"><strong>Retry needs attention</strong><p>{retryError}</p><p>Retrying this request uses the same key; it does not automatically authorize a second attempt.</p><button className="text-button" onClick={() => { pendingRetry.current = null; setRetryError(""); setPollRevision(value => value + 1); }}>Refresh movie before a new retry decision</button></div>}
          {!!job?.warnings.length && <div className="notice"><strong>Production notes</strong>{job.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}

          <div className="storyboard-heading"><h3>The storyboard <span>{String(storyboardFrames.length).padStart(2, "0")} / {String(shotIds.length).padStart(2, "0")}</span></h3><span className="small-muted">CONSISTENT REFERENCES. ONE STORY.</span></div>
          {job?.plan && !completeMovie && <p className="incomplete-label">{approvedCount < shotIds.length ? `Incomplete storyboard preview — ${approvedCount} of ${shotIds.length} shots approved. This is not a finished movie.` : "All storyboard shots are approved. Final movie assembly has not completed."}</p>}
          <div className={`storyboard-grid ${shotIds.length === 6 ? "six-shots" : ""}`}>{shotIds.map((shotId, index) => {
            const frame = storyboardFrames.find(item => item.shotId === shotId);
            const shot = job?.plan?.shots[index];
            return <article className="storyboard-card" key={shotId}><div className="frame-image">{frame ?
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mediaUrl(frame.assetId)} alt={shot?.action || `Storyboard shot ${index + 1}`} /> : <FrameIcon />}
              <span className="frame-number">0{index + 1}</span></div><div className="frame-detail"><span>{(shotIds.length === 6 ? ["ORDINARY MOMENT", "THE SPARK", "CROSSING OVER", "THE IMPOSSIBLE", "MASTERY", "THE PAYOFF"] : ["THE BEGINNING", "THE CONNECTION", "THE JOURNEY", "THE ARRIVAL"])[index]}</span><small>{shot?.durationSeconds ?? timeline.durations[index]} SEC</small></div>
              {shot && <p>{shot.purpose}</p>}{frame ? <span className={`review-badge ${frame.continuity.verdict === "PASS" ? "" : "review-warning"}`}>{frame.continuity.verdict === "PASS" ? "Approved — kept on retry" : "Needs revision"}</span> : job?.plan && <span className="review-badge review-warning">Not generated</span>}
              {frame && frame.continuity.verdict !== "PASS" && <details className="frame-corrections"><summary>Review corrections</summary><ul>{frame.continuity.reasons.map((reason, at) => <li key={at}>{reason}</li>)}</ul></details>}
            </article>;
          })}</div>

          {job?.events.length ? <section className="production-log"><h3>From the production desk</h3><ol>{job.events.slice(-10).map((event, index) => <li key={`${event.at}-${index}`}><span className="log-dot" /><div><strong>{event.message}</strong><small>{event.provider ? `${event.provider} · ` : ""}{stageLabels[event.stage]}{event.shotId ? ` · ${event.shotId}` : ""}</small></div></li>)}</ol></section> : <div className="process-note"><span className="note-mark">✳</span><div><strong>A director, not a random prompt.</strong><p>We establish the permitted references, plan a {shotIds.length}-shot story, review the frames, then assemble the film. Likeness mode preserves your photos; first-person and generic-driver modes leave them out.</p></div></div>}

          {job?.character && <details className="artifact-details"><summary>Inspect reference notes &amp; director plan</summary><p>Visual notes supplement your original photos. They are not identity verification.</p><pre>{JSON.stringify({ character: job.character.attributes, plan: job.plan }, null, 2)}</pre></details>}
          {job?.hero && <details className="artifact-details"><summary>Preview the generated hero shot</summary><video controls preload="none" src={mediaUrl(job.hero.assetId)} /></details>}
          {terminal(job) && <button className="text-button delete-button" disabled={busy} onClick={() => void deleteMovie()}>Delete this movie &amp; unshared private files</button>}

          <details className="setup-details" open={config ? !ready : true}><summary>Studio setup <span>{ready ? "Ready for production" : "Configuration required"}</span></summary>
            <div className="readiness-grid">{[
              ["OpenAI", config?.providers.openai], ["Local worker", config?.worker], ["FFmpeg", config?.renderer], ["Veo (optional)", config?.providers.veo],
            ].map(([label, value]) => {
              const status = typeof value === "object" ? value : undefined;
              return <div key={String(label)}><span className={status?.available ? "ready-dot" : "waiting-dot"} /><strong>{String(label)}</strong><p>{status?.message || "Loading configuration…"}</p></div>;
            })}</div><p className="field-help">Configure <code>MoviePart/.env</code>, add your authorized car reference pack, and start <code>npm run worker</code>. No uploads or generation are sent while configuring.</p><button type="button" className="text-button" onClick={() => void refreshConfig()}>Refresh readiness ↗</button>
          </details>
        </section>
      </div>
    </main>
    <footer><span>MAGICPITCH <span className="footer-separator">/</span> MOVIE MAGIC ENGINE</span><span>Built around your consent. Directed around your story.</span></footer>
  </div>;
}
