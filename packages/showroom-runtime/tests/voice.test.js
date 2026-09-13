import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveVoice, LiveToolDispatcher } from '../browser/index.js';
import { createLiveSessionRequest, DEFAULT_LIVE_MODELS } from '../server/index.js';

function harness(options = {}) {
  const sent = [], errors = [], clones = [];
  let counter = 0;
  const timers = new Map();
  class Track {
    kind = 'audio';
    enabled = true;
    readyState = 'live';
    clone() { const track = new Track(); clones.push(track); return track; }
    stop() { this.readyState = 'ended'; }
  }
  class Stream {
    constructor(tracks = []) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
    getTracks() { return this.tracks; }
    addTrack(track) { this.tracks.push(track); }
  }
  class Channel extends EventTarget {
    readyState = 'open';
    send(data) { sent.push(JSON.parse(data)); }
    close() { this.readyState = 'closed'; }
  }
  const channel = new Channel();
  class Peer extends EventTarget {
    iceGatheringState = 'complete';
    connectionState = 'connected';
    localDescription = { sdp: 'v=0\r\n' };
    createOffer = async () => this.localDescription;
    setLocalDescription = async () => {};
    setRemoteDescription = async () => {};
    createDataChannel = () => channel;
    addTrack = () => {};
    close = () => { this.connectionState = 'closed'; };
  }
  const peer = new Peer();
  const microphone = new Stream([new Track()]);
  const audio = { srcObject: null, muted: false, play: async () => {}, pause() {} };
  const voice = new LiveVoice({
    audioElement: audio,
    sessionFactory: async () => ({ session: { id: 'live-1' }, transport: { type: 'webrtc', sdp: 'v=0\r\n' } }),
    mediaStreamFactory: (tracks) => new Stream(tracks), transportFactory: () => peer,
    randomUUID: () => `event-${++counter}`,
    timers: { setTimeout: (callback, delay) => { const id = ++counter; timers.set(id, { callback, delay }); return id; }, clearTimeout: (id) => timers.delete(id) },
    onError: (error) => errors.push(error.message),
    ...options,
  });
  const event = (data) => channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  return { voice, microphone, clones, audio, channel, peer, sent, errors, event, flush, timers };
}

test('injected session factory, identity, greeting and tool allowlist have no standalone coupling', async () => {
  let request;
  const h = harness({
    sessionFactory: async (input) => { request = input; return { session: { id: 'live-1' }, transport: { type: 'webrtc', sdp: 'v=0\r\n' } }; },
    greetingContext: 'Ask for informed microphone and photography consent.',
    readyContext: 'An approved movie is ready, ask before playback.',
  });
  const connecting = h.voice.connect({ identity: { sessionId: 'showroom-session' }, microphone: h.microphone });
  await h.flush();
  assert.deepEqual(request.identity, { sessionId: 'showroom-session' });
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(h.voice.ready, false);
  h.voice.greet();
  assert.equal(h.sent.length, 0);
  h.event({ type: 'session.started', session: { id: 'live-1' } });
  await connecting;
  assert.equal(h.voice.ready, true);
  assert.equal(h.sent[0].content, 'Ask for informed microphone and photography consent.');
  h.voice.movieReady();
  assert.equal(h.sent[1].content, 'An approved movie is ready, ask before playback.');
  assert.equal(h.voice.greet(), false);
  assert.notEqual(h.clones[0], h.microphone.getAudioTracks()[0]);
  h.voice.setMicrophoneMuted(true);
  assert.equal(h.audio.muted, false);
  assert.equal(h.clones[0].enabled, false);
  h.voice.setPlaybackPaused(true);
  assert.equal(h.clones[0].enabled, false);
  assert.equal(h.microphone.getAudioTracks()[0].enabled, true);
  assert.equal(h.audio.muted, true);
  assert.equal(h.sent.at(-1).type, 'session.input_audio.mute');
  h.voice.setPlaybackPaused(false);
  assert.equal(h.clones[0].enabled, false);
  assert.equal(h.audio.muted, false);
  h.voice.setMicrophoneMuted(false);
  assert.equal(h.clones[0].enabled, true);
  assert.equal(h.sent.at(-1).type, 'session.input_audio.unmute');
  const closing = h.voice.close();
  assert.equal(h.clones[0].readyState, 'ended');
  assert.equal(h.microphone.getAudioTracks()[0].readyState, 'live');
  h.event({ type: 'session.closed', session: { id: 'live-1' } });
  await closing;
  assert.equal(h.audio.srcObject, null);
  assert.equal(h.timers.size, 0);
});

