import type { StoryboardFrame } from "./index";

/** Select the latest approval, or the latest rejected candidate if none passed. */
export function selectStoryboardFrames(frames: StoryboardFrame[], shotIds: readonly string[]): StoryboardFrame[] {
  const latest = new Map<string, StoryboardFrame>();
  const approved = new Map<string, StoryboardFrame>();
  for (const frame of frames) {
    latest.set(frame.shotId, frame);
    if (frame.continuity.verdict === "PASS") approved.set(frame.shotId, frame);
  }
  return shotIds.flatMap(id => {
    const frame = approved.get(id) ?? latest.get(id);
    return frame ? [frame] : [];
  });
}
