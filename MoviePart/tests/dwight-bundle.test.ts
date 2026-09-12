import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../integration/dwight/", import.meta.url));

test("Dwight's imported generated contracts match the portable handoff manifest", async () => {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as {
    generatedFiles: Record<string, string>; sourceHashNormalization: string;
  };
  assert.equal(manifest.sourceHashNormalization, "LF");
  for (const [filename, expected] of Object.entries(manifest.generatedFiles)) {
    assert.equal(path.basename(filename), filename);
    const contents = (await readFile(path.join(directory, filename), "utf8")).replace(/\r\n/g, "\n");
    assert.equal(createHash("sha256").update(contents).digest("hex"), expected, `${filename} differs from Dwight's bundle`);
  }
});
test("OpenAPI schema references remain adjacent and identify distinct authentication boundaries", async () => {
  const orchestrator = JSON.parse(await readFile(path.join(directory, "orchestrator.openapi.json"), "utf8"));
  const media = JSON.parse(await readFile(path.join(directory, "media-service.openapi.json"), "utf8"));
  const definitions = JSON.parse(await readFile(path.join(directory, "contracts.schema.json"), "utf8")).$defs;
  for (const api of [orchestrator, media]) {
    const refs = JSON.stringify(api).matchAll(/"\$ref":"\.\/contracts\.schema\.json#\/\$defs\/([^"]+)"/g);
    for (const match of refs) assert.ok(definitions[match[1]], `Missing definition ${match[1]}`);
  }
  assert.ok(orchestrator.paths["/v1/sessions"]);
  assert.ok(media.paths["/jobs/by-key/{jobId}"].delete);
  assert.ok(media.components.securitySchemes.mediaBearer);
  assert.equal(orchestrator.paths["/jobs"], undefined);
});
