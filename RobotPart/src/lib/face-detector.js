import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { createFaceScanner as createScanner } from "@magicpitch/showroom-runtime/browser";

export function createFaceScanner(options = {}) {
  return createScanner({ vision: { FaceDetector, FilesetResolver }, ...options });
}