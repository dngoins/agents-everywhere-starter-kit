import { timingSafeEqual } from "node:crypto";

export function bearer(header: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9._~-]{24,256})$/.exec(header ?? "");
  return match?.[1];
}

export function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
