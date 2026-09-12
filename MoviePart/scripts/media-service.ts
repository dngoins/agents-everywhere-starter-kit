import path from "node:path";
import { createLiveExecutor } from "../src/media-service/executor";
import { createMediaHttpServer } from "../src/media-service/http";
import { MediaService } from "../src/media-service/service";

async function main() {
  const token = process.env.MEDIA_SERVICE_TOKEN;
  if (!token?.trim()) throw new Error("MEDIA_SERVICE_TOKEN_REQUIRED");
  const port = Number(process.env.MEDIA_SERVICE_PORT ?? 3201);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("INVALID_PORT");
  const tools = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
  const service = new MediaService({
    directory: path.join(process.env.MOVIE_DATA_DIR ?? ".movie-data", "media-service"),
    executor: createLiveExecutor({
      ...tools, apiKey: process.env.OPENAI_API_KEY, imageModel: process.env.OPENAI_IMAGE_MODEL,
    }),
    ...tools,
  });
  await service.start();
  const server = createMediaHttpServer(service, token);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) { await service.close(); throw error; }
  console.log(`Media service: http://127.0.0.1:${port} (server-to-server authentication only).`);
  console.log(await service.ready() ? "Live adapter locally configured; paid generation has not been verified." : "Not ready: OpenAI key and local FFmpeg/ffprobe are required; submissions return 503.");
  console.log("Deletion covers renderer-held files only. OpenAI may retain submitted images under its API data policy; aborting a request cannot recall vendor-held data or guarantee cancellation of charges.");
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {});
    void service.close().then(() => { server.closeAllConnections(); }, () => {
      console.error("Shutdown incomplete. Retained private receipts require cleanup reconciliation.");
      process.exitCode = 1;
      server.closeAllConnections();
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch(() => {
  console.error("Media service could not start. Check its separate token, local executables, port, and private store lease.");
  process.exitCode = 1;
});
