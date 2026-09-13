import type { StoryboardFrame } from "./index";

export function isFrameApproved(frame: StoryboardFrame): boolean {
  if (frame.designerDecision) return frame.designerDecision.action === "keep";
  return frame.continuity.verdict === "PASS";
}

/** Select the latest approval, or the latest rejected candidate if none passed. */
export function selectStoryboardFrames(frames: StoryboardFrame[], shotIds: readonly string[]): StoryboardFrame[] {
  const latest = new Map<string, StoryboardFrame>();
  const approved = new Map<string, StoryboardFrame>();
  const kept = new Map<string, StoryboardFrame>();
  for (const frame of frames) {
    latest.set(frame.shotId, frame);
    if (isFrameApproved(frame)) approved.set(frame.shotId, frame);
    if (frame.designerDecision?.action === "keep") kept.set(frame.shotId, frame);
  }
  return shotIds.flatMap(id => {
    const frame = kept.get(id) ?? approved.get(id) ?? latest.get(id);
    return frame ? [frame] : [];
  });
}
