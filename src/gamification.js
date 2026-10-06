'use strict';

/**
 * Gamification: Punkte für geteilte Fahrten.
 *
 *   Punkte je Fahrt = Faktor(Bewertung durch den jeweils anderen) × CO₂-Ersparnis der Fahrt in kg
 *
 *   Promotor (9–10)  ×10
 *   Neutral  (7–8)   ×5
 *   Kritiker (0–6)   ×1
 *
 * Fahrer werden vom Mitfahrer bewertet (Pflicht bei der Zahlung), Mitfahrer optional vom Fahrer.
 * Solange keine Bewertung vorliegt, zählt der neutrale Faktor – wer nicht bewertet wird, soll
 * nicht leer ausgehen. Kommt die Bewertung später, werden die Punkte neu berechnet.
 */

const { category } = require('./nps');

const LEVELS = [
  { min: 0, name: 'Setzling', icon: '🌱' },
  { min: 50, name: 'Sprössling', icon: '🌿' },
  { min: 200, name: 'Jungbaum', icon: '🪴' },
  { min: 500, name: 'Baum', icon: '🌳' },
  { min: 1500, name: 'Wald', icon: '🌲' },
  { min: 5000, name: 'Klimaheld', icon: '🌍' },
];

const BADGES = [
  { id: 'first', icon: '🚗', name: 'Erste Fahrt', desc: 'Die erste geteilte Fahrt abgeschlossen', test: (s) => s.rides >= 1 },
  { id: 'ten', icon: '🔟', name: 'Stammgast', desc: '10 geteilte Fahrten', test: (s) => s.rides >= 10 },
  { id: 'fifty', icon: '🏅', name: 'Vielteiler', desc: '50 geteilte Fahrten', test: (s) => s.rides >= 50 },
  { id: 'both', icon: '🔄', name: 'Beide Seiten', desc: 'Als Fahrer und als Mitfahrer unterwegs', test: (s) => s.asDriver >= 1 && s.asRider >= 1 },
  { id: 'co2-10', icon: '🍃', name: '10 kg CO₂', desc: '10 kg CO₂ gemeinsam eingespart', test: (s) => s.co2Kg >= 10 },
  { id: 'co2-100', icon: '🌳', name: '100 kg CO₂', desc: '100 kg CO₂ gemeinsam eingespart', test: (s) => s.co2Kg >= 100 },
  { id: 'promoter-5', icon: '⭐', name: 'Empfehlenswert', desc: '5 Promotor-Bewertungen erhalten', test: (s) => s.promoters >= 5 },
  { id: 'streak-5', icon: '🔥', name: 'Promotor-Serie', desc: '5 Promotor-Bewertungen in Folge', test: (s) => s.bestStreak >= 5 },
];

const factorFor = (rating, factors) => factors[rating ? category(rating.score) : 'passive'];

/** Punkte, die userId für eine abgeschlossene Fahrt erhält. */
function ridePoints(ride, userId, factors) {
  if (ride.status !== 'completed' || !ride.final) return null;
  const received = userId === ride.riderId ? ride.npsByDriver : ride.npsByRider;
  const factor = factorFor(received, factors);
  const co2Kg = ride.final.co2SavedKg || 0;
  return {
    points: Math.round(factor * co2Kg),
    factor,
    co2Kg,
    category: received ? category(received.score) : null,
    rated: Boolean(received),
  };
}

function levelFor(points) {
  let i = 0;
  while (i + 1 < LEVELS.length && points >= LEVELS[i + 1].min) i++;
  const cur = LEVELS[i];
  const next = LEVELS[i + 1] || null;
  return {
    ...cur,
    rank: i + 1,
    next: next ? { ...next, missing: next.min - points } : null,
    progress: next ? Math.min(1, (points - cur.min) / (next.min - cur.min)) : 1,
  };
}

const monthKey = (iso) => String(iso || '').slice(0, 7);

/** Einmaliger Durchlauf über alle Fahrten → Punktestand aller Nutzer. */
function computeAll(rides, factors, { month } = {}) {
  const byUser = new Map();
  const get = (id) => {
    if (!byUser.has(id)) byUser.set(id, { total: 0, month: 0, rides: 0, asDriver: 0, asRider: 0, co2Kg: 0, promoters: 0, streak: 0, bestStreak: 0 });
    return byUser.get(id);
  };
  const done = rides.filter((r) => r.status === 'completed' && r.final).sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  for (const ride of done) {
    for (const userId of [ride.driverId, ride.riderId]) {
      const p = ridePoints(ride, userId, factors);
      const s = get(userId);
      s.total += p.points;
      if (month && monthKey(ride.completedAt) === month) s.month += p.points;
      s.rides += 1;
      s.co2Kg += p.co2Kg;
      if (userId === ride.driverId) s.asDriver += 1;
      else s.asRider += 1;
      if (p.category === 'promoter') {
        s.promoters += 1;
        s.streak += 1;
        s.bestStreak = Math.max(s.bestStreak, s.streak);
      } else if (p.rated) {
        s.streak = 0;
      }
    }
  }
  return byUser;
}

function summaryFor(stats) {
  const s = stats || { total: 0, month: 0, rides: 0, asDriver: 0, asRider: 0, co2Kg: 0, promoters: 0, bestStreak: 0 };
  return {
    points: s.total,
    monthPoints: s.month,
    level: levelFor(s.total),
    badges: BADGES.map(({ test, ...b }) => ({ ...b, earned: test(s) })),
    stats: { rides: s.rides, asDriver: s.asDriver, asRider: s.asRider, co2Kg: Math.round(s.co2Kg * 100) / 100, promoters: s.promoters, bestStreak: s.bestStreak },
  };
}

module.exports = { LEVELS, BADGES, ridePoints, levelFor, computeAll, summaryFor, monthKey };
