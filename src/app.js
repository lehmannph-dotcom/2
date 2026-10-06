'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hashPassword, verifyPassword, createSession, userFromRequest, sessionCookie, parseCookies } = require('./auth');
const { validateLicense, canDrive } = require('./license');
const { findMatches } = require('./matching');
const { computeFare, billableKm } = require('./pricing');
const { haversineKm, projectOntoRoute, cumulativeKm, isLatLng } = require('./geo');

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
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
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
    return {
      ...ride,
      role: viewer.id === ride.driverId ? 'driver' : 'rider',
      riderName: rider ? rider.name : '?',
      driverName: driver ? driver.name : '?',
      vehicle: trip ? trip.vehicle : '',
      driverPosition: trip ? trip.position || null : null,
      tripDestination: trip ? trip.destination : null,
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
  on('POST', '/api/register', async ({ body, req, res }) => {
    const name = String(body.name || '').trim().slice(0, 80);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    need(name.length >= 2, 400, 'Bitte Namen angeben.');
    need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 400, 'Ungültige E-Mail-Adresse.');
    need(password.length >= 8, 400, 'Passwort muss mindestens 8 Zeichen haben.');
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
      createdAt: now(),
    };
    db.users[user.id] = user;
    res.setHeader('Set-Cookie', sessionCookie(createSession(store, user.id), req));
    return { user: publicUser(user) };
  }, { public: true });

  on('POST', '/api/login', ({ body, req, res }) => {
    const email = String(body.email || '').trim().toLowerCase();
    const user = Object.values(db.users).find((u) => u.email === email);
    need(user && verifyPassword(String(body.password || ''), user.passwordHash), 401, 'E-Mail oder Passwort falsch.');
    res.setHeader('Set-Cookie', sessionCookie(createSession(store, user.id), req));
    return { user: publicUser(user) };
  }, { public: true });

  on('POST', '/api/logout', ({ req, res }) => {
    delete db.sessions[parseCookies(req.headers.cookie).sid];
    res.setHeader('Set-Cookie', sessionCookie('', req));
    return { ok: true };
  }, { public: true });

  on('GET', '/api/me', ({ user }) => ({ user: publicUser(user) }));

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
      vehicle: String(body.vehicle || '').slice(0, 80),
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
    return { trip };
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

  // ---------- Mitfahrer: besten Fahrer finden ----------
  on('POST', '/api/match', ({ user, body }) => {
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
    return { matches, activeDrivers: trips.length };
  });

  // ---------- Buchungen ----------
  on('POST', '/api/rides', ({ user, body }) => {
    const trip = db.trips[body.tripId];
    need(trip && trip.status === 'active', 404, 'Diese Fahrt ist nicht mehr verfügbar.');
    need(trip.driverId !== user.id, 400, 'Du kannst nicht bei dir selbst mitfahren.');
    need(!Object.values(db.rides).some((r) => r.riderId === user.id && ['requested', 'accepted', 'picked_up'].includes(r.status)), 409, 'Du hast bereits eine offene Mitfahrt.');
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
    const maxCharge = computeFare(match.plannedKm * config.pricing.maxBilledKmFactor, config.pricing, seats).totalCents;
    need(user.walletCents - user.reservedCents >= maxCharge, 402, `Nicht genug Guthaben. Benötigt werden bis zu ${(maxCharge / 100).toFixed(2)} €.`);
    const ride = {
      id: store.id('rid'),
      tripId: trip.id,
      driverId: trip.driverId,
      riderId: user.id,
      status: 'requested',
      pickup,
      dropoff,
      seats,
      plannedKm: match.plannedKm,
      pickupAlongKm: match.pickupAlongKm,
      detourKm: match.detourKm,
      estimate: match.price,
      maxChargeCents: maxCharge,
      reservedCents: 0,
      trackedKm: 0,
      createdAt: now(),
    };
    db.rides[ride.id] = ride;
    return { ride: rideView(ride, user) };
  });

  on('GET', '/api/rides', ({ user }) => ({
    rides: Object.values(db.rides)
      .filter((r) => r.riderId === user.id || r.driverId === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 30)
      .map((r) => rideView(r, user)),
  }));

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

  rideAction('accept', (ride, { user }) => {
    asDriver(ride, user);
    inStatus(ride, 'requested');
    const trip = db.trips[ride.tripId];
    need(trip.status === 'active' && trip.seatsFree >= ride.seats, 409, 'Keine freien Plätze mehr.');
    const rider = db.users[ride.riderId];
    need(rider.walletCents - rider.reservedCents >= ride.maxChargeCents, 402, 'Der Mitfahrer hat nicht genug Guthaben.');
    rider.reservedCents += ride.maxChargeCents;
    ride.reservedCents = ride.maxChargeCents;
    trip.seatsFree -= ride.seats;
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

  // Abschluss & Abrechnung nach gefahrenen Kilometern.
  rideAction('complete', (ride, { user }) => {
    asDriver(ride, user);
    inStatus(ride, 'picked_up');
    const km = billableKm(ride.plannedKm, ride.trackedKm, config.pricing);
    const fare = computeFare(km, config.pricing, ride.seats);
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
    ride.final = { ...fare, billing: ride.trackedKm > 0.2 ? 'gps' : 'geplant' };
    ride.status = 'completed';
    ride.completedAt = now();
  });

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
      if (!route.public) need(ctx.user, 401, 'Bitte anmelden.');
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
      sendJson(res, status, { error: status === 500 ? 'Interner Fehler: ' + err.message : err.message, details: err.details });
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

function serveFile(file, res) {
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  fs.createReadStream(file).pipe(res);
}

module.exports = { createApp, HttpError };
