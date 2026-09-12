import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DateTime } from 'luxon';
import { availabilityFor } from './availability.js';
import { configFromEnv, TIME_ZONE } from './config.js';

const customer = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('configuration is pure, canonical and does not depend on the process environment', () => {
  const config = configFromEnv({ VOICE_MODEL: ' GPT-Live-1 ', REGULAR_MODEL: 'GPT-5.6-luna', HIGHEND_MODEL: 'GPT-6-astra' });
  assert.deepEqual(config, { apiKey: '', models: {
    voice: 'gpt-live-1', regular: 'gpt-5.6-luna', highend: 'gpt-6-astra',
  } });
  assert.deepEqual(configFromEnv(), config);
});

for (const [now, expectedDate, expectedOffset] of [
  ['2026-03-07T23:30:00-05:00', '2026-03-08', -240], // Tomorrow crosses spring DST.
  ['2026-03-08T00:01:00-05:00', '2026-03-09', -240],
  ['2026-10-31T23:30:00-04:00', '2026-11-01', -300], // Tomorrow crosses autumn DST.
  ['2026-11-01T01:30:00-04:00', '2026-11-02', -300],
  ['2026-11-01T01:30:00-05:00', '2026-11-02', -300], // Repeated hour is still the same date.
  ['2026-09-13T03:59:59Z', '2026-09-13', -240], // Sep 12, 23:59:59 in New York.
  ['2026-09-13T04:00:00Z', '2026-09-14', -240],
  ['2026-12-31T23:59:00-05:00', '2027-01-01', -300],
] as const) {
  test(`tomorrow and 18:00 return are Eastern-calendar correct at ${now}`, () => {
    const result = availabilityFor(customer, new Date(now));
    assert.equal(result.date, expectedDate);
    assert.equal(result.timeZone, TIME_ZONE);
    assert.equal(result.demo, true);
    assert.equal(result.slots.length, 3);
    assert.equal(new Set(result.slots.map((slot) => slot.id)).size, 3);
    const hours: number[] = [];
    for (const slot of result.slots) {
      const start = DateTime.fromISO(slot.startAt, { setZone: true });
      const end = DateTime.fromISO(slot.returnAt, { setZone: true });
      assert.equal(start.toISODate(), expectedDate);
      assert.equal(end.toISODate(), expectedDate);
      assert.equal(start.offset, expectedOffset);
      assert.equal(end.offset, expectedOffset);
      assert.ok(start.hour >= 9 && start.hour <= 16);
      assert.equal(start.minute, 0);
      assert.equal(end.hour, 18);
      assert.equal(end.minute, 0);
      assert.ok(end.toMillis() > start.toMillis());
      assert.match(slot.label, /ET.*6:00 PM ET/);
      hours.push(start.hour);
    }
    assert.equal(new Set(hours).size, 3);
    assert.deepEqual(hours, [...hours].sort((a, b) => a - b));
  });
}

test('slots remain identical all day and across uppercase IDs; refresh after midnight changes date and IDs', () => {
  const early = availabilityFor(customer, new Date('2026-09-12T00:01:00-04:00'));
  const late = availabilityFor(customer.toUpperCase(), new Date('2026-09-12T23:59:59-04:00'));
  assert.deepEqual(late, early);
  const next = availabilityFor(customer, new Date('2026-09-13T00:00:00-04:00'));
  assert.notEqual(next.date, early.date);
  assert.ok(next.slots.every((slot) => !early.slots.some((old) => old.id === slot.id)));
  assert.throws(() => availabilityFor(customer, new Date(NaN)), /Invalid application clock/);
});