import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveToolDispatcher, LiveVoice } from './voice.js';

test('LiveToolDispatcher correctly dispatches allowed tools upon response.completed and ignores movie_finished from provider', async () => {
  const sent = [];
  const toolCalls = [];
  const errors = [];
  const dispatcher = new LiveToolDispatcher({
    send: (event) => { sent.push(event); return true; },
    onTool: async (name, args) => {
      toolCalls.push({ name, args });
      return { ok: true, name, mock: true };
    },
    isCurrent: () => true,
    onError: (err) => errors.push(err.message),
  });

  // 1. Delegation created
  dispatcher.handle({
    type: 'session.delegation.created',
    delegation: { id: 'item_del_1', target: 'responses', response_id: 'resp_1' },
  });

  // 2. Function call output item done
  dispatcher.handle({
    type: 'response.event',
    delegation_id: 'item_del_1',
    event: {
      type: 'response.output_item.done',
      response_id: 'resp_1',
      item: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'offer_movie',
        arguments: '{}',
      },
    },
  });

  // Also verify movie_finished is rejected if attempted by model
  dispatcher.handle({
    type: 'response.event',
    delegation_id: 'item_del_1',
    event: {
      type: 'response.output_item.done',
      response_id: 'resp_1',
      item: {
        type: 'function_call',
        call_id: 'call_2',
        name: 'movie_finished',
        arguments: '{}',
      },
    },
  });

  // 3. Response completed triggers tool execution and continuations
  await dispatcher.handle({
    type: 'response.event',
    delegation_id: 'item_del_1',
    event: {
      type: 'response.completed',
      response_id: 'resp_1',
      response: { id: 'resp_1', output: [] },
    },
  });

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'offer_movie');

  // Verify response.item.create was sent for each call, plus response.create
  assert.equal(sent.length, 3);
  assert.equal(sent[0].type, 'response.item.create');
  assert.equal(sent[0].item.call_id, 'call_1');
  assert.equal(JSON.parse(sent[0].item.output).ok, true);

  assert.equal(sent[1].type, 'response.item.create');
  assert.equal(sent[1].item.call_id, 'call_2');
  assert.equal(JSON.parse(sent[1].item.output).ok, false); // movie_finished rejected

  assert.equal(sent[2].type, 'response.create');
});

test('LiveToolDispatcher deduplicates call_id items and serializes responses', async () => {
  const sent = [];
  const dispatcher = new LiveToolDispatcher({
    send: (event) => { sent.push(event); return true; },
    onTool: async (name, args) => ({ ok: true, name, args }),
    isCurrent: () => true,
  });

  dispatcher.handle({
    type: 'session.delegation.created',
    delegation: { id: 'del_2', target: 'responses', response_id: 'resp_2' },
  });

  const item = {
    type: 'function_call',
    call_id: 'call_unique_1',
    name: 'show_movie',
    arguments: '{"accepted":true}',
  };

  dispatcher.handle({
    type: 'response.event',
    delegation_id: 'del_2',
    event: { type: 'response.output_item.done', response_id: 'resp_2', item },
  });

  // Duplicate item event
  dispatcher.handle({
    type: 'response.event',
    delegation_id: 'del_2',
    event: { type: 'response.output_item.done', response_id: 'resp_2', item },
  });

  await dispatcher.handle({
    type: 'response.event',
    delegation_id: 'del_2',
    event: { type: 'response.completed', response_id: 'resp_2' },
  });

  // Only 1 tool execution result + 1 response.create
  assert.equal(sent.length, 2);
  assert.equal(sent[0].item.call_id, 'call_unique_1');
  assert.equal(sent[1].type, 'response.create');
});

test('LiveVoice handles life-cycle, greetings, transcript and quiet context correctly', async () => {
  const channelEvents = [];
  const statusLog = [];
  const transcripts = [];

  class FakeTrack {
    kind = 'audio';
    enabled = true;
    readyState = 'live';
    clone() {
      const cloned = new FakeTrack();
      cloned.enabled = this.enabled;
      return cloned;
    }
    stop() { this.readyState = 'ended'; }
  }

  class FakeMediaStream {
    constructor(tracks = []) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
    getTracks() { return this.tracks; }
    addTrack(t) { this.tracks.push(t); }
  }

  class FakeDataChannel extends EventTarget {
    readyState = 'open';
    send(data) { channelEvents.push(JSON.parse(data)); }
    close() { this.readyState = 'closed'; }
  }

  class FakePeerConnection extends EventTarget {
    iceGatheringState = 'complete';
    connectionState = 'connected';
    localDescription = { sdp: 'v=0\r\no=test 123\r\n' };
    createOffer = async () => ({ sdp: 'v=0\r\no=test 123\r\n' });
    setLocalDescription = async () => {};
    setRemoteDescription = async () => {};
    createDataChannel = () => new FakeDataChannel();
    addTrack = () => {};
    close = () => {};
  }

  const fakeAudioElement = {
    srcObject: null,
    muted: false,
    play: async () => {},
    pause: () => {},
  };

  const fakeMic = new FakeMediaStream([new FakeTrack()]);

  const fakeFetch = async (url, options) => {
    return {
      ok: true,
      json: async () => ({
        session: { id: 'live_test_session_123' },
        transport: { type: 'webrtc', sdp: 'v=0\r\no=remote 456\r\n' },
      }),
    };
  };

  let fakePeer;
  const voice = new LiveVoice({
    audioElement: fakeAudioElement,
    onStatus: (status) => statusLog.push(status),
    onTranscript: (t) => transcripts.push(t),
    onTool: async () => ({ ok: true }),
    fetch: fakeFetch,
    transportFactory: () => {
      fakePeer = new FakePeerConnection();
      return fakePeer;
    },
    mediaStreamFactory: (tracks) => new FakeMediaStream(tracks),
    randomUUID: () => 'uuid-fixed',
  });

  const connectPromise = voice.connect({
    clientId: 'c1111111-1111-4111-8111-111111111111',
    customerId: 'c2222222-2222-4222-8222-222222222222',
    microphone: fakeMic,
  });

  // Emulate data channel message session.started
  setTimeout(() => {
    voice._run.channel.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'session.started', session: { id: 'live_test_session_123' } }),
    }));
  }, 10);

  await connectPromise;
  assert.equal(voice.ready, true);
  assert.deepEqual(statusLog, ['connecting', 'ready']);

  // Greet
  voice.greet();
  assert.equal(channelEvents.length, 1);
  assert.equal(channelEvents[0].type, 'session.instructions.append');
  assert.match(channelEvents[0].content, /Tesla/);

  // Quiet movie readiness context
  voice.movieReady();
  assert.equal(channelEvents.length, 2);
  assert.equal(channelEvents[1].type, 'session.thinking.append');
  assert.match(channelEvents[1].content, /demo movie is ready/);

  // Transcript event
  voice._run.channel.dispatchEvent(new MessageEvent('message', {
    data: JSON.stringify({
      type: 'session.output_transcript.delta',
      delta: 'Hello and welcome!',
      start_ms: 100,
      end_ms: 500,
    }),
  }));

  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].speaker, 'assistant');
  assert.equal(transcripts[0].delta, 'Hello and welcome!');

  // Close voice
  await voice.close();
  assert.equal(voice.ready, false);
  assert.ok(statusLog.includes('closed'));
});
