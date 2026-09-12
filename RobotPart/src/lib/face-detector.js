import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";

export async function createFaceScanner() {
  const vision = await FilesetResolver.forVisionTasks("/vision/wasm");
  const detector = await FaceDetector.createFromOptions(vision, {
    baseOptions: { modelAssetPath: "/vision/blaze_face_short_range.tflite" },
    runningMode: "VIDEO",
    minDetectionConfidence: 0.62,
    minSuppressionThreshold: 0.3,
  });
  return {
    detect(video, timestamp = performance.now()) {
      return detector.detectForVideo(video, timestamp).detections ?? [];
    },
    close() { detector.close(); },
  };
}