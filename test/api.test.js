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
  points: { unratedFactor: 7 },
  funfacts: { minDrivers: 2, minRatings: 3 },
  abortPolicy: { maxQuote: 20, minRides: 5 },
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
  assert.equal(half.settlementPreview.basis, 'geplant');
  assert.equal((await driver('POST', `/api/rides/${ride.id}/confirm`, {})).status, 409, 'nicht doppelt');
  await driver('POST', `/api/trips/${trip.id}/position`, pointAlongRoute(trip.route.coords, 16));
  assert.equal((await rider('GET', '/api/rides')).rides[0].trackedKm, half.trackedKm, 'nach Bestätigung keine km mehr');
  assert.equal((await rider('GET', '/api/me')).user.walletCents, 2000, 'noch nicht abgebucht');

  // Mitfahrer muss bewerten (NPS 0–10), sonst keine Zahlung
  assert.equal((await rider('POST', `/api/rides/${ride.id}/confirm`, {})).status, 400);
  assert.equal((await rider('POST', `/api/rides/${ride.id}/confirm`, { nps: 11 })).status, 400);
  assert.equal((await rider('GET', '/api/me')).user.walletCents, 2000);
  // Bewertung → Abrechnung: nur 10 km gefahren, trotzdem ist mit Fahrtantritt die geplante Route (17 km) fällig
  const done = (await rider('POST', `/api/rides/${ride.id}/confirm`, { nps: 10, comment: 'Super pünktlich!' })).ride;
  assert.equal(done.myRating.score, 10);
  assert.equal(done.myRating.category, 'promoter');
  assert.equal(done.status, 'completed');
  assert.equal(done.final.billing, 'geplant');
  assert.equal(done.final.confirmedBy, 'beide');
  assert.ok(Math.abs(done.final.km - done.final.plannedKm) < 0.01, String(done.final.km));
  assert.ok(Math.abs(done.final.trackedKm - 10) < 0.1);
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

  // NPS des Fahrers; der Fahrer sieht die Bewertung nicht im Einzelnen
  assert.deepEqual((await driver('GET', '/api/me')).user.nps, { score: 100, count: 1, promoters: 1, passives: 0, detractors: 0 });
  const driverView = (await driver('GET', '/api/rides')).rides[0];
  assert.equal(driverView.npsByRider, undefined);
  assert.equal((await rider('POST', `/api/rides/${ride.id}/rate`, { nps: 3 })).status, 409, 'nur einmal bewerten');
  // Fahrer bewertet den Mitfahrer nachträglich
  await driver('POST', `/api/rides/${ride.id}/rate`, { nps: 6 });
  assert.equal((await rider('GET', '/api/me')).user.nps.detractors, 1);
  assert.equal((await admin('GET', '/api/admin/stats')).driverNps.score, 100);

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
  await rider('POST', `/api/rides/${ride.id}/confirm`, { nps: 8 }); // Reihenfolge egal
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
  assert.equal(r.final.billing, 'geplant');
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

test('Gezahlt wird erst mit Absetzen UND NPS-Bewertung des Mitfahrers', async (t) => {
  const { driver, rider, ride } = await bookedRide(t, { kmDriven: 4 });
  // Mitfahrer bewertet zuerst (Kritiker) – noch keine Zahlung, weil nicht abgesetzt
  const r1 = (await rider('POST', `/api/rides/${ride.id}/confirm`, { nps: 4, comment: 'Zu schnell gefahren.' })).ride;
  assert.equal(r1.status, 'confirming');
  assert.equal((await rider('GET', '/api/me')).user.walletCents, 1000);
  // Fahrer setzt ab (bewertet Mitfahrer optional) → Zahlung
  const r2 = (await driver('POST', `/api/rides/${ride.id}/confirm`, { nps: 9 })).ride;
  assert.equal(r2.status, 'completed');
  assert.ok((await rider('GET', '/api/me')).user.walletCents < 1000);
  // Bewertung ändert den Preis nicht
  assert.equal(r2.final.km, r2.final.plannedKm);
  assert.equal((await driver('GET', '/api/me')).user.nps.score, -100);
  assert.equal((await rider('GET', '/api/me')).user.nps.score, 100);
});

