import { LiveVoice as SharedLiveVoice, LiveToolDispatcher as SharedDispatcher } from '@magicpitch/showroom-runtime/browser';

const allowedTools = [
  'offer_movie', 'show_movie', 'movie_feedback', 'test_drive_interest',
  'get_test_drive_slots', 'book_test_drive', 'follow_customer',
  'stop_following', 'ask_vehicle_expert',
];
const greetingContext = 'Greet immediately in English without waiting for the visitor. '
  + 'Give one warm, concise Tesla AI demo welcome: the Model Y with extra seats is '
  + 'far left; the Model 3 with luxurious speed is on the right. These are staged '
  + 'demo descriptions, not verified specifications. Then pause and listen.';
const readyContext = 'Quiet readiness context only: the demo movie is ready, not '
  + 'authorized to play. Finish the current greeting/question without interrupting. '
  + 'At the next natural transition, delegate to call offer_movie BEFORE asking '
  + 'video consent. Do not play automatically or re-offer after a decline.';

export class LiveToolDispatcher extends SharedDispatcher {
  constructor(options = {}) { super({ allowedTools, ...options }); }
}

export class LiveVoice extends SharedLiveVoice {
  constructor(options = {}) {
    super({
      allowedTools, greetingContext, readyContext, sessionEndpoint: '/api/voice/session',
      errorHints: { server: 'Make sure the local API is running on port 8787.' },
      ...options,
    });
  }

  connect({ clientId, customerId, microphone } = {}) {
    if (typeof clientId !== 'string' || !clientId || typeof customerId !== 'string' || !customerId) {
      return Promise.reject(new Error('A client ID and customer ID are required for voice.'));
    }
    return super.connect({ identity: { clientId, customerId }, microphone });
  }
}
