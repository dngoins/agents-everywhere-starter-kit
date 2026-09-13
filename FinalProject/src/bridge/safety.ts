import {
  BRIDGE_LIMITS, BridgeCommandSchema, BridgeLeaseSchema,
  type BridgeAcknowledgement, type BridgeCommand, type BridgeHeartbeat, type BridgeLease,
} from '../contracts/bridge.js';

export interface LocalMotionPort {
  readonly connected: boolean;
  setSpeed(speed: 'low'): Promise<unknown>;
  drive(direction: 'backward', options: { durationMs: number; repeatMs: number }): Promise<unknown>;
  stop(): Promise<unknown>;
}
export interface SafetyClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}
const realClock: SafetyClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * Browser-only fail-closed execution of a server-issued permit. All caps are
 * independent of model output and remain consumed across reconnect/rearming.
 */
export class LocalBridgeSafety {
  private readonly clock: SafetyClock;
  private lease: BridgeLease | null = null;
  private generation = 0;
  private lastSequence = 0;
  private lastBrokerAt = -Infinity;
  private foreground = true;
  private locallyArmed = false;
  private rearClear = false;
  private stopped = false;
  private disposed = false;
  private serial = 0;
  private pulseMsUsed = 0;
  private pulseCount = 0;
  private nextPulseAt = 0;
  private pulse: { command: BridgeCommand; serial: number; timer: unknown; deadline: number } | null = null;
  private watchdog: unknown;
  private stopPending: Promise<void> | null = null;

  constructor(private readonly options: {
    driver: LocalMotionPort;
    clock?: SafetyClock;
    onAcknowledgement(acknowledgement: BridgeAcknowledgement): void;
    onError(message: string): void;
    onChange?(): void;
  }) {
    this.clock = options.clock ?? realClock;
    this.scheduleWatchdog();
  }

  get state() {
    return {
      armed: this.locallyArmed && Boolean(this.lease),
      rearClearanceConfirmed: this.rearClear,
      stopped: this.stopped,
      generation: this.generation,
      lastSequence: this.lastSequence,
      pulseMsUsed: this.pulseMsUsed,
      pulseCount: this.pulseCount,
      lease: this.lease,
      connected: this.options.driver.connected,
    };
  }

  private change() { this.options.onChange?.(); }
  private acknowledge(command: BridgeCommand, status: BridgeAcknowledgement['status'], reason: BridgeAcknowledgement['reason']) {
    this.options.onAcknowledgement({
      commandId: command.commandId, leaseId: command.leaseId,
      leaseGeneration: command.leaseGeneration, sequence: command.sequence,
      status, reason, physicalExecution: 'unverified', at: this.clock.now(),
    });
  }

  brokerHeartbeat(serverTime: number): void {
    const now = this.clock.now();
    if (!Number.isSafeInteger(serverTime) || Math.abs(now - serverTime) > BRIDGE_LIMITS.watchdogMs) {
      void this.stop('Broker clock or heartbeat is stale.');
      return;
    }
    this.lastBrokerAt = now;
  }

  /** A new connection/lease never arms the local driver by itself. */
  async setState(lease: BridgeLease | null, generation: number, lastSequence: number): Promise<void> {
    const parsed = lease === null ? null : BridgeLeaseSchema.parse(lease);
    if (!Number.isSafeInteger(generation) || generation < this.generation || (parsed && parsed.generation !== generation)
      || !Number.isSafeInteger(lastSequence) || lastSequence < 0) {
      await this.stop('Stale bridge connection state.');
      return;
    }
    if (generation !== this.generation || !parsed || (this.lease && parsed.leaseId !== this.lease.leaseId)) {
      await this.stop('Bridge connection changed or the control lease ended.');
    }
    if (this.disposed) return;
    this.generation = generation;
    this.lastSequence = Math.max(this.lastSequence, lastSequence);
    this.lease = parsed;
    this.change();
  }

  /** Must only be called by the local operator's explicit Arm action. */
  arm(rearClearanceConfirmed: boolean): void {
    const now = this.clock.now();
    if (this.disposed || !this.lease || this.lease.expiresAt <= now || !this.foreground
      || !this.options.driver.connected || !rearClearanceConfirmed
      || now - this.lastBrokerAt > BRIDGE_LIMITS.watchdogMs || this.stopPending || !this.stopped) {
      throw new Error('Pair the robot, confirm rear clearance, and obtain a fresh operator lease before arming.');
    }
    if (this.pulseCount >= BRIDGE_LIMITS.maxPulseCount || this.pulseMsUsed >= BRIDGE_LIMITS.maxCumulativePulseMs) {
      throw new Error('The fixed movement budget is exhausted. Operator setup must start a new encounter.');
    }
    this.rearClear = true;
    this.locallyArmed = true;
    this.change();
  }

  async setForeground(visible: boolean): Promise<void> {
    this.foreground = visible;
    if (!visible) await this.stop('Operator page is hidden. Motion is disarmed.');
  }

  async disconnected(): Promise<void> {
    this.lastBrokerAt = -Infinity;
    this.lease = null;
    await this.stop('Bridge or Bluetooth disconnected. Motion is disarmed.');
  }

  heartbeat(): BridgeHeartbeat {
    return {
      leaseId: this.lease?.leaseId ?? null, leaseGeneration: this.generation,
      lastSequence: this.lastSequence, connected: this.options.driver.connected,
      foreground: this.foreground && !this.disposed, stopped: this.stopped, at: this.clock.now(),
    };
  }

