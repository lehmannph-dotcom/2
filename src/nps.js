'use strict';

/**
 * Bewertung nach Net-Promoter-Score-Logik.
 *
 * Frage: „Wie wahrscheinlich ist es, dass du <Name> weiterempfiehlst?“ – Skala 0 bis 10.
 *   9–10  Promotor
 *   7–8   Passiver
 *   0–6   Kritiker
 *   NPS = % Promotoren − % Kritiker  (−100 … +100)
 */

const PRIOR_PASSIVES = 3;

function category(score) {
  if (score >= 9) return 'promoter';
  if (score >= 7) return 'passive';
  return 'detractor';
}

function parseScore(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : null;
}

const countsOf = (user) => ({
  promoters: (user && user.nps && user.nps.promoters) || 0,
  passives: (user && user.nps && user.nps.passives) || 0,
  detractors: (user && user.nps && user.nps.detractors) || 0,
});

function addScore(user, score) {
  const c = countsOf(user);
  c[category(score) + 's'] += 1;
  user.nps = c;
}

/** Klassischer NPS (ganzzahlig) oder null ohne Bewertungen. */
function npsOf(user) {
  const c = countsOf(user);
  const n = c.promoters + c.passives + c.detractors;
  return n ? Math.round(((c.promoters - c.detractors) / n) * 100) : null;
}

/**
 * Geglätteter NPS fürs Matching: wenige Bewertungen sollen nicht sofort ±100 ergeben.
 * Dazu zählen wir drei gedachte „passive“ Bewertungen hinzu (neue Fahrer starten bei 0).
 */
function smoothedNps(user) {
  const c = countsOf(user);
  const n = c.promoters + c.passives + c.detractors + PRIOR_PASSIVES;
  return ((c.promoters - c.detractors) / n) * 100;
}

function summary(user) {
  const c = countsOf(user);
  return { score: npsOf(user), count: c.promoters + c.passives + c.detractors, ...c };
}

module.exports = { category, parseScore, addScore, npsOf, smoothedNps, summary };
