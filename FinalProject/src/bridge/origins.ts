export function assertLocalOperatorOrigins(origins: readonly string[]): void {
  if (!origins.length) throw new Error('At least one exact local operator origin is required.');
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error('Operator bridge origins must be exact loopback HTTP(S) origins without paths or credentials.');
    }
  }
}
