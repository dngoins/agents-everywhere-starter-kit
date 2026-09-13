export const DEFAULT_LIVE_MODELS = Object.freeze({
  voice: 'gpt-live-1',
  regular: 'gpt-5.6-luna',
  highend: 'gpt-6-astra',
});

// Keep audio/turn-taking unspecified: these are the original Live defaults,
// not Realtime voice presets or a browser speech synthesis replacement.
export function createLiveSessionRequest({
  sdp,
  voiceModel = DEFAULT_LIVE_MODELS.voice,
  reasoningModel = DEFAULT_LIVE_MODELS.regular,
  instructions,
  delegationInstructions,
  tools,
}) {
  if (typeof sdp !== 'string' || !/^v=0(?:\r?\n|$)/.test(sdp)
    || new TextEncoder().encode(sdp).length > 128 * 1024) throw new TypeError('Invalid SDP offer.');
  for (const value of [voiceModel, reasoningModel, instructions, delegationInstructions]) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('Live models and instructions are required.');
  }
  if (!Array.isArray(tools)) throw new TypeError('Live tools must be an array.');
  return {
    session: {
      model: voiceModel,
      instructions,
      store: false,
      delegation: {
        type: 'responses',
        responses: {
          model: reasoningModel,
          instructions: delegationInstructions,
          tools,
          tool_choice: 'auto',
          parallel_tool_calls: false,
        },
      },
    },
    transport: { type: 'webrtc', sdp },
  };
}
