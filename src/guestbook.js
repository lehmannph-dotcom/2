'use strict';

/**
 * Gästebuch bei Fahrern: Mitfahrer können nach längeren Fahrten (über 1 Stunde oder über 100 km)
 * freiwillig und anonym ein positives Erlebnis teilen.
 *
 * Anonymität: Öffentlich erscheinen nur Text, Monat und die Art der langen Fahrt –
 * kein Name, kein Datum, keine Strecke. Intern wird der Verfasser gespeichert, damit er
 * seinen Eintrag löschen kann und pro Fahrt nur ein Eintrag möglich ist.
 */

const MIN_KM = 100;
const MIN_MINUTES = 60;
const MIN_SCORE = 7; // nur positive Erlebnisse: Bewertung 7–10
const MIN_LENGTH = 10;
const MAX_LENGTH = 500;

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** Dauer der gemeinsamen Fahrt in Minuten (Einsteigen bis Absetzen). */
function rideMinutes(ride) {
  if (!ride.pickedUpAt || !ride.droppedOffAt) return 0;
  return (new Date(ride.droppedOffAt) - new Date(ride.pickedUpAt)) / 60000;
}

/** Gilt die Fahrt als lang? Gemessen (GPS/Zeit) oder laut geplanter Route. */
function longRideKind(ride) {
  const km = Math.max(ride.plannedKm || 0, ride.trackedKm || 0);
  if (km >= MIN_KM) return 'km';
  const minutes = Math.max(rideMinutes(ride), (ride.plannedRoute && ride.plannedRoute.durationMin) || 0);
  if (minutes >= MIN_MINUTES) return 'hour';
  return null;
}

/** Darf der Mitfahrer zu dieser Fahrt einen Eintrag schreiben? Gibt den Grund zurück, falls nicht. */
function eligibility(ride, userId) {
  if (ride.riderId !== userId) return 'Nur Mitfahrer können ins Gästebuch schreiben.';
  if (ride.status !== 'completed') return 'Die Fahrt ist noch nicht abgeschlossen.';
  if (!longRideKind(ride)) return `Das Gästebuch ist für Fahrten über ${MIN_MINUTES / 60} Stunde oder über ${MIN_KM} km.`;
  if (!ride.npsByRider || ride.npsByRider.score < MIN_SCORE) return 'Das Gästebuch ist für positive Erlebnisse (Bewertung 7–10).';
  return null;
}

/** Prüft den Text: Länge, keine Kontaktdaten oder Links (Anonymität, Spam). */
function validateText(input) {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  const errors = [];
  if (text.length < MIN_LENGTH) errors.push(`Bitte mindestens ${MIN_LENGTH} Zeichen schreiben.`);
  if (text.length > MAX_LENGTH) errors.push(`Höchstens ${MAX_LENGTH} Zeichen.`);
  if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(de|com|net|org|eu|io|info)\b)/i.test(text)) errors.push('Bitte keine Links.');
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) errors.push('Bitte keine E-Mail-Adressen – der Eintrag ist anonym.');
  if (/(\+?\d[\d\s/()-]{6,}\d)/.test(text)) errors.push('Bitte keine Telefonnummern – der Eintrag ist anonym.');
  return { text, errors };
}

function publicEntry(entry) {
  const [y, m] = entry.period.split('-');
  return {
    id: entry.id,
    text: entry.text,
    when: `${MONTHS[Number(m) - 1]} ${y}`,
    period: entry.period, // JJJJ-MM – die Oberfläche formatiert den Monat in der gewählten Sprache
    kind: entry.kind === 'km' ? `Fahrt über ${MIN_KM} km` : 'Fahrt über 1 Stunde',
  };
}

module.exports = { MIN_KM, MIN_MINUTES, MIN_SCORE, MAX_LENGTH, longRideKind, eligibility, validateText, publicEntry, rideMinutes };
