'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRegion, regionName } = require('../src/plates');
const funfacts = require('../src/funfacts');
const { sanitizeProfile } = require('../src/profile');

test('Ortskürzel des Kennzeichens', () => {
  assert.equal(normalizeRegion('hh'), 'HH');
  assert.equal(normalizeRegion('HH-AB 123'), 'HH', 'nur das Ortskürzel wird übernommen');
  assert.equal(normalizeRegion('mü'), 'MÜ');
  assert.equal(normalizeRegion(''), '');
  assert.equal(normalizeRegion('ABCD'), null);
  assert.equal(normalizeRegion('12'), null);
  assert.equal(regionName('HH'), 'Hamburg');
  assert.equal(regionName('XYZ'), 'Kennzeichen XYZ');
});

test('Profil: Automarke aus Liste, Kennzeichen nur als Ortskürzel', () => {
  const ok = sanitizeProfile({ vehicle: { brand: 'Volvo', model: 'V60', color: 'blau', plateRegion: 'hh-xy 42' } });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.profile.vehicle, { brand: 'Volvo', plateRegion: 'HH', model: 'V60', color: 'blau' });
  assert.equal(sanitizeProfile({ vehicle: { brand: 'Trabbi-Deluxe' } }).errors.length, 1);
  assert.equal(sanitizeProfile({ vehicle: { plateRegion: '1234' } }).errors.length, 1);
});

const settings = { minDrivers: 2, minRatings: 3 };
const user = (id, brand, plateRegion) => ({ id, profile: { vehicle: { brand, plateRegion } } });
const users = {
  d1: user('d1', 'Volvo', 'HH'), d2: user('d2', 'Volvo', 'HH'),
  d3: user('d3', 'BMW', 'M'), d4: user('d4', 'BMW', 'M'),
  d5: user('d5', 'Tesla', 'B'), // nur ein Fahrer in Berlin / Tesla → nicht anzeigen
  d6: user('d6', '', ''), // keine Angaben
};
let n = 0;
const ride = (driverId, score) => ({ id: 'r' + n++, driverId, riderId: 'x', status: 'completed', npsByRider: { score } });
const rides = [
  ride('d1', 10), ride('d1', 9), ride('d2', 10), ride('d2', 8),           // HH/Volvo: 3 Promotoren, 1 Passiv → +75
  ride('d3', 10), ride('d3', 5), ride('d4', 9), ride('d4', 2),            // M/BMW: 2 Promotoren, 2 Kritiker → 0
  ride('d5', 10), ride('d5', 10), ride('d5', 10),                         // B/Tesla: nur 1 Fahrer
  ride('d6', 10),
  { id: 'open', driverId: 'd1', status: 'confirming', npsByRider: { score: 0 } }, // zählt nicht
];

test('Funfacts: NPS nach Stadt und Marke, nur Gruppen mit mehreren Fahrern', () => {
  const f = funfacts.compute(rides, users, settings);
  assert.deepEqual(f.regions.ranked.map((g) => [g.code, g.name, g.nps, g.count, g.drivers]), [
    ['HH', 'Hamburg', 75, 4, 2],
    ['M', 'München', 0, 4, 2],
  ]);
  assert.deepEqual(f.brands.ranked.map((g) => [g.name, g.nps]), [['Volvo', 75], ['BMW', 0]]);
  assert.equal(f.regions.hiddenGroups, 1, 'Berlin mit nur einem Fahrer ausgeblendet');
  assert.equal(f.brands.hiddenGroups, 1);
});

test('Funfacts: Mindestzahl an Bewertungen', () => {
  const f = funfacts.compute(rides, users, { minDrivers: 1, minRatings: 5 });
  assert.equal(f.regions.ranked.length, 0);
  const g = funfacts.compute(rides, users, { minDrivers: 1, minRatings: 3 });
  assert.deepEqual(g.regions.ranked.map((x) => x.code), ['B', 'HH', 'M']);
});
