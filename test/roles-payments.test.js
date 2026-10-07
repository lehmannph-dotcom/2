'use strict';

// Identitätsprüfung, Rollen-Schalter, Bestätigung vor Fahrtantritt, Vorkasse-Stufen, Kostengrenze.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/db');
const { createApp } = require('../src/app');
const { straightLine, haversineKm, pointAlongRoute } = require('../src/geo');
const { signPayload } = require('../src/identity');

const A = { label: 'Start', lat: 52.52, lng: 13.3 };
const B = { label: 'Ziel', lat: 52.52, lng: 13.6 };
const routing = {
  geocode: async () => [],
  parseGoogleMapsLink: async () => ({}),
  route: async (from, to) => ({ origin: from, destination: to, coords: straightLine(from, to, 60), distanceKm: haversineKm(from, to), durationMin: haversineKm(from, to), provider: 'test' }),
};
const config = {
  adminEmail: 'chef@example.org',
  pricing: {
    ratePerKmCents: 20, commissionPerKmCents: 5, donationPerKmCents: 5, extraRatePerKmCents: 10, extraCommissionPerKmCents: 2, extraDonationPerKmCents: 2, co2GramsPerCarKm: 150,
    transitFares: [{ maxKm: 3, cents: 260 }, { maxKm: 20, cents: 380 }, { maxKm: 45, cents: 500 }], transitPerKmBeyondCents: 18,
  },
  identity: { provider: 'demo', webhookSecret: 'geheim-webhook' },
  rides: { autoConfirmHours: 24 },
  points: { unratedFactor: 7 },
  funfacts: { minDrivers: 2, minRatings: 3 },
  abortPolicy: { maxQuote: 20, minRides: 5 },
  matching: { maxDetourKm: 3, maxResults: 10 },
};
const DECL = { fitToDrive: true, licensePresent: true };
const img = 'data:image/png;base64,iVBORw0KGgo=';
const today = () => new Date().toISOString().slice(0, 10);

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmr-roles-'));
  const store = new Store(dir);
  const server = http.createServer(createApp({ store, config, routing }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.close(); store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, ...(await res.json()) };
    };
  };
  const admin = client();
  await admin('POST', '/api/register', { name: 'Chef', email: 'chef@example.org', password: 'geheim123', acceptPrivacy: true });
  const user = async (name, email) => {
    const c = client();
    c.me = (await c('POST', '/api/register', { name, email, password: 'geheim123', acceptPrivacy: true })).user;
    return c;
  };
  const license = async (c) => {
    await c('POST', '/api/license', { fullName: c.me.name, number: 'B072RRE2I55', classes: 'B', expiry: '2099-01-01', birthdate: '1985-01-01', frontImage: img, backImage: img });
    await admin('POST', `/api/admin/licenses/${c.me.id}`, { decision: 'verified' });
  };
  const identify = async (c) => {
    const { caseId } = await c('POST', '/api/identity/start', {});
    return c('POST', `/api/identity/demo/${caseId}/complete`, {});
  };
  const vehicle = (c) => c('PUT', '/api/me/profile', { profile: { vehicle: { brand: 'VW', model: 'Golf', color: 'blau' } } });
  return { store, admin, user, license, identify, vehicle };
}

test('Fahrer-Schalter erst mit vollständigem Fahrerprofil (Identität, Führerschein, Fahrzeug)', async (t) => {
  const { user, license, identify, vehicle } = await setup(t);
  const d = await user('Dana Drive', 'dana@example.org');
  assert.deepEqual(d.me.driverMissing, ['identity', 'license', 'vehicle']);
  assert.equal(d.me.canDrive, false);
  // Rollen für heute: Fahrer geht noch nicht, Mitfahrer schon
  assert.equal((await d('PUT', '/api/me/roles', { date: today(), rider: true, driver: true })).status, 409);
  assert.equal((await d('PUT', '/api/me/roles', { date: today(), rider: false, driver: false })).status, 400);
  assert.deepEqual((await d('PUT', '/api/me/roles', { date: today(), rider: true, driver: false })).user.roles, { date: today(), rider: true, driver: false });
  // Ohne Identitätsprüfung kein Angebot
  await license(d);
  await vehicle(d);
  assert.equal((await d('POST', '/api/trips', { origin: A, destination: B, declaration: DECL })).status, 403);
  const verified = await identify(d);
  assert.equal(verified.user.identity.status, 'verified');
  assert.deepEqual(verified.user.driverMissing, []);
  const roles = await d('PUT', '/api/me/roles', { date: today(), rider: true, driver: true });
  assert.equal(roles.user.roles.driver, true);
  // Öffentliches Profil zeigt „Identität geprüft“
  assert.equal((await d('GET', `/api/users/${d.me.id}/profile?preview=stranger`)).profile.identityVerified, true);
});

