import { fileURLToPath } from "node:url";
import path from "node:path";
import { prepareVisionAssets } from "@magicpitch/showroom-runtime/assets";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(root, "public/vision");
await prepareVisionAssets({ root, destination });
console.log("Local face model and WASM are ready in public/vision (no camera frames leave the tablet for detection).");