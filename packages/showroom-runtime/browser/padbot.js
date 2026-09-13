/** Web Bluetooth controller. Write completion is not proof of physical execution. */
export const COMMANDS = Object.freeze({
  STOP: "0",
  FORWARD: "X1",
  BACKWARD: "X4",
  LEFT: "X6",
  RIGHT: "X7",
  FORWARD_LEFT: "XG",
  FORWARD_RIGHT: "XK",
  BACKWARD_LEFT: "XO",
  BACKWARD_RIGHT: "XS",
  HEAD_UP: "X5",
  HEAD_DOWN: "XA",
  SPEED_LOW: "D",
  SPEED_MEDIUM: "E",
  SPEED_FAST: "W",
  SPEED_SETUP: "]",
  BATTERY: "?",
  INFRARED: "&",
  INFO: ":",
  DOCK: "<",
  UNDOCK: ">",
});

const DIRECTIONS = Object.freeze({
  forward: COMMANDS.FORWARD,
  backward: COMMANDS.BACKWARD,
  left: COMMANDS.LEFT,
  right: COMMANDS.RIGHT,
  forwardLeft: COMMANDS.FORWARD_LEFT,
  forwardRight: COMMANDS.FORWARD_RIGHT,
  backwardLeft: COMMANDS.BACKWARD_LEFT,
  backwardRight: COMMANDS.BACKWARD_RIGHT,
  headUp: COMMANDS.HEAD_UP,
  headDown: COMMANDS.HEAD_DOWN,
});
const SPEEDS = Object.freeze({ low: "D", medium: "E", fast: "W" });
const MAX_DELAY = 2147483647;

export function normalizeUuid(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) return value;
  if (typeof value !== "string") throw new TypeError("UUID must be a string or unsigned integer.");
  const uuid = value.trim().toLowerCase();
  if (/^(?:0x)?[0-9a-f]{4}$/.test(uuid)) return Number.parseInt(uuid.replace(/^0x/, ""), 16);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) return uuid;
  throw new TypeError(`Invalid Bluetooth UUID: ${value}`);
}

function speedName(value) {
  const name = typeof value === "number" ? ["low", "medium", "fast"][value - 1] : value;
  if (typeof name !== "string" || !Object.hasOwn(SPEEDS, name)) throw new RangeError("Speed must be low, medium, fast, or 1, 2, 3.");
  return name;
}

function delayValue(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DELAY) {
    throw new RangeError(`${name} must be an integer between 0 and ${MAX_DELAY} milliseconds.`);
  }
  return value;
}

function aborted() {
  return new DOMException("Command superseded or connection closed.", "AbortError");
}

export class PadBot extends EventTarget {
  #bluetooth;
  #options;
  #device = null;
  #server = null;
  #service = null;
  #targets = [];
  #notify = null;
  #ready = false;
  #connecting = null;
  #disconnecting = null;
  #queue = Promise.resolve();
  #session = 0;
  #motion = 0;
  #timers = new Set();
  #speed;
  #lastCommand = null;

