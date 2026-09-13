import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const models = Object.freeze({
  faceDetector: {
    filename: 'blaze_face_short_range.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    minimum: 100_000,
    format: 'tflite',
  },
  faceLandmarker: {
    filename: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    minimum: 1_000_000,
    format: 'task',
  },
  poseLandmarker: {
    filename: 'pose_landmarker_lite.task',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    minimum: 1_000_000,
    format: 'task',
  },
});

function valid(bytes, model) {
  return bytes.length >= model.minimum && bytes.length <= 32 * 1024 * 1024
    && (model.format === 'tflite'
      ? bytes.subarray(4, 8).toString() === 'TFL3'
      : bytes.subarray(-65_557).includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])));
}

/** Public model downloads only; callers choose local destination and model set. */
export async function prepareVisionAssets({ root, destination, modelNames = ['faceDetector'], fetcher = globalThis.fetch }) {
  const selected = modelNames.map((name) => {
    if (!Object.hasOwn(models, name)) throw new TypeError(`Unknown vision model: ${name}`);
    return models[name];
  });
  await mkdir(destination, { recursive: true });
  await cp(path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'), path.join(destination, 'wasm'), { recursive: true });
  for (const model of selected) {
    const file = path.join(destination, model.filename);
    let exists = false;
    try { await access(file); exists = true; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (exists && valid(await readFile(file), model)) continue;
    const response = await fetcher(model.url, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Model download failed (HTTP ${response.status}). Retry asset preparation.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!valid(bytes, model)) throw new Error(`Invalid vision model: ${model.filename}. Retry asset preparation.`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
