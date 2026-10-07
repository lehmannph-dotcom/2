'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { hashPassword, verifyPassword, createSession, userFromRequest, sessionCookie, requestSessionKey, isSecure } = require('./auth');
const { validateLicense, canDrive } = require('./license');
const { findMatches } = require('./matching');
const { computeFare, billableKm } = require('./pricing');
const { haversineKm, projectOntoRoute, cumulativeKm, isLatLng, simplify } = require('./geo');
const mfa = require('./mfa');
const nps = require('./nps');
const game = require('./gamification');
const guestbook = require('./guestbook');
const funfacts = require('./funfacts');
const feedback = require('./feedback');
const filters = require('./filters');
const { REGIONS } = require('./plates');
const { BRANDS, LANGUAGES, UI_LANGUAGES, UI_LANGUAGE_CODES, displayName, publicProfile, privacyOf, profileOf, sanitizeProfile, sanitizePrivacy } = require('./profile');

const PRIVACY_POLICY_VERSION = '2026-10';
const TERMS_VERSION = '2026-10';
const ABORT_REASONS = [
  { id: 'safety', label: 'Sicherheitsbedenken' },
  { id: 'behavior', label: 'Verhalten des Fahrtpartners' },
  { id: 'vehicle', label: 'Panne oder Problem am Fahrzeug' },
  { id: 'health', label: 'Gesundheit oder Notfall' },
  { id: 'plans', label: 'Geänderte Pläne' },
  { id: 'other', label: 'Sonstiges' },
];
const MFA_LOGIN_TTL_MS = 5 * 60 * 1000;
const MFA_MAX_ATTEMPTS = 5;
const MAX_PASSWORD_LENGTH = 200;
const LICENSE_SIDES = ['front', 'back'];

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 16 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message, details, code) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

