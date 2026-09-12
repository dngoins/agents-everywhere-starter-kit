import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { z } from "zod";
import * as core from "../src/contracts/index.ts";
import * as media from "../src/contracts/media.ts";
import * as transport from "../src/contracts/transport.ts";
import { createMockBriefProvider } from "../src/providers/mock.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(root, "interfaces", "v1");
const check = process.argv.includes("--check");
const packageArchive = process.argv.includes("--archive");
const sourcePaths = [
  "src/contracts/index.ts", "src/contracts/media.ts",
  "src/contracts/transport.ts", "src/providers/interfaces.ts",
];
const normalizeText = (text) => text.replace(/\r\n/g, "\n");
const configFile = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
if (configFile.error) throw new Error("Cannot read the TypeScript configuration.");
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const program = ts.createProgram(sourcePaths.map((path) => resolve(root, path)), config.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: (path) => path, getCurrentDirectory: () => root, getNewLine: () => "\n",
}));
const checker = program.getTypeChecker();
const typeDeclarations = [];
for (const path of sourcePaths) {
  const source = program.getSourceFile(resolve(root, path));
  for (const statement of source.statements) {
    if ((!ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) ||
        !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isInterfaceDeclaration(statement)) {
      typeDeclarations.push(normalizeText(statement.getText(source)));
      continue;
    }
    const type = checker.getTypeAtLocation(statement);
    const rendered = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias);
    assert.ok(!rendered.includes('import("') && !rendered.includes("z.infer"), `Nonportable type: ${statement.name.text}`);
    typeDeclarations.push(`export type ${statement.name.text} = ${rendered};`);
  }
}
const types = "// Generated from the executable MagicPitch v1 contracts. Do not edit.\n" +
  "// Type-only, dependency-free: safe to copy into a TypeScript client.\n\n" +
  typeDeclarations.join("\n\n") + "\n";
