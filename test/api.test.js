'use strict';

// End-to-End-Test des gesamten Ablaufs über die HTTP-API (ohne externe Dienste).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/db');
const { createApp } = require('../src/app');
const { straightLine, haversineKm, pointAlongRoute } = require('../src/geo');

const BERLIN = { label: 'Berlin', lat: 52.52, lng: 13.405 };
const POTSDAM = { label: 'Potsdam', lat: 52.3906, lng: 13.0645 };

const fakeRouting = {
  geocode: async (q) => (q === 'Berlin' ? [BERLIN] : [POTSDAM]),
  parseGoogleMapsLink: async () => ({ origin: 'Berlin', destination: 'Potsdam' }),
  route: async (from, to) => {
    const a = typeof from === 'string' ? (from === 'Berlin' ? BERLIN : POTSDAM) : from;
    const b = typeof to === 'string' ? (to === 'Berlin' ? BERLIN : POTSDAM) : to;
    const km = haversineKm(a, b);
    return { origin: a, destination: b, coords: straightLine(a, b, 100), distanceKm: km, durationMin: km, provider: 'test' };
  },
};

const config = {
  adminEmail: 'chef@example.org',
  pricing: { ratePerKmCents: 25, commissionPercent: 10, donationCentsPerRide: 1, co2GramsPerCarKm: 150 },
  rides: { autoConfirmHours: 24 },
  matching: { maxDetourKm: 3, maxResults: 10 },
};

function client(base) {
  let cookie = '';
  return async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json();
    return { status: res.status, ...data };
  };
}

