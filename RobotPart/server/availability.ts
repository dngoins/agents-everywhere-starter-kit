import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { TIME_ZONE } from './config.js';

export interface Slot {
  id: string;
  startAt: string;
  returnAt: string;
  label: string;
}

export interface Availability {
  date: string;
  timeZone: typeof TIME_ZONE;
  slots: Slot[];
  demo: true;
}

export interface Booking {
  id: string;
  customerId: string;
  slotId: string;
  car: 'model3' | 'modely';
  startAt: string;
  returnAt: string;
  timeZone: typeof TIME_ZONE;
  demo: true;
}

export function tomorrowEastern(now: Date): DateTime {
  const local = DateTime.fromJSDate(now, { zone: TIME_ZONE });
  if (!local.isValid) throw new Error('Invalid application clock');
  // Calendar-day arithmetic, NOT 24 hours or parsing a UTC date-only value.
  return local.startOf('day').plus({ days: 1 });
}

export function availabilityFor(customerId: string, now: Date): Availability {
  const tomorrow = tomorrowEastern(now);
  const date = tomorrow.toISODate()!;
  const hours = Array.from({ length: 8 }, (_, index) => index + 9);
  const rank = (hour: number): string => createHash('sha256')
    .update(`${customerId.toLowerCase()}:${date}:${hour}`).digest('hex');
  // Deterministic pseudo-random ranking: three unique, stable hours per customer/date.
  const selected = hours.sort((a, b) => rank(a).localeCompare(rank(b)) || a - b)
    .slice(0, 3).sort((a, b) => a - b);
  const returnAt = tomorrow.set({ hour: 18 }).toISO()!;
  return {
    date,
    timeZone: TIME_ZONE,
    demo: true,
    slots: selected.map((hour) => {
      const start = tomorrow.set({ hour });
      return {
        id: `${customerId.toLowerCase()}:${date}:${hour}`,
        startAt: start.toISO()!,
        returnAt,
        label: `${start.setLocale('en-US').toFormat('ccc, LLL d, h:mm a')} ET — return 6:00 PM ET (demo)`,
      };
    }),
  };
}