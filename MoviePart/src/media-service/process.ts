import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMissing, processAlive } from "../server/files";
import { ServiceError } from "./contracts";

export async function runDurableMediaCommand(
  executable: string, args: string[], directory: string, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const receipt = path.join(directory, `.media-process-${randomUUID()}.json`);
  await new Promise<void>((resolve, reject) => {
    const runner = spawn(process.execPath, [
      fileURLToPath(new URL("./process-runner.mjs", import.meta.url)), receipt, executable, ...args,
    ], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let failed = false;
    let bytes = 0;
    const cancel = () => {
      failed = true;
      if (runner.connected) runner.send({ type: "cancel" }, () => {});
    };
    const timer = setTimeout(cancel, 120_000);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    runner.on("message", message => {
      if ((message as { type?: string })?.type === "ready") {
        if (failed || signal.aborted) cancel();
        else runner.send({ type: "run" }, () => {});
      }
    });
    const consume = (data: Buffer) => {
      bytes += data.length;
      if (bytes > 1024 * 1024) cancel();
    };
    runner.stdout!.on("data", consume);
    runner.stderr!.on("data", consume);
    runner.once("error", () => { failed = true; });
    runner.once("close", code => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (failed || code !== 0) reject(new ServiceError(502, "MEDIA_ENCODING_FAILED"));
      else resolve();
    });
  });
  signal.throwIfAborted();
}

export async function settleMediaProcesses(directory: string, signal: AbortSignal): Promise<void> {
  let files: string[];
  try { files = await readdir(directory); } catch (error) { if (isMissing(error)) return; throw error; }
  for (const name of files.filter(file => /^\.media-process-[0-9a-f-]+\.json$/.test(file))) {
    let pid: number;
    try {
      const value = JSON.parse(await readFile(path.join(directory, name), "utf8")) as { pid?: number };
      if (!Number.isSafeInteger(value.pid) || value.pid! <= 0) throw new ServiceError(503, "INVALID_PROCESS_RECEIPT");
      pid = value.pid!;
    } catch (error) { if (isMissing(error)) continue; throw error; }
    while (processAlive(pid)) {
      signal.throwIfAborted();
      // A runner removes its receipt only after its encoder has exited.
      try { await readFile(path.join(directory, name)); } catch (error) { if (isMissing(error)) break; throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
