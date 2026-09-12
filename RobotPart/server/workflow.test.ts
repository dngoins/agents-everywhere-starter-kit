import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DateTime } from 'luxon';
import type { Booking } from './availability.js';
import { TIME_ZONE } from './config.js';
import { BOOKING_TODO, FOLLOW_MESSAGE } from './workflow.js';
import { CLIENT_A, CLIENT_B, CUSTOMER_A, CUSTOMER_B, fixture } from './test-helpers.js';

test('gates every transition: no premature movie, feedback, slots or booking', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t);
  await h.upload();
  for (const [name, args] of [
    ['offer_movie', {}], ['show_movie', { accepted: true }], ['movie_finished', {}],
    ['movie_feedback', { liked: true }], ['test_drive_interest', { accepted: true }],
    ['get_test_drive_slots', {}], ['book_test_drive', { slotId: 'not-offered', car: 'model3', confirmed: true }],
  ] as const) assert.equal((await h.tool(name, args)).status, 409, name);
  assert.equal((await h.customer()).body.stage, 'chat');
  assert.equal((await h.api(`/api/test-drive/slots?clientId=${CLIENT_A}&customerId=${CUSTOMER_A}`)).status, 409);
  await h.schedule.advance(5000);
  assert.equal((await h.customer()).body.stage, 'chat');
  assert.equal((await h.tool('show_movie', { accepted: true })).status, 409);
  const offer = await h.tool('offer_movie');
  assert.equal(offer.body.stage, 'movie_offer');
  assert.equal(offer.body.uiAction, 'offer_movie');
  assert.equal((await h.tool('offer_movie')).body.replayed, true);
  assert.equal((await h.tool('movie_finished')).status, 409);
  const playing = await h.tool('show_movie', { accepted: true });
  assert.equal(playing.body.stage, 'watching');
  assert.equal(playing.body.uiAction, 'show_movie');
  assert.equal((await h.tool('show_movie', { accepted: false })).status, 409);
  assert.equal((await h.tool('movie_feedback', { liked: true })).status, 409);
  assert.equal((await h.tool('follow_customer', { destination: 'model3', confirmed: true })).status, 409);
  const finished = await h.tool('movie_finished');
  assert.equal(finished.body.stage, 'feedback');
  assert.equal(finished.body.uiAction, 'feedback');
  assert.equal((await h.tool('movie_finished')).body.replayed, true);
  const staleShow = await h.tool('show_movie', { accepted: true });
  assert.deepEqual(staleShow.body, { ok: true, stage: 'feedback', replayed: true });
  assert.equal((await h.tool('test_drive_interest', { accepted: true })).status, 409);
  assert.equal((await h.tool('movie_feedback', { liked: true })).body.uiAction, 'offer_test_drive');
  assert.equal((await h.tool('get_test_drive_slots')).status, 409);
  const selecting = await h.tool('test_drive_interest', { accepted: true });
  assert.equal(selecting.body.stage, 'selecting');
  assert.equal(selecting.body.uiAction, 'show_slots');
  assert.equal(selecting.body.slots?.length, 3);
});

test('booking aliases share offered slots, confirmation, one record and exactly one sales TODO log', { timeout: 10_000 }, async (t) => {
  const logs: { message: string; booking: Booking }[] = [];
  const h = await fixture(t, { logBooking: (message, booking) => { logs.push({ message, booking }); } });
  const slots = await h.selecting();
  const first = slots.slots![0];
  const alias = await h.api(`/api/test-drive/slots?customerId=${CUSTOMER_A}&clientId=${CLIENT_A}`);
  assert.equal(alias.status, 200);
  assert.deepEqual(alias.body.availability, slots.availability);
  assert.deepEqual((await h.tool('test_drive_interest', { accepted: true })).body.availability, slots.availability);
  const selection = { slotId: first.id, car: 'modely', confirmed: true };
  assert.equal((await h.tool('book_test_drive', { ...selection, confirmed: false })).status, 400);
  assert.equal((await h.tool('book_test_drive', { ...selection, slotId: 'made-up' })).status, 409);
  assert.equal((await h.tool('book_test_drive', { ...selection, car: 'cybertruck' })).status, 400);
  assert.equal((await h.tool('book_test_drive', selection, CUSTOMER_A, CLIENT_B)).status, 403);
  const [viaTool, viaAlias] = await Promise.all([
    h.tool('book_test_drive', selection),
    h.api('/api/test-drive/bookings', { clientId: CLIENT_A, customerId: CUSTOMER_A, ...selection }),
  ]);
  assert.equal(viaTool.status, 200);
  assert.equal(viaAlias.status, 200);
  assert.deepEqual(viaTool.body.booking, viaAlias.body.booking);
  const booking = viaTool.body.booking!;
  assert.match(booking.id, /^[0-9a-f-]{36}$/);
  assert.equal(booking.customerId, CUSTOMER_A);
  assert.equal(booking.demo, true);
  assert.equal(booking.car, 'modely');
  assert.equal(booking.timeZone, TIME_ZONE);
  assert.equal(booking.startAt, first.startAt);
  assert.equal(booking.returnAt, first.returnAt);
  assert.equal(DateTime.fromISO(booking.returnAt, { zone: TIME_ZONE }).hour, 18);
  assert.equal((await h.customer()).body.stage, 'booked');
  assert.deepEqual((await h.customer()).body.booking, booking);
  assert.deepEqual(logs, [{ message: BOOKING_TODO, booking }]);
  assert.deepEqual(Object.keys(logs[0].booking).sort(), ['id', 'customerId', 'slotId', 'car', 'startAt', 'returnAt', 'timeZone', 'demo'].sort());
  assert.equal((await h.tool('book_test_drive', { ...selection, car: 'model3' })).status, 409);
  assert.equal((await h.tool('book_test_drive', { ...selection, slotId: slots.slots![1].id })).status, 409);
  assert.equal((await h.tool('get_test_drive_slots')).status, 409);
  assert.equal(logs.length, 1);
});

