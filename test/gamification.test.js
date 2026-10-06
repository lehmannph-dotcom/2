'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../src/gamification');

const factors = { promoter: 10, passive: 5, detractor: 1 };
const ride = (id, driverId, riderId, co2SavedKg, npsByRider, npsByDriver, completedAt = '2026-10-01T10:00:00Z') => ({
  id, driverId, riderId, status: 'completed', completedAt, final: { co2SavedKg },
  npsByRider: npsByRider === undefined ? undefined : { score: npsByRider },
  npsByDriver: npsByDriver === undefined ? undefined : { score: npsByDriver },
});

test('Punkte = Faktor der erhaltenen Bewertung × CO₂-Ersparnis', () => {
  const r = ride('r1', 'D', 'R', 2.5, 10, 4);
  // Fahrer wurde vom Mitfahrer mit 10 bewertet → Promotor ×10
  assert.deepEqual(game.ridePoints(r, 'D', factors), { points: 25, factor: 10, co2Kg: 2.5, category: 'promoter', rated: true });
  // Mitfahrer wurde vom Fahrer mit 4 bewertet → Kritiker ×1
  assert.equal(game.ridePoints(r, 'R', factors).points, 3);
  // Neutral (7–8) ×5
  assert.equal(game.ridePoints(ride('r2', 'D', 'R', 2, 8), 'D', factors).points, 10);
  // Noch nicht bewertet → neutraler Faktor
  const unrated = game.ridePoints(ride('r3', 'D', 'R', 2, 9), 'R', factors);
  assert.equal(unrated.points, 10);
  assert.equal(unrated.rated, false);
  // Nicht abgeschlossene Fahrten zählen nicht
  assert.equal(game.ridePoints({ ...r, status: 'confirming' }, 'D', factors), null);
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
  const all = game.computeAll(rides, factors, { month: '2026-10' });
  const d = game.summaryFor(all.get('D'));
  // 5 × (10×2) + 1 × (1×2) als Fahrer + als Mitfahrer bei R mit 10 bewertet: 10×2
  assert.equal(d.points, 100 + 2 + 20);
  assert.equal(d.monthPoints, 120);
  const earned = d.badges.filter((b) => b.earned).map((b) => b.id);
  assert.ok(earned.includes('first'));
  assert.ok(earned.includes('both'));
  assert.ok(earned.includes('promoter-5'));
  assert.ok(earned.includes('streak-5'));
  assert.ok(!earned.includes('ten'));
  assert.equal(game.summaryFor(undefined).points, 0);
});