test('Nach automatischer Bestätigung kann der Mitfahrer noch bewerten', async (t) => {
  const { driver, rider, ride, store } = await bookedRide(t, { kmDriven: 3 });
  await driver('POST', `/api/rides/${ride.id}/confirm`, {});
  store.data.rides[ride.id].droppedOffAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  assert.equal((await rider('GET', '/api/rides')).rides[0].status, 'completed');
  await rider('POST', `/api/rides/${ride.id}/rate`, { nps: 7 });
  assert.equal((await driver('GET', '/api/me')).user.nps.passives, 1);
});

test('Punkte nach der Fahrt und Bestenliste nur mit Einwilligung', async (t) => {
  const { driver, rider, ride } = await bookedRide(t, { kmDriven: 4 });
  await driver('POST', `/api/rides/${ride.id}/confirm`, {});
  const done = (await rider('POST', `/api/rides/${ride.id}/confirm`, { nps: 10 })).ride;
  const co2 = done.final.co2SavedKg;
  // Fahrer: mit 10 bewertet → ×10
  const dp = await driver('GET', '/api/me/points');
  assert.equal(dp.points, Math.round(10 * co2));
  assert.equal(dp.history[0].factor, 10);
  // Mitfahrer: (noch) nicht bewertet → ×7
  assert.equal((await rider('GET', '/api/me/points')).points, Math.round(7 * co2));
  // Fahrer bewertet Mitfahrer mit 5 → ×1
  await driver('POST', `/api/rides/${ride.id}/rate`, { nps: 5 });
  const rp = await rider('GET', '/api/me/points');
  assert.equal(rp.points, Math.round(1 * co2));
  assert.equal((await rider('GET', '/api/rides')).rides[0].myPoints.factor, 1);
  assert.equal((await driver('GET', '/api/me')).user.points, dp.points);

  // Bestenliste: ohne Einwilligung sieht der Mitfahrer den Fahrer nicht
  let lb = await rider('GET', '/api/leaderboard?period=month');
  assert.deepEqual(lb.entries.map((e) => e.isMe), [true]);
  assert.equal(lb.optedIn, false);
  await driver('PUT', '/api/me/profile', { privacy: { showOnLeaderboard: true } });
  lb = await rider('GET', '/api/leaderboard?period=all');
  assert.equal(lb.entries[0].name, 'Doris F.');
  assert.equal(lb.entries[0].points, dp.points);
  assert.equal(lb.me.rank, 2);
});

