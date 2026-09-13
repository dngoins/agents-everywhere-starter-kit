export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type VoiceStatus = 'idle' | 'connecting' | 'ready' | 'closing' | 'closed';
export interface LiveAnswer { session: { id: string }; transport: { type: 'webrtc'; sdp: string } }
/** Live exposes transcript deltas, not authoritative final utterances or consent. */
export interface LiveTranscript { speaker: 'customer' | 'assistant'; delta: string; start_ms: number; end_ms: number }
export interface LiveToolOptions {
  allowedTools?: readonly string[];
  onTool?: (name: string, arguments_: JsonObject) => JsonValue | Promise<JsonValue>;
  isCurrent?: () => boolean;
  onError?: (error: Error) => void;
}
export interface LiveVoiceOptions extends LiveToolOptions {
  audioElement: HTMLAudioElement;
  sessionFactory?: (request: { sdp: string; identity: JsonObject; signal: AbortSignal }) => Promise<LiveAnswer>;
  sessionEndpoint?: string;
  greetingContext?: string;
  readyContext?: string;
  errorHints?: { server?: string; connect?: string };
  onStatus?: (status: VoiceStatus) => void;
  onTranscript?: (transcript: LiveTranscript) => void;
  fetch?: typeof globalThis.fetch;
  transportFactory?: () => RTCPeerConnection;
  mediaStreamFactory?: (tracks: MediaStreamTrack[]) => MediaStream;
  randomUUID?: () => string;
  timers?: { setTimeout: (callback: () => void, ms: number) => unknown; clearTimeout: (timer: unknown) => void };
}
export class LiveVoice {
  constructor(options: LiveVoiceOptions);
  readonly ready: boolean;
  connect(options: { identity?: JsonObject; microphone: MediaStream }): Promise<void>;
  greet(): boolean;
  movieReady(): boolean;
  context(text: string): boolean;
  instruct(text: string): boolean;
  text(text: string): boolean;
  /** Pauses microphone clones AND incoming playback; does not stop the caller's stream. */
  setPlaybackPaused(paused: boolean): boolean;
  /** Mutes only the owned microphone tracks; assistant playback is unchanged. */
  setMicrophoneMuted(muted: boolean): boolean;
  close(): Promise<void>;
}
export class LiveToolDispatcher {
  constructor(options?: LiveToolOptions & { send?: (event: JsonObject) => boolean | void; onDrained?: () => void });
  readonly busy: boolean;
  handle(envelope: unknown): void | Promise<void>;
  text(text: string): boolean;
  close(): void;
}