test('Identitätsprüfung: Ergebnis des Anbieters nur mit gültiger Signatur', async (t) => {
  const { user } = await setup(t);
  const u = await user('Ina Ident', 'ina@example.org');
  const { caseId, redirectUrl } = await u('POST', '/api/identity/start', {});
  assert.match(redirectUrl, /^#\/identitaet\//);
  assert.equal((await u('GET', '/api/me')).user.identity.status, 'pending');
  const post = async (body) => {
    const res = await u('POST', '/api/identity/webhook', body);
    return res.status;
  };
  const timestamp = Date.now();
  assert.equal(await post({ caseId, result: 'success', timestamp, signature: 'ab'.repeat(32) }), 401, 'falsche Signatur');
  assert.equal(await post({ caseId, result: 'success', timestamp: timestamp - 3600_000, signature: signPayload('geheim-webhook', { caseId, result: 'success', timestamp: timestamp - 3600_000 }) }), 401, 'zu alt');
  assert.equal(await post({ caseId, result: 'success', timestamp, signature: signPayload('geheim-webhook', { caseId, result: 'success', timestamp }) }), 200);
  const me = (await u('GET', '/api/me')).user;
  assert.equal(me.identity.status, 'verified');
  // Gespeichert werden nur Ergebnis, Verfahren und Zeitpunkt
  const exp = await u('GET', '/api/me/export');
  assert.deepEqual(Object.keys(exp.account.identity).sort(), ['provider', 'status', 'verifiedAt']);
  assert.equal((await u('POST', '/api/identity/start', {})).status, 409, 'bereits geprüft');
});

test('Vor Fahrtantritt: Fahrtauglichkeit und Fahrerlaubnis bestätigen – optional für einen Monat', async (t) => {
  const { user, license, identify, vehicle } = await setup(t);
  const d = await user('Dana Drive', 'dana@example.org');
  await license(d); await identify(d); await vehicle(d);
  assert.equal((await d('POST', '/api/trips', { origin: A, destination: B })).status, 428);
  assert.equal((await d('POST', '/api/trips', { origin: A, destination: B, declaration: { fitToDrive: true } })).status, 428);
  const { trip } = await d('POST', '/api/trips', { origin: A, destination: B, declaration: DECL });
  assert.ok(trip.declaration.confirmedAt);
  assert.equal((await d('GET', '/api/me')).user.driverDeclarationUntil, null, 'ohne Häkchen nicht gemerkt');
  await d('POST', `/api/trips/${trip.id}/end`, {});
  assert.equal((await d('POST', '/api/trips', { origin: A, destination: B })).status, 428, 'jedes Mal neu bestätigen');
  const t2 = await d('POST', '/api/trips', { origin: A, destination: B, declaration: { ...DECL, remember: true } });
  const until = new Date((await d('GET', '/api/me')).user.driverDeclarationUntil);
  assert.ok(until - Date.now() > 27 * 864e5 && until - Date.now() < 32 * 864e5, 'einen Monat gültig');
  await d('POST', `/api/trips/${t2.trip.id}/end`, {});
  assert.ok((await d('POST', '/api/trips', { origin: A, destination: B })).trip, 'innerhalb des Monats ohne Pop-up');
});

test('Vorkasse in 3 Stufen mit Rabatt auf die Provision, sonst je Fahrt bezahlen', async (t) => {
  const { user, license, identify, vehicle } = await setup(t);
  const d = await user('Dana Drive', 'dana@example.org');
  await license(d); await identify(d); await vehicle(d);
  const { trip } = await d('POST', '/api/trips', { origin: A, destination: B, seats: 3, declaration: DECL });
  const pickup = pointAlongRoute(trip.route.coords, 2);
  const dropoff = pointAlongRoute(trip.route.coords, 12);

  const cfg = await d('GET', '/api/config');
  assert.deepEqual(cfg.prepaidPackages.map((p) => [p.amountCents, p.discountPercent]), [[1000, 6], [2000, 10], [5000, 20]]);
  assert.equal(cfg.pricing.ratePerKmCents, 20);
  assert.equal(cfg.pricing.extraRatePerKmCents, 10);

  // Ohne Guthaben und ohne Zahlungsmittel: 402
  const r = await user('Rita Ride', 'rita@example.org');
  assert.equal((await r('POST', '/api/rides', { tripId: trip.id, pickup, dropoff, confirmPlannedRoute: true })).status, 402);
  assert.equal((await r('POST', '/api/wallet/topup', { amountCents: 1500 })).status, 400, 'nur feste Stufen');

  // Stufe 1: je Fahrt bezahlen
  await r('POST', '/api/wallet/payment-method', {});
  const perRide = (await r('POST', '/api/rides', { tripId: trip.id, pickup, dropoff, confirmPlannedRoute: true })).ride;
  assert.equal(perRide.payment, 'per_ride');
  assert.equal(perRide.estimate.discountCents, 0);
  await d('POST', `/api/rides/${perRide.id}/accept`, { confirmPlannedRoute: true });
  assert.equal((await r('GET', '/api/me')).user.reservedCents, 0, 'keine Reservierung im Guthaben');
  await d('POST', `/api/rides/${perRide.id}/pickup`, {});
  await d('POST', `/api/rides/${perRide.id}/confirm`, {});
  const done1 = (await r('POST', `/api/rides/${perRide.id}/confirm`, { nps: 10 })).ride;
  assert.equal(done1.status, 'completed');
  assert.equal((await r('GET', '/api/me')).user.walletCents, 0, 'Guthaben unberührt');
  const tx = (await r('GET', '/api/wallet/transactions')).transactions;
  assert.deepEqual(tx.map((x) => x.type).sort(), ['card_charge', 'ride_payment']);

  // Stufe 4: 50 € Vorkasse → 20 % Rabatt auf die Provision
  const me50 = (await r('POST', '/api/wallet/topup', { packageId: 'p50' })).user;
  assert.equal(me50.prepaidCents, 5000);
  assert.equal(me50.prepaidDiscountPercent, 20);
  const pre = (await r('POST', '/api/rides', { tripId: trip.id, pickup, dropoff, confirmPlannedRoute: true })).ride;
  assert.equal(pre.payment, 'wallet');
  assert.equal(pre.commissionDiscountPercent, 20);
  assert.equal(pre.estimate.discountCents, Math.round(pre.estimate.commissionFullCents * 0.2));
  assert.ok(pre.estimate.totalCents < done1.final.totalCents, 'günstiger als je Fahrt');
  await d('POST', `/api/rides/${pre.id}/accept`, { confirmPlannedRoute: true });
  await d('POST', `/api/rides/${pre.id}/pickup`, {});
  await d('POST', `/api/rides/${pre.id}/confirm`, {});
  const done2 = (await r('POST', `/api/rides/${pre.id}/confirm`, { nps: 10 })).ride;
  assert.equal(done2.final.driverCents, done1.final.driverCents, 'Fahrer erhält dasselbe');
  const after = (await r('GET', '/api/me')).user;
  assert.equal(after.walletCents, 5000 - done2.final.totalCents);
  assert.equal(after.prepaidCents, 5000 - done2.final.totalCents);
});

test('Ermäßigung nur für weitere Personen derselben Buchung; jede weitere Buchung zahlt den normalen Tarif', async (t) => {
  const { user, license, identify, vehicle } = await setup(t);
  const d = await user('Dana Drive', 'dana@example.org');
  await license(d); await identify(d); await vehicle(d);
  const { trip } = await d('POST', '/api/trips', { origin: A, destination: B, seats: 4, ratePerKmCents: 99, declaration: DECL });
  assert.equal(trip.ratePerKmCents, undefined, 'Fahrer legt keinen eigenen Satz fest');
  const pickup = pointAlongRoute(trip.route.coords, 1);
  const dropoff = pointAlongRoute(trip.route.coords, 11);
  const book = async (name, seats) => {
    const r = await user(`${name} Ride`, `${name.toLowerCase()}@example.org`);
    await r('POST', '/api/wallet/payment-method', {});
    const m = await r('POST', '/api/match', { pickup, dropoff, seats });
    const { ride } = await r('POST', '/api/rides', { tripId: trip.id, pickup, dropoff, seats, confirmPlannedRoute: true });
    return { m, ride, r };
  };
  // Gemeinsame Buchung für zwei Personen (gleicher Einstieg): 30 + 14 ct/km
  const group = await book('Anna', 2);
  assert.equal(group.m.matches[0].price.totalPerKmCents, 44);
  assert.equal(group.ride.estimate.driverFareCents, Math.round(group.ride.plannedKm * 30));
  // Weitere Buchung auf derselben Fahrt: normaler Tarif
  const single = await book('Ben', 1);
  assert.equal(single.m.matches[0].price.totalPerKmCents, 30, 'keine Ermäßigung für eine eigene Buchung');
  assert.equal(single.ride.estimate.driverFareCents, Math.round(single.ride.plannedKm * 20));
  assert.equal(single.ride.estimate.commissionFullCents, Math.round(single.ride.plannedKm * 5));
  // Abrechnung der Gruppe mit den bei der Buchung festgehaltenen Sätzen
  await d('POST', `/api/rides/${group.ride.id}/accept`, { confirmPlannedRoute: true });
  await d('POST', `/api/rides/${group.ride.id}/pickup`, {});
  await d('POST', `/api/rides/${group.ride.id}/confirm`, {});
  const done = (await group.r('POST', `/api/rides/${group.ride.id}/confirm`, { nps: 10 })).ride;
  assert.equal(done.status, 'completed');
  assert.equal(done.final.totalCents, group.ride.estimate.totalCents);
  assert.equal(done.final.totalPerKmCents, 44);
});