test('Gästebuch: anonym, freiwillig, nur lange Fahrten mit positiver Bewertung', async (t) => {
  const { admin, driver, rider, ride, store } = await bookedRide(t, { kmDriven: 4 });
  await driver('POST', `/api/rides/${ride.id}/confirm`, {});
  await rider('POST', `/api/rides/${ride.id}/confirm`, { nps: 9 });
  // Kurze Fahrt → kein Gästebuch
  let view = (await rider('GET', '/api/rides')).rides[0];
  assert.equal(view.guestbook.eligible, false);
  assert.equal((await rider('POST', `/api/rides/${ride.id}/guestbook`, { text: 'Sehr angenehme Fahrt!', consent: true })).status, 403);

  // Fahrt hat 70 Minuten gedauert → berechtigt
  const r = store.data.rides[ride.id];
  r.droppedOffAt = new Date(new Date(r.pickedUpAt).getTime() + 70 * 60000).toISOString();
  view = (await rider('GET', '/api/rides')).rides[0];
  assert.equal(view.guestbook.eligible, true);
  assert.equal((await driver('GET', '/api/rides')).rides[0].guestbook, null, 'Fahrer kann nicht schreiben');
  assert.equal((await rider('POST', `/api/rides/${ride.id}/guestbook`, { text: 'Sehr angenehme Fahrt!' })).status, 400, 'Einwilligung nötig');
  assert.equal((await rider('POST', `/api/rides/${ride.id}/guestbook`, { text: 'Ruf an: 0170 1234567', consent: true })).status, 400);
  const { entry } = await rider('POST', `/api/rides/${ride.id}/guestbook`, { text: 'Sehr angenehme Fahrt, gute Gespräche und pünktlich!', consent: true });
  assert.equal(entry.kind, 'Fahrt über 1 Stunde');
  assert.equal((await rider('POST', `/api/rides/${ride.id}/guestbook`, { text: 'Noch ein Eintrag bitte', consent: true })).status, 409);

  // Im Fahrerprofil sichtbar – ohne Hinweis auf den Verfasser
  const prof = (await rider('GET', `/api/users/${ride.driverId}/profile`)).profile;
  assert.equal(prof.guestbook.count, 1);
  const raw = JSON.stringify(prof.guestbook);
  assert.ok(!raw.includes(ride.riderId) && !raw.includes('Rudi') && !raw.includes(ride.id));

  // Fahrer blendet aus → nicht mehr öffentlich, aber im eigenen Gästebuch
  const mine = await driver('GET', '/api/me/guestbook');
  assert.equal(mine.entries.length, 1);
  await driver('POST', `/api/guestbook/${entry.id}/hide`, { hidden: true });
  assert.equal((await rider('GET', `/api/users/${ride.driverId}/profile`)).profile.guestbook.count, 0);
  await driver('POST', `/api/guestbook/${entry.id}/hide`, { hidden: false });
  // Fahrer kann fremde Einträge nicht löschen, Verfasser schon
  assert.equal((await driver('DELETE', `/api/guestbook/${entry.id}`, {})).status, 404);
  assert.equal((await admin('GET', '/api/admin/guestbook')).entries.length, 1);
  assert.equal((await rider('DELETE', `/api/guestbook/${entry.id}`, {})).status, 200);
  assert.equal((await rider('GET', `/api/users/${ride.driverId}/profile`)).profile.guestbook.count, 0);
  // Danach wieder möglich
  assert.equal((await rider('GET', '/api/rides')).rides[0].guestbook.eligible, true);
});

test('Gründe bei kritischer Bewertung, anonymes Feedback und Filter beim Suchen', async (t) => {
  const { driver, rider, ride, store, trip } = await bookedRide(t, { kmDriven: 3 });
  await driver('POST', `/api/rides/${ride.id}/confirm`, {});
  const done = (await rider('POST', `/api/rides/${ride.id}/confirm`, { nps: 4, aspects: ['cleanliness', 'driving', 'unbekannt'], comment: 'Krümel auf dem Sitz.' })).ride;
  assert.deepEqual(done.myRating.aspects, ['cleanliness', 'driving']);

  // Fahrer sieht noch nichts (erst ab 3 Rückmeldungen), auch nicht über den Export
  let fbk = await driver('GET', '/api/me/feedback');
  assert.equal(fbk.asDriver.ready, false);
  assert.equal(fbk.asDriver.entries, 1);
  assert.deepEqual(fbk.asDriver.comments, []);
  const exp = await driver('GET', '/api/me/export');
  assert.ok(!JSON.stringify(exp).includes('Krümel'), 'Einzelfeedback nicht im Export des Fahrers');
  assert.ok(JSON.stringify(await rider('GET', '/api/me/export')).includes('Krümel'), 'eigene Bewertung im eigenen Export');

  // Zwei weitere Rückmeldungen (direkt im Speicher simuliert)
  const r = store.data.rides[ride.id];
  for (const [i, aspects, comment] of [[1, ['cleanliness'], ''], [2, ['smell'], 'Roch nach Rauch.']]) {
    store.data.rides['x' + i] = { ...r, id: 'x' + i, npsByRider: { score: 5, aspects, comment, at: `2026-09-0${i}T10:00:00Z` } };
  }
  fbk = await driver('GET', '/api/me/feedback');
  assert.equal(fbk.asDriver.ready, true);
  assert.deepEqual(fbk.asDriver.aspects.map((a) => [a.id, a.count]), [['cleanliness', 2], ['driving', 1], ['smell', 1]]);
  assert.equal(fbk.asDriver.comments.length, 2);

  // Filter: Fahrer raucht nicht (Standard), aber 1 von 3 Bewertungen kritisiert die Fahrweise
  const pickup = pointAlongRoute(trip.route.coords, 2);
  const dropoff = pointAlongRoute(trip.route.coords, 12);
  // Fahrer wieder online bringen
  await driver('POST', `/api/trips/${trip.id}/end`, {});
  const { trip: t2 } = await driver('POST', '/api/trips', { origin: 'Berlin', destination: 'Potsdam', seats: 1 });
  let m = await rider('POST', '/api/match', { pickup, dropoff, filters: { nonSmoker: true } });
  assert.equal(m.matches.length, 1);
  assert.equal(m.matches[0].driverPrefs.smoking, 'nein');
  m = await rider('POST', '/api/match', { pickup, dropoff, filters: { safeDriving: true, minNps: 50 } });
  assert.equal(m.matches.length, 0);
  assert.equal(m.hiddenByFilters, 1);
  assert.deepEqual(m.filteredOut, { minNps: 1, safeDriving: 1 });
  assert.ok(t2.id);
});

