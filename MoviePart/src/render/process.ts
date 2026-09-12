import { spawn } from "node:child_process";
import { MovieError } from "../domain";

export interface MediaCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  outputLimitBytes?: number;
  label: string;
}

const diagnosticCategories = [
  ["no such file or directory", "A local input or executable is missing."],
  ["permission denied", "Access to a local file was denied."],
  ["invalid data found", "A media input could not be decoded."],
  ["unknown encoder", "The required encoder is unavailable."],
  ["error opening input", "A media input could not be opened."],
] as const;

// Decoder diagnostics can contain private paths and metadata. Only allowlisted
// categories, never the original stderr or command line, leave this boundary.
function diagnosticSummary(stderr: string): string {
  const text = stderr.toLowerCase();
  return diagnosticCategories.find(([pattern]) => text.includes(pattern))?.[1]
    ?? "Check local media inputs and renderer configuration.";
}

export function throwIfRenderCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new MovieError("RENDER_CANCELLED", "Movie rendering was cancelled.");
  }
}

export async function runMediaCommand(
  executable: string,
  args: readonly string[],
  options: MediaCommandOptions,
): Promise<string> {
  throwIfRenderCancelled(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBytes = 0;
    const stdout: Buffer[] = [];
    let stderr = Buffer.alloc(0);
    let failure: MovieError | undefined;
    let settled = false;
    const finish = (error?: MovieError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(Buffer.concat(stdout).toString("utf8"));
    };
    const terminate = (error: MovieError) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const onAbort = () => terminate(new MovieError("RENDER_CANCELLED", "Movie rendering was cancelled."));
    const timer = setTimeout(() => terminate(new MovieError(
      "RENDER_TIMEOUT", `${options.label} exceeded its time limit.`,
    )), options.timeoutMs ?? 120_000);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout.on("data", (data: Buffer) => {
      stdoutBytes += data.length;
      if (stdoutBytes > (options.outputLimitBytes ?? 1024 * 1024)) {
        terminate(new MovieError("RENDER_FAILED", `${options.label} returned excessive diagnostic output.`));
      } else {
        stdout.push(data);
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = Buffer.concat([stderr, data]).subarray(-8192);
    });
    child.once("error", () => {
      finish(failure ?? new MovieError("RENDERER_UNAVAILABLE", `${options.label} could not start. Check the configured local executable.`));
    });
    child.once("close", code => {
      finish(failure ?? (code === 0 ? undefined : new MovieError(
        "RENDER_FAILED", `${options.label} failed. ${diagnosticSummary(stderr.toString("utf8"))}`,
      )));
    });
  });
}
