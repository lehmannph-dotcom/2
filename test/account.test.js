'use strict';

// API-Tests: Registrierung mit Einwilligung, MFA-Login, Profile, Privatsphäre, Datenexport, Kontolöschung.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/db');
const { createApp } = require('../src/app');
const mfa = require('../src/mfa');
const { straightLine, haversineKm, pointAlongRoute } = require('../src/geo');

const A = { label: 'Hauptstraße 1, 10115 Berlin, Deutschland', lat: 52.52, lng: 13.405 };
const B = { label: 'Bahnhofstraße 5, 14467 Potsdam, Deutschland', lat: 52.3906, lng: 13.0645 };
const routing = {
  geocode: async () => [A],
  parseGoogleMapsLink: async () => ({ origin: A, destination: B }),
  route: async (a, b) => ({ origin: a, destination: b, coords: straightLine(a, b, 100), distanceKm: haversineKm(a, b), durationMin: 40, provider: 'test' }),
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

const DECLARATION = { fitToDrive: true, licensePresent: true };
/** Fahrerprofil vervollständigen: Identität (Demo-Prüfung) und Fahrzeug. */
async function completeDriverProfile(c) {
  const { caseId } = await c('POST', '/api/identity/start', {});
  await c('POST', `/api/identity/demo/${caseId}/complete`, {});
  await c('PUT', '/api/me/profile', { profile: { vehicle: { brand: 'VW', model: 'Polo', color: 'rot' } } });
}

function client(base) {
  const c = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(c.cookie ? { Cookie: c.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) c.cookie = set.split(';')[0].replace(/^sid=$/, '');
    const text = await res.text();
    return { status: res.status, headers: res.headers, ...(text.startsWith('{') ? JSON.parse(text) : { text }) };
  };
  return c;
}

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmr-'));
  const store = new Store(dir);
  const server = http.createServer(createApp({ store, config, routing }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.close(); store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${server.address().port}`, store };
}

const reg = (c, name, email) => c('POST', '/api/register', { name, email, password: 'geheim123', acceptPrivacy: true });

test('Registrierung nur mit Zustimmung zur Datenschutzerklärung', async (t) => {
  const { base } = await setup(t);
  const c = client(base);
  const r = await c('POST', '/api/register', { name: 'Max', email: 'max@example.org', password: 'geheim123' });
  assert.equal(r.status, 400);
  const ok = await reg(c, 'Max Muster', 'max@example.org');
  assert.ok(ok.user.consentAt);
});

test('MFA: einrichten, Login in zwei Schritten, Backup-Code, Replay-Schutz, deaktivieren', async (t) => {
  const { base, store } = await setup(t);
  const c = client(base);
  await reg(c, 'Mia Sicher', 'mia@example.org');

  const setupRes = await c('POST', '/api/mfa/setup', {});
  assert.match(setupRes.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal((await c('POST', '/api/mfa/enable', { code: '000000' })).status, 400);
  const enableCode = mfa.totp(setupRes.secret);
  const enabled = await c('POST', '/api/mfa/enable', { code: enableCode });
  assert.equal(enabled.user.mfaEnabled, true);
  assert.equal(enabled.backupCodes.length, 10);

  // Secret liegt verschlüsselt im Speicher, Backup-Codes nur als Hash
  const raw = JSON.stringify(store.data);
  assert.ok(!raw.includes(setupRes.secret));
  assert.ok(!raw.includes(enabled.backupCodes[0]));

  await c('POST', '/api/logout', {});
  const login = client(base);
  const step1 = await login('POST', '/api/login', { email: 'mia@example.org', password: 'geheim123' });
  assert.equal(step1.mfaRequired, true);
  assert.ok(!step1.user);
  assert.equal((await login('GET', '/api/me')).status, 401, 'nach Passwort allein noch keine Sitzung');

  // Bereits verwendeter Code (Einrichtung) gilt nicht erneut
  assert.equal((await login('POST', '/api/login/mfa', { mfaToken: step1.mfaToken, code: enableCode })).status, 401);
  const step2 = await login('POST', '/api/login/mfa', { mfaToken: step1.mfaToken, code: mfa.totp(setupRes.secret, Date.now() + 30_000) });
  assert.equal(step2.user.email, 'mia@example.org');
  assert.equal((await login('GET', '/api/me')).status, 200);
  assert.equal((await login('POST', '/api/login/mfa', { mfaToken: step1.mfaToken, code: '123456' })).status, 401, 'Token nur einmal nutzbar');

  // Backup-Code
  const other = client(base);
  const s1 = await other('POST', '/api/login', { email: 'mia@example.org', password: 'geheim123' });
  const viaBackup = await other('POST', '/api/login/mfa', { mfaToken: s1.mfaToken, code: enabled.backupCodes[0] });
  assert.equal(viaBackup.usedBackupCode, true);
  assert.equal(viaBackup.user.backupCodesLeft, 9);
  const s2 = await client(base)('POST', '/api/login', { email: 'mia@example.org', password: 'geheim123' });
  const again = client(base);
  assert.equal((await again('POST', '/api/login/mfa', { mfaToken: s2.mfaToken, code: enabled.backupCodes[0] })).status, 401, 'Backup-Code verbraucht');

  // Zu viele Fehlversuche sperren das mfaToken
  const brute = client(base);
  const s3 = await brute('POST', '/api/login', { email: 'mia@example.org', password: 'geheim123' });
  let last;
  for (let i = 0; i < 6; i++) last = await brute('POST', '/api/login/mfa', { mfaToken: s3.mfaToken, code: '000000' });
  assert.equal(last.status, 429);

  // Deaktivieren erfordert Passwort + Code
  assert.equal((await login('POST', '/api/mfa/disable', { password: 'geheim123', code: '000000' })).status, 401);
  const off = await login('POST', '/api/mfa/disable', { password: 'geheim123', code: enabled.backupCodes[1] });
  assert.equal(off.user.mfaEnabled, false);
  assert.ok((await client(base)('POST', '/api/login', { email: 'mia@example.org', password: 'geheim123' })).user);
});

test('Login-Brute-Force wird gebremst', async (t) => {
  const { base } = await setup(t);
  const c = client(base);
  await reg(c, 'Max Muster', 'max@example.org');
  let r;
  for (let i = 0; i < 11; i++) r = await c('POST', '/api/login', { email: 'max@example.org', password: 'falsch!!' });
  assert.equal(r.status, 429);
});

test('Profile, Privatsphäre und vergröberte Fahrerdaten', async (t) => {
  const { base } = await setup(t);
  const admin = client(base);
  const driver = client(base);
  const rider = client(base);
  const stranger = client(base);
  await reg(admin, 'Chef', 'chef@example.org');
  const d = (await reg(driver, 'Doris Fahrer', 'doris@example.org')).user;
  const r = (await reg(rider, 'Rudi Mit', 'rudi@example.org')).user;
  await reg(stranger, 'Fremd Person', 'fremd@example.org');

  const upd = await driver('PUT', '/api/me/profile', {
    profile: { bio: 'Pendle täglich nach Potsdam.', phone: '+49 170 1234567', languages: ['Deutsch', 'Englisch'], preferences: { music: 'gerne' }, vehicle: { model: 'VW Polo', color: 'rot' } },
    privacy: { phoneVisibility: 'booked' },
  });
  assert.equal(upd.user.profile.bio, 'Pendle täglich nach Potsdam.');
  assert.equal((await driver('PUT', '/api/me/profile', { profile: { phone: 'abc' } })).status, 400);

  const img = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal((await driver('POST', '/api/me/photo', { image: img })).user.hasPhoto, true);

  // Profil eines inaktiven Nutzers ist für Fremde nicht abrufbar
  assert.equal((await stranger('GET', `/api/users/${d.id}/profile`)).status, 404);
  assert.equal((await stranger('GET', `/api/users/${r.id}/profile`)).status, 404);

  // Fahrer verifizieren und online gehen
  await driver('POST', '/api/license', { fullName: 'Doris Fahrer', number: 'B072RRE2I55', classes: 'B', expiry: '2099-01-01', birthdate: '1985-01-01', frontImage: img, backImage: img });
  await admin('POST', `/api/admin/licenses/${d.id}`, { decision: 'verified' });
  await completeDriverProfile(driver);
  assert.equal((await admin('GET', `/api/admin/licenses/${d.id}/front`)).status, 404, 'Führerscheinfotos nach Prüfung gelöscht');
  const { trip } = await driver('POST', '/api/trips', { declaration: DECLARATION, origin: A, destination: B, seats: 2 });
  assert.equal(trip.vehicle, 'rot VW Polo', 'Fahrzeug aus Profil übernommen');

  // Aktiver Fahrer: Profil sichtbar, aber Nachname gekürzt, keine Telefonnummer
  const pub = (await stranger('GET', `/api/users/${d.id}/profile`)).profile;
  assert.equal(pub.name, 'Doris F.');
  assert.equal(pub.phone, null);
  assert.equal(pub.verifiedDriver, true);
  assert.equal(pub.bio, 'Pendle täglich nach Potsdam.');
  assert.equal((await stranger('GET', `/api/users/${d.id}/photo`)).status, 200);

  // Fremde sehen Start/Ziel nur vergröbert, keine Live-Position
  const coarse = (await stranger('GET', `/api/trips/${trip.id}`)).trip;
  assert.equal(coarse.origin.label, '10115 Berlin, Deutschland');
  assert.equal(coarse.position, null);
  assert.ok(haversineKm(coarse.route.coords[0], A) >= 0.45, 'Route beginnt nicht an der Haustür');

  // Nach bestätigter Buchung: Telefonnummer (freigegeben) und genaue Route sichtbar
  await rider('POST', '/api/wallet/topup', { amountCents: 5000 });
  const pickup = pointAlongRoute(trip.route.coords, 2);
  const dropoff = pointAlongRoute(trip.route.coords, 15);
  const m = (await rider('POST', '/api/match', { pickup, dropoff })).matches[0];
  assert.equal(m.origin.label, '10115 Berlin, Deutschland');
  const { ride } = await rider('POST', '/api/rides', { tripId: trip.id, pickup, dropoff, confirmPlannedRoute: true });
  assert.equal((await rider('GET', `/api/users/${d.id}/profile`)).profile.phone, null, 'erst nach Bestätigung');
  await driver('POST', `/api/rides/${ride.id}/accept`, { confirmPlannedRoute: true });
  assert.equal((await rider('GET', `/api/users/${d.id}/profile`)).profile.phone, '+49 170 1234567');
  assert.equal((await rider('GET', `/api/trips/${trip.id}`)).trip.origin.label, A.label);
  assert.equal((await stranger('GET', `/api/users/${d.id}/profile`)).profile.phone, null);

  // Fahrer sieht Profil des Mitfahrers (Fahrtpartner)
  assert.equal((await driver('GET', `/api/users/${r.id}/profile`)).profile.name, 'Rudi M.');
});

test('DSGVO: Datenexport und Kontolöschung', async (t) => {
  const { base } = await setup(t);
  const c = client(base);
  await reg(c, 'Lena Löschen', 'lena@example.org');
  const s = await c('POST', '/api/mfa/setup', {});
  await c('POST', '/api/mfa/enable', { code: mfa.totp(s.secret) });
  await c('POST', '/api/wallet/topup', { packageId: 'p20' });
  await c('POST', '/api/me/photo', { image: 'data:image/png;base64,iVBORw0KGgo=' });

  const exp = await c('GET', '/api/me/export');
  assert.match(exp.headers.get('content-disposition'), /attachment; filename="joinmyride-daten-/);
  assert.equal(exp.account.email, 'lena@example.org');
  assert.equal(exp.account.passwordHash, undefined);
  assert.equal(exp.account.mfa.enabled, true);
  assert.ok(!JSON.stringify(exp).includes(s.secret));
  assert.equal(exp.transactions.length, 1);

  assert.equal((await c('POST', '/api/me/delete', { password: 'geheim123', code: '000000' })).status, 401);
  const del = await c('POST', '/api/me/delete', { password: 'geheim123', code: mfa.totp(s.secret, Date.now() + 30_000) });
  assert.equal(del.ok, true);
  assert.equal(del.payoutCents, 2000);
  assert.equal((await c('GET', '/api/me')).status, 401);
  assert.equal((await client(base)('POST', '/api/login', { email: 'lena@example.org', password: 'geheim123' })).status, 401);
  // E-Mail ist wieder frei
  assert.ok((await reg(client(base), 'Lena Neu', 'lena@example.org')).user);
});

test('Sicherheits-Header auf HTML-Seiten', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(base + '/');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('Profilvorschau zeigt die Sicht anderer', async (t) => {
  const { base } = await setup(t);
  const c = client(base);
  await reg(c, 'Paula Privat', 'paula@example.org');
  await c('PUT', '/api/me/profile', { profile: { phone: '+49 30 123456' }, privacy: { phoneVisibility: 'booked' } });
  const me = (await c('GET', '/api/me')).user;
  const stranger = (await c('GET', `/api/users/${me.id}/profile?preview=stranger`)).profile;
  assert.equal(stranger.name, 'Paula P.');
  assert.equal(stranger.phone, null);
  const booked = (await c('GET', `/api/users/${me.id}/profile?preview=booked`)).profile;
  assert.equal(booked.phone, '+49 30 123456');
  assert.equal((await c('DELETE', '/api/me/photo', {})).status, 200);
});

test('Funfacts sind öffentlich und enthalten keine Personendaten', async (t) => {
  const { base } = await setup(t);
  const anon = client(base);
  const f = await anon('GET', '/api/funfacts');
  assert.equal(f.status, 200);
  assert.deepEqual(f.regions.ranked, []);
  assert.equal(f.minDrivers, 2);
  const c = client(base);
  await reg(c, 'Vera Volvo', 'vera@example.org');
  assert.equal((await c('PUT', '/api/me/profile', { profile: { vehicle: { brand: 'Volvo', plateRegion: 'hh' } } })).user.profile.vehicle.plateRegion, 'HH');
  assert.equal((await c('PUT', '/api/me/profile', { profile: { vehicle: { brand: 'Gibtsnicht' } } })).status, 400);
  assert.ok((await anon('GET', '/api/config')).brands.includes('Volvo'));
});