test('Anfahrt zum Treffpunkt geht ohne Provision an den Fahrer; Filter kommen aus dem Profil', async (t) => {
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
  await driver('PUT', '/api/me/profile', { profile: { preferences: { smoking: 'ja' } } });
  const { trip } = await driver('POST', '/api/trips', { origin: 'Berlin', destination: 'Potsdam', seats: 1 });

  // Abholort ca. 1 km neben der Route des Fahrers
  const onRoute = pointAlongRoute(trip.route.coords, 3);
  const pickup = { lat: onRoute.lat + 0.009, lng: onRoute.lng };
  const dropoff = pointAlongRoute(trip.route.coords, 15);

  // Filter im Profil: Nichtraucher → Fahrer (Raucher) wird nicht angezeigt
  const me = (await rider('PUT', '/api/me/profile', { riderFilters: { nonSmoker: true, chat: 'laut' } })).user;
  assert.deepEqual(me.riderFilters, { nonSmoker: true }, 'ungültige Werte werden verworfen');
  let m = await rider('POST', '/api/match', { pickup, dropoff });
  assert.equal(m.matches.length, 0);
  assert.equal(m.hiddenByFilters, 1);
  await rider('PUT', '/api/me/profile', { riderFilters: {} });
  m = await rider('POST', '/api/match', { pickup, dropoff });
  assert.equal(m.matches.length, 1);
  const price = m.matches[0].price;
  assert.ok(price.detourKm > 0.9 && price.detourKm < 1.6, String(price.detourKm));
  assert.equal(price.detourCents, Math.round(price.detourKm * 25));

  // Buchen, fahren, abrechnen
  await rider('POST', '/api/wallet/topup', { amountCents: 2000 });
  const { ride } = await rider('POST', '/api/rides', { tripId: trip.id, pickup, dropoff, confirmPlannedRoute: true });
  assert.equal(ride.pickupDetourKm, price.detourKm);
  assert.equal(ride.maxChargeCents, price.totalCents);
  await driver('POST', `/api/rides/${ride.id}/accept`, { confirmPlannedRoute: true });
  await driver('POST', `/api/rides/${ride.id}/pickup`, {});
  await driver('POST', `/api/rides/${ride.id}/confirm`, {});
  const done = (await rider('POST', `/api/rides/${ride.id}/confirm`, { nps: 9 })).ride;
  assert.equal(done.final.detourCents, price.detourCents);
  assert.equal(done.final.commissionCents, Math.round((done.final.fareCents * 10) / 100), 'Provision nur auf gemeinsame Strecke');
  const tx = (await driver('GET', '/api/wallet/transactions')).transactions;
  assert.equal(tx.find((x) => x.type === 'pickup_detour').amountCents, price.detourCents);
  const dMe = (await driver('GET', '/api/me')).user;
  assert.equal(dMe.walletCents, done.final.driverCents);
  assert.equal(done.final.driverCents, done.final.fareCents - done.final.commissionCents + done.final.detourCents);
  assert.equal((await admin('GET', '/api/admin/stats')).commissionCents, done.final.commissionCents);
});

