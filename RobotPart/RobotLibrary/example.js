// Import these functions into your own browser module and bind them to your UI.
// Importing this file does NOT pair a device or start movement.
import PadBot from "./padbot.js";

export const robot = new PadBot({ speed: "low", protocolMode: "auto" });

robot.addEventListener("notification", (event) => {
  console.log("Robot reply (raw):", event.detail.text, event.detail.bytes);
});
robot.addEventListener("error", (event) => {
  console.error("Background robot command failed:", event.detail);
});

// Invoke directly from a user click; catch the returned promise in your UI.
export function connectRobot() { return robot.connect(); }
export function disconnectRobot() { return robot.disconnect(); }
export function stopRobot() { return robot.stop(); }
export function changeSpeed(speed) { return robot.setSpeed(speed); }
export function driveForwardBriefly() { return robot.forward({ durationMs: 500 }); }
export function turnLeftBriefly() { return robot.left({ durationMs: 300 }); }
export function moveHeadUpBriefly() { return robot.headUp({ durationMs: 200 }); }
export function requestBattery() { return robot.queryBattery(); }

// Pair this with stopRobot on pointerup AND pointercancel in your host UI.
export function startDrivingBackward() { return robot.backward(); }