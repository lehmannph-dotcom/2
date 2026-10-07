'use strict';

// Regressionstests für das Sicherheits-Review.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/db');
const { createApp } = require('../src/app');

const baseConfig = {
  adminEmail: 'chef@example.org',
  pricing: { ratePerKmCents: 25, commissionPerKmCents: 5, co2GramsPerCarKm: 150 },
  rides: { autoConfirmHours: 24 },
  points: { unratedFactor: 7 },
  funfacts: { minDrivers: 2, minRatings: 3 },
  abortPolicy: { maxQuote: 20, minRides: 5 },
  matching: { maxDetourKm: 3, maxResults: 10 },
};
const routing = { geocode: async () => [], route: async () => { throw new Error('nicht benötigt'); }, parseGoogleMapsLink: async () => ({}) };

async function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmr-sec-'));
  const store = new Store(dir);
  const server = http.createServer(createApp({ store, config: { ...baseConfig, ...extra }, routing }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.close(); store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const c = async (method, p, body, headers = {}) => {
      const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(c.cookie ? { Cookie: c.cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) c.cookie = set.split(';')[0];
      const text = await res.text();
      return { status: res.status, headers: res.headers, ...(text.startsWith('{') ? JSON.parse(text) : { text }) };
    };
    return c;
  };
  const reg = (c, name, email) => c('POST', '/api/register', { name, email, password: 'geheim123', acceptPrivacy: true });
  return { base, store, client, reg };
}

test('Kaputt kodierte URLs bringen den Server nicht zum Absturz', async (t) => {
  const { base } = await setup(t);
  for (const p of ['/%E0%A4%A', '/api/users/%E0%A4%A/profile', '/vendor/%ZZ']) {
    const res = await fetch(base + p);
    assert.ok([400, 401, 404].includes(res.status), `${p} → ${res.status}`);
  }
  assert.equal((await fetch(base + '/api/config')).status, 200, 'Server läuft weiter');
});

test('IDs wie __proto__ verändern keine Objekt-Prototypen', async (t) => {
  const { client, reg } = await setup(t);
  const admin = client();
  await reg(admin, 'Chef', 'chef@example.org');
  for (const id of ['__proto__', 'constructor', 'prototype', 'toString']) {
    assert.equal((await admin('POST', `/api/admin/users/${id}/suspend`, { days: 7, reason: 'Pollution-Test' })).status, 404);
    assert.equal((await admin('POST', `/api/admin/users/${id}/warn`, { note: 'x' })).status, 404);
    assert.equal((await admin('GET', `/api/users/${id}/profile`)).status, 404);
    assert.equal((await admin('POST', `/api/rides/${id}/confirm`, {})).status, 404);
  }
  assert.equal(({}).suspension, undefined);
  assert.equal(({}).warnings, undefined);
  const u = (await reg(client(), 'Neu Nutzer', 'neu@example.org')).user;
  assert.equal(u.suspension, null);
  assert.deepEqual(u.warnings, []);
  assert.equal((await admin('GET', '/api/admin/licenses/x/constructor')).status, 404);
});

test('Sitzungen werden nur gehasht gespeichert', async (t) => {
  const { client, reg, store } = await setup(t);
  const c = client();
  await reg(c, 'Max Muster', 'max@example.org');
  const token = c.cookie.split('=')[1];
  assert.ok(token.length > 30);
  assert.ok(!Object.keys(store.data.sessions).includes(token));
  assert.ok(!JSON.stringify(store.data).includes(token));
  assert.equal((await c('GET', '/api/me')).status, 200);
  await c('POST', '/api/logout', {});
  assert.equal(Object.keys(store.data.sessions).length, 0);
});

test('X-Forwarded-For wird ohne TRUST_PROXY ignoriert (kein Umgehen des Brute-Force-Schutzes)', async (t) => {
  const { client, reg } = await setup(t);
  await reg(client(), 'Max Muster', 'max@example.org');
  const c = client();
  let last;
  for (let i = 0; i < 11; i++) last = await c('POST', '/api/login', { email: 'max@example.org', password: 'falsch!!' }, { 'X-Forwarded-For': `10.0.0.${i}` });
  assert.equal(last.status, 429);
});

test('Sensible Aktionen: Passwort nicht beliebig oft durchprobierbar', async (t) => {
  const { client, reg } = await setup(t);
  const c = client();
  await reg(c, 'Max Muster', 'max@example.org');
  let last;
  for (let i = 0; i < 11; i++) last = await c('POST', '/api/me/delete', { password: 'falsch' + i });
  assert.equal(last.status, 429);
});

test('Zu lange Passwörter werden abgelehnt', async (t) => {
  const { client } = await setup(t);
  const r = await client()('POST', '/api/register', { name: 'Max', email: 'max@example.org', password: 'x'.repeat(201), acceptPrivacy: true });
  assert.equal(r.status, 400);
});

test('Demo-Guthaben lässt sich abschalten', async (t) => {
  const { client, reg } = await setup(t, { allowDemoTopup: false });
  const c = client();
  await reg(c, 'Max Muster', 'max@example.org');
  assert.equal((await c('POST', '/api/wallet/topup', { amountCents: 1000 })).status, 403);
  assert.equal((await c('GET', '/api/config')).demoTopup, false);
});

test('Statische Dateien: Sicherheits-Header, Caching und 304', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(base + '/app.js');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  const lm = res.headers.get('last-modified');
  assert.ok(lm);
  assert.equal((await fetch(base + '/app.js', { headers: { 'If-Modified-Since': lm } })).status, 304);
  assert.equal((await fetch(base + '/vendor/leaflet/leaflet.js')).headers.get('cache-control'), 'public, max-age=86400');
  assert.equal((await fetch(base + '/../package.json')).headers.get('content-type'), 'text/html; charset=utf-8', 'kein Zugriff außerhalb von public/');
  for (const p of ['/..%2Fpackage.json', '/..%2F..%2Fdata%2Fdb.json', '/%2e%2e/server.js']) {
    const r = await fetch(base + p);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8', `${p} liefert keine Datei außerhalb von public/`);
    assert.ok(!(await r.text()).includes('"name": "joinmyride"'));
  }
  const api = await fetch(base + '/api/config');
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
});