test('Fahrtabbruch: begründet, nur gefahrene Strecke, Fahrtabbruchsquote bei beiden', async (t) => {
  const { driver, rider, ride, store } = await bookedRide(t, { kmDriven: 4 });
  // Begründung ist Pflicht
  assert.equal((await rider('POST', `/api/rides/${ride.id}/abort`, { reason: 'Mir ist schlecht geworden.' })).status, 400);
  assert.equal((await rider('POST', `/api/rides/${ride.id}/abort`, { category: 'health', reason: 'kurz' })).status, 400);
  const res = (await rider('POST', `/api/rides/${ride.id}/abort`, { category: 'health', reason: 'Mir ist schlecht geworden, bitte anhalten.' })).ride;
  assert.equal(res.status, 'completed');
  assert.equal(res.final.billing, 'abbruch');
  assert.ok(res.final.km < res.final.plannedKm);
  assert.ok(Math.abs(res.final.km - res.final.trackedKm) < 0.01);
  assert.equal(res.abort.by, 'rider');
  assert.equal(res.abort.category, 'health');
  // Kein zweiter Abbruch, keine Bestätigung mehr
  assert.equal((await driver('POST', `/api/rides/${ride.id}/abort`, { category: 'other', reason: 'nochmal abbrechen?' })).status, 409);
  // Quote bei beiden: 1 von 1 Fahrten abgebrochen
  const r = (await rider('GET', '/api/me')).user.abortStats.asRider;
  assert.deepEqual(r, { rides: 1, aborted: 1, initiated: 1, quote: 100 });
  const d = (await driver('GET', '/api/me')).user.abortStats.asDriver;
  assert.deepEqual(d, { rides: 1, aborted: 1, initiated: 0, quote: 100 });
  // Im Profil des Fahrers sichtbar; Bewertung kann nachgeholt werden
  const prof = (await rider('GET', `/api/users/${ride.driverId}/profile`)).profile;
  assert.equal(prof.abortStats.asDriver.quote, 100);
  assert.equal((await rider('POST', `/api/rides/${ride.id}/rate`, { nps: 7 })).status, 200);
  // Zweite, normale Fahrt → Quote 50 %
  const r2 = { ...store.data.rides[ride.id], id: 'r2', abort: undefined, final: { ...store.data.rides[ride.id].final, billing: 'geplant' } };
  store.data.rides.r2 = r2;
  assert.equal((await driver('GET', '/api/me')).user.abortStats.asDriver.quote, 50);
});

test('Fahrtabbruch nur während der Fahrt möglich', async (t) => {
  const { driver, rider, ride } = await bookedRide(t, { kmDriven: 2 });
  await driver('POST', `/api/rides/${ride.id}/confirm`, {});
  assert.equal((await rider('POST', `/api/rides/${ride.id}/abort`, { category: 'other', reason: 'Zu spät für einen Abbruch.' })).status, 409);
});

