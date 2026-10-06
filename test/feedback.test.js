'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fb = require('../src/feedback');
const { sanitizeFilters, failedCriteria } = require('../src/filters');

test('Gründe nur bei Bewertungen bis 8 und nur gültige Aspekte', () => {
  assert.deepEqual(fb.sanitizeAspects(['cleanliness', 'driving', 'driving', 'quatsch'], 3, 'driver'), ['cleanliness', 'driving']);
  assert.deepEqual(fb.sanitizeAspects(['driving'], 8, 'driver'), ['driving']);
  assert.deepEqual(fb.sanitizeAspects(['driving'], 9, 'driver'), [], 'Promotoren brauchen keine Gründe');
  assert.deepEqual(fb.sanitizeAspects(['driving'], 2, 'rider'), [], 'Fahrweise gibt es nicht für Mitfahrer');
  assert.deepEqual(fb.sanitizeAspects(['luggage'], 2, 'rider'), ['luggage']);
  assert.deepEqual(fb.sanitizeAspects('driving', 2, 'driver'), []);
});

test('Feedback erst ab 3 Rückmeldungen, gesammelt und ohne Datum', () => {
  const r = (score, aspects, comment = '', at = '2026-10-0' + score + 'T10:00:00Z') => ({ score, aspects, comment, at });
  const two = [r(3, ['cleanliness']), r(5, ['driving'], 'Etwas zu schnell')];
  const s2 = fb.summarize(two, 'driver');
  assert.equal(s2.ready, false);
  assert.deepEqual(s2.aspects, []);
  assert.deepEqual(s2.comments, []);
  const s3 = fb.summarize([...two, r(6, ['cleanliness', 'smell'], 'Roch nach Rauch'), r(10, [], 'Toll!')], 'driver');
  assert.equal(s3.ready, true);
  assert.equal(s3.entries, 3, 'Promotoren zählen nicht als Verbesserungs-Feedback');
  assert.deepEqual(s3.aspects.map((a) => [a.id, a.count]), [['cleanliness', 2], ['driving', 1], ['smell', 1]]);
  assert.ok(s3.aspects[0].tip.length > 10);
  assert.deepEqual(s3.comments.slice().sort(), ['Etwas zu schnell', 'Roch nach Rauch']);
  assert.ok(!JSON.stringify(s3).includes('2026-10'), 'kein Datum');
});

test('Filter: Kriterien, die der Fahrer erfüllen muss', () => {
  const driver = (prefs = {}, extra = {}) => ({ id: 'd', profile: { preferences: { smoking: 'nein', pets: 'nein', music: 'gerne', chat: 'gerne', ...prefs }, languages: ['Deutsch', 'Englisch'] }, ...extra });
  const check = (f, d, { etaMin = 5, ratings = [] } = {}) => failedCriteria(sanitizeFilters(f), { driver: d, match: { etaMin }, receivedRatings: ratings });
  assert.deepEqual(check({}, driver()), []);
  assert.deepEqual(check({ nonSmoker: true }, driver({ smoking: 'ja' })), ['nonSmoker']);
  assert.deepEqual(check({ pets: true }, driver()), ['pets']);
  assert.deepEqual(check({ chat: 'quiet' }, driver()), ['chat']);
  assert.deepEqual(check({ chat: 'talkative' }, driver()), []);
  assert.deepEqual(check({ music: 'quiet' }, driver()), ['music']);
  assert.deepEqual(check({ language: 'Englisch' }, driver()), []);
  assert.deepEqual(check({ language: 'Polnisch' }, driver()), ['language']);
  assert.deepEqual(check({ mfa: true }, driver()), ['mfa']);
  assert.deepEqual(check({ mfa: true }, driver({}, { mfa: { enabled: true } })), []);
  assert.deepEqual(check({ maxEtaMin: 10 }, driver(), { etaMin: 15 }), ['maxEtaMin']);
  // NPS: neue Fahrer standardmäßig erlaubt, optional ausschließen
  const rated = driver({}, { nps: { promoters: 1, passives: 0, detractors: 1 } }); // NPS 0
  assert.deepEqual(check({ minNps: 30 }, rated), ['minNps']);
  assert.deepEqual(check({ minNps: 0 }, rated), []);
  assert.deepEqual(check({ minNps: 30 }, driver()), [], 'neue Fahrer bleiben drin');
  assert.deepEqual(check({ minNps: 30, includeNew: false }, driver()), ['minNps']);
  // Sichere Fahrweise: > 10 % Kritik an der Fahrweise bei mind. 3 Bewertungen
  const ratings = [{ aspects: ['driving'] }, { aspects: [] }, { aspects: [] }];
  assert.deepEqual(check({ safeDriving: true }, driver(), { ratings }), ['safeDriving']);
  assert.deepEqual(check({ safeDriving: true }, driver(), { ratings: ratings.slice(0, 2) }), [], 'zu wenige Bewertungen');
  // Ungültige Eingaben werden ignoriert
  assert.deepEqual(sanitizeFilters({ chat: 'laut', maxEtaMin: 'x', minNps: 'abc', nonSmoker: 'ja' }), {});
});
