'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gb = require('../src/guestbook');

const base = { riderId: 'R', driverId: 'D', status: 'completed', plannedKm: 30, trackedKm: 28, pickedUpAt: '2026-10-01T10:00:00Z', droppedOffAt: '2026-10-01T10:35:00Z', npsByRider: { score: 9 } };

test('Lange Fahrt: über 100 km oder über 1 Stunde', () => {
  assert.equal(gb.longRideKind(base), null);
  assert.equal(gb.longRideKind({ ...base, plannedKm: 120 }), 'km');
  assert.equal(gb.longRideKind({ ...base, trackedKm: 101 }), 'km');
  assert.equal(gb.longRideKind({ ...base, droppedOffAt: '2026-10-01T11:05:00Z' }), 'hour');
  assert.equal(gb.longRideKind({ ...base, plannedRoute: { durationMin: 75 } }), 'hour');
});

test('Nur Mitfahrer, abgeschlossen, lange Fahrt, positive Bewertung', () => {
  const long = { ...base, plannedKm: 150 };
  assert.equal(gb.eligibility(long, 'R'), null);
  assert.match(gb.eligibility(long, 'D'), /Nur Mitfahrer/);
  assert.match(gb.eligibility({ ...long, status: 'confirming' }, 'R'), /nicht abgeschlossen/);
  assert.match(gb.eligibility(base, 'R'), /über 1 Stunde oder über 100 km/);
  assert.match(gb.eligibility({ ...long, npsByRider: { score: 6 } }, 'R'), /positive Erlebnisse/);
  assert.match(gb.eligibility({ ...long, npsByRider: undefined }, 'R'), /positive Erlebnisse/);
  assert.equal(gb.eligibility({ ...long, npsByRider: { score: 7 } }, 'R'), null);
});

test('Text: Länge, keine Links, E-Mails oder Telefonnummern', () => {
  assert.deepEqual(gb.validateText('  Super   entspannte Fahrt!  ').text, 'Super entspannte Fahrt!');
  assert.equal(gb.validateText('Super entspannte Fahrt nach Hamburg, tolle Musik!').errors.length, 0);
  assert.ok(gb.validateText('kurz').errors.length);
  assert.ok(gb.validateText('x'.repeat(501)).errors.length);
  assert.ok(gb.validateText('Mehr Infos auf www.example.de bitte').errors.length);
  assert.ok(gb.validateText('Schreib mir an max@example.org, war toll').errors.length);
  assert.ok(gb.validateText('Ruf mich an: 0170 1234567 – war super').errors.length);
});

test('Öffentlicher Eintrag ist anonym', () => {
  const pub = gb.publicEntry({ id: 'gb1', driverId: 'D', riderId: 'R', rideId: 'X', text: 'Tolle Fahrt!', kind: 'km', period: '2026-10', createdAt: '2026-10-06T12:34:00Z' });
  assert.deepEqual(pub, { id: 'gb1', text: 'Tolle Fahrt!', when: 'Oktober 2026', kind: 'Fahrt über 100 km' });
  assert.ok(!JSON.stringify(pub).includes('R"'));
});
