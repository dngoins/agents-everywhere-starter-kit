import { MovieWorker } from "../src/jobs/worker";
import { loadConfig } from "../src/server/config";
import { MovieError } from "../src/domain";

const controller = new AbortController();
const stop = (signal: string) => {
  console.log(`Movie worker received ${signal}; stopping without resubmitting saved work.`);
  controller.abort();
};
const interrupt = () => stop("SIGINT");
const terminate = () => stop("SIGTERM");
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
const worker = new MovieWorker(loadConfig());
console.log("Starting the private local movie worker.");
try {
  await worker.run(controller.signal);
} catch (error) {
  console.error(error instanceof MovieError ? `${error.code}: ${error.message}` : "The movie worker could not continue. Check the private local store.");
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
}
