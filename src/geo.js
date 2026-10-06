'use strict';

// Geometrie-Hilfsfunktionen: Distanzen, Polyline-Dekodierung, Projektion auf Routen.

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Großkreisdistanz zwischen zwei Punkten {lat, lng} in km. */
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Summe der Segmentlängen eines Linienzugs in km. */
function pathLengthKm(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineKm(coords[i - 1], coords[i]);
  return total;
}

/** Dekodiert eine Google "encoded polyline" in [{lat, lng}]. */
function decodePolyline(encoded) {
  const coords = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of ['lat', 'lng']) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 'lat') lat += delta;
      else lng += delta;
    }
    coords.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return coords;
}

/** Kumulierte Distanz (km) bis zu jedem Punkt der Route. */
function cumulativeKm(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineKm(coords[i - 1], coords[i]));
  return cum;
}

/**
 * Projiziert einen Punkt auf die Route.
 * Liefert den Abstand zur Route (offKm) und die Position entlang der Route (alongKm).
 * Lokal wird eine äquirektanguläre Projektion verwendet – genau genug für wenige km.
 */
function projectOntoRoute(point, coords, cum = cumulativeKm(coords)) {
  if (coords.length === 1) {
    return { offKm: haversineKm(point, coords[0]), alongKm: 0, segment: 0 };
  }
  const kx = 111.32 * Math.cos(toRad(point.lat));
  const ky = 110.574;
  let best = { offKm: Infinity, alongKm: 0, segment: 0 };
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const ax = (a.lng - point.lng) * kx;
    const ay = (a.lat - point.lat) * ky;
    const bx = (b.lng - point.lng) * kx;
    const by = (b.lat - point.lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const off = Math.sqrt(px * px + py * py);
    if (off < best.offKm) {
      best = { offKm: off, alongKm: cum[i - 1] + t * (cum[i] - cum[i - 1]), segment: i - 1 };
    }
  }
  return best;
}

/** Punkt an Position alongKm auf der Route (für Simulation / Anzeige). */
function pointAlongRoute(coords, alongKm, cum = cumulativeKm(coords)) {
  if (alongKm <= 0) return { ...coords[0] };
  const total = cum[cum.length - 1];
  if (alongKm >= total) return { ...coords[coords.length - 1] };
  let i = 1;
  while (cum[i] < alongKm) i++;
  const segLen = cum[i] - cum[i - 1];
  const t = segLen === 0 ? 0 : (alongKm - cum[i - 1]) / segLen;
  return {
    lat: coords[i - 1].lat + t * (coords[i].lat - coords[i - 1].lat),
    lng: coords[i - 1].lng + t * (coords[i].lng - coords[i - 1].lng),
  };
}

/** Gerade Linie mit n Zwischenpunkten (Fallback ohne Routing-Dienst). */
function straightLine(a, b, steps = 50) {
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    coords.push({ lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) });
  }
  return coords;
}

/** Reduziert eine Route auf höchstens maxPoints Punkte (Speicher/Übertragung). */
function simplify(coords, maxPoints = 600) {
  if (coords.length <= maxPoints) return coords;
  const step = (coords.length - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints - 1; i++) out.push(coords[Math.round(i * step)]);
  out.push(coords[coords.length - 1]);
  return out;
}

function isLatLng(p) {
  return (
    p != null &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

module.exports = {
  haversineKm,
  pathLengthKm,
  decodePolyline,
  cumulativeKm,
  projectOntoRoute,
  pointAlongRoute,
  straightLine,
  simplify,
  isLatLng,
};