const schemas = {};
function rebaseReferences(value, name) {
  if (Array.isArray(value)) return value.map((item) => rebaseReferences(item, name));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, key === "$ref" && typeof child === "string" && child.startsWith("#")
        ? `#/$defs/${name}${child.slice(1)}` : rebaseReferences(child, name)]));
  }
  return value;
}
for (const [name, schema] of Object.entries({ ...core, ...media, ...transport }).sort(([a], [b]) => a.localeCompare(b))) {
  if (name.endsWith("Schema") && schema instanceof z.ZodType) {
    schemas[name] = rebaseReferences(z.toJSONSchema(schema, { target: "draft-2020-12" }), name);
  }
}
const schemaBundle = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "MagicPitch v1 contract definitions",
  description: "Select a definition under $defs. Runtime consent, state, idempotency, URL policies and scene-duration sum invariants also apply.",
  $defs: schemas,
};
function validateLocalReferences(value, document) {
  if (Array.isArray(value)) return value.forEach((item) => validateLocalReferences(item, document));
  if (!value || typeof value !== "object") return;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
    const resolved = value.$ref.slice(2).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce((node, key) => node?.[key], document);
    assert.ok(resolved, `Unresolved schema reference: ${value.$ref}`);
  }
  Object.values(value).forEach((item) => validateLocalReferences(item, document));
}
validateLocalReferences(schemaBundle, schemaBundle);
const schemaRef = (name) => ({ $ref: `./contracts.schema.json#/$defs/${name}` });
const json = (schema) => ({ "application/json": { schema } });
const response = (name, description = "Validated response") => ({ description, content: json(schemaRef(name)) });
const error = response("ApiErrorResponseSchema", "Safe error; code, message and requestId");
const sessionParameter = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const jobParameter = { name: "jobId", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const sessionSecurity = [{ sessionBearer: [] }];
const paths = {
  "/healthz": { get: { operationId: "health", security: [], responses: { 200: { description: "Process alive" } } } },
  "/readyz": { get: { operationId: "ready", security: [], responses: { 200: { description: "Selected provider modes and local readiness, not a live-provider probe" } } } },
  "/v1/sessions": { post: {
    operationId: "createSession", security: [{ deviceBearer: [] }],
    responses: { 201: response("SessionCreatedSchema"), 401: error, 429: error },
  } },
  "/v1/sessions/{id}": {
    parameters: [sessionParameter],
    get: {
      operationId: "snapshot", security: sessionSecurity,
      parameters: [{ name: "afterRevision", in: "query", schema: { type: "integer", minimum: 0, maximum: 999999999 } }],
      responses: { 200: response("SessionSnapshotSchema"), 401: error, 404: error, 410: error },
    },
    delete: { operationId: "revokeSession", security: sessionSecurity, responses: { 204: { description: "Session revoked; assets cleared" }, 401: error, 410: error } },
  },
  "/v1/sessions/{id}/events": {
    parameters: [sessionParameter],
    post: { operationId: "recordEvent", security: sessionSecurity, requestBody: { required: true, content: json(schemaRef("SessionEventSchema")) },
      responses: { 200: response("SessionSnapshotSchema"), 400: error, 401: error, 403: error, 409: error } },
  },
  "/v1/sessions/{id}/jobs/{jobId}": {
    parameters: [sessionParameter, jobParameter],
    get: { operationId: "getMediaJob", security: sessionSecurity, responses: { 200: response("MediaJobSchema"), 401: error, 404: error, 410: error } },
  },
  "/v1/sessions/{id}/assets": {
    parameters: [sessionParameter],
    post: {
      operationId: "uploadImage", security: sessionSecurity,
      requestBody: { required: true, content: {
        "image/png": { schema: { type: "string", format: "binary" } },
        "image/jpeg": { schema: { type: "string", format: "binary" } },
      } },
      responses: { 201: response("AssetUploadedSchema"), 401: error, 403: error, 409: error, 413: error, 415: error },
    },
  },
  "/v1/sessions/{id}/assets/{assetId}": {
    parameters: [sessionParameter, { name: "assetId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
    get: {
      operationId: "downloadAsset", security: sessionSecurity,
      parameters: [{ name: "Range", in: "header", schema: { type: "string" }, description: "Single bytes=start-end or suffix range" }],
      responses: {
        200: { description: "Authorized asset bytes", content: { "video/mp4": { schema: { type: "string", format: "binary" } }, "image/png": { schema: { type: "string", format: "binary" } }, "image/jpeg": { schema: { type: "string", format: "binary" } } } },
        206: { description: "Authorized byte range" }, 401: error, 404: error, 410: error, 416: { description: "Range not satisfiable" },
      },
    },
  },
};
const commandSchemas = {
  identify_customer: ["IdentifyCustomerInputSchema", "CustomerProfileSchema"],
  enrich_profile: ["EnrichProfileInputSchema", "CustomerContextSchema"],
  create_ad_brief: ["CreateAdBriefInputSchema", "AdBriefSchema"],
  start_media_job: ["StartMediaJobInputSchema", "MediaJobSchema"],
  get_media_status: ["GetMediaStatusInputSchema", "MediaJobSchema"],
  schedule_followup: ["ScheduleFollowupInputSchema", null],
};
assert.deepEqual(Object.keys(commandSchemas).sort(), Object.keys(core.CommandSchemas).sort(), "Command inventory must match the executable API.");
for (const [name, [input, result]] of Object.entries(commandSchemas)) {
  paths[`/v1/sessions/{id}/commands/${name}`] = {
    parameters: [sessionParameter],
    post: {
      operationId: name, security: sessionSecurity,
      requestBody: { required: true, content: json(schemaRef(input)) },
      responses: result ? { [name === "start_media_job" ? 202 : 200]: response(result), 400: error, 401: error, 403: error, 409: error, 502: error, 504: error } : { 503: error },
      ...(result ? {} : { description: "Not implemented. Always returns an explicit disabled response." }),
    },
  };
}
const openapi = {
  openapi: "3.1.0",
  info: { title: "MagicPitch orchestration API", version: "1.0.0", description: "Offline-capable API; no robot/media provider implementation bundled." },
  servers: [{ url: "http://127.0.0.1:3101" }],
  components: { securitySchemes: {
    deviceBearer: { type: "http", scheme: "bearer", description: "Operator pairing token; session creation only" },
    sessionBearer: { type: "http", scheme: "bearer", description: "Returned session capability; scoped to one session" },
  } },
  paths,
};
const mediaOpenapi = {
  openapi: "3.1.0",
  info: { title: "MagicPitch media-service adapter contract", version: "1.0.0", description: "Proposed service for Tiya to implement; distinct from the orchestration API." },
  servers: [{ url: "https://media-service.example.invalid" }],
  security: [{ mediaBearer: [] }],
  components: { securitySchemes: { mediaBearer: { type: "http", scheme: "bearer", description: "Server-held MEDIA_SERVICE_TOKEN; never a browser token" } } },
  paths: {
    "/capabilities": { get: {
      operationId: "mediaCapabilities", responses: { 200: response("MediaCapabilitiesSchema", "Cancellation and deletion are required before image transfer") },
    } },
    "/jobs": { post: {
      operationId: "submitMedia",
      parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", format: "uuid" }, description: "Must equal the globally unique MagicPitch jobId, not a session-local client key" }],
      requestBody: { required: true, content: json(schemaRef("MediaSubmitRequestSchema")) },
      responses: { 202: response("MediaAcceptanceSchema", "Acknowledge before rendering completes; any successful 2xx response is accepted") },
    } },
    "/jobs/{providerJobId}": {
      parameters: [{ name: "providerJobId", in: "path", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9_-]+$" } }],
      get: { operationId: "pollMedia", responses: { 200: response("MediaServiceStatusSchema") } },
    },
    "/assets/{filename}": {
      parameters: [{ name: "filename", in: "path", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9_-]+\\.mp4$" } }],
      get: { operationId: "fetchRenderedMedia", responses: { 200: { description: "Bounded authenticated MP4; redirects rejected", content: { "video/mp4": { schema: { type: "string", format: "binary" } } } } } },
    },
    "/jobs/by-key/{jobId}": {
      parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      delete: {
        operationId: "cancelAndDeleteByKey",
        description: "Cancel/tombstone the globally unique MagicPitch job key, stop its render and delete renderer-held assets. Must also prevent a delayed POST from creating a cancelled key. Idempotent.",
        responses: { 200: response("MediaCancellationSchema") },
      },
    },
  },
};
const ids = {
  session: "11111111-1111-4111-8111-111111111111", brief: "22222222-2222-4222-8222-222222222222",
  job: "33333333-3333-4333-8333-333333333333", event: "44444444-4444-4444-8444-444444444444",
};
const brief = await createMockBriefProvider().create({
  briefId: ids.brief, sessionId: ids.session,
  customer: { customerId: "demo-alex", displayName: "Alex", method: "manual", synthetic: true },
  context: { revision: 1, source: "conversation", preferences: ["Beach road trips"] },
  product: structuredClone(core.DEMO_PRODUCT),
}, new AbortController().signal);
const examples = {
  consent: core.SessionEventSchema.parse({ schemaVersion: 1, eventId: ids.event, type: "consent_recorded", payload: { personalization: true, capture: true, enrichment: false } }),
  identify: core.IdentifyCustomerInputSchema.parse({ customerId: "demo-alex", method: "manual" }),
  context: core.ContextInputSchema.parse({ preferences: ["Beach road trips"] }),
  brief: core.AdBriefSchema.parse(brief),
  startMedia: core.StartMediaJobInputSchema.parse({ briefId: ids.brief, idempotencyKey: "demo-one" }),
  mediaSubmission: media.MediaSubmitRequestSchema.parse({
    schemaVersion: 1, jobId: ids.job, idempotencyKey: ids.job, brief,
    image: { mimeType: "image/png", base64: (await readFile(resolve(root, "fixtures", "media", "sample.png"))).toString("base64") },
  }),
  mediaAccepted: media.MediaAcceptanceSchema.parse({ providerJobId: "render-123" }),
  mediaCapabilities: media.MediaCapabilitiesSchema.parse({ schemaVersion: 1, cancelByKey: true, deleteAssets: true }),
  mediaCancelled: media.MediaCancellationSchema.parse({ status: "cancelled", assetsDeleted: true }),
  mediaReady: media.MediaServiceStatusSchema.parse({ status: "ready", result: { assetPath: "assets/render-123.mp4", mimeType: "video/mp4", durationSeconds: 6 } }),
  reveal: core.SessionEventSchema.parse({ schemaVersion: 1, eventId: "55555555-5555-4555-8555-555555555555", type: "media_revealed", payload: { jobId: ids.job } }),
};
const artifacts = {
  "types.d.ts": types,
  "contracts.schema.json": JSON.stringify(schemaBundle, null, 2) + "\n",
  "orchestrator.openapi.json": JSON.stringify(openapi, null, 2) + "\n",
  "media-service.openapi.json": JSON.stringify(mediaOpenapi, null, 2) + "\n",
  "examples.json": JSON.stringify(examples, null, 2) + "\n",
};
const sourceHashes = {};
for (const path of sourcePaths) sourceHashes[path] = createHash("sha256").update(normalizeText(await readFile(resolve(root, path), "utf8"))).digest("hex");
artifacts["manifest.json"] = JSON.stringify({
  contractVersion: 1, sourceHashNormalization: "LF", sourceHashes,
  generatedFiles: Object.fromEntries(Object.entries(artifacts).map(([path, content]) => [path, createHash("sha256").update(content).digest("hex")])),
  runtimeRules: ["Consent and ownership", "State transitions", "Idempotency and queue/deadline bounds", "Scene durations sum to total", "Media service idempotency key equals the globally unique job ID", "Public-profile URL policy", "Provider output validation"],
}, null, 2) + "\n";
await mkdir(output, { recursive: true });
for (const [file, content] of Object.entries(artifacts)) {
  const path = resolve(output, file);
  if (check) assert.equal(normalizeText(await readFile(path, "utf8")), content, `Stale handoff: ${file}; run npm run interfaces:export`);
  else await writeFile(path, content);
}
const portableProgram = ts.createProgram([resolve(output, "types.d.ts")], {
  strict: true, noEmit: true, types: [], target: ts.ScriptTarget.ES2023, skipLibCheck: false,
});
const portableDiagnostics = ts.getPreEmitDiagnostics(portableProgram);
assert.equal(portableDiagnostics.length, 0, "Generated types must compile without Zod/server imports: " +
  portableDiagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"));
if (packageArchive) {
  const allowed = [...Object.keys(artifacts), "README.md", "DAMIAN.md", "TIYA.md"].sort();
  assert.deepEqual((await readdir(output)).sort(), allowed, "Unexpected files in the handoff directory.");
  const archivePath = resolve(root, "artifacts", "magicpitch-interfaces-v1.tgz");
  await mkdir(resolve(root, "artifacts"), { recursive: true });
  const result = spawnSync("tar", ["-czf", archivePath, "-C", output, ...allowed], { encoding: "utf8", shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("Cannot create interface archive; OS tar is required.");
  const listed = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(listed.status, 0);
  assert.deepEqual(listed.stdout.trim().split(/\r?\n/).sort(), allowed);
  console.log(`Shareable interface archive: ${relative(root, archivePath).split(sep).join("/")}`);
}
console.log(`${check ? "Checked" : "Generated"} dependency-free interfaces and ${Object.keys(schemas).length} JSON schemas.`);
