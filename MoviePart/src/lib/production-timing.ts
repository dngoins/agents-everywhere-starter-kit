import type { JobView } from "../../integration/contracts";

export const PRODUCTION_TARGET_SECONDS = 120;

export function productionTiming(job: JobView | null, now: number) {
  if (!job) return null;
  const accepted = [...job.events].reverse().find(event => event.stage === "RECEIVED")?.at ?? job.createdAt;
  const start = Date.parse(accepted);
  const terminal = job.status === "COMPLETED" || job.status === "FAILED";
  const end = terminal ? Date.parse(job.updatedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const elapsedSeconds = Math.max(0, Math.floor((end - start) / 1000));
  return {
    elapsedSeconds,
    label: `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`,
    overTarget: elapsedSeconds >= PRODUCTION_TARGET_SECONDS,
    terminal,
  };
}
