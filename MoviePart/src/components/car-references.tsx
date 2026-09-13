"use client";

import React, { useEffect, useState } from "react";
import { vehicleChoice } from "../catalog/vehicles";

export function CarReferences({ productId, ready, onSaved }: {
  productId: string; ready: boolean; onSaved: () => Promise<void>;
}) {
  const [exterior, setExterior] = useState<File | null>(null);
  const [interior, setInterior] = useState<File | null>(null);
  const [color, setColor] = useState("");
  const [interiorColor, setInteriorColor] = useState("");
  const [source, setSource] = useState("");
  const [permission, setPermission] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [previews, setPreviews] = useState<string[]>([]);
  const choice = vehicleChoice(productId);

  useEffect(() => {
    setExterior(null); setInterior(null); setColor(""); setInteriorColor("");
    setPermission(false); setSource(""); setError("");
  }, [productId]);
  useEffect(() => {
    const urls = [exterior, interior].map(file => file ? URL.createObjectURL(file) : "");
    setPreviews(urls);
    return () => urls.forEach(url => { if (url) URL.revokeObjectURL(url); });
  }, [exterior, interior]);

  async function save() {
    if (!exterior || !interior || !permission || !source.trim() || !color.trim() || saving) return;
    setSaving(true); setError("");
    try {
      const body = new FormData();
      body.append("exterior", exterior);
      body.append("interior", interior);
      body.append("metadata", JSON.stringify({
        permissionConfirmed: true, source: source.trim(), exteriorColor: color.trim(),
        interiorColor: interiorColor.trim() || null,
      }));
      const response = await fetch(`/api/movie-products/${encodeURIComponent(productId)}/references`, {
        method: "POST", body, cache: "no-store",
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error : "Could not save the car references.";
        throw new Error(message);
      }
      await onSaved();
      setExterior(null); setInterior(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save car references."); }
    finally { setSaving(false); }
  }

  if (!choice) return null;
  return <details className="car-reference-editor" open={!ready}>
    <summary>{ready ? "Reference pack ready · replace photos" : `Add ${choice.name} references`}</summary>
    <p className="field-help">Use exterior and interior photos of the same model, trim and color. No marketing specifications are invented from the model name.</p>
    <div className="car-photo-inputs">
      {(["Exterior / three-quarter", "Interior / dashboard"] as const).map((label, index) => <label key={label}>
        <span>{label}</span>
        {previews[index] && <img src={previews[index]} alt={`Selected ${label.toLowerCase()} reference`} />}
        <input type="file" accept="image/jpeg,image/png,image/webp" disabled={saving} onChange={event => {
          const file = event.target.files?.[0] ?? null;
          if (file && file.size > 10 * 1024 * 1024) { setError("Each car photo must be no larger than 10 MiB."); return; }
          (index === 0 ? setExterior : setInterior)(file);
          setError("");
        }} />
      </label>)}
    </div>
    <div className="interests">
      <input aria-label="Actual exterior color" value={color} maxLength={100} placeholder="Exterior color in these photos" disabled={saving} onChange={event => setColor(event.target.value)} />
      <input aria-label="Actual interior color" value={interiorColor} maxLength={100} placeholder="Interior color (optional)" disabled={saving} onChange={event => setInteriorColor(event.target.value)} />
      <input aria-label="Car image source and permission" value={source} maxLength={1000} placeholder="Image source and permission" disabled={saving} onChange={event => setSource(event.target.value)} />
    </div>
    <label className="car-permission"><input type="checkbox" checked={permission} disabled={saving} onChange={event => setPermission(event.target.checked)} /><span>I have permission to use these vehicle photos for AI generation and advertising.</span></label>
    <button type="button" className="car-save" disabled={saving || !exterior || !interior || !permission || source.trim().length < 5 || !color.trim()} onClick={() => void save()}>{saving ? "Saving references…" : "Use these car references"}</button>
    {error && <p className="car-error" role="alert">{error}</p>}
    <p className="field-help">Private files stay out of Git. Manufacturer press images are not automatically licensed for personalized advertising.</p>
  </details>;
}
