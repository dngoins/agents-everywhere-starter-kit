import { toNamespacedPath } from "node:path";

export function mediaCommandPath(path: string): string {
  // The bundled Windows ffprobe uses legacy file APIs. Its extended-length
  // path form is necessary in deep worktrees even when Node/FFmpeg can open
  // the ordinary path. This is an argv value, never a shell-quoted string.
  return path.length >= 248 ? toNamespacedPath(path) : path;
}
