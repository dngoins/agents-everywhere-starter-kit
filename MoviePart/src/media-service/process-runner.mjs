import { spawn } from "node:child_process";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

// The renderer may outlive a crashed HTTP process. Publish our PID before accepting
// permission to spawn FFmpeg, and kill/reap FFmpeg when the parent's IPC disappears.
const [receipt, executable, ...args] = process.argv.slice(2);
let child;
let stopping = false;
let started = false;
const finish = code => {
  try { unlinkSync(receipt); } catch {}
  process.exit(code);
};
const cancel = () => {
  stopping = true;
  if (child) child.kill("SIGKILL");
  else finish(1);
};
process.on("disconnect", cancel);
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
process.on("message", message => {
  if (message?.type === "cancel") return cancel();
  if (message?.type !== "run" || stopping || started || !process.connected) return;
  started = true;
  child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once("error", () => finish(1));
  child.once("close", code => finish(stopping ? 1 : code === 0 ? 0 : 1));
});

try {
  if (!process.connected) finish(1);
  const staging = `${receipt}.writing`;
  const handle = openSync(staging, "wx", 0o600);
  try {
    writeFileSync(handle, JSON.stringify({ pid: process.pid }));
    fsyncSync(handle);
  } finally { closeSync(handle); }
  renameSync(staging, receipt);
  process.send({ type: "ready" });
} catch { finish(1); }
