export type SpeechState = { status: "idle" | "queued" | "speaking" | "error"; error: string | null };
export interface SpeechCallbacks { start(): void; end(): void; error(): void }
export interface SpeechBackend {
  speak(text: string, callbacks: SpeechCallbacks): () => void;
}

/** Fixed kiosk prompts use a device-local voice only; no microphone or vendor API. */
export function localBrowserSpeech(): SpeechBackend {
  return {
    speak(text, callbacks) {
      if (typeof window === "undefined" || !window.speechSynthesis || !window.SpeechSynthesisUtterance) {
        callbacks.error();
        return () => {};
      }
      const synth = window.speechSynthesis;
      const voice = synth.getVoices().find(voice => voice.localService && /^en(?:-|$)/i.test(voice.lang));
      if (!voice || synth.speaking || synth.pending) {
        callbacks.error();
        return () => {};
      }
      const utterance = new window.SpeechSynthesisUtterance(text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.rate = 0.95;
      let owned = true;
      const finish = (callback: () => void) => { if (owned) { owned = false; callback(); } };
      utterance.onstart = () => { if (owned) callbacks.start(); };
      utterance.onend = () => finish(callbacks.end);
      utterance.onerror = () => finish(callbacks.error);
      synth.speak(utterance);
      return () => {
        if (!owned) return;
        owned = false;
        utterance.onstart = utterance.onend = utterance.onerror = null;
        synth.cancel();
      };
    },
  };
}

export class RobotNarrator {
  private state: SpeechState = { status: "idle", error: null };
  private readonly listeners = new Set<() => void>();
  private cancelVoice?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  constructor(private readonly backend: SpeechBackend, private readonly timeoutMs = 45_000) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(state: SpeechState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  stop = () => {
    this.revision++;
    clearTimeout(this.timer);
    this.cancelVoice?.();
    this.cancelVoice = undefined;
    this.set({ status: "idle", error: null });
  };
  speak(text: string, onComplete?: () => void) {
    this.stop();
    const revision = this.revision;
    this.set({ status: "queued", error: null });
    const finish = (failed: boolean) => {
      if (revision !== this.revision) return;
      this.revision++;
      clearTimeout(this.timer);
      this.cancelVoice?.();
      this.cancelVoice = undefined;
      this.set({
        status: failed ? "error" : "idle",
        error: failed ? "A local voice isn't available or speech was interrupted. You can read the message and continue without sound." : null,
      });
      onComplete?.();
    };
    this.timer = setTimeout(() => finish(true), this.timeoutMs);
    try {
      const cancel = this.backend.speak(text, {
        start: () => { if (revision === this.revision) this.set({ status: "speaking", error: null }); },
        end: () => finish(false),
        error: () => finish(true),
      });
      if (revision === this.revision) this.cancelVoice = cancel;
      else cancel();
    } catch { finish(true); }
  }
}
