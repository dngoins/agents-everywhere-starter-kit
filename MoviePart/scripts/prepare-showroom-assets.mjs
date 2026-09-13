import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareVisionAssets } from '@magicpitch/showroom-runtime/assets';

const root = fileURLToPath(new URL('../', import.meta.url));
await prepareVisionAssets({
  root, destination: path.join(root, 'public', 'showroom-models'),
  modelNames: ['faceLandmarker', 'poseLandmarker'],
});
console.log('Local face/pose models and WASM are ready at /showroom-models. Detection does not upload camera frames.');
