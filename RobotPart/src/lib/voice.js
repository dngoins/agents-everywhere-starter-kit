// GPT-Live, not Realtime. Contract verified against the Live WebRTC, delegation,
// and primary-websocket references on developers.openai.com (2026-09-12).
const MODEL_TOOLS = new Set([
  'offer_movie', 'show_movie', 'movie_feedback', 'test_drive_interest',
  'get_test_drive_slots', 'book_test_drive', 'follow_customer',
  'stop_following', 'ask_vehicle_expert',
]); // movie_finished belongs exclusively to the UI, never to the provider.

const GREETING = 'Greet immediately in English without waiting for the visitor. '
  + 'Give one warm, concise Tesla AI demo welcome: the Model Y with extra seats is '
  + 'far left; the Model 3 with luxurious speed is on the right. These are staged '
  + 'demo descriptions, not verified specifications. Then pause and listen.';
const MOVIE_READY = 'Quiet readiness context only: the demo movie is ready, not '
  + 'authorized to play. Finish the current greeting/question without interrupting. '
  + 'At the next natural transition, delegate to call offer_movie BEFORE asking '
  + 'video consent. Do not play automatically or re-offer after a decline.';

const object = (value) => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const id = (value) => typeof value === 'string' && value.length > 0;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const notify = (callback, value) => {
  try { Promise.resolve(callback?.(value)).catch(() => {}); } catch { /* Parent callbacks cannot break cleanup. */ }
};
const current = (check) => {
  try { return check?.() !== false; } catch { return false; }
};
const scrub = (message) => (typeof message === 'string' ? message : 'Voice reported an error.')
  .replace(/\bsk-[a-z0-9_-]+/gi, '[redacted]')
  .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
  .replace(/\b(api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*[^\s,;"'<>]+/gi, '$1=[redacted]')
  .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 400);
class VoiceFailure extends Error {}
const aborted = () => Object.assign(new Error('Voice connection canceled.'), { name: 'AbortError' });

// Exact token counting would require the model's tokenizer. UTF-8 bytes are a
// conservative upper bound for byte-level tokens, including non-English text.
// Never split a Unicode code point; also enforce the requested 1,800-char cap.
function appendContent(text) {
  let content = '';
  let bytes = 0;
  for (const character of text.slice(0, 1800)) {
    const code = character.codePointAt(0);
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + size > 500) break;
    content += character;
    bytes += size;
  }
  return content;
}

/**
 * DOM-free, single-session tool loop. send(event) is synchronous (false means
 * not sent). handle(envelope) returns a promise for completed-response work.
 * text() queues user messages until idle, including the response.create/created
 * gap. close() permanently invalidates pending work. onDrained is optional.
 * Response IDs are authoritative; a delegation is a correlation, not a response.
 */
export class LiveToolDispatcher {
  constructor({ send, onTool, isCurrent, onError, onDrained } = {}) {
    this.send = send;
    this.onTool = onTool;
    this.isCurrent = isCurrent;
    this.onError = onError;
    this.onDrained = onDrained;
    this.responses = new Map();
    this.results = new Map();
    this._texts = [];
    this._work = Promise.resolve();
    this._waitingResponse = false;
    this._blocked = false;
    this._closed = false;
  }

  get busy() {
    return this._blocked || this._waitingResponse
      || [...this.responses.values()].some((response) => !response.settled);
  }

  _active() {
    if (!current(this.isCurrent)) this.close();
    return !this._closed && !this._blocked;
  }

  _fault(message) {
    this._blocked = true; // Unknown pending results must never be bypassed by text.
    notify(this.onError, new Error(message));
  }

  _emit(event) {
    if (!this._active()) return false;
    try {
      if (this.send(event) !== false) return true;
    } catch { /* Do not expose payloads or transport errors. */ }
    this._fault('Could not send a voice response. Close voice and reconnect.');
    return false;
  }

  _record(responseId, delegationId) {
    let response = this.responses.get(responseId);
    if (!response) {
      response = { id: responseId, delegationId, calls: new Map(), completed: false, settled: false };
      this.responses.set(responseId, response);
      this._waitingResponse = false;
    } else if (delegationId !== null) {
      if (response.delegationId !== null && response.delegationId !== delegationId) {
        this._fault('Conflicting voice response mapping. Close voice and reconnect.');
        return null;
      }
      response.delegationId = delegationId;
    }
    return response;
  }

  _mapped(event, delegationId) {
    const direct = id(event.response_id) ? event.response_id : null;
    const snapshot = id(event.response?.id) ? event.response.id : null;
    if (direct && snapshot && direct !== snapshot) return null;
    if (direct || snapshot) return this._record(direct || snapshot, delegationId);
    // Granular Responses events may omit response_id. Only use an unambiguous
    // active response of this delegation, never an arbitrary "last response".
    const candidates = [...this.responses.values()].filter((response) =>
      response.delegationId === delegationId && !response.completed);
    return candidates.length === 1 ? candidates[0] : null;
  }

  handle(envelope) {
    if (!this._active() || !object(envelope)) return;
    if (envelope.type === 'session.delegation.created') {
      const delegation = envelope.delegation;
      if (delegation?.target !== 'responses') return;
      if (!id(delegation.id) || !id(delegation.response_id)) {
        this._fault('Missing voice response mapping. Close voice and reconnect.');
        return;
      }
      this._record(delegation.response_id, delegation.id);
      return;
    }
    if (envelope.type !== 'response.event') return;
    const event = envelope.event;
    if (!object(event) || typeof event.type !== 'string') {
      this._fault('Invalid delegated voice event. Close voice and reconnect.');
      return;
    }
    // Arguments-done lacks the authoritative finished function item. Ignore it,
    // argument deltas, text, and unknown future lifecycle events.
    const terminal = ['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type);
    if (event.type !== 'response.created' && event.type !== 'response.output_item.done' && !terminal) return;
    const item = event.item;
    if (event.type === 'response.output_item.done' && item?.type !== 'function_call') return;
    const delegationId = id(envelope.delegation_id) ? envelope.delegation_id : null;
    // A repeated item without correlation needs no new work or guessed mapping.
    if (event.type === 'response.output_item.done' && this.results.has(item.call_id)) return;
    const response = this._mapped(event, delegationId);
    if (!response) {
      if (!this._blocked) this._fault('Missing or ambiguous voice response mapping. Close voice and reconnect.');
      return;
    }
    if (response.completed) return response.task;
    if (event.type === 'response.created') return;
    if (event.type === 'response.output_item.done') {
      if (!id(item.call_id)) {
        this._fault('A voice tool call has no call ID. Close voice and reconnect.');
        return;
      }
      const call = { call_id: item.call_id, name: item.name, arguments: item.arguments, sent: false };
      response.calls.set(call.call_id, call);
      this.results.set(call.call_id, call);
      return;
    }
    response.completed = true;
    if (event.type !== 'response.completed') {
      response.settled = true;
      notify(this.onError, new Error('The delegated voice response did not complete. Please try again.'));
      this._drain();
      return;
    }
    // Live clears response.output even at completion; only collected finished
    // items count. Serialize tools/response batches to preserve workflow gates.
    response.task = this._work.then(() => this._finish(response)).catch(() => {
      if (this._active()) this._fault('Could not finish the voice tool response. Close voice and reconnect.');
    });
    this._work = response.task;
    return response.task;
  }

  async _result(call) {
    if (!MODEL_TOOLS.has(call.name)) return { ok: false, error: 'This tool is not available to the voice model.' };
    let args;
    try {
      if (typeof call.arguments !== 'string') throw new Error();
      args = JSON.parse(call.arguments);
      if (!object(args)) throw new Error();
    } catch {
      return { ok: false, error: 'Tool arguments must be a valid JSON object.' };
    }
    if (!this._active()) return null;
    try {
      // The parent performs server validation AND UI application. Do not also
      // apply uiAction here, including for receipt replays.
      const result = await this.onTool(call.name, args);
      if (!this._active()) return null;
      const output = JSON.stringify(result);
      if (output === undefined) throw new Error();
      return JSON.parse(output);
    } catch {
      if (this._active()) notify(this.onError, new Error('A voice tool failed. Check the server and try again.'));
      return { ok: false, error: 'The requested tool could not be completed.' };
    }
  }

  async _finish(response) {
    if (!this._active()) return;
    for (const call of response.calls.values()) {
      if (!this._active()) return;
      call.result = await this._result(call);
      if (!this._active()) return;
    }
    for (const call of response.calls.values()) {
      if (!this._active()) return;
      if (!call.sent) {
        call.sent = true; // No reentrant or retried send can duplicate this item.
        if (!this._emit({ type: 'response.item.create', item: {
          type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(call.result),
        } })) return;
      }
    }
    response.settled = true;
    if (response.calls.size) {
      this._waitingResponse = true; // Also guards the gap before response.created.
      if (!this._emit({ type: 'response.create' })) return;
    }
    this._drain();
  }

  text(text) {
    if (!this._active() || typeof text !== 'string' || !text.trim()) return false;
    this._texts.push(text);
    this._drain();
    return true;
  }

  _drain() {
    if (!this._active() || this.busy) return;
    if (this._texts.length) {
      const text = this._texts.shift();
      this._waitingResponse = true;
      if (this._emit({ type: 'response.item.create', item: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text }],
      } })) this._emit({ type: 'response.create' });
    } else {
      notify(this.onDrained);
    }
  }

  close() {
    this._closed = true;
    this._texts.length = 0;
  }
}

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(aborted()); };
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(operation).then((value) => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) reject(aborted()); else resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', cancel);
      reject(error);
    });
    if (signal.aborted) cancel();
  });
}

