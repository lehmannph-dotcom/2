'use strict';

const crypto = require('node:crypto');

const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Sitzungen werden nur als SHA-256-Hash des Tokens gespeichert: Wer die Datenbank liest,
 * kann damit keine Sitzung übernehmen.
 */
const sessionKey = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');

function createSession(store, userId, extra = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  store.data.sessions[sessionKey(token)] = { userId, expires: Date.now() + SESSION_DAYS * 864e5, ...extra };
  store.save();
  return token;
}

function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(raw);
    } catch {
      out[part.slice(0, i).trim()] = raw; // fehlerhafte Kodierung nicht als Serverfehler behandeln
    }
  }
  return out;
}

/** Sitzungsschlüssel aus dem Cookie der Anfrage (oder null). */
function requestSessionKey(req) {
  const token = parseCookies(req.headers.cookie).sid;
  return token ? sessionKey(token) : null;
}

function userFromRequest(store, req) {
  const key = requestSessionKey(req);
  const session = key && store.data.sessions[key];
  if (!session) return null;
  if (session.expires < Date.now()) {
    delete store.data.sessions[key];
    store.save();
    return null;
  }
  return store.data.users[session.userId] || null;
}

/** HTTPS erkennen – X-Forwarded-Proto nur auswerten, wenn ein vertrauenswürdiger Proxy davor steht. */
const isSecure = (req, trustProxy) => Boolean(req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https'));

function sessionCookie(token, req, trustProxy = false) {
  const secure = isSecure(req, trustProxy) ? '; Secure' : '';
  const maxAge = token ? SESSION_DAYS * 86400 : 0;
  return `sid=${token || ''}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

module.exports = { hashPassword, verifyPassword, createSession, userFromRequest, sessionCookie, parseCookies, sessionKey, requestSessionKey, isSecure };
