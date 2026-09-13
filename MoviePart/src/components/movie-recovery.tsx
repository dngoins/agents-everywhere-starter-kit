import React from "react";
import type { JobView } from "../../integration/contracts";

export function MovieRecovery({ job, retrying, disabled, onRetry }: {
  job: JobView; retrying: boolean; disabled: boolean; onRetry: () => void;
}) {
  if (job.status !== "FAILED" || !job.retry?.eligible) return null;
  const { approvedShots, remainingShots } = job.retry;
  return <section className="movie-recovery" aria-label="Resume incomplete movie">
    <h3>{remainingShots ? "Continue this movie, not a new take" : "Your approved storyboard is ready for assembly"}</h3>
    <p id="retry-description">Keep the saved director plan, original references, and {approvedShots} approved {approvedShots === 1 ? "shot" : "shots"}. {remainingShots ? `Retry the ${remainingShots} failed or missing shots with their latest review corrections. Only new generation and review work may incur API charges.` : "No storyboard images or director plan will be regenerated."}</p>
    <p>Retry uses this movie’s saved settings, not changes in the form. A final movie is produced only when every required shot is approved.</p>
    <p>If an optional hero-video step has not run yet, it may still run under the saved settings and incur charges. A previously attempted hero video is not resubmitted.</p>
    <button type="button" className="retry-button" disabled={disabled || retrying} aria-describedby="retry-description" onClick={onRetry}>{retrying ? "Requesting retry…" : remainingShots ? "Retry failed and remaining shots" : "Retry final assembly"}</button>
  </section>;
}