  constructor({
    bluetooth = globalThis.navigator?.bluetooth,
    serviceUuid = "0xfff0",
    writeUuid = null,
    notifyUuid = null,
    protocolMode = "auto",
    speed = "medium",
    initialize = true,
  } = {}) {
    super();
    if (!["raw", "mn", "pq", "auto"].includes(protocolMode)) {
      throw new RangeError("protocolMode must be raw, mn, pq, or auto.");
    }
    this.#bluetooth = bluetooth;
    this.#speed = speedName(speed);
    this.#options = {
      serviceUuid: normalizeUuid(serviceUuid),
      writeUuid: writeUuid == null || writeUuid === "" ? null : normalizeUuid(writeUuid),
      notifyUuid: notifyUuid == null || notifyUuid === "" ? null : normalizeUuid(notifyUuid),
      protocolMode,
      initialize,
    };
  }

  static isSupported() { return Boolean(globalThis.navigator?.bluetooth); }
  get connected() { return this.#ready && Boolean(this.#server?.connected); }
  get device() { return this.#device; }
  get speed() { return this.#speed; }
  get lastCommand() { return this.#lastCommand; }
  get connectionInfo() {
    return {
      connected: this.connected,
      deviceId: this.#device?.id ?? null,
      deviceName: this.#device?.name ?? null,
      serviceUuid: this.#service?.uuid ?? null,
      writeUuids: this.#targets.map((item) => item.uuid),
      notifyUuid: this.#notify?.uuid ?? null,
      protocolMode: this.#options.protocolMode,
    };
  }

  #emit(type, detail) {
    const event = new Event(type);
    Object.defineProperty(event, "detail", { value: detail });
    this.dispatchEvent(event);
  }

  /** Call directly from a click handler when opening the pairing chooser. */
  connect({ device } = {}) {
    if (this.#disconnecting) return Promise.reject(new Error("Disconnect is in progress."));
    if (this.#connecting) return this.#connecting;
    if (this.connected) return Promise.resolve(this.connectionInfo);
    this.#connecting = this.#connect(device).finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  async #connect(device) {
    const { serviceUuid, writeUuid, notifyUuid, initialize } = this.#options;
    try {
      if (!device) {
        if (!this.#bluetooth) throw new Error("Web Bluetooth is unavailable. Use Chrome/Edge on HTTPS or localhost.");
        device = await this.#bluetooth.requestDevice({
          filters: [{ services: [serviceUuid] }, { namePrefix: "PadBot" }, { namePrefix: "padbot" }],
          optionalServices: [serviceUuid],
        });
      }
      if (!device?.gatt) throw new Error("The selected device does not provide a GATT server.");
      this.#device = device;
      const session = ++this.#session;
      const checkSession = () => { if (session !== this.#session) throw aborted(); };
      device.addEventListener("gattserverdisconnected", this.#onDisconnected);
      const server = await device.gatt.connect();
      checkSession();
      this.#server = server;
      const service = await server.getPrimaryService(serviceUuid);
      checkSession();
      this.#service = service;
      const characteristics = await service.getCharacteristics();
      checkSession();
      const targets = writeUuid !== null
        ? [await service.getCharacteristic(writeUuid)]
        : characteristics.filter((item) => item.properties.writeWithoutResponse || item.properties.write);
      checkSession();
      if (!targets.length || targets.some((item) => !item.properties.writeWithoutResponse && !item.properties.write)) {
        throw new Error("No writable BLE characteristic was found.");
      }
      this.#targets = targets;
      const notify = notifyUuid !== null
        ? await service.getCharacteristic(notifyUuid)
        : characteristics.find((item) => item.properties.notify || item.properties.indicate);
      checkSession();
      this.#notify = notify ?? null;
      if (notify) {
        notify.addEventListener("characteristicvaluechanged", this.#onNotification);
        await notify.startNotifications();
        checkSession();
      }
      this.#ready = true;
      if (initialize) {
        await this.setSpeed(this.#speed);
        await this.queryInfrared();
        if (this.#options.protocolMode === "auto") await this.queryInfo();
      }
      checkSession();
      this.#emit("connected", this.connectionInfo);
      return this.connectionInfo;
    } catch (error) {
      const gatt = this.#device?.gatt;
      this.#cleanup();
      if (gatt?.connected) gatt.disconnect();
      throw error;
    }
  }

  /** Returns permitted devices only; never opens a chooser or picks an arbitrary device. */
  async getKnownDevices() {
    if (!this.#bluetooth?.getDevices) throw new Error("This browser cannot list previously permitted Bluetooth devices.");
    return this.#bluetooth.getDevices();
  }

  /** Reuses the last selected device, or requires an explicit permitted device. */
  reconnect(device = this.#device) {
    if (!device) return Promise.reject(new Error("No previous device. Call connect() first or supply a permitted device."));
    return this.connect({ device });
  }

  disconnect() {
    if (!this.#disconnecting) {
      this.#disconnecting = this.#disconnect().finally(() => { this.#disconnecting = null; });
    }
    return this.#disconnecting;
  }

  async #disconnect() {
    if (this.#connecting) await this.#connecting.catch(() => {});
    let failure;
    try {
      if (this.connected) {
        const token = this.#cancelMotion();
        // Send all three stop writes before deliberately closing the radio link.
        for (let index = 0; index < 3; index += 1) {
          try { await this.#send(COMMANDS.STOP, token); } catch (error) { failure ??= error; }
          if (index < 2) await new Promise((resolve) => setTimeout(resolve, 90));
        }
      }
    } finally {
      const gatt = this.#device?.gatt;
      const wasReady = this.#ready;
      this.#cleanup();
      if (gatt?.connected) gatt.disconnect();
      if (wasReady) this.#emit("disconnected", { device: this.#device, unexpected: false });
    }
    if (failure) throw failure;
  }

  #onDisconnected = () => {
    this.#cleanup();
    this.#emit("disconnected", { device: this.#device, unexpected: true });
  };

  #onNotification = (event) => {
    const value = event.target.value;
    // Respect DataView offsets; copy because the browser may reuse its buffer.
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    this.#emit("notification", { bytes, text: new TextDecoder().decode(bytes), characteristicUuid: event.target.uuid });
  };

  #cleanup() {
    this.#cancelMotion();
    this.#session += 1;
    this.#ready = false;
    this.#notify?.removeEventListener("characteristicvaluechanged", this.#onNotification);
    this.#device?.removeEventListener("gattserverdisconnected", this.#onDisconnected);
    this.#server = null;
    this.#service = null;
    this.#targets = [];
    this.#notify = null;
    this.#lastCommand = null;
  }

  #assertConnected() {
    if (!this.connected) throw new Error("Robot is not connected.");
    if (this.#disconnecting) throw new Error("Disconnect is in progress.");
  }

  #cancelMotion() {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    return ++this.#motion;
  }

  #schedule(callback, delay, token) {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (token !== this.#motion || !this.connected) return;
      callback().catch((error) => {
        if (error.name !== "AbortError") this.#emit("error", error);
      });
    }, delay);
    this.#timers.add(timer);
  }

  #frames(command) {
    switch (this.#options.protocolMode) {
      case "mn": return [`m${command}n`];
      case "pq": return [`p${command}q`];
      case "auto": return [command, `m${command}n`, `p${command}q`];
      default: return [command];
    }
  }

  #send(command, token = null) {
    const session = this.#session;
    const targets = this.#targets.slice();
    const check = () => {
      if (session !== this.#session || (token !== null && token !== this.#motion)) throw aborted();
      if (!this.connected) throw new Error("Robot is not connected.");
    };
    const operation = this.#queue.then(async () => {
      check();
      const writes = [];
      const failures = [];
      for (const frame of this.#frames(command)) {
        const bytes = new TextEncoder().encode(frame);
        for (const characteristic of targets) {
          check();
          try {
            if (characteristic.properties.writeWithoutResponse && characteristic.writeValueWithoutResponse) {
              await characteristic.writeValueWithoutResponse(bytes);
            } else if (characteristic.writeValueWithResponse) {
              await characteristic.writeValueWithResponse(bytes);
            } else {
              await characteristic.writeValue(bytes);
            }
            writes.push({ frame, characteristicUuid: characteristic.uuid });
          } catch (error) {
            failures.push({ frame, characteristicUuid: characteristic.uuid, error });
          }
        }
      }
      check();
      if (!writes.length) throw new AggregateError(failures.map((item) => item.error), `All BLE writes failed for ${command}.`);
      this.#lastCommand = command;
      const result = { command, writes, failures };
      this.#emit("command", result);
      return result;
    });
    // A failed write must not poison subsequent commands (especially STOP).
    this.#queue = operation.catch(() => {});
    return operation;
  }

  /** Raw protocol escape hatch; cancels managed driving before sending. */
  async sendCommand(command) {
    if (typeof command !== "string" || !command.length) throw new TypeError("Command must be a non-empty string.");
    this.#assertConnected();
    if (command === COMMANDS.STOP) return this.stop();
    return this.#send(command, this.#cancelMotion());
  }

  async setSpeed(value) {
    const name = speedName(value);
    this.#assertConnected();
    const result = await this.#send(SPEEDS[name]);
    this.#speed = name;
    return result;
  }

  /** Resolves after initial write; durationMs schedules STOP, not promise completion. */
  async drive(direction, { durationMs = 0, repeatMs = 220 } = {}) {
    if (typeof direction !== "string" || !Object.hasOwn(DIRECTIONS, direction)) throw new RangeError("Unknown drive direction.");
    delayValue(durationMs, "durationMs");
    delayValue(repeatMs, "repeatMs");
    this.#assertConnected();
    const token = this.#cancelMotion();
    const command = DIRECTIONS[direction];
    const send = async () => {
      try {
        const result = await this.#send(command, token);
        if (token === this.#motion && repeatMs) this.#schedule(send, repeatMs, token);
        return result;
      } catch (error) {
        if (token === this.#motion && this.connected && !this.#disconnecting) await this.stop().catch(() => {});
        throw error;
      }
    };
    const result = await send();
    if (token === this.#motion && durationMs) this.#schedule(() => this.stop(), durationMs, token);
    return result;
  }

  forward(options) { return this.drive("forward", options); }
  backward(options) { return this.drive("backward", options); }
  left(options) { return this.drive("left", options); }
  right(options) { return this.drive("right", options); }
  forwardLeft(options) { return this.drive("forwardLeft", options); }
  forwardRight(options) { return this.drive("forwardRight", options); }
  backwardLeft(options) { return this.drive("backwardLeft", options); }
  backwardRight(options) { return this.drive("backwardRight", options); }
  headUp(options) { return this.drive("headUp", options); }
  headDown(options) { return this.drive("headDown", options); }

  /** Cancel movement immediately; send STOP now and repeat at 90 and 180 ms. */
  async stop() {
    this.#assertConnected();
    const token = this.#cancelMotion();
    this.#schedule(() => this.#send(COMMANDS.STOP, token), 90, token);
    this.#schedule(() => this.#send(COMMANDS.STOP, token), 180, token);
    return this.#send(COMMANDS.STOP, token);
  }

  async #query(command) {
    this.#assertConnected();
    return this.#send(command);
  }

  queryBattery() { return this.#query(COMMANDS.BATTERY); }
  queryInfrared() { return this.#query(COMMANDS.INFRARED); }
  queryInfo() { return this.#query(COMMANDS.INFO); }
  initializeSpeed() { return this.#query(COMMANDS.SPEED_SETUP); }
  dock() { return this.sendCommand(COMMANDS.DOCK); }
  undock() { return this.sendCommand(COMMANDS.UNDOCK); }
}

export default PadBot;