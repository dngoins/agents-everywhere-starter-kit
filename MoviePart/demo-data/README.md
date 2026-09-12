# Private demo data

Tiya's ZIP supplied a useful folder-based demo workflow, but no customer or car photos. Use consenting teammate images, not arbitrary online portraits. There is no automatic private-photo ingestion or mock success when credentials are missing.

Customer photos can stay in ignored `demo-data\customer-01` or another private folder. Choose them in the studio or pass explicit `--photo` arguments to `npm run cli`. `POV` and `PERSONALIZED` do not upload or send customer photos.

## Car catalog

The creator studio offers **Tesla Model Y** (`tesla-model-y`) and **Toyota Tundra Hybrid** (`toyota-tundra-hybrid`). Select either car and use **Add car references** to upload an exterior and interior photograph of the same actual model/trim. Enter the actual colors, source and permission. Neither option is marked ready until its own reference pack exists.

This upload stores separate private packs in `.movie-data\catalog\tesla-model-y` and `.movie-data\catalog\toyota-tundra-hybrid`. The application does not silently substitute Tesla Model S, invent a model year, or reuse one vehicle's cabin for the other.

No manufacturer photographs are bundled. Official press-gallery access does not by itself grant advertising or generative reuse permission. Use your own authorized photographs or assets licensed for this purpose.

For operator-managed catalog files instead of the UI:

Place a permitted, coherent vehicle reference set under `.movie-data\catalog` (or the configured `MOVIE_DATA_DIR\catalog`) and create `product.json` there:

```json
{
  "id": "team-demo-car",
  "version": 1,
  "name": "Team-approved demo vehicle",
  "make": null,
  "model": null,
  "exteriorColor": "Match the supplied vehicle photographs",
  "interiorColor": null,
  "appearance": "Describe only the vehicle that actually appears in the reference photographs.",
  "approvedClaims": [],
  "usagePermission": "Replace with the source and actual permission to use these images.",
  "images": [
    { "file": "front-three-quarter.jpg", "role": "front_three_quarter" },
    { "file": "side.jpg", "role": "side" },
    { "file": "interior.jpg", "role": "interior" }
  ]
}
```

Use two to eight unique images, including an interior reference, and plain filenames within the catalog folder. Do not copy the illustrative permission sentence as a substitute for real permission.

Tiya's source prototype named a Tesla Model S and included performance claims. Those claims and trim assumptions are deliberately not installed as verified catalog data. If using a Tesla, supply the exact car's images and independently approved metadata.

The `demo-car-v1` synthetic concept in Dwight's orchestrator is a separate media-service contract. It does not implicitly refer to this studio's real car catalog.