function createApp({ store, config, routing }) {
  const db = store.data;
  const routes = [];
  const on = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler, ...opts });
  };

  // ---------- Hilfsfunktionen ----------
  const now = () => new Date().toISOString();
  const need = (cond, status, msg) => {
    if (!cond) throw new HttpError(status, msg);
  };
  const point = (p, name) => {
    const v = p && { lat: Number(p.lat), lng: Number(p.lng), label: p.label ? String(p.label).slice(0, 200) : undefined };
    need(isLatLng(v), 400, `${name}: Koordinaten fehlen.`);
    return v;
  };
  const publicUser = (u) => {
    const g = gameOf(u.id);
    return {
    id: u.id,
    name: u.name,
    email: u.email,
    isAdmin: Boolean(u.isAdmin),
    walletCents: u.walletCents,
    reservedCents: u.reservedCents,
    nps: nps.summary(u),
    points: g.points,
    level: { name: g.level.name, rank: g.level.rank },
    co2SavedKg: Math.round((u.co2SavedKg || 0) * 100) / 100,
    canDrive: canDrive(u),
    mfaEnabled: Boolean(u.mfa && u.mfa.enabled),
    backupCodesLeft: u.mfa && u.mfa.enabled ? u.mfa.backupHashes.length : 0,
    hasPhoto: Boolean(profileOf(u).photo),
    profile: { ...profileOf(u), photo: undefined },
    privacy: privacyOf(u),
    riderFilters: u.riderFilters || {},
    abortStats: { asDriver: abortStats(u.id, 'driver'), asRider: abortStats(u.id, 'rider') },
    suspension: activeSuspension(u),
    warnings: (u.warnings || []).slice(-3),
    termsVersion: u.termsVersion || null,
    consentAt: u.consentAt || null,
    license: u.license
      ? {
          status: u.license.status,
          number: u.license.number.slice(0, 3) + '•••••' + u.license.number.slice(-3),
          classes: u.license.classes,
          expiry: u.license.expiry,
          reviewNote: u.license.reviewNote || '',
        }
      : null,
    };
  };

  // ---------- Abgeleitete Kennzahlen – einmal je Datenstand berechnet ----------
  // Statt bei jeder Anfrage (und je Fahrt/Fahrer mehrfach) alle Fahrten zu durchsuchen, wird ein
  // Index aufgebaut und bis zur nächsten Änderung (store.rev) wiederverwendet.
  let derivedCache = null;
  const EMPTY_SLOT = Object.freeze({ all: [], partners: new Set(), driver: [], rider: [], ratedAsDriver: [], ratedAsRider: [] });
  const derived = () => {
    const month = game.monthKey(now());
    if (derivedCache && derivedCache.rev === store.rev && derivedCache.month === month) return derivedCache;
    const rides = Object.values(db.rides);
    const perUser = new Map();
    const slot = (id) => {
      let s = perUser.get(id);
      if (!s) perUser.set(id, (s = { all: [], partners: new Set(), driver: [], rider: [], ratedAsDriver: [], ratedAsRider: [] }));
      return s;
    };
    const confirming = [];
    for (const r of rides) {
      // Alle Fahrten je Nutzer und Fahrtpartner (für Fahrtenliste und Profil-Sichtbarkeit)
      slot(r.driverId).all.push(r);
      slot(r.riderId).all.push(r);
      slot(r.driverId).partners.add(r.riderId);
      slot(r.riderId).partners.add(r.driverId);
      if (r.status === 'confirming') confirming.push(r);
      if (r.status === 'completed') {
        slot(r.driverId).driver.push(r);
        slot(r.riderId).rider.push(r);
      }
      if (r.npsByRider) slot(r.driverId).ratedAsDriver.push(r.npsByRider);
      if (r.npsByDriver) slot(r.riderId).ratedAsRider.push(r.npsByDriver);
    }
    derivedCache = { rev: store.rev, month, perUser, confirming, game: game.computeAll(rides, config.points, { month }), funfacts: null };
    return derivedCache;
  };
  const userSlot = (id) => derived().perUser.get(id) || EMPTY_SLOT;
  const gameAll = () => derived().game;
  const gameOf = (userId) => game.summaryFor(gameAll().get(userId));
  // Kilometer im deutschen Format, gleich gerundet wie in der Oberfläche (z. B. „0,9“)
  const fmtKm = (n) => Number(n).toLocaleString('de-DE', { maximumFractionDigits: 1 });
  /**
   * Fahrtabbruchsquote: abgebrochene Fahrten im Verhältnis zu allen abgeschlossenen Fahrten
   * in einer Rolle – egal, wer abgebrochen hat (beide waren beteiligt). initiated = selbst abgebrochen.
   */
  const abortStats = (userId, role) => {
    const rides = userSlot(userId)[role];
    const aborted = rides.filter((r) => r.abort);
    return {
      rides: rides.length,
      aborted: aborted.length,
      initiated: aborted.filter((r) => r.abort.by === role).length,
      quote: rides.length ? Math.round((aborted.length / rides.length) * 100) : null,
    };
  };
  /** Aktive Sperre oder null. Befristete Sperren laufen automatisch ab. */
  const activeSuspension = (u) => {
    const sp = u && u.suspension;
    if (!sp) return null;
    if (sp.until && new Date(sp.until) <= new Date()) return null;
    return sp;
  };
  const needNotSuspended = (u) => {
    const sp = activeSuspension(u);
    if (sp) throw new HttpError(403, `Dein Konto ist ${sp.until ? 'bis ' + new Date(sp.until).toLocaleDateString('de-DE') : 'bis auf Weiteres'} gesperrt (${sp.reason}). Laufende Fahrten kannst du abschließen.`);
  };
  /** Liegt eine Rolle über dem Grenzwert der Nutzungsbedingungen? */
  const abortFlags = (u) => {
    const { maxQuote, minRides } = config.abortPolicy;
    return ['driver', 'rider']
      .map((role) => ({ role, ...abortStats(u.id, role) }))
      .filter((st) => st.rides >= minRides && st.quote > maxQuote);
  };
  const book = (account, amountCents, type, rideId, note) => {
    db.ledger.push({ id: store.id('tx'), at: now(), account, amountCents, type, rideId, note });
  };
  /** Hochgeladene Datei ausliefern; fehlt sie, gibt es 404 statt eines Serverfehlers. */
  const sendUpload = (res, file, cacheControl) => {
    let data;
    try {
      data = fs.readFileSync(store.uploadPath(path.basename(file)));
    } catch {
      throw new HttpError(404, 'Datei nicht gefunden.');
    }
    const ext = path.extname(file).slice(1);
    res.writeHead(200, { 'Content-Type': `image/${ext === 'jpg' ? 'jpeg' : ext}`, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  };
  const tripCum = (trip) => {
    if (!trip._cum) Object.defineProperty(trip, '_cum', { value: cumulativeKm(trip.route.coords), enumerable: false, writable: true });
    return trip._cum;
  };
  const rideView = (ride, viewer) => {
    const trip = db.trips[ride.tripId];
    const rider = db.users[ride.riderId];
    const driver = db.users[ride.driverId];
    const role = viewer.id === ride.driverId ? 'driver' : 'rider';
    const partner = role === 'driver' ? 'rider' : 'driver';
    const c = ride.confirmations || {};
    let settlementPreview = null;
    if (['picked_up', 'confirming', 'disputed'].includes(ride.status)) {
      const b = billableKm(ride.plannedKm, ride.trackedKm, { aborted: Boolean(ride.abort) });
      settlementPreview = { plannedKm: ride.plannedKm, trackedKm: ride.trackedKm, billedKm: b.km, basis: b.basis, price: computeFare(b.km, config.pricing, ride.seats, { pickupDetourKm: ride.pickupDetourKm || 0 }) };
    }
    return {
      ...ride,
      role,
      myRouteConfirmed: Boolean(c[role + 'Route']),
      partnerRouteConfirmed: Boolean(c[partner + 'Route']),
      myEndConfirmed: Boolean(c[role + 'End']),
      partnerEndConfirmed: Boolean(c[partner + 'End']),
      // Jeder sieht nur die eigene Bewertung – die des Partners fließt anonym in dessen NPS ein.
      npsByRider: role === 'rider' ? ride.npsByRider : undefined,
      npsByDriver: role === 'driver' ? ride.npsByDriver : undefined,
      myRating: (role === 'rider' ? ride.npsByRider : ride.npsByDriver) || null,
      myPoints: game.ridePoints(ride, viewer.id, config.points),
      // Fahrtabbruchsquote des Fahrtpartners in seiner Rolle
      partnerAbort: role === 'driver' ? abortStats(ride.riderId, 'rider') : abortStats(ride.driverId, 'driver'),
      guestbook: role === 'rider' && ride.status === 'completed'
        ? (() => {
            const entry = db.guestbook.find((g) => g.rideId === ride.id);
            const reason = guestbook.eligibility(ride, viewer.id);
            return { eligible: !reason && !entry, longRide: Boolean(guestbook.longRideKind(ride)), entry: entry ? { id: entry.id, text: entry.text, hidden: entry.hidden } : null };
          })()
        : null,
      autoConfirmAt: ride.status === 'confirming' ? new Date(new Date(ride.droppedOffAt).getTime() + config.rides.autoConfirmHours * 3600 * 1000).toISOString() : null,
      settlementPreview,
      riderName: displayName(rider, viewer),
      driverName: displayName(driver, viewer),
      vehicle: trip ? trip.vehicle : '',
      driverPosition: trip ? trip.position || null : null,
      tripDestination: trip ? trip.destination : null,
    };
  };
  // Datenschutz: Start und Ziel eines Fahrers sind oft Wohn- oder Arbeitsadresse.
  // Wer nicht bestätigt mitfährt, sieht sie nur vergröbert (Ort statt Straße, Route ohne die ersten/letzten 500 m).
  const PRIVACY_TRIM_KM = 0.5;
  const coarsePlace = (p) => {
    const parts = String(p.label || '').split(',').map((x) => x.trim()).filter(Boolean);
    const isCoords = /^-?\d+(\.\d+)?$/.test(parts[0] || '') && parts.length === 2;
    const label = isCoords ? 'Ungefährer Ort' : parts.length > 1 ? parts.slice(1).join(', ') : parts[0] || '';
    return { label, lat: Math.round(p.lat * 100) / 100, lng: Math.round(p.lng * 100) / 100 };
  };
  const isBookedOn = (trip, userId) =>
    Object.values(db.rides).some((r) => r.tripId === trip.id && r.riderId === userId && ['accepted', 'picked_up', 'confirming'].includes(r.status));
  const tripView = (trip, viewer) => {
    if (trip.driverId === viewer.id || isBookedOn(trip, viewer.id)) return trip;
    const cum = tripCum(trip);
    const total = cum[cum.length - 1];
    const coords = trip.route.coords.filter((_, i) => cum[i] >= PRIVACY_TRIM_KM && cum[i] <= total - PRIVACY_TRIM_KM);
    return {
      id: trip.id,
      driverId: trip.driverId,
      status: trip.status,
      seats: trip.seats,
      seatsFree: trip.seatsFree,
      vehicle: trip.vehicle,
      origin: coarsePlace(trip.origin),
      destination: coarsePlace(trip.destination),
      route: { ...trip.route, coords: coords.length >= 2 ? coords : [] },
      position: null,
      progressKm: trip.progressKm,
    };
  };
  const releaseReservation = (ride) => {
    const rider = db.users[ride.riderId];
    if (ride.reservedCents && rider) {
      rider.reservedCents = Math.max(0, rider.reservedCents - ride.reservedCents);
      ride.reservedCents = 0;
    }
  };
  const freeSeats = (ride) => {
    const trip = db.trips[ride.tripId];
    if (trip && ['accepted', 'picked_up'].includes(ride.status)) trip.seatsFree += ride.seats;
  };

  // ---------- Öffentliche Konfiguration ----------
  on('GET', '/api/config', () => ({
    pricing: config.pricing,
    routingProvider: config.googleMapsApiKey ? 'google' : 'openstreetmap',
    maxDetourKm: config.matching.maxDetourKm,
    points: config.points,
    brands: BRANDS,
    plateRegions: REGIONS,
    aspects: { driver: feedback.DRIVER_ASPECTS, rider: feedback.RIDER_ASPECTS, maxScore: feedback.MAX_ASPECT_SCORE },
    filterLabels: filters.LABELS,
    abortReasons: ABORT_REASONS,
    abortPolicy: config.abortPolicy,
    termsVersion: TERMS_VERSION,
    languages: LANGUAGES,
    uiLanguages: UI_LANGUAGES,
    demoTopup: config.allowDemoTopup !== false,
  }), { public: true });

  // ---------- Funfacts (öffentlich, nur zusammengefasste Daten) ----------
  // Öffentlich erreichbar – daher je Datenstand nur einmal berechnet.
  on('GET', '/api/funfacts', () => {
    const d = derived();
    if (!d.funfacts) {
      const rides = Object.values(db.rides);
      d.funfacts = { ...funfacts.compute(rides, db.users, config.funfacts), totalRatings: rides.filter((r) => r.npsByRider).length };
    }
    return d.funfacts;
  }, { public: true });

  // ---------- Konto ----------
  const box = mfa.createSecretBox(store.secretKey());
  const pendingLogins = new Map(); // mfaToken → { userId, expires, attempts }
  const attempts = new Map(); // Brute-Force-Schutz: key → { count, reset }
  const throttle = (key, max = 10, windowMs = 15 * 60 * 1000) => {
    const t = Date.now();
    const a = attempts.get(key);
    if (!a || a.reset < t) return attempts.set(key, { count: 1, reset: t + windowMs }), undefined;
    a.count++;
    need(a.count <= max, 429, 'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.');
  };
  // X-Forwarded-For nur hinter einem vertrauenswürdigen Proxy – sonst könnte man den Brute-Force-Schutz umgehen.
  const clientIp = (req) =>
    (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  const cookie = (token, req) => sessionCookie(token, req, config.trustProxy);
  const startSession = (user, req, res) => {
    const token = createSession(store, user.id, { createdAt: now(), userAgent: String(req.headers['user-agent'] || '').slice(0, 160) });
    user.lastLoginAt = now();
    res.setHeader('Set-Cookie', cookie(token, req));
  };
  // Vergleichs-Hash für unbekannte E-Mail-Adressen: gleiche Rechenzeit, kein Rückschluss, ob ein Konto existiert.
  const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
  const passwordMatches = (user, password) => {
    const pw = String(password || '');
    if (pw.length > MAX_PASSWORD_LENGTH) return false;
    const ok = verifyPassword(pw, user ? user.passwordHash : DUMMY_HASH);
    return Boolean(user) && ok;
  };
  // Zähler und halbfertige Anmeldungen regelmäßig aufräumen (sonst wachsen die Maps unbegrenzt).
  const pruneTimer = setInterval(() => {
    const t = Date.now();
    for (const [k, a] of attempts) if (a.reset < t) attempts.delete(k);
    for (const [k, p] of pendingLogins) if (p.expires < t) pendingLogins.delete(k);
  }, 10 * 60 * 1000);
  pruneTimer.unref();
  /** Prüft TOTP- oder Backup-Code; schützt vor Wiederverwendung eines TOTP-Codes. */
  const checkSecondFactor = (user, code) => {
    const c = String(code || '').trim();
    const step = mfa.verifyTotp(box.decrypt(user.mfa.secret), c, { lastStep: user.mfa.lastStep ?? -1 });
    if (step !== null) {
      user.mfa.lastStep = step;
      return 'totp';
    }
    if (mfa.useBackupCode(user.mfa.backupHashes, c)) return 'backup';
    return null;
  };
  // Sensible Aktionen (2FA ändern, Konto löschen): Passwort/Code nicht beliebig oft durchprobierbar.
  const confirmIdentity = (user, body) => {
    throttle('confirm:' + user.id, 10);
    need(passwordMatches(user, body.password), 401, 'Passwort ist falsch.');
    if (user.mfa && user.mfa.enabled) need(checkSecondFactor(user, body.code), 401, 'Bestätigungscode ist ungültig.');
  };

  on('POST', '/api/register', async ({ body, req, res }) => {
    throttle('register:' + clientIp(req), 20, 60 * 60 * 1000);
    const name = String(body.name || '').trim().slice(0, 80);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    need(name.length >= 2, 400, 'Bitte Namen angeben.');
    need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 400, 'Ungültige E-Mail-Adresse.');
    need(password.length >= 8, 400, 'Passwort muss mindestens 8 Zeichen haben.');
    need(password.length <= MAX_PASSWORD_LENGTH, 400, `Passwort darf höchstens ${MAX_PASSWORD_LENGTH} Zeichen haben.`);
    need(body.acceptPrivacy === true, 400, 'Bitte der Datenschutzerklärung und den Nutzungsbedingungen zustimmen.');
    need(!Object.values(db.users).some((u) => u.email === email), 409, 'E-Mail ist bereits registriert.');
    const isFirst = Object.keys(db.users).length === 0;
    const user = {
      id: store.id('usr'),
      name,
      email,
      passwordHash: hashPassword(password),
      isAdmin: config.adminEmail ? email === config.adminEmail : isFirst,
      walletCents: 0,
      reservedCents: 0,
      nps: null,
      co2SavedKg: 0,
      license: null,
      // Sprache, in der die Registrierung angezeigt wurde, als Sprache der Oberfläche übernehmen
      profile: UI_LANGUAGE_CODES.includes(body.uiLanguage) ? { uiLanguage: body.uiLanguage } : null,
      privacy: null,
      mfa: null,
      consentAt: now(),
      consentVersion: PRIVACY_POLICY_VERSION,
      termsVersion: TERMS_VERSION,
      createdAt: now(),
    };
    db.users[user.id] = user;
    startSession(user, req, res);
    return { user: publicUser(user) };
  }, { public: true });

  // Schritt 1: Passwort. Ist MFA aktiv, gibt es noch keine Sitzung, sondern ein kurzlebiges mfaToken.
  on('POST', '/api/login', ({ body, req, res }) => {
    const email = String(body.email || '').trim().toLowerCase();
    throttle('login:' + clientIp(req) + ':' + email);
    const user = Object.values(db.users).find((u) => u.email === email && !u.deleted);
    need(passwordMatches(user, body.password), 401, 'E-Mail oder Passwort falsch.');
    if (user.mfa && user.mfa.enabled) {
      const mfaToken = crypto.randomBytes(24).toString('base64url');
      pendingLogins.set(mfaToken, { userId: user.id, expires: Date.now() + MFA_LOGIN_TTL_MS, attempts: 0 });
      return { mfaRequired: true, mfaToken };
    }
    startSession(user, req, res);
    return { user: publicUser(user) };
  }, { public: true });

  // Schritt 2: Code aus der Authenticator-App oder Backup-Code.
  on('POST', '/api/login/mfa', ({ body, req, res }) => {
    const pending = pendingLogins.get(String(body.mfaToken || ''));
    need(pending && pending.expires > Date.now(), 401, 'Anmeldung abgelaufen. Bitte erneut mit Passwort anmelden.');
    pending.attempts++;
    if (pending.attempts > MFA_MAX_ATTEMPTS) {
      pendingLogins.delete(String(body.mfaToken));
      throw new HttpError(429, 'Zu viele falsche Codes. Bitte erneut mit Passwort anmelden.');
    }
    const user = db.users[pending.userId];
    const method = checkSecondFactor(user, body.code);
    need(method, 401, 'Code ist ungültig.');
    pendingLogins.delete(String(body.mfaToken));
    startSession(user, req, res);
    return { user: publicUser(user), usedBackupCode: method === 'backup' };
  }, { public: true });

  on('POST', '/api/logout', ({ req, res }) => {
    const key = requestSessionKey(req);
    if (key) delete db.sessions[key];
    res.setHeader('Set-Cookie', cookie('', req));
    return { ok: true };
  }, { public: true });

  on('GET', '/api/me', ({ user }) => ({ user: publicUser(user) }));

  // ---------- MFA einrichten / verwalten ----------
  on('POST', '/api/mfa/setup', ({ user }) => {
    need(!(user.mfa && user.mfa.enabled), 409, 'MFA ist bereits aktiv.');
    const secret = mfa.generateSecret();
    user.mfaPending = { secret: box.encrypt(secret), createdAt: now() };
    return { secret, otpauthUri: mfa.otpauthUri(secret, user.email) };
  });

  on('POST', '/api/mfa/enable', ({ user, body }) => {
    need(user.mfaPending, 409, 'Bitte MFA-Einrichtung zuerst starten.');
    const secret = box.decrypt(user.mfaPending.secret);
    const step = mfa.verifyTotp(secret, body.code);
    need(step !== null, 400, 'Code stimmt nicht. Bitte Uhrzeit des Handys prüfen und erneut versuchen.');
    const { codes, hashes } = mfa.generateBackupCodes();
    user.mfa = { enabled: true, secret: user.mfaPending.secret, lastStep: step, backupHashes: hashes, enabledAt: now() };
    delete user.mfaPending;
    return { user: publicUser(user), backupCodes: codes };
  });

  on('POST', '/api/mfa/backup-codes', ({ user, body }) => {
    need(user.mfa && user.mfa.enabled, 409, 'MFA ist nicht aktiv.');
    confirmIdentity(user, body);
    const { codes, hashes } = mfa.generateBackupCodes();
    user.mfa.backupHashes = hashes;
    return { user: publicUser(user), backupCodes: codes };
  });

  on('POST', '/api/mfa/disable', ({ user, body }) => {
    need(user.mfa && user.mfa.enabled, 409, 'MFA ist nicht aktiv.');
    confirmIdentity(user, body);
    user.mfa = null;
    return { user: publicUser(user) };
  });

  // ---------- Profil & Privatsphäre ----------
  const rideStats = (userId) => {
    const s = userSlot(userId);
    return { asDriver: s.driver.length, asRider: s.rider.length };
  };
  const sharesBooking = (a, b) =>
    Object.values(db.rides).some(
      (r) => ['accepted', 'picked_up', 'confirming'].includes(r.status) && ((r.driverId === a && r.riderId === b) || (r.driverId === b && r.riderId === a)),
    );
  const sharesAnyRide = (a, b) => userSlot(a).partners.has(b);
  // Profile sind nur für angemeldete Nutzer sichtbar – und nur für aktive Fahrer
  // oder Fahrtpartner (keine Möglichkeit, alle Mitglieder zu durchsuchen).
  const canSeeProfile = (viewer, target) =>
    viewer.id === target.id ||
    viewer.isAdmin ||
    sharesAnyRide(viewer.id, target.id) ||
    Object.values(db.trips).some((t) => t.driverId === target.id && t.status === 'active');

  on('PUT', '/api/me/profile', ({ user, body }) => {
    const name = body.name !== undefined ? String(body.name).trim().slice(0, 80) : user.name;
    need(name.length >= 2, 400, 'Bitte Namen angeben.');
    const { errors, profile } = sanitizeProfile(body.profile || {}, user.profile);
    if (errors.length) throw new HttpError(400, 'Profil unvollständig.', errors);
    user.name = name;
    user.profile = profile;
    if (body.privacy) user.privacy = sanitizePrivacy(body.privacy, user.privacy);
    // Wünsche an den Fahrer – gelten automatisch bei jeder Suche
    if (body.riderFilters) user.riderFilters = filters.sanitizeFilters(body.riderFilters);
    return { user: publicUser(user) };
  });

  on('POST', '/api/me/photo', ({ user, body }) => {
    const dataUrl = String(body.image || '');
    need(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) && dataUrl.length < 3_000_000, 400, 'Bitte ein Bild (JPG/PNG, max. 2 MB) wählen.');
    const prof = profileOf(user);
    store.removeUpload(prof.photo);
    const ext = dataUrl.slice(11, dataUrl.indexOf(';')).replace('jpeg', 'jpg');
    const file = `${user.id}_photo_${Date.now()}.${ext}`;
    fs.writeFileSync(store.uploadPath(file), Buffer.from(dataUrl.split(',')[1], 'base64'));
    user.profile = { ...prof, photo: file };
    return { user: publicUser(user) };
  });

  on('DELETE', '/api/me/photo', ({ user }) => {
    const prof = profileOf(user);
    store.removeUpload(prof.photo);
    user.profile = { ...prof, photo: null };
    return { user: publicUser(user) };
  });

  on('GET', '/api/users/:id/profile', ({ user, params, query }) => {
    const target = db.users[params.id];
    need(target && !target.deleted && canSeeProfile(user, target), 404, 'Profil nicht gefunden.');
    // Vorschau des eigenen Profils aus Sicht eines Fremden bzw. eines bestätigten Fahrtpartners
    const preview = target.id === user.id && query.get('preview');
    const withGuestbook = (profile) => ({
      ...profile,
      guestbook: guestbookOf(target),
      abortStats: { asDriver: abortStats(target.id, 'driver'), asRider: abortStats(target.id, 'rider') },
    });
    if (preview) {
      return { profile: withGuestbook(publicProfile(target, { id: 'preview' }, { hasBooking: preview === 'booked', stats: rideStats(target.id), game: gameOf(target.id) })) };
    }
    return { profile: withGuestbook(publicProfile(target, user, { hasBooking: sharesBooking(user.id, target.id), stats: rideStats(target.id), game: gameOf(target.id) })) };
  });

  on('GET', '/api/users/:id/photo', ({ user, params, res }) => {
    const target = db.users[params.id];
    need(target && !target.deleted && canSeeProfile(user, target), 404, 'Kein Foto.');
    const photo = profileOf(target).photo;
    need(photo && (privacyOf(target).showPhoto || target.id === user.id), 404, 'Kein Foto.');
    sendUpload(res, photo, 'private, max-age=300');
    return undefined;
  });

  // ---------- Gästebuch ----------
  const guestbookOf = (driver) => {
    if (!privacyOf(driver).showGuestbook) return { enabled: false, count: 0, entries: [] };
    const visible = db.guestbook.filter((g) => g.driverId === driver.id && !g.hidden).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { enabled: true, count: visible.length, entries: visible.slice(0, 20).map(guestbook.publicEntry) };
  };

  // Mitfahrer schreibt – freiwillig, anonym, nur nach langer Fahrt mit positiver Bewertung.
  on('POST', '/api/rides/:id/guestbook', ({ user, params, body }) => {
    const ride = db.rides[params.id];
    need(ride && ride.riderId === user.id, 404, 'Fahrt nicht gefunden.');
    const reason = guestbook.eligibility(ride, user.id);
    need(!reason, 403, reason);
    need(!db.guestbook.some((g) => g.rideId === ride.id), 409, 'Zu dieser Fahrt gibt es bereits einen Eintrag.');
    need(body.consent === true, 400, 'Bitte bestätige, dass dein Eintrag anonym im Profil des Fahrers erscheinen darf.');
    const { text, errors } = guestbook.validateText(body.text);
    if (errors.length) throw new HttpError(400, 'Eintrag nicht möglich.', errors);
    const entry = {
      id: store.id('gb'),
      driverId: ride.driverId,
      riderId: user.id, // intern – nie öffentlich
      rideId: ride.id,
      text,
      kind: guestbook.longRideKind(ride),
      period: (ride.completedAt || now()).slice(0, 7),
      hidden: false,
      createdAt: now(),
    };
    db.guestbook.push(entry);
    return { entry: guestbook.publicEntry(entry) };
  });

  // Verfasser löscht seinen Eintrag.
  on('DELETE', '/api/guestbook/:id', ({ user, params }) => {
    const i = db.guestbook.findIndex((g) => g.id === params.id && (g.riderId === user.id || user.isAdmin));
    need(i >= 0, 404, 'Eintrag nicht gefunden.');
    db.guestbook.splice(i, 1);
    return { ok: true };
  });

  // Fahrer: eigenes Gästebuch inkl. ausgeblendeter Einträge, Einträge aus-/einblenden.
  on('GET', '/api/me/guestbook', ({ user }) => ({
    enabled: privacyOf(user).showGuestbook,
    entries: db.guestbook
      .filter((g) => g.driverId === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((g) => ({ ...guestbook.publicEntry(g), hidden: g.hidden })),
  }));

  on('POST', '/api/guestbook/:id/hide', ({ user, params, body }) => {
    const entry = db.guestbook.find((g) => g.id === params.id && g.driverId === user.id);
    need(entry, 404, 'Eintrag nicht gefunden.');
    entry.hidden = Boolean(body.hidden);
    return { entry: { ...guestbook.publicEntry(entry), hidden: entry.hidden } };
  });

  // ---------- Gamification ----------
  on('GET', '/api/me/points', ({ user }) => {
    const summary = gameOf(user.id);
    const history = Object.values(db.rides)
      .filter((r) => r.status === 'completed' && (r.riderId === user.id || r.driverId === user.id))
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
      .slice(0, 30)
      .map((r) => ({
        rideId: r.id,
        at: r.completedAt,
        role: r.driverId === user.id ? 'driver' : 'rider',
        partner: displayName(db.users[r.driverId === user.id ? r.riderId : r.driverId], user),
        km: r.final.km,
        ...game.ridePoints(r, user.id, config.points),
      }));
    return { ...summary, unratedFactor: config.points.unratedFactor, levels: game.LEVELS, history, leaderboardOptIn: privacyOf(user).showOnLeaderboard };
  });

  // Bestenliste: nur Mitglieder, die zugestimmt haben (Privatsphäre-Einstellung), Anzeigename gemäß Privatsphäre.
  on('GET', '/api/leaderboard', ({ user, query }) => {
    const period = query.get('period') === 'all' ? 'all' : 'month';
    const all = gameAll();
    const ranked = [...all.entries()]
      .map(([id, s]) => ({ id, points: period === 'all' ? s.total : s.month, total: s.total }))
      .filter((e) => e.points > 0 && db.users[e.id] && !db.users[e.id].deleted)
      .sort((a, b) => b.points - a.points);
    const visible = ranked.filter((e) => e.id === user.id || privacyOf(db.users[e.id]).showOnLeaderboard);
    const entries = visible.slice(0, 20).map((e, i) => {
      const lvl = game.levelFor(e.total);
      return { rank: i + 1, name: displayName(db.users[e.id], user), points: e.points, level: { name: lvl.name, rank: lvl.rank }, isMe: e.id === user.id };
    });
    const myIndex = visible.findIndex((e) => e.id === user.id);
    return {
      period,
      month: game.monthKey(now()),
      entries,
      me: myIndex >= 0 ? { rank: myIndex + 1, points: visible[myIndex].points } : { rank: null, points: 0 },
      optedIn: privacyOf(user).showOnLeaderboard,
      participants: visible.length,
    };
  });

  // ---------- Sitzungen ----------
  on('GET', '/api/me/sessions', ({ user, req }) => {
    const current = requestSessionKey(req);
    return {
      sessions: Object.entries(db.sessions)
        .filter(([, s]) => s.userId === user.id && s.expires > Date.now())
        .map(([key, s]) => ({ current: key === current, createdAt: s.createdAt || null, userAgent: s.userAgent || '' })),
    };
  });

  on('POST', '/api/me/sessions/revoke-others', ({ user, req }) => {
    const current = requestSessionKey(req);
    for (const [key, s] of Object.entries(db.sessions)) if (s.userId === user.id && key !== current) delete db.sessions[key];
    return { ok: true };
  });

  // ---------- DSGVO: Auskunft / Datenübertragbarkeit (Art. 15, 20) ----------
  on('GET', '/api/me/export', ({ user, res }) => {
    const { passwordHash, mfa: m, mfaPending, ...account } = user;
    const data = {
      exportedAt: now(),
      service: 'joinmyride.com',
      account: {
        ...account,
        mfa: m && m.enabled ? { enabled: true, enabledAt: m.enabledAt, backupCodesLeft: m.backupHashes.length } : { enabled: false },
        license: user.license ? { ...user.license, files: user.license.files ? Object.keys(user.license.files) : [] } : null,
      },
      trips: Object.values(db.trips).filter((t) => t.driverId === user.id),
      rides: Object.values(db.rides)
        .filter((r) => r.riderId === user.id || r.driverId === user.id)
        .map((r) => {
          // Einzelbewertungen des Partners bleiben anonym (Schutz Dritter, Art. 15 Abs. 4 DSGVO) –
          // enthalten ist nur die eigene abgegebene Bewertung; erhaltenes Feedback gibt es gesammelt.
          const { npsByRider, npsByDriver, ...rest } = r;
          return { ...rest, myRating: r.riderId === user.id ? npsByRider || null : npsByDriver || null, partner: displayName(db.users[r.riderId === user.id ? r.driverId : r.riderId], user) };
        }),
      feedbackReceived: {
        asDriver: feedback.summarize(receivedRatings(user.id, 'driver'), 'driver', { seed: user.id }),
        asRider: feedback.summarize(receivedRatings(user.id, 'rider'), 'rider', { seed: user.id }),
      },
      transactions: db.ledger.filter((t) => t.account === `user:${user.id}`),
      guestbookWritten: db.guestbook.filter((g) => g.riderId === user.id).map((g) => ({ ...guestbook.publicEntry(g), rideId: g.rideId })),
      guestbookReceived: db.guestbook.filter((g) => g.driverId === user.id).map((g) => ({ ...guestbook.publicEntry(g), hidden: g.hidden })),
      sessions: Object.values(db.sessions).filter((s) => s.userId === user.id).map((s) => ({ createdAt: s.createdAt, userAgent: s.userAgent })),
    };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="joinmyride-daten-${new Date().toISOString().slice(0, 10)}.json"`,
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data, null, 2));
    return undefined;
  });

  // ---------- DSGVO: Konto löschen (Art. 17) ----------
  // Persönliche Daten werden gelöscht. Buchungen bleiben anonymisiert erhalten,
  // weil Abrechnungsbelege gesetzlich aufbewahrt werden müssen (§ 147 AO, § 257 HGB).
  on('POST', '/api/me/delete', ({ user, body, req, res }) => {
    confirmIdentity(user, body);
    const open = Object.values(db.rides).some((r) => (r.riderId === user.id || r.driverId === user.id) && ['requested', 'accepted', 'picked_up', 'confirming', 'disputed'].includes(r.status));
    need(!open, 409, 'Bitte zuerst offene Fahrten abschließen oder stornieren.');
    need(!Object.values(db.trips).some((t) => t.driverId === user.id && t.status === 'active'), 409, 'Bitte zuerst deine aktive Fahrt beenden.');
    need(user.walletCents >= 0, 409, 'Bitte zuerst den offenen Betrag ausgleichen.');
    store.removeUpload(profileOf(user).photo);
    // Gästebuch: eigene Einträge und Einträge im eigenen Gästebuch werden gelöscht.
    db.guestbook = db.guestbook.filter((g) => g.riderId !== user.id && g.driverId !== user.id);
    if (user.license && user.license.files) Object.values(user.license.files).forEach((f) => store.removeUpload(f));
    for (const [token, s] of Object.entries(db.sessions)) if (s.userId === user.id) delete db.sessions[token];
    for (const t of Object.values(db.trips)) {
      if (t.driverId !== user.id) continue;
      t.position = null;
      t.vehicle = '';
    }
    const payoutCents = user.walletCents;
    Object.assign(user, {
      deleted: true,
      deletedAt: now(),
      name: 'Gelöschtes Konto',
      email: null,
      passwordHash: null,
      profile: null,
      privacy: null,
      mfa: null,
      mfaPending: null,
      license: null,
      isAdmin: false,
      walletCents: 0,
      reservedCents: 0,
    });
    if (payoutCents > 0) book(`user:${user.id}`, -payoutCents, 'payout', null, 'Auszahlung Restguthaben bei Kontolöschung');
    res.setHeader('Set-Cookie', cookie('', req));
    return { ok: true, payoutCents };
  });

  // Demo-Guthaben. Produktiv: Zahlungsdienstleister (z. B. Stripe Connect), siehe README.
  on('POST', '/api/wallet/topup', ({ user, body }) => {
    need(config.allowDemoTopup !== false, 403, 'Guthaben wird über den Zahlungsdienstleister aufgeladen.');
    const amount = Math.round(Number(body.amountCents));
    need(Number.isInteger(amount) && amount >= 100 && amount <= 50000, 400, 'Betrag zwischen 1 € und 500 € wählen.');
    user.walletCents += amount;
    book(`user:${user.id}`, amount, 'topup', null, 'Guthaben aufgeladen');
    return { user: publicUser(user) };
  });

  on('GET', '/api/wallet/transactions', ({ user }) => ({
    transactions: db.ledger.filter((t) => t.account === `user:${user.id}`).slice(-50).reverse(),
  }));

  // ---------- Führerschein ----------
  on('POST', '/api/license', ({ user, body }) => {
    const check = validateLicense(body);
    if (!check.ok) throw new HttpError(400, 'Führerscheindaten unvollständig.', check.errors);
    const files = {};
    for (const side of LICENSE_SIDES) {
      const dataUrl = body[side + 'Image'];
      const ext = dataUrl.slice(11, dataUrl.indexOf(';')).replace('jpeg', 'jpg');
      const file = `${user.id}_${side}_${Date.now()}.${ext}`;
      fs.writeFileSync(store.uploadPath(file), Buffer.from(dataUrl.split(',')[1], 'base64'));
      files[side] = file;
    }
    user.license = { ...check.normalized, files, status: 'pending', submittedAt: now() };
    return { user: publicUser(user) };
  });

  // ---------- Routing ----------
  // Externe Karten-Dienste kosten Geld bzw. haben Nutzungsgrenzen – pro Nutzer drosseln.
  const routingQuota = (user) => throttle('routing:' + user.id, 300);
  on('GET', '/api/geocode', async ({ user, query }) => {
    routingQuota(user);
    return { results: await routing.geocode(String(query.get('q') || '').slice(0, 200)) };
  });

  on('POST', '/api/route/preview', async ({ user, body }) => {
    routingQuota(user);
    let { origin, destination } = body;
    if (body.googleMapsUrl) ({ origin, destination } = await routing.parseGoogleMapsLink(body.googleMapsUrl));
    need(origin && destination, 400, 'Start und Ziel angeben.');
    return { route: await routing.route(origin, destination) };
  });

  // ---------- Fahrer: Fahrt anbieten ----------
  on('POST', '/api/trips', async ({ user, body }) => {
    need(canDrive(user), 403, 'Bitte zuerst einen gültigen Führerschein verifizieren lassen.');
    needNotSuspended(user);
    need(!Object.values(db.trips).some((t) => t.driverId === user.id && t.status === 'active'), 409, 'Du hast bereits eine aktive Fahrt.');
    routingQuota(user);
    let { origin, destination } = body;
    if (body.googleMapsUrl) ({ origin, destination } = await routing.parseGoogleMapsLink(body.googleMapsUrl));
    need(origin && destination, 400, 'Start und Ziel angeben.');
    const seats = Math.round(Number(body.seats) || 1);
    need(seats >= 1 && seats <= 8, 400, 'Zwischen 1 und 8 Plätze anbieten.');
    const r = await routing.route(origin, destination);
    const trip = {
      id: store.id('trp'),
      driverId: user.id,
      status: 'active',
      origin: r.origin,
      destination: r.destination,
      route: { coords: r.coords, distanceKm: r.distanceKm, durationMin: r.durationMin, provider: r.provider },
      seats,
      seatsFree: seats,
      vehicle: String(body.vehicle || (({ color, brand, model, plateRegion }) => [color, brand, model].filter(Boolean).join(' ') + (plateRegion ? ` (${plateRegion})` : ''))(profileOf(user).vehicle)).trim().slice(0, 80),
      position: r.origin,
      progressKm: 0,
      createdAt: now(),
    };
    db.trips[trip.id] = trip;
    return { trip };
  });

  on('GET', '/api/trips/active', ({ user }) => ({
    trip: Object.values(db.trips).find((t) => t.driverId === user.id && t.status === 'active') || null,
  }));

  on('GET', '/api/trips/:id', ({ user, params }) => {
    const trip = db.trips[params.id];
    need(trip, 404, 'Fahrt nicht gefunden.');
    const involved = trip.driverId === user.id || Object.values(db.rides).some((r) => r.tripId === trip.id && r.riderId === user.id);
    need(involved || trip.status === 'active', 403, 'Kein Zugriff.');
    return { trip: tripView(trip, user) };
  });

  // GPS-Position des Fahrers. Daraus werden die tatsächlich gefahrenen km je Mitfahrer berechnet.
  on('POST', '/api/trips/:id/position', ({ user, params, body }) => {
    const trip = db.trips[params.id];
    need(trip && trip.driverId === user.id, 404, 'Fahrt nicht gefunden.');
    need(trip.status === 'active', 409, 'Fahrt ist beendet.');
    const pos = point(body, 'Position');
    const last = trip.position;
    const stepKm = last ? haversineKm(last, pos) : 0;
    // GPS-Sprünge (> 20 km zwischen zwei Meldungen) nicht als gefahrene Strecke werten.
    const plausible = stepKm < 20;
    for (const ride of Object.values(db.rides)) {
      if (ride.tripId === trip.id && ride.status === 'picked_up' && plausible) {
        ride.trackedKm = Math.round(((ride.trackedKm || 0) + stepKm) * 1000) / 1000;
      }
    }
    const proj = projectOntoRoute(pos, trip.route.coords, tripCum(trip));
    if (proj.offKm < 2) trip.progressKm = Math.max(trip.progressKm || 0, proj.alongKm);
    trip.position = { lat: pos.lat, lng: pos.lng, at: now() };
    return { trip: { id: trip.id, position: trip.position, progressKm: trip.progressKm } };
  });

  on('POST', '/api/trips/:id/end', ({ user, params }) => {
    const trip = db.trips[params.id];
    need(trip && trip.driverId === user.id, 404, 'Fahrt nicht gefunden.');
    const open = Object.values(db.rides).filter((r) => r.tripId === trip.id && r.status === 'picked_up');
    need(open.length === 0, 409, 'Bitte zuerst alle Mitfahrer am Ziel absetzen.');
    for (const ride of Object.values(db.rides)) {
      if (ride.tripId === trip.id && ['requested', 'accepted'].includes(ride.status)) {
        freeSeats(ride);
        releaseReservation(ride);
        ride.status = 'cancelled';
        ride.cancelReason = 'Fahrer hat die Fahrt beendet';
      }
    }
    trip.status = 'ended';
    trip.endedAt = now();
    return { trip };
  });

  // ---------- Geplante Route (Basis für Bestätigung und Abrechnung) ----------
  // Die schnellste Route vom Abholort zum Ziel ist unabhängig vom Fahrer – sie wird einmal
  // berechnet, beiden Seiten angezeigt und von beiden bestätigt. Abgerechnet wird höchstens diese Strecke.
  const plannedRouteFor = async (pickup, dropoff) => {
    const r = await routing.route(pickup, dropoff);
    return {
      coords: simplify(r.coords, 300),
      distanceKm: Math.round(r.distanceKm * 100) / 100,
      durationMin: Math.round(r.durationMin),
      provider: r.provider,
    };
  };

  // ---------- Mitfahrer: besten Fahrer finden ----------
  on('POST', '/api/match', async ({ user, body }) => {
    const pickup = point(body.pickup, 'Abholort');
    const dropoff = point(body.dropoff, 'Ziel');
    const seats = Math.max(1, Math.min(8, Math.round(Number(body.seats) || 1)));
    needNotSuspended(user);
    routingQuota(user);
    // Gesperrte Fahrer erscheinen nicht in der Suche
    const trips = Object.values(db.trips).filter((t) => t.status === 'active' && canDrive(db.users[t.driverId]) && !activeSuspension(db.users[t.driverId]));
    trips.forEach(tripCum);
    const all = findMatches({
      trips,
      request: { pickup, dropoff, seats, riderId: user.id },
      pricing: config.pricing,
      maxDetourKm: config.matching.maxDetourKm,
      maxResults: Infinity,
      users: db.users,
    });
    // Filter des Mitfahrers: Kriterien, die der Fahrer erfüllen muss
    // Filter aus dem Profil des Mitfahrers (body.filters nur für API-Clients/Tests)
    const wanted = filters.sanitizeFilters(body.filters !== undefined ? body.filters : user.riderFilters || {});
    const filteredOut = {};
    let hidden = 0;
    const matches = all
      .filter((m) => {
        const failed = filters.failedCriteria(wanted, { driver: db.users[m.driverId], match: m, receivedRatings: receivedRatings(m.driverId, 'driver') });
        failed.forEach((k) => (filteredOut[k] = (filteredOut[k] || 0) + 1));
        if (failed.length) hidden++;
        return !failed.length;
      })
      .slice(0, config.matching.maxResults);
    const plannedRoute = matches.length ? await plannedRouteFor(pickup, dropoff) : null;
    return {
      plannedRoute,
      activeDrivers: trips.length,
      filters: wanted,
      hiddenByFilters: hidden,
      filteredOut,
      matches: matches.map((m) => ({
        driverPrefs: (({ preferences, languages }) => ({ ...preferences, languages }))(profileOf(db.users[m.driverId])),
        driverMfa: Boolean(db.users[m.driverId].mfa && db.users[m.driverId].mfa.enabled),
        driverAbort: abortStats(m.driverId, 'driver'),
        ...m,
        plannedKm: plannedRoute.distanceKm,
        plannedDurationMin: plannedRoute.durationMin,
        price: computeFare(plannedRoute.distanceKm, config.pricing, seats, { pickupDetourKm: m.pickupDetourKm }),
        driverName: displayName(db.users[m.driverId], user),
        origin: coarsePlace(m.origin),
        destination: coarsePlace(m.destination),
      })),
    };
  });

  // ---------- Buchungen ----------
  const OPEN = ['requested', 'accepted', 'picked_up', 'confirming'];

  // Anfrage = Bestätigung des Mitfahrers auf Basis der angezeigten geplanten Route.
  on('POST', '/api/rides', async ({ user, body }) => {
    const trip = db.trips[body.tripId];
    need(trip && trip.status === 'active', 404, 'Diese Fahrt ist nicht mehr verfügbar.');
    need(trip.driverId !== user.id, 400, 'Du kannst nicht bei dir selbst mitfahren.');
    needNotSuspended(user);
    need(!activeSuspension(db.users[trip.driverId]), 404, 'Diese Fahrt ist nicht mehr verfügbar.');
    need(!Object.values(db.rides).some((r) => r.riderId === user.id && OPEN.includes(r.status)), 409, 'Du hast bereits eine offene Mitfahrt.');
    need(body.confirmPlannedRoute === true, 400, 'Bitte die geplante Route bestätigen.');
    const pickup = point(body.pickup, 'Abholort');
    const dropoff = point(body.dropoff, 'Ziel');
    const seats = Math.max(1, Math.min(8, Math.round(Number(body.seats) || 1)));
    tripCum(trip);
    const [match] = findMatches({
      trips: [trip],
      request: { pickup, dropoff, seats, riderId: user.id },
      pricing: config.pricing,
      maxDetourKm: config.matching.maxDetourKm,
    });
    need(match, 409, 'Der Fahrer passt nicht mehr zu deiner Strecke.');
    const plannedRoute = await plannedRouteFor(pickup, dropoff);
    // Der Mitfahrer bestätigt genau die Strecke, die ihm angezeigt wurde.
    if (body.plannedKm !== undefined && Math.abs(Number(body.plannedKm) - plannedRoute.distanceKm) > 0.5) {
      throw new HttpError(409, 'Die geplante Route hat sich geändert. Bitte erneut suchen und bestätigen.');
    }
    const estimate = computeFare(plannedRoute.distanceKm, config.pricing, seats, { pickupDetourKm: match.pickupDetourKm });
    // Da nie mehr als die geplante Route berechnet wird, ist der geplante Preis zugleich der Höchstbetrag.
    need(user.walletCents - user.reservedCents >= estimate.totalCents, 402, `Nicht genug Guthaben. Benötigt werden ${(estimate.totalCents / 100).toFixed(2).replace('.', ',')} €.`);
    const ride = {
      id: store.id('rid'),
      tripId: trip.id,
      driverId: trip.driverId,
      riderId: user.id,
      status: 'requested',
      pickup,
      dropoff,
      seats,
      plannedRoute,
      plannedKm: plannedRoute.distanceKm,
      pickupDetourKm: estimate.detourKm, // Anfahrt zum Treffpunkt – ohne Provision, 100 % an den Fahrer
      pickupAlongKm: match.pickupAlongKm,
      detourKm: match.detourKm,
      estimate,
      maxChargeCents: estimate.totalCents,
      reservedCents: 0,
      trackedKm: 0,
      confirmations: { riderRoute: now() },
      createdAt: now(),
    };
    db.rides[ride.id] = ride;
    return { ride: rideView(ride, user) };
  });

  on('GET', '/api/rides', ({ user }) => {
    settleOverdue();
    return {
      rides: [...new Set(userSlot(user.id).all)] // Set: Fahrten mit sich selbst nicht doppelt
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 30)
        .map((r) => rideView(r, user)),
    };
  });

  const rideAction = (action, handler) =>
    on('POST', `/api/rides/:id/${action}`, (ctx) => {
      const ride = db.rides[ctx.params.id];
      need(ride && (ride.riderId === ctx.user.id || ride.driverId === ctx.user.id), 404, 'Buchung nicht gefunden.');
      handler(ride, ctx);
      ride.updatedAt = now();
      return { ride: rideView(ride, ctx.user) };
    });

  const asDriver = (ride, user) => need(ride.driverId === user.id, 403, 'Nur der Fahrer kann das.');
  const inStatus = (ride, ...states) => need(states.includes(ride.status), 409, `Aktion im Status „${ride.status}“ nicht möglich.`);
  const roleOf = (ride, user) => (ride.driverId === user.id ? 'driver' : 'rider');

  // Annahme = Bestätigung des Fahrers auf Basis derselben geplanten Route.
  rideAction('accept', (ride, { user, body }) => {
    asDriver(ride, user);
    inStatus(ride, 'requested');
    need(body.confirmPlannedRoute === true, 400, 'Bitte die geplante Route bestätigen.');
    const trip = db.trips[ride.tripId];
    need(trip.status === 'active' && trip.seatsFree >= ride.seats, 409, 'Keine freien Plätze mehr.');
    const rider = db.users[ride.riderId];
    need(rider.walletCents - rider.reservedCents >= ride.maxChargeCents, 402, 'Der Mitfahrer hat nicht genug Guthaben.');
    rider.reservedCents += ride.maxChargeCents;
    ride.reservedCents = ride.maxChargeCents;
    trip.seatsFree -= ride.seats;
    ride.confirmations.driverRoute = now();
    ride.status = 'accepted';
    ride.acceptedAt = now();
  });

  rideAction('decline', (ride, { user }) => {
    asDriver(ride, user);
    inStatus(ride, 'requested');
    ride.status = 'declined';
  });

  rideAction('cancel', (ride) => {
    inStatus(ride, 'requested', 'accepted');
    freeSeats(ride);
    releaseReservation(ride);
    ride.status = 'cancelled';
  });

  rideAction('pickup', (ride, { user }) => {
    asDriver(ride, user);
    inStatus(ride, 'accepted');
    ride.status = 'picked_up';
    ride.pickedUpAt = now();
    ride.trackedKm = 0;
  });

  /**
   * Abrechnung: geplante Route (fällig mit dem Einsteigen); bei Fahrtabbruch die gefahrene Strecke.
   * kmOverride nur durch den Betreiber bei Reklamationen (höchstens geplante km).
   */
  const settle = (ride, confirmedBy, kmOverride) => {
    const basis = kmOverride !== undefined ? { km: kmOverride, basis: 'betreiber' } : billableKm(ride.plannedKm, ride.trackedKm, { aborted: Boolean(ride.abort) });
    const fare = computeFare(basis.km, config.pricing, ride.seats, { pickupDetourKm: ride.pickupDetourKm || 0 });
    const rider = db.users[ride.riderId];
    const driver = db.users[ride.driverId];
    releaseReservation(ride);
    freeSeats(ride);

    rider.walletCents -= fare.totalCents;
    driver.walletCents += fare.driverCents;
    const abortNote = ride.abort ? ' (Fahrtabbruch)' : '';
    book(`user:${rider.id}`, -fare.totalCents, 'ride_payment', ride.id, `Mitfahrt ${fmtKm(fare.km)} km${abortNote}`);
    book(`user:${driver.id}`, fare.driverCents - fare.detourCents, 'ride_earning', ride.id, `Fahreranteil ${fmtKm(fare.km)} km`);
    if (fare.detourCents) book(`user:${driver.id}`, fare.detourCents, 'pickup_detour', ride.id, `Anfahrt zum Treffpunkt ${fmtKm(fare.detourKm)} km (ohne Provision)`);
    book('platform', fare.commissionCents, 'commission', ride.id, `Provision ${config.pricing.commissionPercent} %`);
    book('donation', fare.donationCents, 'donation', ride.id, 'Spende Umweltschutz');

    rider.co2SavedKg = (rider.co2SavedKg || 0) + fare.co2SavedKg;
    driver.co2SavedKg = (driver.co2SavedKg || 0) + fare.co2SavedKg;
    ride.final = { ...fare, plannedKm: ride.plannedKm, trackedKm: ride.trackedKm, billing: basis.basis, confirmedBy };
    ride.status = 'completed';
    ride.completedAt = now();
    store.touch();
  };

  // ratedRole: wer bewertet wird ('driver' oder 'rider') – bestimmt die möglichen Gründe (Aspekte).
  const ratingFrom = (body, ratedRole) => {
    const score = nps.parseScore(body.nps);
    if (score === null) return null;
    return {
      score,
      category: nps.category(score),
      aspects: feedback.sanitizeAspects(body.aspects, score, ratedRole),
      comment: String(body.comment || '').trim().slice(0, 500),
      at: now(),
    };
  };

  /** Alle Bewertungen, die ein Nutzer in einer Rolle erhalten hat. */
  const receivedRatings = (userId, role) => (role === 'driver' ? userSlot(userId).ratedAsDriver : userSlot(userId).ratedAsRider);

  /**
   * Fahrtende: Gezahlt wird, wenn der Fahrer den Mitfahrer ABGESETZT hat UND der Mitfahrer
   * die Fahrt nach NPS-Logik (0–10) BEWERTET hat. Reihenfolge egal; mit dem ersten Schritt
   * endet die km-Messung, mit dem zweiten wird abgerechnet.
   * Der Fahrer kann beim Absetzen optional den Mitfahrer bewerten.
   */
  rideAction('confirm', (ride, { user, body }) => {
    inStatus(ride, 'picked_up', 'confirming');
    const role = roleOf(ride, user);
    need(!ride.confirmations[role + 'End'], 409, role === 'driver' ? 'Du hast das Absetzen bereits bestätigt.' : 'Du hast die Fahrt bereits bewertet.');
    const rating = ratingFrom(body, role === 'rider' ? 'driver' : 'rider');
    if (role === 'rider') {
      need(rating, 400, 'Bitte bewerte die Fahrt mit 0 bis 10 – erst dann wird bezahlt.');
      ride.npsByRider = rating;
      nps.addScore(db.users[ride.driverId], rating.score);
    } else if (rating) {
      ride.npsByDriver = rating;
      nps.addScore(db.users[ride.riderId], rating.score);
    }
    if (ride.status === 'picked_up') {
      freeSeats(ride);
      ride.status = 'confirming';
      ride.droppedOffAt = now();
    }
    ride.confirmations[role + 'End'] = now();
    store.touch();
    if (ride.confirmations.driverEnd && ride.confirmations.riderEnd) settle(ride, 'beide');
  });

  // Fahrtabbruch: nur die bis dahin gefahrene Strecke wird berechnet. Muss begründet werden und
  // fließt in die Fahrtabbruchsquote beider Beteiligten ein.
  rideAction('abort', (ride, { user, body }) => {
    inStatus(ride, 'picked_up');
    const category = String(body.category || '');
    need(ABORT_REASONS.some((r) => r.id === category), 400, 'Bitte einen Grund für den Abbruch auswählen.');
    const reason = String(body.reason || '').trim().slice(0, 500);
    need(reason.length >= 10, 400, 'Bitte den Fahrtabbruch kurz begründen (mindestens 10 Zeichen).');
    freeSeats(ride);
    ride.droppedOffAt = now();
    ride.abort = { by: roleOf(ride, user), category, reason, at: now(), trackedKm: ride.trackedKm };
    settle(ride, 'abbruch');
  });

  // Reklamation statt Bestätigung: keine Abrechnung, der Betreiber entscheidet.
  rideAction('dispute', (ride, { user, body }) => {
    inStatus(ride, 'picked_up', 'confirming');
    const reason = String(body.reason || '').trim().slice(0, 500);
    need(reason.length >= 5, 400, 'Bitte kurz beschreiben, was nicht gestimmt hat.');
    if (ride.status === 'picked_up') {
      freeSeats(ride);
      ride.droppedOffAt = now();
    }
    ride.status = 'disputed';
    ride.dispute = { by: roleOf(ride, user), reason, at: now() };
  });

  // Bestätigt nur eine Seite, gilt die Fahrt nach Ablauf der Frist als bestätigt.
  const settleOverdue = () => {
    const limit = Date.now() - config.rides.autoConfirmHours * 3600 * 1000;
    // Nur Fahrten prüfen, die auf Bestätigung warten (Index), nicht alle Fahrten.
    for (const ride of derived().confirming) {
      if (ride.status === 'confirming' && new Date(ride.droppedOffAt).getTime() < limit) {
        ride.confirmations.autoAt = now();
        settle(ride, 'automatisch');
        store.save();
      }
    }
  };
  const timer = setInterval(settleOverdue, 5 * 60 * 1000);
  timer.unref();

  // Nachträgliche Bewertung (z. B. Fahrer bewertet Mitfahrer, oder nach automatischer Bestätigung).
  rideAction('rate', (ride, { user, body }) => {
    inStatus(ride, 'completed');
    const isRider = ride.riderId === user.id;
    const rating = ratingFrom(body, isRider ? 'driver' : 'rider');
    need(rating, 400, 'Bewertung von 0 bis 10.');
    const field = isRider ? 'npsByRider' : 'npsByDriver';
    need(!ride[field], 409, 'Bereits bewertet.');
    ride[field] = rating;
    nps.addScore(db.users[isRider ? ride.driverId : ride.riderId], rating.score);
    store.touch();
  });

  // Feedback zum Lernen – gesammelt und anonym (ab feedback.MIN_ENTRIES Rückmeldungen)
  on('GET', '/api/me/feedback', ({ user }) => ({
    asDriver: feedback.summarize(receivedRatings(user.id, 'driver'), 'driver', { seed: user.id }),
    asRider: feedback.summarize(receivedRatings(user.id, 'rider'), 'rider', { seed: user.id }),
  }));

  // ---------- Betreiber / Admin ----------
  const adminOnly = (user) => need(user.isAdmin, 403, 'Nur für Betreiber.');

  on('GET', '/api/admin/stats', ({ user }) => {
    adminOnly(user);
    const sum = (acc) => db.ledger.filter((t) => t.account === acc).reduce((s, t) => s + t.amountCents, 0);
    const completed = Object.values(db.rides).filter((r) => r.status === 'completed');
    return {
      commissionCents: sum('platform'),
      donationCents: sum('donation'),
      ridesCompleted: completed.length,
      kmShared: Math.round(completed.reduce((s, r) => s + r.final.km, 0) * 10) / 10,
      co2SavedKg: Math.round(completed.reduce((s, r) => s + r.final.co2SavedKg, 0) * 100) / 100,
      users: Object.keys(db.users).length,
      activeTrips: Object.values(db.trips).filter((t) => t.status === 'active').length,
      verifiedDrivers: Object.values(db.users).filter((u) => canDrive(u)).length,
      openDisputes: Object.values(db.rides).filter((r) => r.status === 'disputed').length,
      // NPS der Plattform aus allen Bewertungen der Mitfahrer
      driverNps: (() => {
        const all = Object.values(db.rides).filter((r) => r.npsByRider);
        const acc = { nps: null };
        all.forEach((r) => nps.addScore(acc, r.npsByRider.score));
        return nps.summary(acc);
      })(),
    };
  });

  // ---------- Nutzungsbedingungen: Sperre bei zu hoher Fahrtabbruchsquote ----------
  const memberView = (u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    flags: abortFlags(u),
    abortStats: { asDriver: abortStats(u.id, 'driver'), asRider: abortStats(u.id, 'rider') },
    suspension: activeSuspension(u),
    warnings: u.warnings || [],
  });

  on('GET', '/api/admin/abort-review', ({ user }) => {
    adminOnly(user);
    const members = Object.values(db.users).filter((u) => !u.deleted);
    return {
      policy: config.abortPolicy,
      flagged: members.filter((u) => abortFlags(u).length && !activeSuspension(u)).map(memberView),
      suspended: members.filter((u) => activeSuspension(u)).map(memberView),
    };
  });

  on('POST', '/api/admin/users/:id/warn', ({ user, params, body }) => {
    adminOnly(user);
    const target = db.users[params.id];
    need(target && !target.deleted, 404, 'Nutzer nicht gefunden.');
    const note = String(body.note || '').trim().slice(0, 300) || 'Hohe Fahrtabbruchsquote';
    target.warnings = [...(target.warnings || []), { at: now(), by: user.id, note }];
    return { member: memberView(target) };
  });

  on('POST', '/api/admin/users/:id/suspend', ({ user, params, body }) => {
    adminOnly(user);
    const target = db.users[params.id];
    need(target && !target.deleted, 404, 'Nutzer nicht gefunden.');
    need(target.id !== user.id, 400, 'Du kannst dich nicht selbst sperren.');
    const days = body.days === null || body.days === 'unbefristet' ? null : Math.round(Number(body.days));
    need(days === null || (days >= 1 && days <= 365), 400, 'Dauer: 1–365 Tage oder unbefristet.');
    const reason = String(body.reason || '').trim().slice(0, 300);
    need(reason.length >= 5, 400, 'Bitte einen Grund angeben.');
    target.suspension = { since: now(), until: days === null ? null : new Date(Date.now() + days * 864e5).toISOString(), reason, by: user.id };
    // Aktive Fahrt ohne Mitfahrer an Bord sofort beenden; offene Anfragen stornieren
    for (const trip of Object.values(db.trips)) {
      if (trip.driverId !== target.id || trip.status !== 'active') continue;
      const onboard = Object.values(db.rides).some((r) => r.tripId === trip.id && ['picked_up', 'confirming'].includes(r.status));
      for (const ride of Object.values(db.rides)) {
        if (ride.tripId === trip.id && ['requested', 'accepted'].includes(ride.status)) {
          freeSeats(ride);
          releaseReservation(ride);
          ride.status = 'cancelled';
          ride.cancelReason = 'Fahrer gesperrt';
        }
      }
      if (!onboard) { trip.status = 'ended'; trip.endedAt = now(); }
    }
    for (const ride of Object.values(db.rides)) {
      if (ride.riderId === target.id && ['requested', 'accepted'].includes(ride.status)) {
        freeSeats(ride);
        releaseReservation(ride);
        ride.status = 'cancelled';
        ride.cancelReason = 'Mitfahrer gesperrt';
      }
    }
    return { member: memberView(target) };
  });

  on('POST', '/api/admin/users/:id/unsuspend', ({ user, params }) => {
    adminOnly(user);
    const target = db.users[params.id];
    need(target && target.suspension, 404, 'Keine Sperre gefunden.');
    target.suspensionHistory = [...(target.suspensionHistory || []), { ...target.suspension, liftedAt: now(), liftedBy: user.id }];
    target.suspension = null;
    return { member: memberView(target) };
  });

  on('GET', '/api/admin/disputes', ({ user }) => {
    adminOnly(user);
    return {
      disputes: Object.values(db.rides)
        .filter((r) => r.status === 'disputed')
        .map((r) => ({ ...rideView(r, user), riderName: db.users[r.riderId].name, driverName: db.users[r.driverId].name })),
    };
  });

  // Reklamation entscheiden: abrechnen (Regel oder geringere km) oder kostenlos stornieren.
  on('POST', '/api/admin/rides/:id/resolve', ({ user, params, body }) => {
    adminOnly(user);
    const ride = db.rides[params.id];
    need(ride && ride.status === 'disputed', 404, 'Reklamation nicht gefunden.');
    need(['bill', 'cancel'].includes(body.decision), 400, 'Entscheidung: bill oder cancel.');
    ride.dispute.resolvedAt = now();
    ride.dispute.resolvedBy = user.id;
    ride.dispute.note = String(body.note || '').slice(0, 300);
    if (body.decision === 'cancel') {
      releaseReservation(ride);
      ride.status = 'cancelled';
      ride.cancelReason = 'Reklamation: vom Betreiber storniert';
      return { ride };
    }
    let km;
    if (body.km !== undefined && body.km !== '') {
      km = Number(body.km);
      need(Number.isFinite(km) && km >= 0 && km <= ride.plannedKm, 400, `km zwischen 0 und ${ride.plannedKm} (geplante Route).`);
    }
    settle(ride, 'betreiber', km);
    return { ride };
  });

  on('GET', '/api/admin/guestbook', ({ user }) => {
    adminOnly(user);
    return {
      entries: db.guestbook
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 50)
        .map((g) => ({ ...guestbook.publicEntry(g), driverName: db.users[g.driverId] ? db.users[g.driverId].name : '?', hidden: g.hidden })),
    };
  });

  on('GET', '/api/admin/licenses', ({ user }) => {
    adminOnly(user);
    return {
      licenses: Object.values(db.users)
        .filter((u) => u.license && u.license.status === 'pending')
        .map((u) => ({ userId: u.id, name: u.name, email: u.email, ...u.license, files: undefined })),
    };
  });

  on('POST', '/api/admin/licenses/:userId', ({ user, params, body }) => {
    adminOnly(user);
    const target = db.users[params.userId];
    need(target && target.license, 404, 'Antrag nicht gefunden.');
    need(['verified', 'rejected'].includes(body.decision), 400, 'Entscheidung: verified oder rejected.');
    target.license.status = body.decision;
    target.license.reviewNote = String(body.note || '').slice(0, 300);
    target.license.reviewedAt = now();
    target.license.reviewedBy = user.id;
    // Datensparsamkeit: Fotos werden nach der Prüfung gelöscht, nur die Prüfdaten bleiben.
    Object.values(target.license.files || {}).forEach((f) => store.removeUpload(f));
    target.license.files = null;
    return { ok: true };
  });

  on('GET', '/api/admin/licenses/:userId/:side', ({ user, params, res }) => {
    adminOnly(user);
    need(LICENSE_SIDES.includes(params.side), 404, 'Bild nicht gefunden.');
    const target = db.users[params.userId];
    const file = target && target.license && target.license.files && target.license.files[params.side];
    need(file, 404, 'Bild nicht gefunden.');
    sendUpload(res, file, 'private, no-store');
    return undefined;
  });

  // ---------- HTTP-Handler ----------
  return async function handle(req, res) {
    const secure = isSecure(req, config.trustProxy);
    // Alles in try/catch: Eine fehlerhafte Anfrage (z. B. kaputt kodierte URL) darf den Server nie beenden.
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) return await serveStatic(url.pathname, req, res, secure);
      await handleApi(req, res, url, secure);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: status === 500 ? 'Interner Fehler. Bitte später erneut versuchen.' : err.message }, secure);
    }
  };

  async function handleApi(req, res, url, secure) {
    const ctx = { req, res, query: url.searchParams, params: {}, body: {} };
    try {
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      need(route, 404, 'Unbekannter Endpunkt.');
      const m = url.pathname.match(route.re);
      route.keys.forEach((k, i) => {
        try {
          ctx.params[k] = decodeURIComponent(m[i + 1]);
        } catch {
          throw new HttpError(400, 'Ungültige Adresse.');
        }
      });
      ctx.user = userFromRequest(store, req);
      if (!route.public && !ctx.user) throw new HttpError(401, 'Bitte anmelden.', undefined, 'auth_required');
      if (req.method !== 'GET') {
        // Einfacher CSRF-Schutz: nur JSON-Anfragen akzeptieren.
        need(String(req.headers['content-type'] || '').startsWith('application/json'), 415, 'JSON erwartet.');
        ctx.body = await readJson(req);
        store.touch();
      }
      const result = await route.handler(ctx);
      if (req.method !== 'GET') store.save();
      if (result !== undefined) sendJson(res, 200, result, secure);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      // Bei 500 keine internen Details nach außen geben (nur ins Log).
      sendJson(res, status, { error: status === 500 ? 'Interner Fehler. Bitte später erneut versuchen.' : err.message, details: err.details, code: err.code }, secure);
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Anfrage zu groß.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Ungültiges JSON.'));
      }
    });
    req.on('error', reject);
  });
}

const HSTS = 'max-age=31536000; includeSubDomains';

function sendJson(res, status, data, secure = false) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(secure ? { 'Strict-Transport-Security': HSTS } : {}),
  });
  res.end(JSON.stringify(data));
}

async function serveStatic(pathname, req, res, secure) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    throw new HttpError(400, 'Ungültige Adresse.');
  }
  let file = path.resolve(PUBLIC_DIR, rel);
  let stat = file.startsWith(PUBLIC_DIR + path.sep) ? await fs.promises.stat(file).catch(() => null) : null;
  if (!stat || stat.isDirectory()) {
    // SPA-Fallback
    file = path.join(PUBLIC_DIR, 'index.html');
    stat = await fs.promises.stat(file);
  }
  return serveFile(file, stat, req, res, secure);
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function serveFile(file, stat, req, res, secure) {
  const lastModified = stat.mtime.toUTCString();
  const headers = {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': CSP,
    'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()',
    'Last-Modified': lastModified,
    // Bibliotheken ändern sich selten (1 Tag), eigene Dateien immer neu prüfen (304, wenn unverändert).
    'Cache-Control': file.includes(`${path.sep}vendor${path.sep}`) ? 'public, max-age=86400' : 'no-cache',
    ...(secure ? { 'Strict-Transport-Security': HSTS } : {}),
  };
  const since = Date.parse(req.headers['if-modified-since'] || '');
  if (since && Math.floor(stat.mtimeMs / 1000) * 1000 <= since) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

module.exports = { createApp, HttpError };
