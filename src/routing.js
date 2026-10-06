'use strict';

/**
 * Geocoding und Routing.
 *  - Mit GOOGLE_MAPS_API_KEY: Google Geocoding API + Directions API.
 *  - Ohne Key: OpenStreetMap Nominatim + OSRM (öffentliche Demo-Server).
 *  - Ohne Netz: Luftlinie × Straßenfaktor (nur Notbetrieb).
 *
 * Außerdem können Fahrer einfach einen Google-Maps-Routenlink einfügen.
 */

const config = require('./config');
const { decodePolyline, haversineKm, straightLine, simplify, isLatLng } = require('./geo');

const USER_AGENT = 'joinmyride.com/0.2 (Mitfahrzentrale; Kostenteilung)';
const cache = new Map();

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} von ${new URL(url).host}`);
  return res.json();
}

function parseLatLng(text) {
  const m = String(text).trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const p = { lat: Number(m[1]), lng: Number(m[2]) };
  return isLatLng(p) ? p : null;
}

/** Adresse → [{label, lat, lng}] */
async function geocode(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const direct = parseLatLng(q);
  if (direct) return [{ label: q, ...direct }];

  const key = 'geo:' + q.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  let results;
  if (config.googleMapsApiKey) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?language=de&region=de&address=${encodeURIComponent(q)}&key=${config.googleMapsApiKey}`;
    const data = await fetchJson(url);
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') throw new Error('Google Geocoding: ' + data.status);
    results = (data.results || []).slice(0, 5).map((r) => ({
      label: r.formatted_address,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
    }));
  } else {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=de&q=${encodeURIComponent(q)}`;
    const data = await fetchJson(url);
    results = data.map((r) => ({ label: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }));
  }
  cache.set(key, results);
  return results;
}

async function resolvePlace(place) {
  if (isLatLng(place)) return { label: place.label || `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`, lat: place.lat, lng: place.lng };
  const [first] = await geocode(typeof place === 'string' ? place : place && place.label);
  if (!first) throw new Error(`Ort nicht gefunden: ${typeof place === 'string' ? place : (place && place.label) || '?'}`);
  return first;
}

/** Route zwischen zwei Orten → {coords, distanceKm, durationMin, provider} */
async function route(from, to) {
  const a = await resolvePlace(from);
  const b = await resolvePlace(to);
  let result;
  try {
    result = config.googleMapsApiKey ? await googleRoute(a, b) : await osrmRoute(a, b);
  } catch (err) {
    const km = haversineKm(a, b) * 1.3;
    result = { coords: straightLine(a, b), distanceKm: km, durationMin: km /* ~60 km/h */, provider: 'luftlinie', warning: err.message };
  }
  result.coords = simplify(result.coords);
  return { origin: a, destination: b, ...result };
}

async function googleRoute(a, b) {
  const url =
    `https://maps.googleapis.com/maps/api/directions/json?language=de&mode=driving` +
    `&origin=${a.lat},${a.lng}&destination=${b.lat},${b.lng}&key=${config.googleMapsApiKey}`;
  const data = await fetchJson(url);
  if (data.status !== 'OK') throw new Error('Google Directions: ' + data.status);
  const r = data.routes[0];
  const legs = r.legs || [];
  return {
    coords: decodePolyline(r.overview_polyline.points),
    distanceKm: legs.reduce((s, l) => s + l.distance.value, 0) / 1000,
    durationMin: legs.reduce((s, l) => s + l.duration.value, 0) / 60,
    provider: 'google',
  };
}

async function osrmRoute(a, b) {
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=polyline`;
  const data = await fetchJson(url);
  if (data.code !== 'Ok' || !data.routes.length) throw new Error('OSRM: ' + data.code);
  const r = data.routes[0];
  return {
    coords: decodePolyline(r.geometry),
    distanceKm: r.distance / 1000,
    durationMin: r.duration / 60,
    provider: 'osrm',
  };
}

/**
 * Extrahiert Start und Ziel aus einem Google-Maps-Routenlink, z. B.
 *   https://www.google.com/maps/dir/Berlin+Hbf/Hamburg+Hbf/@53.0,10.0,8z/...
 *   https://www.google.com/maps/dir/?api=1&origin=Berlin&destination=Hamburg
 * Kurzlinks (maps.app.goo.gl) werden vorher über die Weiterleitung aufgelöst.
 */
async function parseGoogleMapsLink(link) {
  let url;
  try {
    url = new URL(String(link).trim());
  } catch {
    throw new Error('Ungültiger Link.');
  }
  if (/^(maps\.app\.goo\.gl|goo\.gl)$/.test(url.hostname)) {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const loc = res.headers.get('location');
    if (!loc) throw new Error('Kurzlink konnte nicht aufgelöst werden.');
    url = new URL(loc, url);
  }
  if (!/(^|\.)google\.[a-z.]+$/.test(url.hostname) || !url.pathname.startsWith('/maps')) {
    throw new Error('Bitte einen Google-Maps-Routenlink einfügen.');
  }
  return parseGoogleMapsUrl(url);
}

function parseGoogleMapsUrl(url) {
  const origin = url.searchParams.get('origin');
  const destination = url.searchParams.get('destination');
  if (origin && destination) return { origin: toPlace(origin), destination: toPlace(destination) };

  const m = url.pathname.match(/\/maps\/dir\/(.+)/);
  if (!m) throw new Error('Der Link enthält keine Route (…/maps/dir/Start/Ziel).');
  const parts = m[1]
    .split('/')
    .filter((s) => s && !s.startsWith('@') && !s.startsWith('data=') && s !== 'am=t')
    .map((s) => decodeURIComponent(s.replace(/\+/g, ' ')));
  if (parts.length < 2) throw new Error('Start oder Ziel fehlt im Link.');
  return { origin: toPlace(parts[0]), destination: toPlace(parts[parts.length - 1]) };
}

function toPlace(text) {
  return parseLatLng(text) || text;
}

module.exports = { geocode, route, resolvePlace, parseGoogleMapsLink, parseGoogleMapsUrl };
