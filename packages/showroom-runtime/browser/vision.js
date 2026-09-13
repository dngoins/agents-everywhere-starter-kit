export async function createFaceScanner({
  vision,
  wasmPath = '/vision/wasm',
  modelAssetPath = '/vision/blaze_face_short_range.tflite',
  minDetectionConfidence = 0.62,
  minSuppressionThreshold = 0.3,
}) {
  const fileset = await vision.FilesetResolver.forVisionTasks(wasmPath);
  const detector = await vision.FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath },
    runningMode: 'VIDEO',
    minDetectionConfidence,
    minSuppressionThreshold,
  });
  return {
    detect(video, timestamp = performance.now()) {
      return detector.detectForVideo(video, timestamp).detections ?? [];
    },
    close() { detector.close(); },
  };
}
