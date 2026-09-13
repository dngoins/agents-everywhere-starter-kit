export const DEFAULT_LIVE_MODELS: Readonly<{ voice: 'gpt-live-1'; regular: 'gpt-5.6-luna'; highend: 'gpt-6-astra' }>;
export interface LiveSessionRequestOptions<T> {
  sdp: string;
  voiceModel?: string;
  reasoningModel?: string;
  instructions: string;
  delegationInstructions: string;
  tools: readonly T[];
}
export function createLiveSessionRequest<T>(options: LiveSessionRequestOptions<T>): {
  session: {
    model: string;
    instructions: string;
    store: false;
    delegation: {
      type: 'responses';
      responses: { model: string; instructions: string; tools: readonly T[]; tool_choice: 'auto'; parallel_tool_calls: false };
    };
  };
  transport: { type: 'webrtc'; sdp: string };
};