test('Nutzungsbedingungen: Sperre bei zu hoher Fahrtabbruchsquote', async (t) => {
  const { admin, driver, rider, ride, store, trip } = await bookedRide(t, { kmDriven: 2 });
  await driver('POST', `/api/rides/${ride.id}/confirm`, {});
  await rider('POST', `/api/rides/${ride.id}/confirm`, { nps: 8 });
  const base = store.data.rides[ride.id];
  // 6 Fahrten, davon 2 abgebrochen → 33 % > 20 % bei mind. 5 Fahrten
  for (let i = 0; i < 5; i++) {
    store.data.rides['x' + i] = { ...base, id: 'x' + i, abort: i < 2 ? { by: 'driver', category: 'other', reason: 'Testabbruch', at: base.completedAt } : undefined };
  }
  assert.equal((await rider('GET', '/api/admin/abort-review')).status, 403);
  let review = await admin('GET', '/api/admin/abort-review');
  assert.deepEqual(review.policy, { maxQuote: 20, minRides: 5 });
  const flagged = review.flagged.find((m) => m.id === ride.driverId);
  assert.ok(flagged, 'Fahrer steht auf der Prüfliste');
  assert.equal(flagged.flags[0].role, 'driver');
  assert.equal(flagged.flags[0].quote, 33);
  assert.ok(review.flagged.find((m) => m.id === ride.riderId), 'Abbrüche zählen auch für den Mitfahrer');

  // Verwarnung ist für den Betroffenen sichtbar
  await admin('POST', `/api/admin/users/${ride.driverId}/warn`, { note: 'Bitte Abbrüche vermeiden.' });
  assert.equal((await driver('GET', '/api/me')).user.warnings[0].note, 'Bitte Abbrüche vermeiden.');

  // Sperre: Begründung Pflicht, nicht sich selbst
  assert.equal((await admin('POST', `/api/admin/users/${ride.driverId}/suspend`, { days: 7 })).status, 400);
  const me = (await admin('GET', '/api/me')).user;
  assert.equal((await admin('POST', `/api/admin/users/${me.id}/suspend`, { days: 7, reason: 'Selbsttest' })).status, 400);
  await driver('POST', `/api/trips/${trip.id}/end`, {});
  const { trip: t2 } = await driver('POST', '/api/trips', { origin: 'Berlin', destination: 'Potsdam', seats: 1 });
  const s = await admin('POST', `/api/admin/users/${ride.driverId}/suspend`, { days: 7, reason: 'Fahrtabbruchsquote 33 % trotz Verwarnung' });
  assert.ok(s.member.suspension.until);
  assert.equal(store.data.trips[t2.id].status, 'ended', 'aktive Fahrt ohne Mitfahrer beendet');

  // Wirkung: kein Angebot, nicht in der Suche, Konto bleibt zugänglich
  const dMe = (await driver('GET', '/api/me')).user;
  assert.equal(dMe.suspension.reason, 'Fahrtabbruchsquote 33 % trotz Verwarnung');
  const blocked = await driver('POST', '/api/trips', { origin: 'Berlin', destination: 'Potsdam', seats: 1 });
  assert.equal(blocked.status, 403);
  assert.match(blocked.error, /gesperrt/);
  assert.equal((await driver('GET', '/api/me/export')).account.suspension.reason, 'Fahrtabbruchsquote 33 % trotz Verwarnung');
  review = await admin('GET', '/api/admin/abort-review');
  assert.ok(review.suspended.find((m) => m.id === ride.driverId));
  assert.ok(!review.flagged.find((m) => m.id === ride.driverId));

  // Entsperren
  await admin('POST', `/api/admin/users/${ride.driverId}/unsuspend`, {});
  assert.equal((await driver('GET', '/api/me')).user.suspension, null);
  assert.ok((await driver('POST', '/api/trips', { origin: 'Berlin', destination: 'Potsdam', seats: 1 })).trip);

  // Befristete Sperre läuft automatisch ab; gesperrte Mitfahrer können nicht suchen
  await admin('POST', `/api/admin/users/${ride.riderId}/suspend`, { days: 1, reason: 'Fahrtabbruchsquote zu hoch' });
  assert.equal((await rider('POST', '/api/match', { pickup: { lat: 52.5, lng: 13.3 }, dropoff: { lat: 52.4, lng: 13.1 } })).status, 403);
  store.data.users[ride.riderId].suspension.until = new Date(Date.now() - 1000).toISOString();
  assert.equal((await rider('GET', '/api/me')).user.suspension, null);
});
