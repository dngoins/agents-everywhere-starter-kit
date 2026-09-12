import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = resolve(root, "artifacts");
const staging = resolve(artifacts, "demo-package");
const archive = resolve(artifacts, "magicpitch-demo.tgz");
let ownsStaging = false;
const files = [
  "package.json", "package-lock.json", ".env.example", ".nvmrc", ".npmrc", "README.md", "PLAN.md",
  "docs/runbook.md", "docs/contracts.md",
  "public/dev/index.html", "public/dev/app.js", "public/dev/styles.css",
  "fixtures/media/mock-preview.mp4", "fixtures/media/sample.png", "fixtures/media/README.md",
  "scripts/smoke.mjs", "scripts/offline-network-guard.mjs",
  "interfaces/v1/README.md", "interfaces/v1/DAMIAN.md", "interfaces/v1/TIYA.md",
  "interfaces/v1/types.d.ts", "interfaces/v1/contracts.schema.json",
  "interfaces/v1/orchestrator.openapi.json", "interfaces/v1/media-service.openapi.json",
  "interfaces/v1/examples.json", "interfaces/v1/manifest.json",
];

async function ensureOrdinary(path, directory = false) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())) {
    throw new Error(`Package input is not an ordinary ${directory ? "directory" : "file"}.`);
  }
}

async function collectDist(directory) {
  await ensureOrdinary(directory, true);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Symlinks are not allowed in the demo package.");
    if (entry.isDirectory()) await collectDist(path);
    else {
      if (!/\.(?:js|d\.ts)$/.test(entry.name)) throw new Error("Unexpected build output; only compiled JavaScript and declarations are packaged.");
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
}

function tar(args) {
  const result = spawnSync("tar", args, { cwd: root, encoding: "utf8", shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("Archive operation failed. Install the OS tar utility.");
  return result.stdout;
}

try {
  await ensureOrdinary(resolve(root, "dist", "server.js"));
  await collectDist(resolve(root, "dist"));
  try {
    await ensureOrdinary(resolve(root, "docs", "status.md"));
    files.push("docs/status.md");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
  if (packageJson.name !== lock.name || packageJson.version !== lock.version) {
    throw new Error("Package identity does not match its lockfile.");
  }
  const fixture = await readFile(resolve(root, "fixtures", "media", "mock-preview.mp4"));
  if (fixture.subarray(4, 8).toString("ascii") !== "ftyp") throw new Error("Synthetic MP4 is invalid.");
  try {
    await ensureOrdinary(artifacts, true);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(artifacts);
  }
  try {
    await ensureOrdinary(staging, true);
    await rm(staging, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(staging);
  ownsStaging = true;
  for (const file of files.sort()) {
    const input = resolve(root, file);
    const output = resolve(staging, file);
    await ensureOrdinary(input);
    // Check parent directories too: lstat(file) alone would follow a parent symlink.
    let parent = dirname(input);
    while (parent !== root.replace(/[\\/]$/, "")) {
      if (!parent.startsWith(root)) throw new Error("Package input escaped its root.");
      await ensureOrdinary(parent, true);
      parent = dirname(parent);
    }
    await mkdir(dirname(output), { recursive: true });
    await copyFile(input, output);
  }
  tar(["-czf", archive, "-C", staging, ...files]);
  const listed = tar(["-tzf", archive]).trim().split(/\r?\n/).filter(Boolean).sort();
  if (JSON.stringify(listed) !== JSON.stringify([...files].sort())) {
    throw new Error("Archive contents did not exactly match the explicit allowlist.");
  }
  const checksum = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(resolve(artifacts, "magicpitch-demo.sha256"), `${checksum}  magicpitch-demo.tgz\n`);
  await rm(staging, { recursive: true });
  ownsStaging = false;
  console.log(JSON.stringify({ event: "demo_packaged", archive: "artifacts/magicpitch-demo.tgz", fileCount: files.length, sha256: checksum }));
} catch (error) {
  console.error(`Demo package failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (ownsStaging) {
    try { await rm(staging, { recursive: true }); } catch {
      console.error("Could not remove the package's staging directory.");
      process.exitCode = 1;
    }
  }
}
