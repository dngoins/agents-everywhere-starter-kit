import type { StoryboardFrame } from "../../integration/contracts";

export function mainStoryboardFrames(
  frames: StoryboardFrame[],
  shotIds: string[] = ["shot_01", "shot_02", "shot_03", "shot_04"],
): StoryboardFrame[] {
  const latest = new Map(frames.map(frame => [frame.shotId, frame]));
  return shotIds.flatMap(id => {
    const frame = latest.get(id);
    return frame ? [frame] : [];
  });
}
