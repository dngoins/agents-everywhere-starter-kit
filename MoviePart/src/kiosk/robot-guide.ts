import type { KioskState } from "./controller";
import { currentJob } from "./controller";

export type RobotAction = "connect" | "permissions" | "preferences" | "brief" | "photo" | "create" | "load" | "controls" | null;
export interface RobotPrompt {
  id: string;
  title: string;
  message: string;
  action: RobotAction;
  actionLabel: string;
  expression: "smile" | "thinking" | "gentle";
}

export function robotPrompt(state: KioskState): RobotPrompt {
  const snapshot = state.snapshot;
  const job = currentJob(snapshot);
  if (state.connection === "unpaired") return {
    id: "welcome", title: "Hi! I'm your showroom robot.",
    message: "Let's imagine your next drive. Your guide can connect me when you're ready. I won't use a photo without your permission.",
    action: "connect", actionLabel: "Connect robot", expression: "smile",
  };
  if (state.connection === "terminal" || snapshot?.state === "cancelled") return {
    id: "ended", title: "See you next time.",
    message: "This session has ended. My local preview is cleared. Your guide can connect a new session whenever you're ready.",
    action: "connect", actionLabel: "Connect a new session", expression: "gentle",
  };
  if (state.connection !== "active") return {
    id: `connection-${state.connection}`, title: "One moment, please.",
    message: state.connection === "cleanup_failed"
      ? "Local playback has stopped, but server cleanup needs attention. Please ask your guide to retry it."
      : "I'm waiting for a secure session connection. We won't start a new photo or movie request while disconnected.",
    action: "controls", actionLabel: "Connection controls", expression: "gentle",
  };
  if (!snapshot?.consent?.personalization || !snapshot.consent.capture) return {
    id: "permissions", title: "Your choices come first.",
    message: "May I use a reference photo and the preferences you share to make a car concept? You choose the permissions on screen. You can say no or end the session at any time.",
    action: "permissions", actionLabel: "Let's begin", expression: "smile",
  };
  if (state.movieUrl) return {
    id: "playback", title: "Your moment on screen.",
    message: "Press play when you're ready. You can stop the video or end this session at any time.",
    action: null, actionLabel: "", expression: "smile",
  };
  if (job?.status === "ready" && job.result) {
    const mock = job.result.provenance === "mock_fixture";
    const prerecorded = job.result.provenance === "prerendered_fallback";
    return {
      id: `ready-${job.jobId}`, title: mock ? "Our practice preview is ready." : "Your preview is ready.",
      message: mock ? "This is a synthetic sample, not a movie of you. Let's load it and try the screen together."
        : prerecorded ? "A prerecorded fallback is available. It was not generated for this interaction."
        : "Your media preview is ready to load. Let's check the video before we play it.",
      action: "load", actionLabel: "Load movie", expression: "smile",
    };
  }
  if (job && ["failed", "cancelled", "expired"].includes(job.status)) return {
    id: `stopped-${job.jobId}-${job.status}`, title: "Let's pause here.",
    message: "That movie didn't finish. I won't pretend it did. Your guide can review what happened and help with a new session.",
    action: "controls", actionLabel: "Review movie status", expression: "gentle",
  };
  if (job && ["queued", "running"].includes(job.status)) return {
    id: `preparing-${job.jobId}`, title: "A little imagination at work.",
    message: "Your movie request is in progress. I'll let you know when a result is ready. You can end the session while we wait.",
    action: "controls", actionLabel: "View progress", expression: "thinking",
  };
  if (!snapshot.customer || !snapshot.context?.preferences.length) return {
    id: "preferences", title: "What makes a great drive?",
    message: "Choose a demo customer and tell me what matters to you. Maybe beach road trips, or a quiet weekend away. Confirm your preferences on screen.",
    action: "preferences", actionLabel: "Choose preferences", expression: "smile",
  };
  if (!snapshot.brief || snapshot.brief.contextRevision !== snapshot.context.revision) return {
    id: "brief", title: "Let's picture it together.",
    message: "Your preferences are confirmed. Create the concept brief now so you can review the scenes and words before choosing a reference photo.",
    action: "brief", actionLabel: "Create brief", expression: "smile",
  };
  if (!state.uploadedId) return {
    id: "photo", title: "A reference, only with your say.",
    message: "Review the brief, then choose and upload a permitted photo. In the offline demo you can use the sample image. I don't open your camera automatically.",
    action: "photo", actionLabel: "Choose a reference", expression: "smile",
  };
  return {
    id: "create", title: "Ready when you are.",
    message: "Your brief and reference are ready. Review them, then choose Create this movie. You stay in control.",
    action: "create", actionLabel: "Review & create", expression: "smile",
  };
}
