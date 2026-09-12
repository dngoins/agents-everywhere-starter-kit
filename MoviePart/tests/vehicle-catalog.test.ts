import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ProductCatalog } from "../src/server/catalog";
import { LocalMediaRepository } from "../src/server/media";
import { uploadProductReferences } from "../src/server/product-upload";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "movie-vehicle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new ProductCatalog(directory, new LocalMediaRepository(directory));
}
async function image(color: string) {
  return sharp({ create: { width: 32, height: 24, channels: 3, background: color } }).png().toBuffer();
}
function upload(exterior: Uint8Array, interior: Uint8Array, permissionConfirmed = true) {
  const form = new FormData();
  form.append("exterior", new File([Buffer.from(exterior)], "exterior.png", { type: "image/png" }));
  form.append("interior", new File([Buffer.from(interior)], "interior.png", { type: "image/png" }));
  form.append("metadata", JSON.stringify({
    permissionConfirmed, source: "Operator-owned synthetic test shapes", exteriorColor: "Red", interiorColor: "Black",
  }));
  return new Request("http://localhost:3200/api/movie-products/test/references", { method: "POST", body: form });
}

test("both requested vehicles are selectable but not ready without real reference packs", async t => {
  const catalog = await fixture(t);
  assert.deepEqual(await catalog.list(), [
    { id: "tesla-model-y", name: "Tesla Model Y", ready: false },
    { id: "toyota-tundra-hybrid", name: "Toyota Tundra Hybrid", ready: false },
  ]);
  await assert.rejects(catalog.getProduct("tesla-model-y"), /missing/);
});

test("authorized exterior/interior uploads create distinct durable Tesla and Toyota packs", async t => {
  const catalog = await fixture(t);
  await uploadProductReferences(upload(await image("red"), await image("black")), "tesla-model-y", catalog);
  await uploadProductReferences(upload(await image("blue"), await image("gray")), "toyota-tundra-hybrid", catalog);
  const tesla = await catalog.getProduct("tesla-model-y");
  const toyota = await catalog.getProduct("toyota-tundra-hybrid");
  assert.equal(tesla.model, "Model Y");
  assert.equal(toyota.model, "Tundra i-FORCE MAX Hybrid");
  assert.deepEqual(tesla.approvedClaims, []);
  assert.deepEqual(toyota.approvedClaims, []);
  assert.equal(tesla.referenceImages.length, 2);
  assert.ok(tesla.referenceImages.some(reference => reference.role === "interior"));
  assert.notDeepEqual(tesla.referenceImages, toyota.referenceImages);
  assert.deepEqual((await catalog.getProduct("tesla-model-y")).referenceImages, tesla.referenceImages);
  assert.ok((await catalog.list()).every(product => product.ready));
});

test("missing rights, duplicate images, missing interior or unsupported vehicle fail before readiness", async t => {
  const catalog = await fixture(t);
  const red = await image("red");
  await assert.rejects(uploadProductReferences(upload(red, await image("black"), false), "tesla-model-y", catalog), /permission/);
  await assert.rejects(uploadProductReferences(upload(red, red), "tesla-model-y", catalog), /distinct/);
  await assert.rejects(uploadProductReferences(upload(red, await image("black")), "model-s", catalog), /Choose Tesla/);
  const missing = new FormData();
  missing.append("exterior", new File([Uint8Array.from(red)], "exterior.png", { type: "image/png" }));
  await assert.rejects(uploadProductReferences(new Request("http://localhost/upload", { method: "POST", body: missing }), "tesla-model-y", catalog), /interior/);
  assert.ok((await catalog.list()).every(product => !product.ready));
});
