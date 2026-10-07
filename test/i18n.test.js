'use strict';

// Mehrsprachigkeit: Übersetzungen vollständig und konsistent, Sprache im Profil speicherbar.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/db');
const { createApp } = require('../src/app');
const { UI_LANGUAGES, UI_LANGUAGE_CODES } = require('../src/profile');
const { extract, checkCatalog, SOURCE_FILE, I18N_DIR } = require('../scripts/i18n');

const config = {
  adminEmail: 'chef@example.org',
  pricing: { ratePerKmCents: 25, commissionPerKmCents: 5, donationPerKmCents: 5, co2GramsPerCarKm: 150 },
  rides: { autoConfirmHours: 24 },
  points: { unratedFactor: 7 },
  funfacts: { minDrivers: 2, minRatings: 3 },
  abortPolicy: { maxQuote: 20, minRides: 5 },
  matching: { maxDetourKm: 3, maxResults: 10 },
};
const routing = { geocode: async () => [], route: async () => { throw new Error('nicht benötigt'); }, parseGoogleMapsLink: async () => ({}) };

test('Deutsch und die 10 meistgesprochenen Sprachen sind wählbar', () => {
  assert.deepEqual(UI_LANGUAGE_CODES, ['de', 'en', 'zh', 'hi', 'es', 'ar', 'fr', 'bn', 'pt', 'ru', 'id']);
  assert.equal(UI_LANGUAGES.find((l) => l.code === 'ar').dir, 'rtl');
  for (const l of UI_LANGUAGES) assert.doesNotThrow(() => new Intl.NumberFormat(l.locale), l.code);
});

test('Ausgangstexte sind aktuell (npm run i18n:extract nach Textänderungen)', () => {
  const current = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
  assert.deepEqual(Object.keys(extract({ write: false })), Object.keys(current));
});

test('Jede Übersetzung ist vollständig – Platzhalter, HTML und Links unverändert', () => {
  const source = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
  for (const code of UI_LANGUAGE_CODES.filter((c) => c !== 'de')) {
    const catalog = JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${code}.json`), 'utf8'));
    assert.deepEqual(checkCatalog(source, catalog), [], code);
  }
});

test('Prüfung erkennt fehlende Platzhalter, HTML und Pluralformen', () => {
  const source = { 'Hallo {name}': 'Hallo {name}', '<b>fett</b>': '<b>fett</b>', '{n} Punkte': { one: '{n} Punkt', other: '{n} Punkte' } };
  const errors = checkCatalog(source, { 'Hallo {name}': 'Hello', '<b>fett</b>': 'bold', '{n} Punkte': '{n} points' });
  assert.equal(errors.length, 3, errors.join('\n'));
});

test('Sprache der Oberfläche: bei Registrierung übernommen, im Profil änderbar, ungültige abgelehnt', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmr-i18n-'));
  const store = new Store(dir);
  const server = http.createServer(createApp({ store, config, routing }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.close(); store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json()) };
  };

  const cfg = await call('GET', '/api/config');
  assert.deepEqual(cfg.uiLanguages.map((l) => l.code), UI_LANGUAGE_CODES);
  assert.ok(cfg.languages.includes('Hindi') && cfg.languages.includes('Indonesisch'));

  const reg = await call('POST', '/api/register', { name: 'Ana', email: 'ana@example.org', password: 'geheim123', acceptPrivacy: true, uiLanguage: 'es' });
  assert.equal(reg.user.profile.uiLanguage, 'es');

  const changed = await call('PUT', '/api/me/profile', { profile: { uiLanguage: 'ar' } });
  assert.equal(changed.user.profile.uiLanguage, 'ar');
  assert.equal((await call('PUT', '/api/me/profile', { profile: { uiLanguage: 'xx' } })).status, 400);
  assert.equal((await call('PUT', '/api/me/profile', { profile: { uiLanguage: '' } })).user.profile.uiLanguage, '');

  // Startseite unter /, die App unter /app (beide mit Sicherheits-Headern)
  const home = await fetch(base + '/');
  assert.match(await home.text(), /Du fährst sowieso\. Nimm jemanden mit\./);
  assert.ok(home.headers.get('content-security-policy'));
  assert.match(await (await fetch(base + '/app')).text(), /id="panel"/);
  assert.match(await (await fetch(base + '/app/')).text(), /id="panel"/);

  // Übersetzungsdateien werden ausgeliefert
  const res = await fetch(base + '/i18n/zh.json');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json; charset=utf-8/);
  assert.ok(Object.keys(await res.json()).length > 500);
});
