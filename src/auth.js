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

function createSession(store, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  store.data.sessions[token] = { userId, expires: Date.now() + SESSION_DAYS * 864e5 };
  store.save();
  return token;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function userFromRequest(store, req) {
  const token = parseCookies(req.headers.cookie).sid;
  const session = token && store.data.sessions[token];
  if (!session) return null;
  if (session.expires < Date.now()) {
    delete store.data.sessions[token];
    store.save();
    return null;
  }
  return store.data.users[session.userId] || null;
}

function sessionCookie(token, req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  const maxAge = token ? SESSION_DAYS * 86400 : 0;
  return `sid=${token || ''}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

module.exports = { hashPassword, verifyPassword, createSession, userFromRequest, sessionCookie, parseCookies };