test('kompletter Ablauf: Führerschein → Fahrt → Match → Buchung → GPS → Abrechnung', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfz-'));
  const store = new Store(dir);
  const server = http.createServer(createApp({ store, config, routing: fakeRouting }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.close(); store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const admin = client(base);
  const driver = client(base);
  const rider = client(base);

  assert.equal((await admin('POST', '/api/register', { name: 'Chef', email: 'chef@example.org', password: 'geheim123', acceptPrivacy: true })).user.isAdmin, true);
  const d = (await driver('POST', '/api/register', { name: 'Doris Fahrer', email: 'doris@example.org', password: 'geheim123', acceptPrivacy: true })).user;
  await rider('POST', '/api/register', { name: 'Rudi Mit', email: 'rudi@example.org', password: 'geheim123', acceptPrivacy: true });
  assert.equal(d.isAdmin, false);

  // Ohne Führerschein kein Angebot
  assert.equal((await driver('POST', '/api/trips', { origin: 'Berlin', destination: 'Potsdam' })).status, 403);

  // Führerschein einreichen und vom Betreiber bestätigen lassen
  const img = 'data:image/png;base64,iVBORw0KGgo=';
  const bad = await driver('POST', '/api/license', { number: 'x' });
  assert.equal(bad.status, 400);
  assert.ok(bad.details.length > 0);
  const lic = await driver('POST', '/api/license', { fullName: 'Doris Fahrer', number: 'B072RRE2I55', classes: 'B', expiry: '2099-01-01', birthdate: '1985-01-01', frontImage: img, backImage: img });
  assert.equal(lic.user.license.status, 'pending');
  assert.equal((await rider('GET', '/api/admin/licenses')).status, 403);
  const pending = await admin('GET', '/api/admin/licenses');
  assert.equal(pending.licenses.length, 1);
  await admin('POST', `/api/admin/licenses/${d.id}`, { decision: 'verified' });
  assert.equal((await driver('GET', '/api/me')).user.canDrive, true);

  // Fahrer geht per Google-Maps-Link online
  const { trip } = await driver('POST', '/api/trips', { googleMapsUrl: 'https://www.google.com/maps/dir/Berlin/Potsdam', seats: 2, vehicle: 'roter Polo' });
  assert.equal(trip.status, 'active');

  // Mitfahrer sucht – Abholort und Ziel liegen auf der Strecke
  const pickup = { ...pointAlongRoute(trip.route.coords, 3), label: 'Abholung' };
  const dropoff = { ...pointAlongRoute(trip.route.coords, 20), label: 'Ziel' };
  const { matches } = await rider('POST', '/api/match', { pickup, dropoff, seats: 1 });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].driverName, 'Doris F.'); // Nachname standardmäßig abgekürzt
  assert.ok(Math.abs(matches[0].plannedKm - 17) < 0.5, String(matches[0].plannedKm));

  // Geplante (schnellste) Route ist Basis der Bestätigung und des Preises
  const plan = (await rider('POST', '/api/match', { pickup, dropoff })).plannedRoute;
  assert.ok(Math.abs(plan.distanceKm - 17) < 0.5);
  assert.ok(plan.coords.length > 2);
  assert.equal(matches[0].price.fareCents, Math.round(plan.distanceKm * 25));

  // Ohne Bestätigung der Route keine Buchung
  assert.equal((await rider('POST', '/api/rides', { tripId: trip.id, pickup, dropoff })).status, 400);
  // Ohne Guthaben keine Buchung
  assert.equal((await rider('POST', '/api/rides', { tripId: trip.id, pickup, dropoff, confirmPlannedRoute: true })).status, 402);
  await rider('POST', '/api/wallet/topup', { amountCents: 2000 });
  const { ride } = await rider('POST', '/api/rides', { tripId: trip.id, pickup, dropoff, confirmPlannedRoute: true });
  assert.equal(ride.status, 'requested');

  // Fahrer muss die geplante Route ebenfalls bestätigen
  assert.equal((await driver('POST', `/api/rides/${ride.id}/accept`, {})).status, 400);
  assert.equal(ride.plannedRoute.distanceKm, plan.distanceKm);
  // Fahrer nimmt an → Betrag (= Preis der geplanten Route, Höchstbetrag) wird reserviert
  assert.equal(ride.maxChargeCents, ride.estimate.totalCents);
  assert.equal((await driver('POST', `/api/rides/${ride.id}/accept`, { confirmPlannedRoute: true })).ride.status, 'accepted');
  const me1 = (await rider('GET', '/api/me')).user;
  assert.equal(me1.reservedCents, ride.maxChargeCents);

  // Abholen und GPS-Positionen senden (10 km gefahren)
  await driver('POST', `/api/trips/${trip.id}/position`, pointAlongRoute(trip.route.coords, 3));
  await driver('POST', `/api/rides/${ride.id}/pickup`, {});
  for (let k = 4; k <= 13; k++) await driver('POST', `/api/trips/${trip.id}/position`, pointAlongRoute(trip.route.coords, k));

  // Fahrer bestätigt das Fahrtende → noch keine Abrechnung, km-Messung endet
  const half = (await driver('POST', `/api/rides/${ride.id}/confirm`, {})).ride;
  assert.equal(half.status, 'confirming');
  assert.equal(half.myEndConfirmed, true);
  assert.equal(half.partnerEndConfirmed, false);
  assert.equal(half.settlementPreview.basis, 'gefahren');
  assert.equal((await driver('POST', `/api/rides/${ride.id}/confirm`, {})).status, 409, 'nicht doppelt');
  await driver('POST', `/api/trips/${trip.id}/position`, pointAlongRoute(trip.route.coords, 16));
  assert.equal((await rider('GET', '/api/rides')).rides[0].trackedKm, half.trackedKm, 'nach Bestätigung keine km mehr');
  assert.equal((await rider('GET', '/api/me')).user.walletCents, 2000, 'noch nicht abgebucht');

  // Mitfahrer bestätigt → Abrechnung: gefahrene 10 km < geplante 17 km
  const done = (await rider('POST', `/api/rides/${ride.id}/confirm`, {})).ride;
  assert.equal(done.status, 'completed');
  assert.equal(done.final.billing, 'gefahren');
  assert.equal(done.final.confirmedBy, 'beide');
  assert.ok(Math.abs(done.final.km - 10) < 0.1, String(done.final.km));
  assert.ok(done.final.plannedKm > 16);
  assert.equal(done.final.fareCents, Math.round(done.final.km * 25));
  assert.equal(done.final.donationCents, 1);

  const riderMe = (await rider('GET', '/api/me')).user;
  const driverMe = (await driver('GET', '/api/me')).user;
  assert.equal(riderMe.reservedCents, 0);
  assert.equal(riderMe.walletCents, 2000 - done.final.totalCents);
  assert.equal(driverMe.walletCents, done.final.driverCents);
  assert.ok(riderMe.co2SavedKg > 1);

  const stats = await admin('GET', '/api/admin/stats');
  assert.equal(stats.commissionCents, done.final.commissionCents);
  assert.equal(stats.donationCents, 1);
  assert.equal(stats.ridesCompleted, 1);
  // Geld geht nicht verloren: Mitfahrer zahlt = Fahrer + Provision + Spende
  assert.equal(done.final.totalCents, done.final.driverCents + stats.commissionCents + stats.donationCents);

  // Bewertung
  await rider('POST', `/api/rides/${ride.id}/rate`, { stars: 5 });
  assert.equal((await driver('GET', '/api/me')).user.rating, 5);

  // Fahrt beenden
  assert.equal((await driver('POST', `/api/trips/${trip.id}/end`, {})).trip.status, 'ended');
  assert.equal((await rider('POST', '/api/match', { pickup, dropoff })).matches.length, 0);
});

