"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { RobotPrompt } from "../kiosk/robot-guide";
import { localBrowserSpeech, RobotNarrator } from "../kiosk/robot-speech";
import styles from "./robot-face.module.css";

export function RobotFace({
  prompt, sessionKey, disabled, onAction, onControls, children,
}: {
  prompt: RobotPrompt;
  sessionKey: string;
  disabled: boolean;
  onAction(): void;
  onControls(): void;
  children?: ReactNode;
}) {
  const [narrator] = useState(() => new RobotNarrator(localBrowserSpeech()));
  const speech = useSyncExternalStore(narrator.subscribe, narrator.getState, narrator.getState);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const voiceOn = useRef(false);
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);
  const visibility = useRef({ visible: true, pageVisible: true });
  const [motionPaused, setMotionPaused] = useState(false);
  const surface = useRef<HTMLElement>(null);
  const lastPrompt = useRef("");
  const active = speech.status === "speaking";
  const pending = active || speech.status === "queued";
  const action = useRef(onAction);
  action.current = onAction;
  const video = Boolean(children);

  useEffect(() => {
    narrator.stop();
    voiceOn.current = false;
    setVoiceEnabled(false);
    lastPrompt.current = "";
    return () => narrator.stop();
  }, [narrator, sessionKey]);

  useEffect(() => {
    window.speechSynthesis?.getVoices();
    const changed = () => {
      visibility.current.pageVisible = !document.hidden;
      setPageVisible(!document.hidden);
      if (document.hidden) narrator.stop();
    };
    changed();
    document.addEventListener("visibilitychange", changed);
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      visibility.current.visible = entry.isIntersecting;
      setVisible(entry.isIntersecting);
      if (!entry.isIntersecting) narrator.stop();
    });
    if (surface.current) observer?.observe(surface.current);
    return () => {
      document.removeEventListener("visibilitychange", changed);
      observer?.disconnect();
      narrator.stop();
    };
  }, [narrator]);

  useEffect(() => {
    narrator.stop();
    const changed = lastPrompt.current !== prompt.id;
    lastPrompt.current = prompt.id;
    // Narrate only stage changes after a deliberate tap; never every status poll.
    if (voiceOn.current && visibility.current.visible && visibility.current.pageVisible && changed && !video &&
      !["welcome", "ended"].includes(prompt.id) && !prompt.id.startsWith("connection-")) {
      narrator.speak(prompt.message, prompt.action === "permissions" ? () => action.current() : undefined);
    }
    return () => narrator.stop();
  }, [narrator, prompt.id, prompt.message, prompt.action, video]);

  function hear() {
    setVoiceEnabled(true);
    voiceOn.current = true;
    lastPrompt.current = prompt.id;
    // Start on this user gesture for browser audio policies.
    narrator.speak(prompt.message, prompt.action === "permissions" ? () => action.current() : undefined);
  }
  function stopVoice() {
    setVoiceEnabled(false);
    voiceOn.current = false;
    narrator.stop();
  }
  function primaryAction() {
    if (prompt.action === "permissions") hear();
    else { narrator.stop(); onAction(); }
  }

  return (
    <section ref={surface} className={styles.host} aria-label="Showroom robot"
      data-speaking={active} data-motion-paused={motionPaused || !visible || !pageVisible}
      data-expression={prompt.expression} data-video={video}>
      {video ? (
        <div className={styles.movie}>
          <div className={styles.movieHeading}><h2>{prompt.title}</h2><span>Robot voice paused for your movie</span></div>
          {children}
        </div>
      ) : (
        <>
          <div className={styles.face} role="img" aria-label={active ? "Smiling robot speaking" : "Friendly smiling robot"}>
            <svg className={styles.portrait} viewBox="0 0 600 420" aria-hidden="true">
              <g className={styles.eyes}>
                <path d="M130 185 Q160 115 195 185" fill="none" stroke="currentColor" strokeWidth="23" strokeLinecap="round" />
                <path d="M405 185 Q440 115 470 185" fill="none" stroke="currentColor" strokeWidth="23" strokeLinecap="round" />
              </g>
              <g className={styles.cheeks} fill="currentColor" opacity=".45">
                <ellipse cx="105" cy="240" rx="27" ry="12" /><ellipse cx="495" cy="240" rx="27" ry="12" />
              </g>
              <path className={styles.smile} d="M205 258 Q300 370 395 258" fill="none" stroke="currentColor" strokeWidth="22" strokeLinecap="round" />
              <g className={styles.talkingMouth}>
                <ellipse cx="300" cy="296" rx="84" ry="56" fill="currentColor" />
                <path d="M252 317 Q300 287 348 317 Q300 346 252 317" fill="#202a25" />
              </g>
            </svg>
            <span className={styles.faceState} aria-hidden="true">{active ? "Speaking" : prompt.expression === "thinking" ? "Preparing your preview" : "Here with you"}</span>
          </div>
          <div className={styles.conversation}>
            <h2>{prompt.title}</h2>
            <p className={styles.caption} aria-live="polite" aria-atomic="true">{prompt.message}</p>
            <div className={styles.actions}>
              {prompt.action && <button className={styles.primary} disabled={disabled || pending} onClick={primaryAction}>{prompt.actionLabel}</button>}
              {prompt.action === "permissions" && <button className={styles.secondary} disabled={disabled}
                onClick={() => { stopVoice(); onAction(); }}>Continue without voice</button>}
            </div>
            <div className={styles.voiceControls}>
              {!voiceEnabled && <button onClick={hear} disabled={pending || !pageVisible}>Hear this message</button>}
              {voiceEnabled && <button onClick={stopVoice}>{pending ? "Stop voice" : "Mute voice"}</button>}
              <button aria-pressed={motionPaused} onClick={() => setMotionPaused(value => !value)}>{motionPaused ? "Resume face motion" : "Pause face motion"}</button>
            </div>
            <p className={styles.voiceNote}>Local demo voice · microphone off. Permissions are always your choice.</p>
            {speech.error && <p className={styles.error} role="status">{speech.error}</p>}
          </div>
        </>
      )}
      <div className={styles.bottomBar}>
        <span>{video ? "Session-authorized playback" : "Showroom robot · synthetic product demo"}</span>
        <button onClick={() => { narrator.stop(); onControls(); }}>Show session controls</button>
      </div>
    </section>
  );
}