test('tomorrow regenerates on Eastern midnight and rejects yesterday\'s offered IDs', { timeout: 10_000 }, async (t) => {
  let now = new Date('2026-09-12T23:59:59-04:00');
  let logCount = 0;
  const h = await fixture(t, { now: () => now, logBooking: () => { logCount += 1; } });
  const old = await h.selecting();
  assert.equal(old.date, '2026-09-13');
  now = new Date('2026-09-13T00:00:00-04:00');
  const bookingArgs = { slotId: old.slots![0].id, car: 'model3', confirmed: true };
  assert.equal((await h.tool('book_test_drive', bookingArgs)).status, 409);
  const refreshed = await h.tool('test_drive_interest', { accepted: true });
  assert.equal(refreshed.body.date, '2026-09-14');
  assert.deepEqual((await h.tool('get_test_drive_slots')).body.availability, refreshed.body.availability);
  assert.equal((await h.tool('book_test_drive', bookingArgs)).status, 409);
  const freshArgs = { ...bookingArgs, slotId: refreshed.body.slots![0].id };
  const booked = await h.tool('book_test_drive', freshArgs);
  assert.equal(booked.status, 200);
  now = new Date('2026-09-14T00:00:00-04:00');
  assert.deepEqual((await h.tool('book_test_drive', freshArgs)).body.booking, booked.body.booking);
  assert.equal(logCount, 1); // Already committed retries are valid even after date rollover.
});

for (const declineAt of ['show_movie', 'movie_feedback', 'test_drive_interest'] as const) {
  test(`decline at ${declineAt} ends the flow without automatic repeat offers`, { timeout: 10_000 }, async (t) => {
    const h = await fixture(t);
    await h.upload();
    await h.schedule.advance(5000);
    await h.tool('offer_movie');
    if (declineAt !== 'show_movie') {
      await h.tool('show_movie', { accepted: true });
      await h.tool('movie_finished');
    }
    if (declineAt === 'test_drive_interest') await h.tool('movie_feedback', { liked: true });
    const args = declineAt === 'movie_feedback' ? { liked: false } : { accepted: false };
    assert.equal((await h.tool(declineAt, args)).body.stage, 'declined');
    assert.equal((await h.tool(declineAt, args)).body.replayed, true);
    const reoffer = await h.tool('offer_movie');
    assert.equal(reoffer.body.stage, 'declined');
    assert.equal(reoffer.body.uiAction, undefined);
    assert.equal((await h.tool('get_test_drive_slots')).status, 409);
    assert.equal((await h.tool('test_drive_interest', { accepted: true })).status, 409);
  });
}

test('following requires confirmation, is restartable after stop, and never controls motors', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t);
  await h.upload();
  const args = { destination: 'model3', confirmed: true };
  assert.equal((await h.tool('follow_customer', { ...args, confirmed: false })).status, 400);
  assert.equal((await h.tool('follow_customer', { ...args, destination: 'outside' })).status, 400);
  const following = await h.tool('follow_customer', args);
  assert.deepEqual(following.body, { ok: true, stage: 'chat', uiAction: 'follow_customer', destination: 'model3', message: FOLLOW_MESSAGE });
  const retry = await h.tool('follow_customer', args);
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.uiAction, undefined);
  assert.equal((await h.tool('stop_following')).body.uiAction, 'stop_following');
  assert.equal((await h.tool('follow_customer', args)).body.uiAction, 'follow_customer');
  assert.equal((await h.tool('motor', { speed: 100 })).status, 400);
  await h.upload(CUSTOMER_B, CLIENT_B);
  assert.equal((await h.tool('stop_following', {}, CUSTOMER_A, CLIENT_B)).status, 403);
  await h.api(`/api/customers/${CUSTOMER_A}`, { clientId: CLIENT_A }, 'DELETE');
  assert.equal((await h.tool('follow_customer', args)).status, 409);
});

test('invalid tool arguments and extra identity fields never advance state', { timeout: 10_000 }, async (t) => {
  const h = await fixture(t);
  await h.upload();
  for (const [name, args] of [
    ['offer_movie', { ignored: true }], ['show_movie', { accepted: 'true' }],
    ['book_test_drive', { confirmed: true }], ['get_test_drive_slots', null], ['stop_following', []],
  ] as const) assert.equal((await h.tool(name, args)).status, 400);
  assert.equal((await h.api('/api/tools/offer_movie', { clientId: CLIENT_A, customerId: CUSTOMER_A, args: {}, bypass: true })).status, 400);
  assert.equal((await h.customer()).body.stage, 'chat');
});