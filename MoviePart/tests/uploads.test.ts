import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomFillSync, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { MovieError } from "../src/domain";
import { catalogFile, ProductCatalog } from "../src/server/catalog";
import { LocalMediaRepository, MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES, normalizeImage, PRODUCT_OWNER } from "../src/server/media";
import { boundedBody, uploadPhotos } from "../src/server/uploads";

const consent = { likeness: true as const, personalization: true as const };
async function fixture(t: TestContext) {
  const directory = path.resolve(".movie-data", "tests", `uploads-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, media: new LocalMediaRepository(directory) };
}
const picture = (color = "red") => sharp({ create: { width: 8, height: 6, channels: 3, background: color } }).png().toBuffer();
function upload(files: Uint8Array[], consentValue: unknown = consent): Request {
  const form = new FormData();
  files.forEach(bytes => form.append("photos", new Blob([Buffer.from(bytes)], { type: "image/png" }), "../../private.png"));
  if (consentValue !== null) form.append("consent", JSON.stringify(consentValue));
  return new Request("http://127.0.0.1:3200/api/movie-assets", { method: "POST", body: form });
}

test("upload decodes images, strips metadata, rotates and stores consent privately", async t => {
  const { media } = await fixture(t);
  const rotated = await sharp({ create: { width: 8, height: 6, channels: 3, background: "red" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const [asset] = await uploadPhotos(upload([rotated]), "owner-a", media);
  assert.equal(asset.width, 6);
  assert.equal(asset.height, 8);
  assert.equal(asset.filename, `${asset.id}.media`);
  assert.equal(asset.ownerId, "owner-a");
  assert.deepEqual(await media.getConsent(asset.id), consent);
  const metadata = await sharp(await media.readAsset(asset.id)).metadata();
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.format, "jpeg");
  await assert.rejects(media.requireOwned(asset.id, "owner-b"), (error: unknown) => error instanceof MovieError && error.httpStatus === 404);
  await assert.rejects(media.getAsset("..\\catalog\\product"), /Asset not found/);
});

test("upload rejects missing consent, false consent, duplicates, malformed and excessive photos", async t => {
  const { media } = await fixture(t);
  const png = await picture();
  await assert.rejects(uploadPhotos(upload([png], null), "owner", media), /consent field/);
  await assert.rejects(uploadPhotos(upload([png], { likeness: false, personalization: true }), "owner", media), /consent/);
  await assert.rejects(uploadPhotos(upload([png, png]), "owner", media), /unique/);
  await assert.rejects(uploadPhotos(upload([]), "owner", media), /1–4/);
  await assert.rejects(uploadPhotos(upload(Array(5).fill(png)), "owner", media), /1–4/);
  await assert.rejects(uploadPhotos(upload([new TextEncoder().encode("<svg>not a photo</svg>")]), "owner", media), /decoded/);
  assert.equal((await media.listAssets()).length, 0);
});

test("image and multipart bounds reject before parsing or saving", async t => {
  const { media } = await fixture(t);
  await assert.rejects(normalizeImage(new Uint8Array(MAX_IMAGE_BYTES + 1)), /10 MiB/);
  const oversized = await sharp({ create: { width: 5001, height: 5000, channels: 3, background: "red" } }).png().toBuffer();
  await assert.rejects(normalizeImage(oversized), /megapixels/);
  const request = upload([await picture()]);
  request.headers.set("content-length", String(MAX_UPLOAD_BYTES + 1));
  await assert.rejects(uploadPhotos(request, "owner", media), (error: unknown) => error instanceof MovieError && error.httpStatus === 413);
  assert.equal((await media.listAssets()).length, 0);
});

test("bounded streaming rejects chunked bodies and dishonest content lengths before multipart parsing", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(5)); },
    cancel() { cancelled = true; },
  });
  const request = new Request("http://localhost:3200", {
    method: "POST", headers: { "content-length": "1" }, body: stream, duplex: "half",
  } as RequestInit);
  await assert.rejects(boundedBody(request, 8), /exceeds/);
  assert.equal(cancelled, true);
});

test("normalization cannot publish uploads or ready products larger than the provider's 10 MiB limit", async t => {
  const { media, directory } = await fixture(t);
  const pixels = randomFillSync(Buffer.alloc(4800 * 4800 * 3));
  const source = await sharp(pixels, { raw: { width: 4800, height: 4800, channels: 3 } }).jpeg({ quality: 35 }).toBuffer();
  assert.ok(source.byteLength < MAX_IMAGE_BYTES, "The uploaded compressed source is within the input limit.");
  const oversized = (error: unknown) => error instanceof MovieError && error.code === "IMAGE_TOO_LARGE" &&
    error.httpStatus === 413 && /normalized photo/.test(error.message);
  await assert.rejects(normalizeImage(source), oversized);
  await assert.rejects(uploadPhotos(upload([source]), "owner", media), oversized);
  assert.equal((await media.listAssets()).length, 0);

  const catalogDirectory = path.join(directory, "catalog");
  await mkdir(catalogDirectory);
  await writeFile(path.join(catalogDirectory, "front.jpg"), source);
  await writeFile(path.join(catalogDirectory, "interior.png"), await picture("black"));
  await writeFile(path.join(catalogDirectory, "product.json"), JSON.stringify({
    id: "demo-car", version: 1, name: "Test fixture", make: null, model: null, exteriorColor: "red", interiorColor: null,
    appearance: "Synthetic test only", approvedClaims: [], usagePermission: "Synthetic test fixture",
    images: [{ file: "front.jpg", role: "front_three_quarter" }, { file: "interior.png", role: "interior" }],
  }));
  const catalog = await new ProductCatalog(directory, media).load();
  assert.equal(catalog.product, null);
  assert.match(catalog.warning!, /invalid/);
  assert.equal((await media.listAssets()).length, 0);
});

test("catalog normalizes and caches stable sources and requires permission and interior references", async t => {
  const { media, directory } = await fixture(t);
  const catalogDirectory = path.join(directory, "catalog");
  await mkdir(catalogDirectory);
  const manifest = {
    id: "demo-car", version: 1, name: "Demo", make: null, model: null, exteriorColor: "red", interiorColor: "black",
    appearance: "Approved example", approvedClaims: [], usagePermission: "Owner permits this local demo.",
    images: [{ file: "front.png", role: "front_three_quarter" }, { file: "interior.png", role: "interior" }],
  };
  await writeFile(path.join(catalogDirectory, "product.json"), JSON.stringify(manifest));
  await writeFile(path.join(catalogDirectory, "front.png"), await picture());
  await writeFile(path.join(catalogDirectory, "interior.png"), await picture("black"));
  const catalog = new ProductCatalog(directory, media);
  const first = await catalog.getProduct("demo-car");
  const second = await catalog.getProduct("demo-car");
  assert.deepEqual(first.referenceImages, second.referenceImages);
  assert.equal((await media.listAssets()).length, 2);
  assert.equal((await media.getAsset(first.referenceImages[0].assetId)).ownerId, PRODUCT_OWNER);
  await writeFile(path.join(catalogDirectory, "front.png"), await picture("blue"));
  const changed = await catalog.getProduct("demo-car");
  assert.notEqual(changed.referenceImages[0].assetId, first.referenceImages[0].assetId);
  assert.ok((await media.readAsset(first.referenceImages[0].assetId)).byteLength > 0);
  await writeFile(path.join(catalogDirectory, "product.json"), JSON.stringify({ ...manifest, usagePermission: "" }));
  assert.equal((await catalog.load()).product, null);
  await writeFile(path.join(catalogDirectory, "product.json"), JSON.stringify({ ...manifest, images: manifest.images.map(image => ({ ...image, role: "exterior" })) }));
  assert.equal((await catalog.load()).product, null);
  assert.ok(await readFile(path.join(catalogDirectory, "front.png")));
});

test("missing, invalid and escaping catalog references never create a fake ready product", async t => {
  const { media, directory } = await fixture(t);
  const catalog = new ProductCatalog(directory, media);
  const missing = await catalog.load();
  assert.equal(missing.product, null);
  assert.match(missing.warning!, /missing/);
  for (const file of ["..\\secret.jpg", "../secret.jpg", "C:\\secret.jpg", "front.jpg:secret", "\\\\server\\file.jpg", "https://example.com/a.jpg"]) {
    assert.throws(() => catalogFile(directory, file), /plain filenames/);
  }
  await mkdir(path.join(directory, "catalog"));
  await writeFile(path.join(directory, "catalog", "product.json"), "{invalid private/path/key");
  const invalid = await catalog.load();
  assert.equal(invalid.product, null);
  assert.doesNotMatch(invalid.warning!, /private\/path\/key/);
});
