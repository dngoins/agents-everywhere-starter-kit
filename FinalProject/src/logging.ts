type LogEvent = {
  event: string;
  requestId?: string;
  status?: number;
  method?: string;
  latencyMs?: number;
  code?: string;
};

// Accept only deliberately selected fields, never request/provider payloads.
export function logEvent(event: LogEvent) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...event }));
}
