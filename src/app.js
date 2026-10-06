'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { hashPassword, verifyPassword, createSession, userFromRequest, sessionCookie, parseCookies } = require('./auth');
const { validateLicense, canDrive } = require('./license');
const { findMatches } = require('./matching');
const { computeFare, billableKm } = require('./pricing');
const { haversineKm, projectOntoRoute, cumulativeKm, isLatLng, simplify } = require('./geo');
const mfa = require('./mfa');
const { displayName, publicProfile, privacyOf, profileOf, sanitizeProfile, sanitizePrivacy } = require('./profile');

const PRIVACY_POLICY_VERSION = '2026-10';
const MFA_LOGIN_TTL_MS = 5 * 60 * 1000;
const MFA_MAX_ATTEMPTS = 5;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 16 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
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
  const publicUser = (u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    isAdmin: Boolean(u.isAdmin),
    walletCents: u.walletCents,
    reservedCents: u.reservedCents,
    rating: u.ratingCount ? Math.round((u.ratingSum / u.ratingCount) * 10) / 10 : null,
    ratingCount: u.ratingCount,
    co2SavedKg: Math.round((u.co2SavedKg || 0) * 100) / 100,
    canDrive: canDrive(u),
    mfaEnabled: Boolean(u.mfa && u.mfa.enabled),
    backupCodesLeft: u.mfa && u.mfa.enabled ? u.mfa.backupHashes.length : 0,
    hasPhoto: Boolean(profileOf(u).photo),
    profile: { ...profileOf(u), photo: undefined },
    privacy: privacyOf(u),
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
  });
  const book = (account, amountCents, type, rideId, note) => {
    db.ledger.push({ id: store.id('tx'), at: now(), account, amountCents, type, rideId, note });
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
      const b = billableKm(ride.plannedKm, ride.trackedKm);
      settlementPreview = { plannedKm: ride.plannedKm, trackedKm: ride.trackedKm, billedKm: b.km, basis: b.basis, price: computeFare(b.km, config.pricing, ride.seats) };
    }
    return {
      ...ride,
      role,
      myRouteConfirmed: Boolean(c[role + 'Route']),
      partnerRouteConfirmed: Boolean(c[partner + 'Route']),
      myEndConfirmed: Boolean(c[role + 'End']),
      partnerEndConfirmed: Boolean(c[partner + 'End']),
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
  }), { public: true });

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
  const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const startSession = (user, req, res) => {
    const token = createSession(store, user.id);
    Object.assign(db.sessions[token], { createdAt: now(), userAgent: String(req.headers['user-agent'] || '').slice(0, 160) });
    user.lastLoginAt = now();
    res.setHeader('Set-Cookie', sessionCookie(token, req));
  };
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
  const confirmIdentity = (user, body) => {
    need(verifyPassword(String(body.password || ''), user.passwordHash), 401, 'Passwort ist falsch.');
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
      ratingSum: 0,
      ratingCount: 0,
      co2SavedKg: 0,
      license: null,
      profile: null,
      privacy: null,
      mfa: null,
      consentAt: now(),
      consentVersion: PRIVACY_POLICY_VERSION,
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
    need(user && verifyPassword(String(body.password || ''), user.passwordHash), 401, 'E-Mail oder Passwort falsch.');
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
      pendingLogins.delete(body.mfaToken);
      throw new HttpError(429, 'Zu viele falsche Codes. Bitte erneut mit Passwort anmelden.');
    }
    const user = db.users[pending.userId];
    const method = checkSecondFactor(user, body.code);
    need(method, 401, 'Code ist ungültig.');
    pendingLogins.delete(body.mfaToken);
    startSession(user, req, res);
    return { user: publicUser(user), usedBackupCode: method === 'backup' };
  }, { public: true });

  on('POST', '/api/logout', ({ req, res }) => {
    delete db.sessions[parseCookies(req.headers.cookie).sid];
    res.setHeader('Set-Cookie', sessionCookie('', req));
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
    let asDriver = 0;
    let asRider = 0;
    for (const r of Object.values(db.rides)) {
      if (r.status !== 'completed') continue;
      if (r.driverId === userId) asDriver++;
      if (r.riderId === userId) asRider++;
    }
    return { asDriver, asRider };
  };
  const sharesBooking = (a, b) =>
    Object.values(db.rides).some(
      (r) => ['accepted', 'picked_up', 'confirming'].includes(r.status) && ((r.driverId === a && r.riderId === b) || (r.driverId === b && r.riderId === a)),
    );
  const sharesAnyRide = (a, b) =>
    Object.values(db.rides).some((r) => (r.driverId === a && r.riderId === b) || (r.driverId === b && r.riderId === a));
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
    if (preview) {
      return { profile: publicProfile(target, { id: 'preview' }, { hasBooking: preview === 'booked', stats: rideStats(target.id) }) };
    }
    return { profile: publicProfile(target, user, { hasBooking: sharesBooking(user.id, target.id), stats: rideStats(target.id) }) };
  });

  on('GET', '/api/users/:id/photo', ({ user, params, res }) => {
    const target = db.users[params.id];
    need(target && !target.deleted && canSeeProfile(user, target), 404, 'Kein Foto.');
    const photo = profileOf(target).photo;
    need(photo && (privacyOf(target).showPhoto || target.id === user.id), 404, 'Kein Foto.');
    const ext = path.extname(photo).slice(1);
    res.writeHead(200, { 'Content-Type': `image/${ext === 'jpg' ? 'jpeg' : ext}`, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    res.end(fs.readFileSync(store.uploadPath(photo)));
    return undefined;
  });

  // ---------- Sitzungen ----------
  on('GET', '/api/me/sessions', ({ user, req }) => {
    const current = parseCookies(req.headers.cookie).sid;
    return {
      sessions: Object.entries(db.sessions)
        .filter(([, s]) => s.userId === user.id && s.expires > Date.now())
        .map(([token, s]) => ({ current: token === current, createdAt: s.createdAt || null, userAgent: s.userAgent || '' })),
    };
  });

  on('POST', '/api/me/sessions/revoke-others', ({ user, req }) => {
    const current = parseCookies(req.headers.cookie).sid;
    for (const [token, s] of Object.entries(db.sessions)) if (s.userId === user.id && token !== current) delete db.sessions[token];
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
        .map((r) => ({ ...r, partner: displayName(db.users[r.riderId === user.id ? r.driverId : r.riderId], user) })),
      transactions: db.ledger.filter((t) => t.account === `user:${user.id}`),
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
    res.setHeader('Set-Cookie', sessionCookie('', req));
    return { ok: true, payoutCents };
  });

  // Demo-Guthaben. Produktiv: Zahlungsdienstleister (z. B. Stripe Connect), siehe README.
  on('POST', '/api/wallet/topup', ({ user, body }) => {
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
    for (const side of ['front', 'back']) {
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
  on('GET', '/api/geocode', async ({ query }) => ({ results: await routing.geocode(query.get('q')) }));

  on('POST', '/api/route/preview', async ({ body }) => {
    let { origin, destination } = body;
    if (body.googleMapsUrl) ({ origin, destination } = await routing.parseGoogleMapsLink(body.googleMapsUrl));
    need(origin && destination, 400, 'Start und Ziel angeben.');
    return { route: await routing.route(origin, destination) };
  });

  // ---------- Fahrer: Fahrt anbieten ----------
  on('POST', '/api/trips', async ({ user, body }) => {
    need(canDrive(user), 403, 'Bitte zuerst einen gültigen Führerschein verifizieren lassen.');
    need(!Object.values(db.trips).some((t) => t.driverId === user.id && t.status === 'active'), 409, 'Du hast bereits eine aktive Fahrt.');
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
      vehicle: String(body.vehicle || [profileOf(user).vehicle.color, profileOf(user).vehicle.model].filter(Boolean).join(' ')).slice(0, 80),
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
    const trips = Object.values(db.trips).filter((t) => t.status === 'active' && canDrive(db.users[t.driverId]));
    trips.forEach(tripCum);
    const matches = findMatches({
      trips,
      request: { pickup, dropoff, seats, riderId: user.id },
      pricing: config.pricing,
      maxDetourKm: config.matching.maxDetourKm,
      maxResults: config.matching.maxResults,
      users: db.users,
    });
    const plannedRoute = matches.length ? await plannedRouteFor(pickup, dropoff) : null;
    return {
      plannedRoute,
      activeDrivers: trips.length,
      matches: matches.map((m) => ({
        ...m,
        plannedKm: plannedRoute.distanceKm,
        plannedDurationMin: plannedRoute.durationMin,
        price: computeFare(plannedRoute.distanceKm, config.pricing, seats),
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
    const estimate = computeFare(plannedRoute.distanceKm, config.pricing, seats);
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
      rides: Object.values(db.rides)
        .filter((r) => r.riderId === user.id || r.driverId === user.id)
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
   * Abrechnung: geplante Route oder gefahrene Strecke, sofern kürzer.
   * kmOverride nur durch den Betreiber bei Reklamationen (höchstens geplante km).
   */
  const settle = (ride, confirmedBy, kmOverride) => {
    const basis = kmOverride !== undefined ? { km: kmOverride, basis: 'betreiber' } : billableKm(ride.plannedKm, ride.trackedKm);
    const fare = computeFare(basis.km, config.pricing, ride.seats);
    const rider = db.users[ride.riderId];
    const driver = db.users[ride.driverId];
    releaseReservation(ride);
    freeSeats(ride);

    rider.walletCents -= fare.totalCents;
    driver.walletCents += fare.driverCents;
    book(`user:${rider.id}`, -fare.totalCents, 'ride_payment', ride.id, `Mitfahrt ${fare.km.toFixed(1)} km`);
    book(`user:${driver.id}`, fare.driverCents, 'ride_earning', ride.id, `Fahreranteil ${fare.km.toFixed(1)} km`);
    book('platform', fare.commissionCents, 'commission', ride.id, `Provision ${config.pricing.commissionPercent} %`);
    book('donation', fare.donationCents, 'donation', ride.id, 'Spende Umweltschutz');

    rider.co2SavedKg = (rider.co2SavedKg || 0) + fare.co2SavedKg;
    driver.co2SavedKg = (driver.co2SavedKg || 0) + fare.co2SavedKg;
    ride.final = { ...fare, plannedKm: ride.plannedKm, trackedKm: ride.trackedKm, billing: basis.basis, confirmedBy };
    ride.status = 'completed';
    ride.completedAt = now();
  };

  // Fahrtende bestätigen – Fahrer UND Mitfahrer. Mit der ersten Bestätigung endet die km-Messung,
  // mit der zweiten wird abgerechnet.
  rideAction('confirm', (ride, { user }) => {
    inStatus(ride, 'picked_up', 'confirming');
    const role = roleOf(ride, user);
    need(!ride.confirmations[role + 'End'], 409, 'Du hast die Fahrt bereits bestätigt.');
    if (ride.status === 'picked_up') {
      freeSeats(ride);
      ride.status = 'confirming';
      ride.droppedOffAt = now();
    }
    ride.confirmations[role + 'End'] = now();
    if (ride.confirmations.driverEnd && ride.confirmations.riderEnd) settle(ride, 'beide');
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
    for (const ride of Object.values(db.rides)) {
      if (ride.status === 'confirming' && new Date(ride.droppedOffAt).getTime() < limit) {
        ride.confirmations.autoAt = now();
        settle(ride, 'automatisch');
        store.save();
      }
    }
  };
  const timer = setInterval(settleOverdue, 5 * 60 * 1000);
  timer.unref();

  rideAction('rate', (ride, { user, body }) => {
    inStatus(ride, 'completed');
    const stars = Math.round(Number(body.stars));
    need(stars >= 1 && stars <= 5, 400, '1 bis 5 Sterne.');
    const isRider = ride.riderId === user.id;
    const field = isRider ? 'ratingByRider' : 'ratingByDriver';
    need(!ride[field], 409, 'Bereits bewertet.');
    ride[field] = stars;
    const target = db.users[isRider ? ride.driverId : ride.riderId];
    target.ratingSum += stars;
    target.ratingCount += 1;
  });

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
    };
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
    const target = db.users[params.userId];
    const file = target && target.license && target.license.files && target.license.files[params.side];
    need(file, 404, 'Bild nicht gefunden.');
    const ext = path.extname(file).slice(1);
    res.writeHead(200, { 'Content-Type': `image/${ext === 'jpg' ? 'jpeg' : ext}`, 'Cache-Control': 'private, no-store' });
    res.end(fs.readFileSync(store.uploadPath(file)));
    return undefined;
  });

  // ---------- HTTP-Handler ----------
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

    const ctx = { req, res, query: url.searchParams, params: {}, body: {} };
    try {
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      need(route, 404, 'Unbekannter Endpunkt.');
      const m = url.pathname.match(route.re);
      route.keys.forEach((k, i) => (ctx.params[k] = decodeURIComponent(m[i + 1])));
      ctx.user = userFromRequest(store, req);
      if (!route.public && !ctx.user) throw new HttpError(401, 'Bitte anmelden.', undefined, 'auth_required');
      if (req.method !== 'GET') {
        // Einfacher CSRF-Schutz: nur JSON-Anfragen akzeptieren.
        need(String(req.headers['content-type'] || '').startsWith('application/json'), 415, 'JSON erwartet.');
        ctx.body = await readJson(req);
      }
      const result = await route.handler(ctx);
      if (req.method !== 'GET') store.save();
      if (result !== undefined) sendJson(res, 200, result);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: status === 500 ? 'Interner Fehler: ' + err.message : err.message, details: err.details, code: err.code });
    }
  };
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

function sendJson(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA-Fallback
    return serveFile(path.join(PUBLIC_DIR, 'index.html'), res);
  }
  return serveFile(file, res);
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

function serveFile(file, res) {
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': CSP,
    'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()',
  });
  fs.createReadStream(file).pipe(res);
}

module.exports = { createApp, HttpError };
