'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { haversineKm, decodePolyline, projectOntoRoute, straightLine } = require('../src/geo');
const { computeFare, billableKm } = require('../src/pricing');
const { findMatches } = require('../src/matching');
const { validateLicense, canDrive } = require('../src/license');
const { parseGoogleMapsUrl } = require('../src/routing');

const pricing = { ratePerKmCents: 25, commissionPercent: 10, donationCentsPerRide: 1, co2GramsPerCarKm: 150 };
const BERLIN = { lat: 52.52, lng: 13.405 };
const HAMBURG = { lat: 53.5511, lng: 9.9937 };

test('haversine Berlin–Hamburg ≈ 255 km', () => {
  const d = haversineKm(BERLIN, HAMBURG);
  assert.ok(d > 250 && d < 260, String(d));
});

test('decodePolyline (Google-Beispiel)', () => {
  const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(pts, [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ]);
});

test('Projektion auf Route liefert Abstand und Position', () => {
  const route = straightLine({ lat: 52, lng: 13 }, { lat: 52, lng: 14 }, 10);
  const p = projectOntoRoute({ lat: 52.01, lng: 13.5 }, route);
  assert.ok(Math.abs(p.offKm - 1.11) < 0.05, String(p.offKm));
  assert.ok(Math.abs(p.alongKm - haversineKm({ lat: 52, lng: 13 }, { lat: 52, lng: 13.5 })) < 0.2);
});

test('Preisaufteilung: Fahrer + Provision + 1 Cent Spende', () => {
  const f = computeFare(100, pricing);
  assert.equal(f.fareCents, 2500);
  assert.equal(f.commissionCents, 250);
  assert.equal(f.driverCents, 2250);
  assert.equal(f.donationCents, 1);
  assert.equal(f.totalCents, 2501);
  assert.equal(f.driverCents + f.commissionCents + f.donationCents, f.totalCents);
  assert.equal(f.co2SavedKg, 15);
});

test('Preis für mehrere Personen und Rundung in Cent', () => {
  const f = computeFare(12.345, pricing, 2);
  assert.equal(f.km, 12.35);
  assert.equal(f.fareCents, Math.round(12.35 * 25 * 2));
  assert.ok(Number.isInteger(f.commissionCents) && Number.isInteger(f.driverCents));
});

test('Mit Fahrtantritt ist die geplante Route fällig – nur beim Fahrtabbruch die gefahrene Strecke', () => {
  assert.deepEqual(billableKm(10, 0), { km: 10, basis: 'geplant' }, 'ohne GPS: geplante Route');
  assert.deepEqual(billableKm(10, 4), { km: 10, basis: 'geplant' }, 'früher ausgestiegen: trotzdem geplante Route');
  assert.deepEqual(billableKm(10, 14), { km: 10, basis: 'geplant' }, 'Umweg zahlt der Mitfahrer nicht');
  assert.deepEqual(billableKm(10, 4, { aborted: true }), { km: 4, basis: 'abbruch' }, 'Abbruch: gefahrene Strecke');
  assert.deepEqual(billableKm(10, 14, { aborted: true }), { km: 10, basis: 'abbruch' }, 'Abbruch: höchstens geplante Route');
  assert.deepEqual(billableKm(10, 0, { aborted: true }), { km: 0, basis: 'abbruch' });
});

test('Matching: findet Fahrer in Fahrtrichtung, ignoriert Gegenrichtung und Umwege', () => {
  const coords = straightLine(BERLIN, HAMBURG, 200);
  const mk = (id, c, extra = {}) => ({
    id,
    driverId: 'd_' + id,
    status: 'active',
    seatsFree: 3,
    route: { coords: c, distanceKm: 290, durationMin: 180 },
    progressKm: 0,
    ...extra,
  });
  const trips = [
    mk('richtig', coords),
    mk('gegenrichtung', [...coords].reverse()),
    mk('voll', coords, { seatsFree: 0 }),
    mk('weit-weg', straightLine({ lat: 48.1, lng: 11.6 }, { lat: 49.4, lng: 11.1 })),
    mk('schon-vorbei', coords, { progressKm: 200 }),
  ];
  // Abholort und Ziel exakt auf der Linie
  const onLine = (t) => ({ lat: BERLIN.lat + t * (HAMBURG.lat - BERLIN.lat), lng: BERLIN.lng + t * (HAMBURG.lng - BERLIN.lng) });
  const res = findMatches({ trips, request: { pickup: onLine(0.2), dropoff: onLine(0.8), seats: 1, riderId: 'r' }, pricing });
  assert.deepEqual(res.map((r) => r.tripId), ['richtig']);
  assert.ok(res[0].plannedKm > 140 && res[0].plannedKm < 170, String(res[0].plannedKm));
  assert.ok(res[0].price.totalCents > 0);
});

