'use strict';

/**
 * Identitätsprüfung („verifizierter Nutzer“) über einen externen Anbieter.
 *
 * Ablauf (anbieterunabhängig):
 *  1. Nutzer startet die Prüfung → Vorgang (case) wird angelegt, Weiterleitung zum Anbieter.
 *  2. Der Anbieter prüft Ausweis und Person (POSTIDENT per Video/Filiale/eID, Online-Ausweis,
 *     IDnow, Veriff …) und meldet das Ergebnis signiert an /api/identity/webhook.
 *  3. Gespeichert werden nur Ergebnis, Verfahren und Zeitpunkt – keine Ausweiskopie
 *     (Datenminimierung, Art. 5 Abs. 1 lit. c DSGVO).
 *
 * Für jeden Anbieter wird nur ein kleiner Adapter benötigt, der dessen Ergebnis-Meldung in
 * { caseId, result, timestamp, signature } übersetzt. Der Anbieter 'demo' simuliert Schritt 2.
 */

const crypto = require('node:crypto');

const PROVIDERS = Object.freeze({
  demo: { name: 'Demo-Prüfung' },
  postident: { name: 'POSTIDENT (Deutsche Post)' },
  eid: { name: 'Online-Ausweis (eID)' },
  idnow: { name: 'IDnow' },
  veriff: { name: 'Veriff' },
});
const CASE_TTL_MS = 24 * 3600 * 1000;
const MAX_SIGNATURE_AGE_MS = 10 * 60 * 1000;

const signPayload = (secret, { caseId, result, timestamp }) =>
  crypto.createHmac('sha256', secret).update(`${caseId}|${result}|${timestamp}`).digest('hex');

/** Prüft die Signatur einer Ergebnis-Meldung (zeitkonstant, mit Altersgrenze gegen Wiederholung). */
function verifySignature(secret, payload, nowMs = Date.now()) {
  if (!secret || !payload || typeof payload.signature !== 'string') return false;
  const ts = Number(payload.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > MAX_SIGNATURE_AGE_MS) return false;
  const expected = Buffer.from(signPayload(secret, payload), 'hex');
  const given = Buffer.from(payload.signature, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Öffentliche Sicht auf den Prüfstatus eines Nutzers. */
function identityStatus(user) {
  const id = user.identity;
  if (!id) return { status: 'none' };
  return { status: id.status, provider: id.provider, providerName: (PROVIDERS[id.provider] || {}).name || id.provider, verifiedAt: id.verifiedAt || null };
}

const isVerified = (user) => Boolean(user && user.identity && user.identity.status === 'verified');

module.exports = { PROVIDERS, CASE_TTL_MS, signPayload, verifySignature, identityStatus, isVerified };
