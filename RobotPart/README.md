# Tesla Showroom AI Sales Robot

An interactive sales robot application designed for a Windows 11 tablet running Google Chrome mounted on a PadBot BLE robot.

## Features

- **Web Bluetooth Robot Integration:** Uses `RobotLibrary/padbot.js` to connect to the PadBot over BLE, center on customers, approach safely, and turn towards showroom exhibits upon request.
- **On-Device Face Detection:** Uses local Google MediaPipe Face Detector (running via WebAssembly/TFLite model in the browser) to detect customer faces without sending raw video streams off-device.
- **OpenAI GPT-Live Voice Integration:** Direct browser WebRTC connection to OpenAI's `gpt-live-1` voice model with full-duplex conversational voice, natural interruption handling, and tool delegation to `gpt-5.6-luna`.
- **Personalized Video Delivery:** Captures customer face, sends to backend (`POST /newCustomerFace`), triggers a 5-second simulated generation delay, and receives WebSocket event (`movie.ready`) to offer and play `/Movies/demo.mp4`.
- **All-Day Test Drive Booking:** Supports mock scheduling for tomorrow in Eastern Time (`America/New_York`) with 6:00 PM same-day return, and logs booking confirmations to console with a `TODO` for the sales team.

## Prerequisites

- **OS & Browser:** Windows 11 with Google Chrome (or Edge) supporting Web Bluetooth and WebRTC.
- **Node.js:** v22.6+ (v24+ recommended).
- **Environment:** A `.env` file in `RobotPart/` containing:

  ```env
  OPENAI_API_KEY=your-api-key
  VOICE_MODEL=gpt-live-1
  REGULAR_MODEL=gpt-5.6-luna
  HIGHEND_MODEL=gpt-6-astra
  ```

## Getting Started

1. **Install Dependencies and Prepare Local Assets:**

   ```bash
   npm install
   ```

   *(The `postinstall` script automatically prepares the MediaPipe WASM and model files under `public/vision/`)*

2. **Run in Development Mode (Vite + Node API Server):**

   ```bash
   npm run dev
   ```

   - Frontend: `http://localhost:5173`
   - Backend API & WebSockets: `http://127.0.0.1:8787`

3. **Run Production Build:**

   ```bash
   npm run build
   npm start
   ```

4. **Run Unit and Integration Tests:**

   ```bash
   npm test
   ```

## Workflow Guide

1. Open `http://localhost:5173` in Google Chrome on the tablet.
2. Tap **CONNECT ROBOT** to open the Web Bluetooth device picker and select your PadBot.
3. Tap **START** to begin camera streaming, local face scanning, and the GPT-Live voice session.
4. When a customer faces the robot, the robot centers and approaches, snaps a photo, and starts the showroom greeting.
5. Once the movie is reported ready via WebSockets, the voice assistant smoothly asks permission to show the Model 3 personalized video.
6. After video playback, the assistant collects feedback, offers an all-day test drive for tomorrow, presents available time slots, and books the chosen slot.
7. Tap **STOP ROBOT** at any time to halt motion immediately and reset the demo safely.
