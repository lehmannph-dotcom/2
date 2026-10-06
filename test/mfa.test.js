'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mfa = require('../src/mfa');
const { displayName, publicProfile, sanitizeProfile } = require('../src/profile');

// RFC 6238, Anhang B: Secret "12345678901234567890" (SHA1), 8-stellige Werte → letzte 6 Stellen
const RFC_SECRET = mfa.base32Encode(Buffer.from('12345678901234567890'));

test('Base32 Hin- und Rückweg', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const buf = crypto.randomBytes(20);
  assert.deepEqual(mfa.base32Decode(mfa.base32Encode(buf)), buf);
});

test('TOTP entspricht RFC-6238-Testvektoren', () => {
  assert.equal(mfa.totp(RFC_SECRET, 59 * 1000), '287082');
  assert.equal(mfa.totp(RFC_SECRET, 1111111109 * 1000), '081804');
  assert.equal(mfa.totp(RFC_SECRET, 1234567890 * 1000), '005924');
  assert.equal(mfa.totp(RFC_SECRET, 2000000000 * 1000), '279037');
});

test('verifyTotp: Zeitfenster ±30 s und Schutz vor Wiederverwendung', () => {
  const secret = mfa.generateSecret();
  const t = Date.now();
  const code = mfa.totp(secret, t);
  const step = mfa.verifyTotp(secret, code, { ms: t });
  assert.equal(step, mfa.timeStep(t));
  assert.equal(mfa.verifyTotp(secret, code, { ms: t + 30_000 }), step);
  assert.equal(mfa.verifyTotp(secret, code, { ms: t + 90_000 }), null);
  assert.equal(mfa.verifyTotp(secret, code, { ms: t, lastStep: step }), null, 'gleicher Code darf nicht zweimal gelten');
  assert.equal(mfa.verifyTotp(secret, '12345', { ms: t }), null);
  assert.equal(mfa.verifyTotp(secret, 'abcdef', { ms: t }), null);
});

test('Backup-Codes sind einmalig nutzbar und nur als Hash gespeichert', () => {
  const { codes, hashes } = mfa.generateBackupCodes();
  assert.equal(codes.length, 10);
  assert.ok(codes.every((c) => /^[0-9a-f]{4}-[0-9a-f]{4}$/.test(c)));
  assert.ok(hashes.every((h) => !codes.includes(h)));
  assert.equal(mfa.useBackupCode(hashes, codes[3].toUpperCase().replace('-', ' ')), true);
  assert.equal(mfa.useBackupCode(hashes, codes[3]), false);
  assert.equal(hashes.length, 9);
});

test('Secrets werden verschlüsselt (AES-256-GCM) und manipulationssicher gespeichert', () => {
  const box = mfa.createSecretBox(crypto.randomBytes(32));
  const enc = box.encrypt('GEZDGNBV');
  assert.ok(!enc.includes('GEZDGNBV'));
  assert.equal(box.decrypt(enc), 'GEZDGNBV');
  const parts = enc.split(':');
  parts[3] = Buffer.from('XXXXXXXX').toString('base64');
  assert.throws(() => box.decrypt(parts.join(':')));
});

test('otpauth-URI für Authenticator-Apps', () => {
  const uri = mfa.otpauthUri('ABC', 'max@example.org');
  assert.match(uri, /^otpauth:\/\/totp\/joinmyride\.com%3Amax%40example\.org\?secret=ABC&issuer=joinmyride\.com/);
});

test('Profil: Anzeigename und Telefonnummer gemäß Privatsphäre', () => {
  const user = { id: 'u1', name: 'Doris Maria Fahrer', createdAt: '2026-01-01T00:00:00Z', profile: { phone: '+49 170 1234567' } };
  const viewer = { id: 'u2' };
  assert.equal(displayName(user, viewer), 'Doris F.');
  assert.equal(displayName(user, user), 'Doris Maria Fahrer');
  assert.equal(displayName({ ...user, privacy: { showFullName: true } }, viewer), 'Doris Maria Fahrer');

  assert.equal(publicProfile(user, viewer).phone, null);
  assert.equal(publicProfile(user, viewer, { hasBooking: true }).phone, null, 'Standard: Telefonnummer nie zeigen');
  const sharing = { ...user, privacy: { phoneVisibility: 'booked' } };
  assert.equal(publicProfile(sharing, viewer).phone, null);
  assert.equal(publicProfile(sharing, viewer, { hasBooking: true }).phone, '+49 170 1234567');
  assert.equal(publicProfile({ ...user, privacy: { showStats: false } }, viewer).stats, null);
});

test('Profil-Eingaben werden geprüft', () => {
  const ok = sanitizeProfile({ bio: 'x'.repeat(900), languages: ['Deutsch', 'Klingonisch'], preferences: { smoking: 'nein', music: 'gerne' } });
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.profile.bio.length, 500);
  assert.deepEqual(ok.profile.languages, ['Deutsch']);
  assert.equal(ok.profile.preferences.music, 'gerne');
  const bad = sanitizeProfile({ phone: 'ruf mich an', preferences: { smoking: 'manchmal' } });
  assert.equal(bad.errors.length, 2);
});