test('Matching: kleinerer Umweg gewinnt', () => {
  const near = straightLine({ lat: 52, lng: 13 }, { lat: 52, lng: 14 });
  const far = straightLine({ lat: 52.02, lng: 13 }, { lat: 52.02, lng: 14 });
  const trips = [
    { id: 'far', driverId: 'a', status: 'active', seatsFree: 2, route: { coords: far, distanceKm: 70, durationMin: 50 } },
    { id: 'near', driverId: 'b', status: 'active', seatsFree: 2, route: { coords: near, distanceKm: 70, durationMin: 50 } },
  ];
  const res = findMatches({ trips, request: { pickup: { lat: 52, lng: 13.2 }, dropoff: { lat: 52, lng: 13.8 }, riderId: 'r' }, pricing });
  assert.deepEqual(res.map((r) => r.tripId), ['near', 'far']);
});

test('Führerschein-Validierung', () => {
  const img = 'data:image/jpeg;base64,AAAA';
  const ok = validateLicense({ fullName: 'Max Muster', number: 'b072rre2i55', classes: 'AM, B, L', expiry: '2035-01-01', birthdate: '1990-05-05', frontImage: img, backImage: img }, new Date('2026-01-01'));
  assert.ok(ok.ok, ok.errors.join());
  assert.equal(ok.normalized.number, 'B072RRE2I55');

  const bad = validateLicense({ fullName: 'Max', number: '123', classes: 'A', expiry: '2020-01-01', birthdate: '2015-01-01' }, new Date('2026-01-01'));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 5);
});

test('canDrive nur mit verifiziertem, gültigem Führerschein', () => {
  const now = new Date('2026-01-01');
  assert.equal(canDrive({ license: { status: 'verified', expiry: '2030-01-01' } }, now), true);
  assert.equal(canDrive({ license: { status: 'pending', expiry: '2030-01-01' } }, now), false);
  assert.equal(canDrive({ license: { status: 'verified', expiry: '2025-01-01' } }, now), false);
  assert.equal(canDrive({}, now), false);
});

test('Google-Maps-Links werden erkannt', () => {
  const a = parseGoogleMapsUrl(new URL('https://www.google.com/maps/dir/Berlin+Hbf/Hamburg+Hbf/@53.0,10.0,8z/data=!3m1!4b1'));
  assert.deepEqual(a, { origin: 'Berlin Hbf', destination: 'Hamburg Hbf' });
  const b = parseGoogleMapsUrl(new URL('https://www.google.com/maps/dir/?api=1&origin=52.52,13.40&destination=K%C3%B6ln'));
  assert.deepEqual(b, { origin: { lat: 52.52, lng: 13.4 }, destination: 'Köln' });
  const c = parseGoogleMapsUrl(new URL('https://www.google.de/maps/dir/52.5,13.4/Leipzig/Dresden/'));
  assert.deepEqual(c, { origin: { lat: 52.5, lng: 13.4 }, destination: 'Dresden' });
  assert.throws(() => parseGoogleMapsUrl(new URL('https://www.google.com/maps/place/Berlin')));
});

test('Anfahrt zum Treffpunkt: ohne Provision, 100 % an den Fahrer, ohne CO₂-Gutschrift', () => {
  const f = computeFare(100, pricing, 1, { pickupDetourKm: 2 });
  assert.equal(f.fareCents, 2500);
  assert.equal(f.commissionCents, 250, 'Provision nur auf die gemeinsame Strecke');
  assert.equal(f.detourKm, 2);
  assert.equal(f.detourCents, 50);
  assert.equal(f.driverCents, 2250 + 50);
  assert.equal(f.totalCents, 2500 + 50 + 1);
  assert.equal(f.driverCents + f.commissionCents + f.donationCents, f.totalCents);
  assert.equal(f.co2SavedKg, 15, 'Anfahrt spart kein CO₂');
  // Anfahrt einmal pro Fahrt, nicht pro Person; Kleinstwerte ignoriert
  assert.equal(computeFare(10, pricing, 3, { pickupDetourKm: 2 }).detourCents, 50);
  assert.equal(computeFare(10, pricing, 1, { pickupDetourKm: 0.05 }).detourCents, 0);
});

test('Sortierung: immer der kürzeste Umweg zuerst – auch vor besserer Bewertung und kürzerer Wartezeit', () => {
  const line = (lat) => straightLine({ lat, lng: 13 }, { lat, lng: 14 });
  const users = {
    star: { id: 'star', nps: { promoters: 50, passives: 0, detractors: 0 } },
    eco: { id: 'eco', nps: { promoters: 0, passives: 0, detractors: 5 } },
  };
  const trips = [
    // bester NPS, kurze Wartezeit, aber ~2 km neben der Strecke
    { id: 'far', driverId: 'star', status: 'active', seatsFree: 1, progressKm: 0.3, route: { coords: line(52.018), distanceKm: 70, durationMin: 50 } },
    // schlechter NPS, aber direkt auf der Strecke
    { id: 'near', driverId: 'eco', status: 'active', seatsFree: 1, route: { coords: line(52), distanceKm: 70, durationMin: 50 } },
  ];
  const res = findMatches({ trips, users, request: { pickup: { lat: 52, lng: 13.2 }, dropoff: { lat: 52, lng: 13.8 }, riderId: 'r' }, pricing });
  assert.deepEqual(res.map((r) => r.tripId), ['near', 'far']);
  assert.ok(res[1].pickupDetourKm > 2 && res[1].price.detourCents > 0);
  assert.equal(res[0].pickupDetourKm, 0);
});