function gatherIce(peer, signal, timers) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error) => {
      timers.clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', changed);
      signal.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve();
    };
    const changed = () => { if (peer.iceGatheringState === 'complete') finish(); };
    const cancel = () => finish(aborted());
    peer.addEventListener('icegatheringstatechange', changed);
    signal.addEventListener('abort', cancel, { once: true });
    timer = timers.setTimeout(() => finish(new VoiceFailure('ICE gathering timed out after 10 seconds. Check your network and reconnect.')), 10_000);
    if (signal.aborted) cancel(); else changed();
  });
}

/**
 * Browser GPT-Live adapter; no SDK, DOM creation, credentials, or hardware API.
 * Required: audioElement (parent-owned, visible controls as autoplay fallback),
 * onTool(name, args) -> JSON (server call + UI application). Optional callbacks:
 * onStatus, onTranscript, onError, isCurrent (customer generation predicate).
 * Test seams: fetch, transportFactory() -> peer, mediaStreamFactory(tracks),
 * randomUUID(), timers {setTimeout, clearTimeout}; defaults captured at connect.
 * connect resolves only when ready, rejects Error/AbortError on failure/cancel.
 * Commands return true when queued/sent, false when inactive/invalid. No auto
 * greeting. close resolves after finalization or <=4s best-effort cleanup.
 * The parent must guard its own in-flight onTool/UI work when replacing customers.
 */