export type BluetoothUuid = string | number;
export type PadBotDirection = 'forward' | 'backward' | 'left' | 'right' | 'forwardLeft' | 'forwardRight' | 'backwardLeft' | 'backwardRight' | 'headUp' | 'headDown';
export type PadBotSpeed = 'low' | 'medium' | 'fast';
export interface BleCharacteristic extends EventTarget {
  uuid: string;
  properties: { write?: boolean; writeWithoutResponse?: boolean; notify?: boolean; indicate?: boolean };
  writeValue?(bytes: Uint8Array): Promise<void>;
  writeValueWithResponse?(bytes: Uint8Array): Promise<void>;
  writeValueWithoutResponse?(bytes: Uint8Array): Promise<void>;
  startNotifications(): Promise<unknown>;
}
export interface BleService {
  uuid: string;
  getCharacteristics(): Promise<BleCharacteristic[]>;
  getCharacteristic(uuid: BluetoothUuid): Promise<BleCharacteristic>;
}
export interface BleServer {
  connected: boolean;
  connect(): Promise<BleServer>;
  disconnect(): void;
  getPrimaryService(uuid: BluetoothUuid): Promise<BleService>;
}
export interface BleDevice extends EventTarget { id: string; name?: string; gatt?: BleServer }
export interface BluetoothAdapter {
  requestDevice(options: { filters: ({ services: BluetoothUuid[] } | { namePrefix: string })[]; optionalServices: BluetoothUuid[] }): Promise<BleDevice>;
  getDevices?(): Promise<BleDevice[]>;
}
export interface PadBotConnectionInfo {
  connected: boolean;
  deviceId: string | null;
  deviceName: string | null;
  serviceUuid: string | null;
  writeUuids: string[];
  notifyUuid: string | null;
  protocolMode: 'raw' | 'mn' | 'pq' | 'auto';
}
/** This result acknowledges BLE writes, never physical movement. */
export interface BleWriteResult {
  command: string;
  writes: { frame: string; characteristicUuid: string }[];
  failures: { frame: string; characteristicUuid: string; error: unknown }[];
}
export interface DriveOptions { durationMs?: number; repeatMs?: number }
export class PadBot extends EventTarget {
  constructor(options?: {
    bluetooth?: BluetoothAdapter; serviceUuid?: BluetoothUuid; writeUuid?: BluetoothUuid | null;
    notifyUuid?: BluetoothUuid | null; protocolMode?: 'raw' | 'mn' | 'pq' | 'auto';
    speed?: PadBotSpeed | 1 | 2 | 3; initialize?: boolean;
  });
  static isSupported(): boolean;
  readonly connected: boolean;
  readonly device: BleDevice | null;
  readonly speed: PadBotSpeed;
  readonly lastCommand: string | null;
  readonly connectionInfo: PadBotConnectionInfo;
  connect(options?: { device?: BleDevice }): Promise<PadBotConnectionInfo>;
  reconnect(device?: BleDevice): Promise<PadBotConnectionInfo>;
  getKnownDevices(): Promise<BleDevice[]>;
  disconnect(): Promise<void>;
  sendCommand(command: string): Promise<BleWriteResult>;
  setSpeed(speed: PadBotSpeed | 1 | 2 | 3): Promise<BleWriteResult>;
  drive(direction: PadBotDirection, options?: DriveOptions): Promise<BleWriteResult>;
  forward(options?: DriveOptions): Promise<BleWriteResult>;
  backward(options?: DriveOptions): Promise<BleWriteResult>;
  left(options?: DriveOptions): Promise<BleWriteResult>;
  right(options?: DriveOptions): Promise<BleWriteResult>;
  forwardLeft(options?: DriveOptions): Promise<BleWriteResult>;
  forwardRight(options?: DriveOptions): Promise<BleWriteResult>;
  backwardLeft(options?: DriveOptions): Promise<BleWriteResult>;
  backwardRight(options?: DriveOptions): Promise<BleWriteResult>;
  headUp(options?: DriveOptions): Promise<BleWriteResult>;
  headDown(options?: DriveOptions): Promise<BleWriteResult>;
  stop(): Promise<BleWriteResult>;
  queryBattery(): Promise<BleWriteResult>;
  queryInfrared(): Promise<BleWriteResult>;
  queryInfo(): Promise<BleWriteResult>;
  initializeSpeed(): Promise<BleWriteResult>;
  dock(): Promise<BleWriteResult>;
  undock(): Promise<BleWriteResult>;
}
export const COMMANDS: Readonly<Record<string, string>>;
export function normalizeUuid(value: BluetoothUuid): BluetoothUuid;

export interface FaceDetection {
  boundingBox?: { originX: number; originY: number; width: number; height: number; angle?: number };
  categories: { score: number; categoryName: string; index: number; displayName: string }[];
  keypoints: { x: number; y: number; label?: string; score?: number }[];
}
export interface FaceScanner { detect(video: HTMLVideoElement, timestamp?: number): FaceDetection[]; close(): void }
export function createFaceScanner<TFileset>(options: {
  vision: {
    FilesetResolver: { forVisionTasks(path: string): Promise<TFileset> };
    FaceDetector: { createFromOptions(fileset: TFileset, options: {
      baseOptions: { modelAssetPath: string }; runningMode: 'VIDEO'; minDetectionConfidence: number; minSuppressionThreshold: number;
    }): Promise<{ detectForVideo(video: HTMLVideoElement, timestamp: number): { detections: FaceDetection[] }; close(): void }> };
  };
  wasmPath?: string;
  modelAssetPath?: string;
  minDetectionConfidence?: number;
  minSuppressionThreshold?: number;
}): Promise<FaceScanner>;

/** The UI can request an intent, never send raw motor commands or mint a permit. */
export interface MotionDriver<TIntent, TAcknowledgement> {
  readonly mode: 'remote' | 'direct';
  requestFraming(intent: TIntent): Promise<TAcknowledgement>;
  stop(): Promise<TAcknowledgement>;
  close(): Promise<void>;
}
