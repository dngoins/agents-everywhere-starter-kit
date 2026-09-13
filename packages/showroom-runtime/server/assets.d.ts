export function prepareVisionAssets(options: {
  root: string;
  destination: string;
  modelNames?: readonly ('faceDetector' | 'faceLandmarker' | 'poseLandmarker')[];
  fetcher?: typeof globalThis.fetch;
}): Promise<void>;