export class LiveVoice {
  constructor(options = {}) {
    this.options = options;
    this.audioElement = options.audioElement;
    this._run = null;
    this._state = 'idle';
    this._queued = [];
    this._paused = false;
    this._greeted = false;
    this._movieReady = false;
  }

  get ready() { return Boolean(this._active(this._run) && this._run.ready); }

  _active(run) {
    if (!run || run !== this._run || run.closing || run.closed) return false;
    if (!current(this.options.isCurrent)) {
      this._beginClose(run);
      return false;
    }
    return true;
  }

  _status(run, status) {
    if (run !== this._run || this._state === status) return;
    this._state = status;
    if (current(this.options.isCurrent)) notify(this.options.onStatus, status);
  }

  _error(run, error) {
    if (run === this._run && !run?.closed && current(this.options.isCurrent)) {
      notify(this.options.onError, new Error(scrub(error.message)));
    }
  }

  _fail(run, error) {
    if (!this._active(run)) return;
    run.failure = error;
    this._error(run, error);
    this._beginClose(run);
  }

  _assert(run) { if (!this._active(run)) throw aborted(); }

  async connect({ clientId, customerId, microphone } = {}) {
    if (this._run && !this._run.closed) throw new Error('Voice is already connecting, connected, or closing.');
    if (!current(this.options.isCurrent)) throw aborted();
    const options = this.options;
    const run = {
      abort: new AbortController(), tracks: new Set(), listeners: [],
      readySignal: deferred(), closedSignal: deferred(), earlyEvents: [],
      ready: false, started: false, answerApplied: false, closing: false, closed: false,
      timers: options.timers || { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
      uuid: options.randomUUID || (() => globalThis.crypto.randomUUID()),
    };
    this._run = run;
    this._status(run, 'connecting');
    const signal = run.abort.signal;
    try {
      this._assert(run);
      if (!this.audioElement || typeof this.audioElement.play !== 'function') {
        throw new VoiceFailure('Provide a visible audio element with playback controls for voice.');
      }
      if (!id(clientId) || !id(customerId)) throw new VoiceFailure('A client ID and customer ID are required for voice.');
      const tracks = microphone?.getAudioTracks?.();
      if (!tracks?.length || tracks.some((track) => track.readyState === 'ended')) {
        throw new VoiceFailure('Provide an active microphone stream. Enable microphone permission and try again.');
      }
      const makeStream = options.mediaStreamFactory || ((audioTracks) => new globalThis.MediaStream(audioTracks));
      run.peer = options.transportFactory ? options.transportFactory() : new globalThis.RTCPeerConnection();
      run.remote = makeStream([]);
      this.audioElement.srcObject = run.remote;
      this.audioElement.muted = this._paused;
      for (const track of tracks) {
        const clone = track.clone();
        if (clone === track) throw new VoiceFailure('The microphone could not be safely cloned.');
        run.tracks.add(clone); // Record ownership before any fallible operation.
        clone.enabled = !this._paused;
        run.peer.addTrack(clone, makeStream([clone]));
      }
      this._listen(run, run.peer, 'track', (event) => this._track(run, event));
      this._listen(run, run.peer, 'connectionstatechange', () => {
        if (['failed', 'closed'].includes(run.peer.connectionState)) this._lost(run);
      });
      run.channel = run.peer.createDataChannel('oai-events');
      // All listeners, including terminal events, exist BEFORE createOffer.
      this._listen(run, run.channel, 'message', ({ data }) => this._message(run, data));
      this._listen(run, run.channel, 'open', () => {
        if (run.closing) this._sendClose(run); else this._tryReady(run);
      });
      this._listen(run, run.channel, 'close', () => this._lost(run));
      this._listen(run, run.channel, 'error', () => this._lost(run));
      run.dispatcher = new LiveToolDispatcher({
        send: (event) => this._send(run, event),
        onTool: options.onTool,
        isCurrent: () => this._active(run) && run.ready,
        onError: (error) => this._error(run, error),
      });
      const offer = await abortable(run.peer.createOffer(), signal);
      this._assert(run);
      await abortable(run.peer.setLocalDescription(offer), signal);
      this._assert(run);
      await gatherIce(run.peer, signal, run.timers);
      this._assert(run);
      const sdp = run.peer.localDescription?.sdp;
      if (typeof sdp !== 'string' || !/^v=0(?:\r?\n|$)/.test(sdp)) throw new VoiceFailure('The browser did not produce a valid SDP offer.');
      const fetchSession = options.fetch || globalThis.fetch.bind(globalThis);
      run.fetchTimer = run.timers.setTimeout(() => this._fail(run, new VoiceFailure('Voice session creation timed out. Check the server and reconnect.')), 30_000);
      const response = await abortable(fetchSession('/api/voice/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, customerId, sdp }), signal,
      }), signal);
      this._assert(run);
      let result;
      try { result = await abortable(response.json(), signal); } catch {
        this._assert(run);
        if (!response.ok) {
          const status = Number.isInteger(response.status) ? ` (HTTP ${response.status})` : '';
          throw new VoiceFailure(`Voice server request failed${status}. Make sure the local API is running on port 8787.`);
        }
        throw new VoiceFailure('The voice server returned an invalid response. Check the server and reconnect.');
      }
      this._assert(run);
      run.timers.clearTimeout(run.fetchTimer);
      if (!response.ok) throw new VoiceFailure(scrub(result?.error || 'The voice server could not create a session.'));
      if (!id(result?.session?.id) || result?.transport?.type !== 'webrtc'
        || typeof result.transport.sdp !== 'string' || !/^v=0(?:\r?\n|$)/.test(result.transport.sdp)) {
        throw new VoiceFailure('The voice server returned an invalid session or SDP answer.');
      }
      run.sessionId = result.session.id;
      run.startTimer = run.timers.setTimeout(() => this._fail(run, new VoiceFailure('Voice did not start within 30 seconds. Check your network and reconnect.')), 30_000);
      await abortable(run.peer.setRemoteDescription({ type: 'answer', sdp: result.transport.sdp }), signal);
      this._assert(run);
      run.answerApplied = true;
      this._tryReady(run);
      await abortable(run.readySignal.promise, signal);
      this._assert(run);
    } catch (error) {
      if (run.failure) throw run.failure;
      if (!this._active(run) || signal.aborted) throw aborted();
      const safe = error instanceof VoiceFailure ? error
        : new VoiceFailure('Could not connect voice. Check microphone permissions, browser WebRTC support, and the server.');
      this._fail(run, safe);
      throw safe;
    }
  }

