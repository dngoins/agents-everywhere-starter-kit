"use client";

import React, { useState } from "react";
import type { StoryboardFrame } from "../../integration/contracts";

export function DesignerFrameControls({ frame, candidates, disabled, reviewAllowed, onSelect, onDecision }: {
  frame: StoryboardFrame; candidates: StoryboardFrame[]; disabled: boolean; reviewAllowed: boolean;
  onSelect: (assetId: string) => void;
  onDecision: (action: "keep" | "regenerate", note: string) => void;
}) {
  const [note, setNote] = useState(frame.designerDecision?.note ?? "");
  if (frame.source === "extracted") return null;
  return <div className="designer-frame-controls">
    {candidates.length > 1 && <label>Candidate image
      <select aria-label={`Choose candidate for ${frame.shotId}`} value={frame.assetId} disabled={disabled} onChange={event => onSelect(event.target.value)}>
        {candidates.map((candidate, index) => <option key={candidate.assetId} value={candidate.assetId}>Image {index + 1}{candidate.designerDecision?.action === "keep" ? " · kept by designer" : candidate.continuity.verdict === "PASS" ? " · AI approved" : ""}</option>)}
      </select>
    </label>}
    <label>Designer note
      <textarea aria-label={`Designer note for ${frame.shotId}`} value={note} maxLength={1000} rows={3} disabled={disabled || !reviewAllowed}
        placeholder="e.g. Keep this composition, or describe what should change."
        onChange={event => setNote(event.target.value)} />
    </label>
    <div className="designer-frame-actions">
      <button type="button" disabled={disabled || !reviewAllowed} onClick={() => onDecision("keep", note)}>Keep this image</button>
      <button type="button" className="regenerate-frame" disabled={disabled || !reviewAllowed} onClick={() => onDecision("regenerate", note)}>Regenerate this shot</button>
    </div>
    <p>{reviewAllowed
      ? "Choose images across the storyboard, then continue a paused movie with your selections. Keep preserves this exact image; it does not queue a new generation. A call already in flight may finish first."
      : "Image decisions unlock during storyboard review or after a failed attempt. Rendering and completed movies are locked."}</p>
  </div>;
}
