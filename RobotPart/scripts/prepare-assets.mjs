import { cp, mkdir, access, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(root, "public/vision");
await mkdir(destination, { recursive: true });
await cp(path.join(root, "node_modules/@mediapipe/tasks-vision/wasm"), path.join(destination, "wasm"), { recursive: true });
const model = path.join(destination, "blaze_face_short_range.tflite");
try {
  await access(model);
} catch {
  const response = await fetch("https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite", {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Face model download failed (${response.status}). Retry npm run assets.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 100_000 || new TextDecoder().decode(bytes.slice(4, 8)) !== "TFL3") {
    throw new Error("Downloaded file is not a valid face model. Retry npm run assets.");
  }
  await writeFile(model, bytes);
}
console.log("Local face model and WASM are ready in public/vision (no camera frames leave the tablet for detection).");