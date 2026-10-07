'use strict';

/**
 * Filter des Mitfahrers: Kriterien, die der Fahrer erfüllen muss.
 * Jeder Filter liefert true (passt) oder false (Fahrer wird ausgeblendet).
 */

const { npsOf } = require('./nps');
const { aspectShare } = require('./feedback');

const SAFE_DRIVING_MAX_SHARE = 0.1; // höchstens 10 % der Bewertungen mit Kritik an der Fahrweise
const SAFE_DRIVING_MIN_RATINGS = 3;

const LABELS = {
  minNps: 'Mindest-NPS',
  nonSmoker: 'Nichtraucher',
  pets: 'Tiere erlaubt',
  chat: 'Unterhaltung',
  music: 'Musik',
  language: 'Sprache',
  mfa: '2FA-gesichert',
  identity: 'Identität geprüft',
  safeDriving: 'Sichere Fahrweise',
  maxEtaMin: 'Wartezeit',
  verifiedOnly: 'Bewertete Fahrer',
};

function sanitizeFilters(input = {}) {
  const f = {};
  const nps = Number(input.minNps);
  if (input.minNps !== undefined && input.minNps !== '' && Number.isFinite(nps)) f.minNps = Math.max(-100, Math.min(100, Math.round(nps)));
  if (input.includeNew === false) f.includeNew = false;
  for (const k of ['nonSmoker', 'pets', 'mfa', 'identity', 'safeDriving']) if (input[k] === true) f[k] = true;
  if (['quiet', 'talkative'].includes(input.chat)) f.chat = input.chat;
  if (input.music === 'quiet') f.music = 'quiet';
  if (typeof input.language === 'string' && input.language) f.language = input.language.slice(0, 30);
  const eta = Number(input.maxEtaMin);
  if (input.maxEtaMin !== undefined && input.maxEtaMin !== '' && Number.isFinite(eta) && eta > 0) f.maxEtaMin = Math.round(eta);
  return f;
}

/**
 * Prüft einen Fahrer gegen die Filter. Gibt die Liste der nicht erfüllten Kriterien zurück (leer = passt).
 * receivedRatings: Bewertungen, die der Fahrer von Mitfahrern erhalten hat (für NPS/Fahrweise).
 */
function failedCriteria(filters, { driver, match, receivedRatings }) {
  const failed = [];
  const prof = (driver && driver.profile) || {};
  const prefs = { smoking: 'nein', pets: 'nach Absprache', music: 'egal', chat: 'egal', ...(prof.preferences || {}) };
  const languages = prof.languages || ['Deutsch'];
  const nps = npsOf(driver);

  if (filters.minNps !== undefined) {
    if (nps === null ? filters.includeNew === false : nps < filters.minNps) failed.push('minNps');
  } else if (filters.includeNew === false && nps === null) {
    failed.push('minNps');
  }
  if (filters.nonSmoker && prefs.smoking !== 'nein') failed.push('nonSmoker');
  if (filters.pets && prefs.pets === 'nein') failed.push('pets');
  if (filters.chat === 'quiet' && prefs.chat === 'gerne') failed.push('chat');
  if (filters.chat === 'talkative' && prefs.chat === 'lieber ruhig') failed.push('chat');
  if (filters.music === 'quiet' && prefs.music === 'gerne') failed.push('music');
  if (filters.language && !languages.includes(filters.language)) failed.push('language');
  if (filters.mfa && !(driver.mfa && driver.mfa.enabled)) failed.push('mfa');
  if (filters.identity && !(driver.identity && driver.identity.status === 'verified')) failed.push('identity');
  if (filters.safeDriving && receivedRatings.length >= SAFE_DRIVING_MIN_RATINGS && aspectShare(receivedRatings, 'driving') > SAFE_DRIVING_MAX_SHARE) failed.push('safeDriving');
  if (filters.maxEtaMin && match.etaMin > filters.maxEtaMin) failed.push('maxEtaMin');
  return failed;
}

module.exports = { LABELS, sanitizeFilters, failedCriteria, SAFE_DRIVING_MAX_SHARE };
