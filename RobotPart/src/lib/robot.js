import PadBot from "../../RobotLibrary/padbot.js";

export function createRobot() {
  const robot = new PadBot({ speed: "low", protocolMode: "auto" });
  let moving = false;
  return {
    robot,
    get connected() { return robot.connected; },
    async connect() { return robot.connect(); },
    async stop() { moving = false; if (robot.connected) await robot.stop(); },
    async scan(face) {
      if (!robot.connected || !face) return;
      const center = face.boundingBox.originX + face.boundingBox.width / 2;
      const frameWidth = face.frameWidth || 640;
      const offset = center / frameWidth - 0.5;
      if (Math.abs(offset) > 0.14) {
        moving = true;
        await robot[(offset < 0 ? "left" : "right")]({ durationMs: 240, repeatMs: 0 });
      } else if (face.boundingBox.width < frameWidth * 0.24) {
        moving = true;
        await robot.forward({ durationMs: 260, repeatMs: 0 });
      } else if (moving) {
        await robot.stop();
        moving = false;
      }
    },
    async follow(destination) {
      if (!robot.connected) return;
      await robot.stop();
      await robot[(destination === "model3" ? "right" : "left")]({ durationMs: 500, repeatMs: 0 });
    },
  };
}