  async execute(input: unknown): Promise<void> {
    const result = BridgeCommandSchema.safeParse(input);
    if (!result.success) { await this.stop('Invalid bridge command. Motion is disarmed.'); return; }
    const command = result.data;
    // STOP is deliberately outside replay, expiry and generation gates.
    if (command.type === 'stop') {
      this.lastSequence = Math.max(this.lastSequence, command.sequence);
      const written = await this.stop('Stop requested.');
      this.acknowledge(command, written ? 'stop_written' : 'rejected', written ? 'stop' : 'write_failed');
      return;
    }
    const now = this.clock.now();
    let reason: BridgeAcknowledgement['reason'] | undefined;
    if (this.disposed || !this.options.driver.connected) reason = 'disconnected';
    else if (!this.lease || command.leaseId !== this.lease.leaseId || command.leaseGeneration !== this.generation
      || command.bridgeId !== this.lease.bridgeId || command.sessionId !== this.lease.sessionId) reason = 'stale_generation';
    else if (command.sequence !== this.lastSequence + 1) reason = 'out_of_order';
    else if (command.expiresAt <= now || command.issuedAt > now || this.lease.expiresAt <= now
      || now - Date.parse(command.tracking.capturedAt) >= BRIDGE_LIMITS.trackingFreshnessMs
      || Date.parse(command.tracking.capturedAt) > now) reason = 'expired';
    else if (!this.locallyArmed || !this.rearClear || !this.foreground || this.pulse || this.stopPending
      || now - this.lastBrokerAt > BRIDGE_LIMITS.watchdogMs || command.tracking.confidence < 0.8
      || this.pulseCount >= BRIDGE_LIMITS.maxPulseCount
      || this.pulseMsUsed + command.pulseMs > BRIDGE_LIMITS.maxCumulativePulseMs || now < this.nextPulseAt) reason = 'not_armed';
    if (reason) {
      this.acknowledge(command, 'rejected', reason);
      await this.stop('A movement permit failed local safety checks.');
      return;
    }
    this.lastSequence = command.sequence;
    this.pulseCount += 1;
    this.pulseMsUsed += command.pulseMs;
    this.nextPulseAt = now + command.pulseMs + BRIDGE_LIMITS.cooldownMs;
    const serial = ++this.serial;
    const deadline = Math.min(now + command.pulseMs, command.expiresAt,
      this.lease!.expiresAt, Date.parse(command.tracking.capturedAt) + BRIDGE_LIMITS.trackingFreshnessMs);
    const timer = this.clock.setTimeout(() => { void this.finishPulse(serial); }, Math.max(0, deadline - now));
    this.pulse = { command, serial, timer, deadline };
    this.stopped = false;
    this.change();
    try {
      await this.options.driver.setSpeed('low');
      if (!this.current(serial)) return;
      if (this.clock.now() >= deadline) { await this.finishPulse(serial); return; }
      // No repetition and no unbounded driver duration; the independent timer
      // starts BEFORE the first BLE write rather than after write completion.
      await this.options.driver.drive('backward', { durationMs: Math.max(1, deadline - this.clock.now()), repeatMs: 0 });
      if (!this.current(serial)) return;
      if (this.clock.now() >= deadline) { await this.finishPulse(serial); return; }
      this.acknowledge(command, 'write_completed', 'completed');
    } catch {
      this.acknowledge(command, 'rejected', 'write_failed');
      await this.stop('BLE movement write failed. Use the physical stop procedure.');
    }
  }

  private current(serial: number) { return this.serial === serial && this.pulse?.serial === serial && !this.disposed; }
  private async finishPulse(serial: number): Promise<void> {
    if (!this.current(serial)) return;
    const command = this.pulse!.command;
    this.clock.clearTimeout(this.pulse!.timer);
    this.pulse = null;
    ++this.serial;
    const written = await this.writeStop();
    this.acknowledge(command, written ? 'stop_written' : 'rejected', written ? 'stop' : 'write_failed');
    if (!written) { this.locallyArmed = false; this.rearClear = false; }
    this.change();
  }

  /** Local Stop bypasses the network broker. Its result only describes BLE writes. */
  async stop(message = 'Local Stop requested.'): Promise<boolean> {
    this.locallyArmed = false;
    this.rearClear = false;
    ++this.serial;
    if (this.pulse) this.clock.clearTimeout(this.pulse.timer);
    this.pulse = null;
    this.change();
    const written = await this.writeStop();
    if (!written) this.options.onError(`${message} Stop write is unconfirmed; use the physical stop procedure.`);
    return written;
  }

  private async writeStop(): Promise<boolean> {
    if (this.stopPending) { await this.stopPending; return this.stopped; }
    this.stopped = false;
    if (!this.options.driver.connected) { this.change(); return false; }
    this.stopPending = this.options.driver.stop().then(() => { this.stopped = true; }, () => {
      this.stopped = false;
      this.options.onError('BLE Stop write failed. Use the physical stop procedure.');
    }).finally(() => { this.stopPending = null; this.change(); });
    await this.stopPending;
    return this.stopped;
  }

  private scheduleWatchdog(): void {
    this.watchdog = this.clock.setTimeout(() => {
      if (this.disposed) return;
      const now = this.clock.now();
      if (this.locallyArmed && (!this.foreground || !this.options.driver.connected || !this.lease
        || this.lease.expiresAt <= now || now - this.lastBrokerAt > BRIDGE_LIMITS.watchdogMs)) {
        void this.stop('Local watchdog expired. Motion is disarmed.');
      }
      this.scheduleWatchdog();
    }, 100);
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.clock.clearTimeout(this.watchdog);
    this.lease = null;
    await this.stop('Operator bridge closed.');
  }
}
