import { getMovieFormat, MovieError, type MovieJob, type VideoSegment } from "./index";

export function videoClipCount(job: MovieJob): 1 | 2 | 3 {
  return job.request.render_layout === "video-bookends" ? getMovieFormat(job.request.movie_duration_seconds).clipCount : 1;
}

export function savedVideoSegments(job: MovieJob): VideoSegment[] {
  const count = videoClipCount(job);
  const provider = job.request.video_provider === "openai-sora" ? "OpenAI Sora" : "Google Veo";
  const operations = job.operations.filter(item => item.provider === provider);
  const saved = new Map<number, VideoSegment>();
  for (const segment of job.videoSegments ?? []) {
    if (saved.has(segment.index) || segment.index >= count) {
      throw new MovieError("INVALID_VIDEO_STATE", "The saved animation sequence does not match the requested movie length.", 409);
    }
    saved.set(segment.index, segment);
  }
  const operationIds = new Set<string>();
  return Array.from({ length: count }, (_, index) => {
    const previous = saved.get(index);
    const operation = count === 1 ? operations.at(-1) : operations[index];
    if (previous?.operationId && operation && previous.operationId !== operation.id) {
      throw new MovieError("INVALID_VIDEO_STATE", "The saved animation operation does not match its segment.", 409);
    }
    if (index === 0 && previous?.clip && job.hero && previous.clip.assetId !== job.hero.assetId) {
      throw new MovieError("INVALID_VIDEO_STATE", "The first animation segment does not match the saved hero clip.", 409);
    }
    const operationId = previous?.operationId ?? operation?.id;
    if (operationId) {
      if (operationIds.has(operationId)) throw new MovieError("INVALID_VIDEO_STATE", "The same video operation cannot fill multiple animation segments.", 409);
      operationIds.add(operationId);
    }
    return {
      index, submitted: previous?.submitted ?? (index === 0 ? !!job.heroAttempted : false),
      ...(previous?.startFrameAssetId ? { startFrameAssetId: previous.startFrameAssetId } : {}),
      ...(previous?.clip ? { clip: previous.clip } : index === 0 && job.hero ? { clip: job.hero } : {}),
      ...(operationId ? { operationId } : {}),
    };
  });
}

export function hasUncertainVideoSegment(job: MovieJob): boolean {
  return !!job.videoSegments && savedVideoSegments(job).some(segment => segment.submitted && !segment.operationId && !segment.clip);
}
