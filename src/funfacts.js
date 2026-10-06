'use strict';

/**
 * Funfacts: Wo und in welchen Autos sitzen die nettesten Fahrer?
 * Grundlage: NPS aus allen Bewertungen der Mitfahrer (0–10), gruppiert nach
 * Ortskürzel des Kennzeichens und nach Automarke aus dem Fahrerprofil.
 *
 * Datenschutz: Eine Gruppe erscheint erst ab minDrivers verschiedenen Fahrern und
 * minRatings Bewertungen – so lässt sich kein einzelner Fahrer ablesen.
 */

const { category } = require('./nps');
const { regionName } = require('./plates');

function group(rides, users, keyOf, { minDrivers, minRatings }) {
  const groups = new Map();
  for (const ride of rides) {
    if (ride.status !== 'completed' || !ride.npsByRider) continue;
    const driver = users[ride.driverId];
    if (!driver || driver.deleted) continue;
    const key = keyOf(driver);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, promoters: 0, passives: 0, detractors: 0, drivers: new Set() });
    const g = groups.get(key);
    g[category(ride.npsByRider.score) + 's'] += 1;
    g.drivers.add(driver.id);
  }
  const all = [...groups.values()].map((g) => {
    const count = g.promoters + g.passives + g.detractors;
    return { key: g.key, nps: Math.round(((g.promoters - g.detractors) / count) * 100), count, drivers: g.drivers.size, promoters: g.promoters, passives: g.passives, detractors: g.detractors };
  });
  const ranked = all
    .filter((g) => g.drivers >= minDrivers && g.count >= minRatings)
    .sort((a, b) => b.nps - a.nps || b.count - a.count || a.key.localeCompare(b.key));
  return { ranked, hiddenGroups: all.length - ranked.length };
}

function compute(rides, users, settings) {
  const brandOf = (u) => (u.profile && u.profile.vehicle && u.profile.vehicle.brand) || null;
  const regionOf = (u) => (u.profile && u.profile.vehicle && u.profile.vehicle.plateRegion) || null;
  const byRegion = group(rides, users, regionOf, settings);
  const byBrand = group(rides, users, brandOf, settings);
  return {
    minDrivers: settings.minDrivers,
    minRatings: settings.minRatings,
    regions: { ...byRegion, ranked: byRegion.ranked.map((g) => ({ ...g, code: g.key, name: regionName(g.key) })) },
    brands: { ...byBrand, ranked: byBrand.ranked.map((g) => ({ ...g, name: g.key })) },
  };
}

module.exports = { compute, group };
