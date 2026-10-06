'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../src/gamification');

const settings = { unratedFactor: 7 };
const ride = (id, driverId, riderId, co2SavedKg, npsByRider, npsByDriver, completedAt = '2026-10-01T10:00:00Z') => ({
  id, driverId, riderId, status: 'completed', completedAt, final: { co2SavedKg },
  npsByRider: npsByRider === undefined ? undefined : { score: npsByRider },
  npsByDriver: npsByDriver === undefined ? undefined : { score: npsByDriver },
});

test('Faktor = NPS-Wert bei Promotoren und Passiven, 4–6 → 1, 0–3 → 0', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(game.factorForScore), [0, 0, 0, 0, 1, 1, 1, 7, 8, 9, 10]);
});

test('Punkte = Faktor der erhaltenen Bewertung × CO₂-Ersparnis', () => {
  const r = ride('r1', 'D', 'R', 2.5, 10, 4);
  // Fahrer wurde vom Mitfahrer mit 10 bewertet → ×10
  assert.deepEqual(game.ridePoints(r, 'D', settings), { points: 25, factor: 10, co2Kg: 2.5, score: 10, category: 'promoter', rated: true });
  // Mitfahrer wurde vom Fahrer mit 4 bewertet → ×1
  assert.equal(game.ridePoints(r, 'R', settings).points, 3);
  // 9 → ×9, 8 → ×8, 7 → ×7
  assert.equal(game.ridePoints(ride('a', 'D', 'R', 2, 9), 'D', settings).points, 18);
  assert.equal(game.ridePoints(ride('b', 'D', 'R', 2, 8), 'D', settings).points, 16);
  assert.equal(game.ridePoints(ride('c', 'D', 'R', 2, 7), 'D', settings).points, 14);
  // 0–3 → keine Punkte
  assert.equal(game.ridePoints(ride('d', 'D', 'R', 2, 3), 'D', settings).points, 0);
  assert.equal(game.ridePoints(ride('e', 'D', 'R', 2, 0), 'D', settings).points, 0);
  // Noch nicht bewertet → unratedFactor
  const unrated = game.ridePoints(ride('r3', 'D', 'R', 2, 9), 'R', settings);
  assert.equal(unrated.points, 14);
  assert.equal(unrated.rated, false);
  // Nicht abgeschlossene Fahrten zählen nicht
  assert.equal(game.ridePoints({ ...r, status: 'confirming' }, 'D', settings), null);
});

test('Level und Fortschritt', () => {
  assert.equal(game.levelFor(0).name, 'Setzling');
  const l = game.levelFor(125);
  assert.equal(l.name, 'Sprössling');
  assert.equal(l.next.name, 'Jungbaum');
  assert.equal(l.next.missing, 75);
  assert.equal(l.progress, 0.5);
  assert.equal(game.levelFor(99999).next, null);
});

test('Summen, Monat, Abzeichen und Promotor-Serie', () => {
  const rides = [
    ...[1, 2, 3, 4, 5].map((i) => ride('p' + i, 'D', 'R', 2, 10, undefined, `2026-10-0${i}T10:00:00Z`)),
    ride('x', 'D', 'R2', 2, 3, undefined, '2026-09-20T10:00:00Z'),
    ride('y', 'R', 'D', 2, 9, 10, '2026-10-06T10:00:00Z'),
  ];
  const all = game.computeAll(rides, settings, { month: '2026-10' });
  const d = game.summaryFor(all.get('D'));
  // 5 × (10×2) + 1 × (0×2, Bewertung 3) als Fahrer + als Mitfahrer bei R mit 10 bewertet: 10×2
  assert.equal(d.points, 100 + 0 + 20);
  assert.equal(d.monthPoints, 120);
  const earned = d.badges.filter((b) => b.earned).map((b) => b.id);
  assert.ok(earned.includes('first'));
  assert.ok(earned.includes('both'));
  assert.ok(earned.includes('promoter-5'));
  assert.ok(earned.includes('streak-5'));
  assert.ok(!earned.includes('ten'));
  assert.equal(game.summaryFor(undefined).points, 0);
});
