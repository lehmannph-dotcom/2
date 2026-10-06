'use strict';

/**
 * Zwei-Faktor-Anmeldung (MFA) mit zeitbasierten Einmalcodes (TOTP, RFC 6238),
 * kompatibel mit Google Authenticator, Microsoft Authenticator, Authy, 1Password usw.
 * Dazu einmalig nutzbare Backup-Codes für den Fall, dass das Handy verloren geht.
 */

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
const ISSUER = 'joinmyride.com';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Ungültiges Base32-Zeichen.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

/** HOTP (RFC 4226) für einen Zählerstand. */
function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

const timeStep = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);
const totp = (secret, ms = Date.now()) => hotp(secret, timeStep(ms));

/**
 * Prüft einen Code mit ±1 Zeitfenster Toleranz (Uhrabweichung).
 * Gibt den verwendeten Zeitschritt zurück (für Schutz vor Wiederverwendung) oder null.
 * Bereits verwendete Zeitschritte (≤ lastStep) werden abgelehnt.
 */
function verifyTotp(secret, code, { ms = Date.now(), lastStep = -1, window = 1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = timeStep(ms);
  for (let s = now - window; s <= now + window; s++) {
    if (s <= lastStep) continue;
    const expected = Buffer.from(hotp(secret, s));
    if (crypto.timingSafeEqual(expected, Buffer.from(c))) return s;
  }
  return null;
}

function otpauthUri(secret, account) {
  const label = encodeURIComponent(`${ISSUER}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ---------- Backup-Codes ----------
const hashCode = (code) => crypto.createHash('sha256').update(normalizeBackup(code)).digest('hex');
const normalizeBackup = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 10 Codes im Format xxxx-xxxx; gespeichert werden nur Hashes. */
function generateBackupCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString('hex').slice(0, 8);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return { codes, hashes: codes.map(hashCode) };
}

/** Verbraucht einen Backup-Code. Gibt true zurück und entfernt ihn aus der Liste. */
function useBackupCode(hashes, code) {
  if (normalizeBackup(code).length !== 8) return false;
  const h = hashCode(code);
  const idx = hashes.findIndex((x) => crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
  if (idx < 0) return false;
  hashes.splice(idx, 1);
  return true;
}

// ---------- Verschlüsselung der TOTP-Secrets im Datenspeicher ----------
function createSecretBox(key) {
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
    },
    decrypt(boxed) {
      const [, iv, tag, enc] = String(boxed).split(':');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}

module.exports = {
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  totp,
  timeStep,
  verifyTotp,
  otpauthUri,
  generateBackupCodes,
  useBackupCode,
  createSecretBox,
  ISSUER,
};