  _listen(run, target, type, listener) {
    target.addEventListener(type, listener);
    run.listeners.push(() => target.removeEventListener(type, listener));
  }

  _tryReady(run) {
    if (!this._active(run) || run.ready || !run.started || !run.answerApplied || run.channel.readyState !== 'open') return;
    run.ready = true;
    run.timers.clearTimeout(run.startTimer);
    run.readySignal.resolve();
    this._status(run, 'ready');
    for (const event of run.earlyEvents.splice(0)) {
      if (this._active(run)) this._event(run, event);
    }
    while (this._active(run) && this._queued.length) this._command(this._queued.shift());
    if (this._active(run) && this._paused) this._send(run, { type: 'session.input_audio.mute' });
  }

  _message(run, data) {
    if (run !== this._run || run.closed) return;
    if (!run.closing && !this._active(run)) return;
    let event;
    try {
      if (typeof data !== 'string') throw new Error();
      event = JSON.parse(data);
      if (!object(event) || typeof event.type !== 'string') throw new Error();
    } catch {
      if (!run.closing) this._error(run, new Error('An invalid voice event was ignored.'));
      return;
    }
    this._event(run, event);
  }

  _event(run, event) {
    if (event.type === 'session.closed') {
      if (event.session?.id && run.sessionId && event.session.id !== run.sessionId) return;
      this._finishClose(run);
      return;
    }
    if (!this._active(run)) return;
    if (event.type === 'session.started') {
      if (!id(event.session?.id) || event.session.id !== run.sessionId) {
        this._fail(run, new VoiceFailure('The voice session identity did not match. Reconnect voice.'));
        return;
      }
      run.started = true;
      this._tryReady(run);
      return;
    }
    if (event.type === 'error') {
      const error = new VoiceFailure(scrub(event.error?.message));
      if (!run.ready) this._fail(run, error); else this._error(run, error);
      return;
    }
    if (!run.ready) {
      if (run.started) run.earlyEvents.push(event);
      return;
    }
    if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      if (typeof event.delta !== 'string' || !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms)) {
        this._error(run, new Error('An invalid voice transcript event was ignored.'));
        return;
      }
      notify(this.options.onTranscript, {
        speaker: event.type === 'session.input_transcript.delta' ? 'customer' : 'assistant',
        delta: event.delta, start_ms: event.start_ms, end_ms: event.end_ms,
      });
    } else {
      run.dispatcher.handle(event);
    }
  }

  _send(run, event) {
    if (!this._active(run) || !run.ready || run.channel.readyState !== 'open') return false;
    try {
      run.channel.send(JSON.stringify({ ...event, event_id: run.uuid() }));
      return true;
    } catch {
      this._fail(run, new VoiceFailure('Could not send a voice command. Close voice and reconnect.'));
      return false;
    }
  }

  _track(run, event) {
    if (!this._active(run) || event.track?.kind !== 'audio') return;
    if (!run.remote.getTracks().includes(event.track)) run.remote.addTrack(event.track);
    if (this.audioElement.srcObject !== run.remote) return;
    this.audioElement.muted = this._paused; // Never unmute because a late track arrived.
    this._play(run);
  }

  _play(run) {
    if (!this._active(run) || this.audioElement.srcObject !== run.remote) return;
    const failed = () => {
      if (this._active(run) && this.audioElement.srcObject === run.remote && !this._paused) {
        this._error(run, new Error('Voice audio could not play automatically. Select Play on the visible audio controls and allow sound in your browser.'));
      }
    };
    try { Promise.resolve(this.audioElement.play()).catch(failed); } catch { failed(); }
  }

  setPlaybackPaused(paused) {
    const run = this._run;
    if (run && !this._active(run)) return false;
    this._paused = Boolean(paused);
    for (const track of run?.tracks || []) track.enabled = !this._paused;
    if (!run || this.audioElement?.srcObject === run.remote) {
      if (this.audioElement) this.audioElement.muted = this._paused;
    }
    if (run?.ready) this._send(run, { type: this._paused ? 'session.input_audio.mute' : 'session.input_audio.unmute' });
    if (run?.remote && !this._paused) this._play(run);
    return true;
  }

  _command(command) {
    if (!current(this.options.isCurrent)) { if (this._run) this._beginClose(this._run); return false; }
    if (this._state === 'closing' || this._state === 'closed') return false;
    if (!this.ready) { this._queued.push(command); return true; }
    if (command.type === 'text') return this._run.dispatcher.text(command.content);
    return this._send(this._run, { ...command, delegation_id: null });
  }

  greet() {
    if (this._greeted) return false;
    this._greeted = this._command({ type: 'session.instructions.append', content: GREETING });
    return this._greeted;
  }

  movieReady() {
    if (this._movieReady) return false;
    this._movieReady = this._command({ type: 'session.thinking.append', content: MOVIE_READY });
    return this._movieReady;
  }

  context(text) {
    return typeof text === 'string' && Boolean(text.trim())
      && this._command({ type: 'session.thinking.append', content: appendContent(text) });
  }

  // Application-authored UI transitions only. Never route typed user text here.
  instruct(text) {
    return typeof text === 'string' && Boolean(text.trim())
      && this._command({ type: 'session.instructions.append', content: appendContent(text) });
  }

  text(text) {
    return typeof text === 'string' && Boolean(text.trim()) && this._command({ type: 'text', content: text });
  }

  _stopAudio(run) {
    for (const track of run.tracks) {
      try { track.enabled = false; track.stop(); } catch { /* Continue releasing other owned tracks. */ }
    }
    run.tracks.clear();
    if (run.remote && this.audioElement?.srcObject === run.remote) {
      this.audioElement.muted = true;
      try { this.audioElement.pause?.(); } catch { /* No audio callback can prevent close. */ }
    }
  }

  _sendClose(run) {
    if (run.closed || run.closeSent || run.channel?.readyState !== 'open') return;
    run.closeSent = true;
    try { run.channel.send(JSON.stringify({ type: 'session.close', event_id: run.uuid() })); } catch {
      this._error(run, new Error('Voice disconnected before session.closed; finalization is unconfirmed.'));
      this._finishClose(run);
    }
  }

  _beginClose(run) {
    if (run.closing || run.closed) return;
    run.closing = true;
    run.ready = false;
    run.dispatcher?.close();
    run.abort.abort();
    this._stopAudio(run); // Privacy first, even while awaiting final provider usage.
    this._queued.length = 0;
    this._status(run, 'closing');
    run.timers.clearTimeout(run.startTimer);
    run.timers.clearTimeout(run.fetchTimer);
    if (run.channel?.readyState === 'open' || (run.sessionId && run.channel?.readyState === 'connecting')) {
      run.closeTimer = run.timers.setTimeout(() => {
        this._error(run, new Error('Voice closed without session.closed after 4 seconds; finalization is unconfirmed.'));
        this._finishClose(run);
      }, 4000);
      this._sendClose(run);
    } else {
      this._finishClose(run);
    }
  }

  _lost(run) {
    if (run !== this._run || run.closed) return;
    if (!run.closing) this._fail(run, new VoiceFailure('Voice disconnected before session.closed. Check your network and reconnect; finalization is unconfirmed.'));
    else this._error(run, new Error('Voice disconnected before session.closed; finalization is unconfirmed.'));
    this._finishClose(run);
  }

  _finishClose(run) {
    if (run.closed) return;
    run.closed = true; // Set before closing transports (which may emit events).
    run.ready = false;
    run.closing = true;
    run.abort.abort();
    run.dispatcher?.close();
    this._stopAudio(run);
    for (const timer of [run.fetchTimer, run.startTimer, run.closeTimer]) run.timers.clearTimeout(timer);
    for (const remove of run.listeners.splice(0)) remove();
    try { run.channel?.close(); } catch { /* Best effort transport release. */ }
    try { run.peer?.close(); } catch { /* Best effort transport release. */ }
    if (run.remote && this.audioElement?.srcObject === run.remote) this.audioElement.srcObject = null;
    run.earlyEvents.length = 0;
    if (run === this._run) {
      this._queued.length = 0;
      this._greeted = false;
      this._movieReady = false;
      this._status(run, 'closed');
    }
    run.closedSignal.resolve();
  }

  async close() {
    const run = this._run;
    if (!run) {
      this._queued.length = 0;
      if (this._state !== 'closed') {
        this._status(null, 'closing');
        this._status(null, 'closed');
      }
      return;
    }
    this._beginClose(run);
    await run.closedSignal.promise;
  }
}