async function bookedRide(t, { kmDriven, plannedShift } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfz-'));
  const store = new Store(dir);
  const server = http.createServer(createApp({ store, config, routing: fakeRouting }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.close(); store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = client(base), driver = client(base), rider = client(base);
  await admin('POST', '/api/register', { name: 'Chef', email: 'chef@example.org', password: 'geheim123', acceptPrivacy: true });
  const d = (await driver('POST', '/api/register', { name: 'Doris Fahrer', email: 'd@example.org', password: 'geheim123', acceptPrivacy: true })).user;
  await rider('POST', '/api/register', { name: 'Rudi Mit', email: 'r@example.org', password: 'geheim123', acceptPrivacy: true });
  const img = 'data:image/png;base64,iVBORw0KGgo=';
  await driver('POST', '/api/license', { fullName: 'Doris Fahrer', number: 'B072RRE2I55', classes: 'B', expiry: '2099-01-01', birthdate: '1985-01-01', frontImage: img, backImage: img });
  await admin('POST', `/api/admin/licenses/${d.id}`, { decision: 'verified' });
  const { trip } = await driver('POST', '/api/trips', { origin: 'Berlin', destination: 'Potsdam', seats: 1 });
  const pickup = pointAlongRoute(trip.route.coords, 2);
  const dropoff = pointAlongRoute(trip.route.coords, 12);
  await rider('POST', '/api/wallet/topup', { amountCents: 1000 });
  const { plannedRoute } = await rider('POST', '/api/match', { pickup, dropoff });
  const shown = plannedShift ? plannedRoute.distanceKm + plannedShift : plannedRoute.distanceKm;
  const booking = await rider('POST', '/api/rides', { tripId: trip.id, pickup, dropoff, confirmPlannedRoute: true, plannedKm: shown });
  if (plannedShift) return { booking };
  const { ride } = booking;
  await driver('POST', `/api/rides/${ride.id}/accept`, { confirmPlannedRoute: true });
  await driver('POST', `/api/trips/${trip.id}/position`, pickup);
  await driver('POST', `/api/rides/${ride.id}/pickup`, {});
  // Umweg simulieren: Strecke hin und her fahren
  let along = 2;
  let dir2 = 1;
  for (let driven = 0; driven < kmDriven; driven++) {
    along += dir2;
    if (along >= 14 || along <= 1) dir2 = -dir2;
    await driver('POST', `/api/trips/${trip.id}/position`, pointAlongRoute(trip.route.coords, along));
  }
  return { admin, driver, rider, ride, store, trip };
}

test('Umweg wird nicht berechnet: gefahrene Strecke länger → geplante Route', async (t) => {
  const { driver, rider, ride } = await bookedRide(t, { kmDriven: 15 });
  await rider('POST', `/api/rides/${ride.id}/confirm`, {}); // Reihenfolge egal
  const done = (await driver('POST', `/api/rides/${ride.id}/confirm`, {})).ride;
  assert.ok(done.final.trackedKm > done.final.plannedKm);
  assert.equal(done.final.billing, 'geplant');
  assert.equal(done.final.km, ride.plannedKm);
  assert.equal(done.final.totalCents, ride.estimate.totalCents);
});

test('Geänderte Route muss neu bestätigt werden', async (t) => {
  const { booking } = await bookedRide(t, { plannedShift: 3 });
  assert.equal(booking.status, 409);
});

test('Einseitige Bestätigung wird nach Frist automatisch abgerechnet', async (t) => {
  const { driver, rider, ride, store } = await bookedRide(t, { kmDriven: 4 });
  await driver('POST', `/api/rides/${ride.id}/confirm`, {});
  assert.equal((await rider('GET', '/api/rides')).rides[0].status, 'confirming');
  store.data.rides[ride.id].droppedOffAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const r = (await rider('GET', '/api/rides')).rides[0];
  assert.equal(r.status, 'completed');
  assert.equal(r.final.confirmedBy, 'automatisch');
  assert.equal(r.final.billing, 'gefahren');
});

test('Reklamation: keine Abrechnung, Betreiber entscheidet', async (t) => {
  const { admin, driver, rider, ride } = await bookedRide(t, { kmDriven: 4 });
  assert.equal((await rider('POST', `/api/rides/${ride.id}/dispute`, { reason: '' })).status, 400);
  const disp = (await rider('POST', `/api/rides/${ride.id}/dispute`, { reason: 'Fahrer hat mich am falschen Ort abgesetzt.' })).ride;
  assert.equal(disp.status, 'disputed');
  assert.equal((await driver('POST', `/api/rides/${ride.id}/confirm`, {})).status, 409);
  assert.equal((await rider('GET', '/api/me')).user.walletCents, 1000);
  assert.equal((await admin('GET', '/api/admin/disputes')).disputes.length, 1);
  assert.equal((await rider('GET', '/api/admin/disputes')).status, 403);
  assert.equal((await admin('POST', `/api/admin/rides/${ride.id}/resolve`, { decision: 'bill', km: 999 })).status, 400);
  const res = (await admin('POST', `/api/admin/rides/${ride.id}/resolve`, { decision: 'bill', km: 2 })).ride;
  assert.equal(res.final.km, 2);
  assert.equal(res.final.billing, 'betreiber');
  const me = (await rider('GET', '/api/me')).user;
  assert.equal(me.walletCents, 1000 - res.final.totalCents);
  assert.equal(me.reservedCents, 0);
});
