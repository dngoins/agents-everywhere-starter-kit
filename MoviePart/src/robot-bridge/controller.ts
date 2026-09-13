import { PadBot, type PadBotConnectionInfo } from '@magicpitch/showroom-runtime/browser';
import {
  BridgeCredentialSchema, BridgeLeaseSchema, BridgeServerMessageSchema, OperatorCredentialSchema,
  type BridgeAcknowledgement, type BridgeCredential, type BridgeLease, type OperatorCredential,
} from '../../../FinalProject/src/contracts/bridge';
import { LocalBridgeSafety } from '../../../FinalProject/src/bridge/safety';

export interface OperatorBridgeState {
  available: boolean;
  message: string;
  bridgeId: string | null;
  boundSession: string | null;
  device: PadBotConnectionInfo | null;
  brokerConnected: boolean;
  generation: number;
  lease: BridgeLease | null;
  armed: boolean;
  stopped: boolean;
  pulseCount: number;
  pulseMsUsed: number;
  lastAcknowledgement: BridgeAcknowledgement | null;
  credentialExpiresAt: number | null;
}
export function isLocalWindowsOperator(location: Pick<Location, 'hostname' | 'protocol'>, userAgent: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
    && ['http:', 'https:'].includes(location.protocol) && /Windows NT/.test(userAgent) && /Chrome\//.test(userAgent);
}

/** Tokens live only in this instance, never URLs, storage, logs or page source. */
export class OperatorBridgeController {
  private readonly robot = new PadBot({ speed: 'low', initialize: false });
  private readonly safety: LocalBridgeSafety;
  private bridge: BridgeCredential | null = null;
  private operator: OperatorCredential | null = null;
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private statePending = 0;
  private stopped = false;
  private readonly api: string;
  private snapshot: OperatorBridgeState;

