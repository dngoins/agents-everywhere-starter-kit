import path from "node:path";
import { generateSample } from "../src/media-service/render";

const output = path.resolve(process.argv[2] ?? "sample-fixtures\\dwight-synthetic-sample.mp4");
generateSample(output, { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH })
  .then(() => console.log(`SYNTHETIC SAMPLE only (offline, no participant generation): ${output}`))
  .catch(() => { console.error("Synthetic sample rendering failed."); process.exitCode = 1; });
