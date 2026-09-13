import type { StoryboardFrame } from "../../integration/contracts";
import { selectStoryboardFrames } from "../domain/storyboard-state";

export function mainStoryboardFrames(
  frames: StoryboardFrame[],
  shotIds: string[] = ["shot_01", "shot_02", "shot_03", "shot_04"],
): StoryboardFrame[] {
  return selectStoryboardFrames(frames, shotIds);
}