  constructor(private readonly onChange: (state: OperatorBridgeState) => void, apiPort = 3101) {
    if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535) throw new Error('Use a valid local API port.');
    this.api = `http://127.0.0.1:${apiPort}`;
    const available = isLocalWindowsOperator(window.location, navigator.userAgent) && window.isSecureContext && PadBot.isSupported();
    this.snapshot = {
      available, message: available ? 'Motion is disarmed. Pair locally and redeem separate role codes.' : 'Use Windows Chrome on the local operator URL. Public/tunnel origins cannot control Bluetooth.',
      bridgeId: null, boundSession: null, device: null, brokerConnected: false, generation: 0,
      lease: null, armed: false, stopped: false, pulseCount: 0, pulseMsUsed: 0,
      lastAcknowledgement: null, credentialExpiresAt: null,
    };
    this.safety = new LocalBridgeSafety({
      driver: this.robot,
      onAcknowledgement: (acknowledgement) => {
        this.update({ lastAcknowledgement: acknowledgement });
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'acknowledgement', acknowledgement }));
      },
      onError: (message) => this.update({ message }),
      onChange: () => this.syncSafety(),
    });
    this.robot.addEventListener('disconnected', this.onDisconnect);
    this.robot.addEventListener('error', this.onBleError);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('offline', this.onOffline);
    this.update({});
  }
  private update(change: Partial<OperatorBridgeState>) {
    this.snapshot = { ...this.snapshot, ...change };
    if (!this.stopped) this.onChange(this.snapshot);
  }
  private syncSafety() {
    const state = this.safety.state;
    this.update({ armed: state.armed, stopped: state.stopped, pulseCount: state.pulseCount, pulseMsUsed: state.pulseMsUsed,
      lease: state.lease, generation: state.generation, boundSession: state.lease?.sessionId ?? null,
      device: this.robot.connected ? this.robot.connectionInfo : null });
  }
  private requireLocal() {
    if (!this.snapshot.available || this.stopped) throw new Error('This operation requires the live local Windows Chrome operator page.');
  }
  private async request(path: string, body: unknown, credential?: string): Promise<unknown> {
    this.requireLocal();
    const response = await fetch(`${this.api}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Bridge request rejected (HTTP ${response.status}). Renew local authorization; no automatic retry.`);
    return response.json() as Promise<unknown>;
  }

  /** Invoke directly from a click, without awaiting other work first. */
  async pairBluetooth(): Promise<void> {
    this.requireLocal();
    const connecting = this.robot.connect();
    this.update({ message: 'Select the PadBot in the local Bluetooth chooser.' });
    await connecting;
    await this.safety.stop('Robot paired; initial Stop requested.');
    this.syncSafety();
  }

  async redeem(bridgeId: string, pairingCode: string, operatorCode: string): Promise<void> {
    this.requireLocal();
    if (this.bridge || this.socket) throw new Error('Already paired. Use explicit renewal or reload after ending this encounter.');
    if (!/^[0-9a-f-]{36}$/i.test(bridgeId)) throw new Error('Enter the bridge ID returned by local operator setup.');
    this.bridge = BridgeCredentialSchema.parse(await this.request(`/v1/bridges/${bridgeId}/pair`, { pairingCode: pairingCode.trim().toUpperCase() }));
    try {
      this.operator = OperatorCredentialSchema.parse(await this.request(`/v1/bridges/${bridgeId}/operator-pair`, { operatorCode: operatorCode.trim().toUpperCase() }));
    } catch (error) {
      this.update({ bridgeId, message: 'Bridge role paired but operator authorization failed. Redeem a fresh operator code separately.' });
      throw error;
    }
    this.connectBroker();
  }

  async redeemOperator(operatorCode: string): Promise<void> {
    if (!this.bridge) throw new Error('Redeem a bridge code first.');
    this.operator = OperatorCredentialSchema.parse(await this.request(`/v1/bridges/${this.bridge.bridgeId}/operator-pair`, { operatorCode: operatorCode.trim().toUpperCase() }));
    if (!this.socket) this.connectBroker();
  }

  private connectBroker(): void {
    this.requireLocal();
    if (!this.bridge || this.bridge.expiresAt <= Date.now()) throw new Error('The bridge credential expired. Start a new local setup.');
    const credential = this.bridge;
    const socket = new WebSocket(`${this.api.replace('http:', 'ws:')}/v1/bridges/${credential.bridgeId}/connect`);
    this.socket = socket;
    this.update({ bridgeId: credential.bridgeId, credentialExpiresAt: credential.expiresAt, message: 'Connecting local broker; motion remains disarmed.' });
    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.stopped) { socket.close(); return; }
      socket.send(JSON.stringify({ type: 'authenticate', bridgeToken: credential.bridgeToken }));
      this.heartbeat = setInterval(() => {
        if (this.socket === socket && socket.readyState === WebSocket.OPEN && !this.statePending) {
          socket.send(JSON.stringify({ type: 'heartbeat', heartbeat: this.safety.heartbeat() }));
        }
      }, 250);
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        const message = BridgeServerMessageSchema.parse(JSON.parse(String(event.data)));
        if (message.type === 'command') {
          // Do not serialize behind a BLE write: Stop must preempt queued motion.
          void this.safety.execute(message.command).catch(() => this.fail('Local command handling failed.'));
        } else {
          this.safety.brokerHeartbeat(message.serverTime);
          if (message.type === 'state') {
            this.generation = message.generation;
            ++this.statePending;
            void this.safety.setState(message.lease, message.generation, message.lastSequence)
              .then(() => this.update({ brokerConnected: true, message: message.lease ? 'Operator lease received. Motion requires local arming and customer consent.' : 'Broker connected; no control lease. Motion is disarmed.' }))
              .catch(() => this.fail('Invalid bridge state.'))
              .finally(() => { --this.statePending; });
          }
        }
      } catch { this.fail('Invalid broker message. Motion is disarmed.'); }
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      void this.safety.disconnected();
      this.update({ brokerConnected: false, message: 'Broker disconnected. Motion is disarmed; reconnect and rearm explicitly.' });
    });
    socket.addEventListener('error', () => this.fail('Local broker connection failed. Motion is disarmed.'));
  }

  async arm(sessionId: string, rearClearanceConfirmed: boolean): Promise<void> {
    this.requireLocal();
    if (!this.bridge || !this.operator || this.operator.expiresAt <= Date.now() || !this.snapshot.brokerConnected
      || !rearClearanceConfirmed || document.hidden) throw new Error('Fresh operator authorization, broker connection and explicit rear clearance are required.');
    const lease = BridgeLeaseSchema.parse(await this.request(`/v1/operator/bridges/${this.bridge.bridgeId}/lease`, {
      eventId: crypto.randomUUID(), sessionId, expectedGeneration: this.generation, operatorArmed: true, rearClearanceConfirmed: true,
    }, this.operator.operatorToken));
    this.generation = lease.generation;
    await this.safety.setState(lease, lease.generation, this.safety.state.lastSequence);
    this.safety.arm(true);
    this.update({ message: 'Armed for bounded reverse framing only. Customer consent and a fresh approved measurement are still required.' });
  }

  async stop(): Promise<void> {
    // The local BLE Stop comes first and never waits on HTTP or WebSocket.
    const localStop = this.safety.stop();
    if (this.bridge && this.operator && this.operator.expiresAt > Date.now()) {
      void this.request(`/v1/operator/bridges/${this.bridge.bridgeId}/stop`, {}, this.operator.operatorToken)
        .catch(() => this.update({ message: 'Local Stop attempted; broker stop notification failed. Physical motion remains unverified.' }));
    }
    const written = await localStop;
    this.update({ message: written ? 'Local Stop write completed. Physical motion is unverified; check the robot.' : 'Stop write is unconfirmed. Use the physical stop procedure.' });
  }
  async reconnect(): Promise<void> {
    if (this.socket) throw new Error('Close or stop the existing control connection before reconnecting.');
    await this.safety.disconnected();
    this.connectBroker();
  }
  async renew(): Promise<void> {
    if (!this.bridge) throw new Error('No bridge credential to renew.');
    await this.stop();
    const credential = BridgeCredentialSchema.parse(await this.request(`/v1/bridges/${this.bridge.bridgeId}/renew`, {}, this.bridge.bridgeToken));
    this.socket?.close();
    this.socket = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.bridge = credential;
    this.update({ brokerConnected: false, credentialExpiresAt: credential.expiresAt, message: 'Credential renewed. Reconnect explicitly, then obtain a new operator lease.' });
  }
  private fail(message: string) { void this.safety.stop(message); this.update({ message }); this.socket?.close(); }
  private onDisconnect = () => { void this.safety.disconnected(); this.update({ device: null, message: 'Bluetooth disconnected. Use the physical stop procedure if movement continues.' }); };
  private onBleError = () => this.fail('BLE reported an error. Stop is unconfirmed; use the physical stop procedure.');
  private onVisibility = () => {
    void this.safety.setForeground(!document.hidden);
    if (document.hidden) { this.update({ message: 'Operator page hidden. Motion is disarmed.' }); void this.stop(); }
  };
  private onOffline = () => this.fail('Network is offline. Motion is disarmed.');
  private onPageHide = () => { void this.close(); };
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('offline', this.onOffline);
    this.socket?.close();
    this.socket = null;
    this.bridge = null;
    this.operator = null;
    await this.safety.close();
    try { await this.robot.disconnect(); } catch { this.onChange({ ...this.snapshot, armed: false, message: 'BLE disconnect could not confirm Stop. Use the physical stop procedure.' }); }
    this.robot.removeEventListener('disconnected', this.onDisconnect);
    this.robot.removeEventListener('error', this.onBleError);
  }
}