test('timeout aborts injected session creation; late success cannot enable voice', async () => {
  let signal, finish;
  const h = harness({ sessionFactory: (input) => { signal = input.signal; return new Promise((resolve) => { finish = resolve; }); } });
  const connecting = h.voice.connect({ microphone: h.microphone });
  const rejected = assert.rejects(connecting, /timed out/);
  await h.flush();
  [...h.timers.values()].find((timer) => timer.delay === 30_000).callback();
  await rejected;
  assert.equal(signal.aborted, true);
  finish({ session: { id: 'live-1' }, transport: { type: 'webrtc', sdp: 'v=0\r\n' } });
  await h.flush();
  assert.equal(h.voice.ready, false);
  [...h.timers.values()].find((timer) => timer.delay === 4000).callback();
  await h.voice.close();
  assert.equal(h.audio.srcObject, null);
  assert.ok(h.errors.some((error) => error.includes('finalization is unconfirmed')));
});

test('default tools fail closed; injected tools serialize, dedupe IDs, and precede queued text', async () => {
  const sent = [], calls = [];
  const dispatcher = new LiveToolDispatcher({
    allowedTools: ['confirm_action'],
    onTool: async (name, args) => { calls.push({ name, args }); return { ok: true }; },
    send: (event) => sent.push(event),
  });
  dispatcher.handle({ type: 'session.delegation.created', delegation: { target: 'responses', id: 'd', response_id: 'r' } });
  const item = { type: 'function_call', call_id: 'c1', name: 'confirm_action', arguments: '{"revision":3}' };
  const done = { type: 'response.event', delegation_id: 'd', event: { type: 'response.output_item.done', response_id: 'r', item } };
  dispatcher.handle(done);
  dispatcher.handle(done);
  dispatcher.handle({ ...done, event: { ...done.event, item: { ...item, call_id: 'c2', name: 'book_test_drive' } } });
  dispatcher.text('User correction');
  await dispatcher.handle({ type: 'response.event', delegation_id: 'd', event: { type: 'response.completed', response_id: 'r' } });
  assert.deepEqual(calls, [{ name: 'confirm_action', args: { revision: 3 } }]);
  assert.deepEqual(sent.map((event) => event.type), ['response.item.create', 'response.item.create', 'response.create']);
  assert.equal(JSON.parse(sent[1].item.output).ok, false);
  dispatcher.handle({ type: 'response.event', event: { type: 'response.created', response_id: 'r2' } });
  await dispatcher.handle({ type: 'response.event', event: { type: 'response.completed', response_id: 'r2' } });
  assert.equal(sent[3].item.content[0].text, 'User correction');
});

test('provider helper preserves original Live payload/audio defaults while changing business instructions', () => {
  const tools = [{ type: 'function', name: 'confirm_action', strict: true, parameters: { type: 'object', additionalProperties: false } }];
  assert.deepEqual(createLiveSessionRequest({ sdp: 'v=0\r\n', instructions: 'Speak naturally', delegationInstructions: 'Require readback approval', tools }), {
    session: { model: 'gpt-live-1', instructions: 'Speak naturally', store: false, delegation: { type: 'responses', responses: {
      model: 'gpt-5.6-luna', instructions: 'Require readback approval', tools, tool_choice: 'auto', parallel_tool_calls: false,
    } } }, transport: { type: 'webrtc', sdp: 'v=0\r\n' },
  });
  assert.equal(DEFAULT_LIVE_MODELS.highend, 'gpt-6-astra');
  const overridden = createLiveSessionRequest({ sdp: 'v=0\n', voiceModel: 'configured-live', reasoningModel: 'configured-delegation', instructions: 'speak', delegationInstructions: 'act', tools: [] });
  assert.equal(overridden.session.model, 'configured-live');
  assert.equal(overridden.session.delegation.responses.model, 'configured-delegation');
  assert.equal('audio' in overridden.session, false);
  assert.throws(() => createLiveSessionRequest({ sdp: 'bad', instructions: 'speak', delegationInstructions: 'act', tools: [] }), /SDP/);
});
