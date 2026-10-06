'use strict';

const { haversineKm, projectOntoRoute, cumulativeKm } = require('./geo');
const { computeFare } = require('./pricing');
const nps = require('./nps');

// Straßen sind länger als die Luftlinie – Faktor für Umwegschätzung.
const ROAD_FACTOR = 1.3;

/**
 * Sucht die besten Fahrer für einen Mitfahrwunsch.
 *
 * Für jede aktive Fahrt wird geprüft:
 *  1. Liegen Abholort und Ziel nahe genug an der Route des Fahrers?
 *  2. Liegt der Abholort in Fahrtrichtung VOR dem Ziel?
 *  3. Hat der Fahrer den Abholort noch nicht passiert und genug freie Plätze?
 *
 * Bewertung (kleiner = besser): Umweg des Fahrers, Wartezeit bis Abholung,
 * Anteil der Strecke, die der Mitfahrer nicht abgedeckt bekommt, und NPS des Fahrers
 * (geglättet, damit wenige Bewertungen nicht überbewertet werden).
 */
function findMatches({ trips, request, pricing, maxDetourKm = 3, maxResults = 10, users = {} }) {
  const { pickup, dropoff, seats = 1, riderId } = request;
  const directKm = haversineKm(pickup, dropoff) * ROAD_FACTOR;
  const results = [];

  for (const trip of trips) {
    if (trip.status !== 'active') continue;
    if (trip.driverId === riderId) continue;
    if (trip.seatsFree < seats) continue;

    const cum = trip._cum || cumulativeKm(trip.route.coords);
    const p = projectOntoRoute(pickup, trip.route.coords, cum);
    const d = projectOntoRoute(dropoff, trip.route.coords, cum);

    if (p.offKm > maxDetourKm || d.offKm > maxDetourKm) continue;
    if (d.alongKm - p.alongKm < 0.3) continue; // falsche Richtung oder zu kurz
    const progressKm = trip.progressKm || 0;
    if (p.alongKm < progressKm - 0.2) continue; // Fahrer ist schon vorbei

    const sharedKm = (d.alongKm - p.alongKm) + (p.offKm + d.offKm) * ROAD_FACTOR;
    const detourKm = 2 * (p.offKm + d.offKm) * ROAD_FACTOR;
    const totalKm = cum[cum.length - 1] || 1;
    const avgKmh = trip.route.durationMin > 0 ? (trip.route.distanceKm / trip.route.durationMin) * 60 : 50;
    const etaMin = (Math.max(0, p.alongKm - progressKm) + p.offKm * ROAD_FACTOR) / Math.max(avgKmh, 5) * 60;
    const coverage = Math.min(1, sharedKm / Math.max(directKm, 0.1));
    const driver = users[trip.driverId];
    // NPS −100 … +100 → Abzug 8 … 0 Punkte
    const npsPenalty = ((100 - nps.smoothedNps(driver)) / 200) * 8;

    const score = detourKm * 2 + etaMin * 0.5 + (1 - coverage) * 10 + npsPenalty;

    results.push({
      tripId: trip.id,
      driverId: trip.driverId,
      driverName: driver ? driver.name : 'Fahrer',
      driverNps: nps.summary(driver),
      vehicle: trip.vehicle || '',
      origin: trip.origin,
      destination: trip.destination,
      seatsFree: trip.seatsFree,
      pickupAlongKm: round(p.alongKm),
      dropoffAlongKm: round(d.alongKm),
      pickupOffKm: round(p.offKm),
      dropoffOffKm: round(d.offKm),
      detourKm: round(detourKm),
      etaMin: Math.round(etaMin),
      plannedKm: round(sharedKm),
      routeShare: round(sharedKm / totalKm),
      score: round(score),
      price: computeFare(sharedKm, pricing, seats),
    });
  }

  results.sort((a, b) => a.score - b.score);
  return results.slice(0, maxResults);
}

const round = (n) => Math.round(n * 100) / 100;

module.exports = { findMatches, ROAD_FACTOR };
