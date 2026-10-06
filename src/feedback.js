'use strict';

/**
 * Feedback zum Lernen: Bei kritischen (0–6) und mittleren (7–8) Bewertungen können Gründe
 * („Aspekte“) gewählt und ein freiwilliger Text geschrieben werden.
 *
 * Der Bewertete sieht das Feedback nur GESAMMELT und ANONYM – erst ab MIN_ENTRIES Rückmeldungen,
 * Kommentare ohne Datum in zufälliger Reihenfolge. So lässt sich keine einzelne Fahrt zuordnen
 * (Schutz vor Gegenbewertungen).
 */

const crypto = require('node:crypto');

// Aspekte, wenn der Mitfahrer den Fahrer bewertet
const DRIVER_ASPECTS = [
  { id: 'cleanliness', label: 'Sauberkeit des Autos', icon: '🧽', tip: 'Kurz vor der Fahrt Müll entfernen, Sitze und Fußraum aussaugen, Fenster innen sauber halten.' },
  { id: 'condition', label: 'Zustand des Autos', icon: '🔧', tip: 'Reifen, Licht und Bremsen regelmäßig prüfen; klappernde Teile, Warnleuchten oder fehlende Gurte reparieren lassen.' },
  { id: 'driving', label: 'Fahrweise', icon: '🛣️', tip: 'Vorausschauend und gleichmäßig fahren, Abstand halten, Tempolimits beachten, Handy nur über Freisprechanlage.' },
  { id: 'interpersonal', label: 'Zwischenmenschliches', icon: '🤝', tip: 'Freundlich begrüßen, kurz nach Wünschen fragen (Temperatur, Musik, Gesprächsbedarf) und respektvoll bleiben.' },
  { id: 'punctuality', label: 'Pünktlichkeit', icon: '⏰', tip: 'Verspätungen früh ankündigen und die angezeigte Abholzeit realistisch halten.' },
  { id: 'route', label: 'Route / Umwege', icon: '🗺️', tip: 'Möglichst der bestätigten Route folgen; Änderungen vorher ansprechen. (Umwege zahlt der Mitfahrer ohnehin nicht.)' },
  { id: 'communication', label: 'Kommunikation / Treffpunkt', icon: '💬', tip: 'Treffpunkt klar beschreiben (Auto, Farbe, Ortskürzel) und bei Bedarf kurz Bescheid geben.' },
  { id: 'smell', label: 'Gerüche / Rauchen', icon: '👃', tip: 'Gut lüften, nicht im Auto rauchen und starke Duftbäume vermeiden.' },
  { id: 'music', label: 'Musik / Lautstärke', icon: '🔊', tip: 'Lautstärke moderat halten und fragen, ob Musik gewünscht ist.' },
  { id: 'comfort', label: 'Platz / Komfort / Temperatur', icon: '🌡️', tip: 'Ausreichend Platz für Gepäck schaffen und Temperatur sowie Sitzposition kurz abstimmen.' },
];

// Aspekte, wenn der Fahrer den Mitfahrer bewertet
const RIDER_ASPECTS = [
  { id: 'punctuality', label: 'Pünktlichkeit', icon: '⏰', tip: 'Ein paar Minuten vor der Abholzeit am Treffpunkt sein.' },
  { id: 'interpersonal', label: 'Zwischenmenschliches', icon: '🤝', tip: 'Freundlich und respektvoll bleiben – das Auto ist der private Raum des Fahrers.' },
  { id: 'cleanliness', label: 'Sauberkeit / Verhalten im Auto', icon: '🧽', tip: 'Keinen Müll zurücklassen, nicht mit schmutzigen Schuhen auf die Sitze, Essen vorher absprechen.' },
  { id: 'communication', label: 'Kommunikation / Treffpunkt', icon: '💬', tip: 'Am richtigen Treffpunkt warten und bei Änderungen rechtzeitig Bescheid geben.' },
  { id: 'luggage', label: 'Gepäck', icon: '🧳', tip: 'Größeres Gepäck vorher ankündigen.' },
];

const MIN_ENTRIES = 3;
const MAX_ASPECT_SCORE = 8; // Gründe bei 0–8 möglich (Kritiker und Passive)

const aspectsFor = (ratedRole) => (ratedRole === 'driver' ? DRIVER_ASPECTS : RIDER_ASPECTS);

/** Nur gültige, eindeutige Aspekt-IDs – und nur bei Bewertungen bis 8. */
function sanitizeAspects(input, score, ratedRole) {
  if (!(score <= MAX_ASPECT_SCORE) || !Array.isArray(input)) return [];
  const valid = new Set(aspectsFor(ratedRole).map((a) => a.id));
  return [...new Set(input.filter((id) => valid.has(id)))];
}

/** Gesammeltes, anonymes Feedback für den Bewerteten. */
function summarize(ratings, ratedRole, { seed = '' } = {}) {
  const withFeedback = ratings.filter((r) => r.score <= MAX_ASPECT_SCORE && ((r.aspects && r.aspects.length) || r.comment));
  const ready = withFeedback.length >= MIN_ENTRIES;
  const counts = new Map();
  for (const r of withFeedback) for (const id of r.aspects || []) counts.set(id, (counts.get(id) || 0) + 1);
  const aspects = aspectsFor(ratedRole)
    .map((a) => ({ ...a, count: counts.get(a.id) || 0 }))
    .filter((a) => a.count > 0)
    .sort((a, b) => b.count - a.count);
  // Kommentare in stabiler, aber zufälliger Reihenfolge ohne Datum
  const comments = withFeedback
    .filter((r) => r.comment)
    .map((r) => ({ text: r.comment, key: crypto.createHash('sha256').update(seed + r.at + r.comment).digest('hex') }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((c) => c.text);
  return {
    minEntries: MIN_ENTRIES,
    entries: withFeedback.length,
    ready,
    ratingsTotal: ratings.length,
    aspects: ready ? aspects : [],
    comments: ready ? comments : [],
  };
}

/** Anteil der Bewertungen, in denen ein Aspekt genannt wurde (für Filter wie „sichere Fahrweise“). */
function aspectShare(ratings, id) {
  if (!ratings.length) return 0;
  return ratings.filter((r) => (r.aspects || []).includes(id)).length / ratings.length;
}

module.exports = { DRIVER_ASPECTS, RIDER_ASPECTS, MIN_ENTRIES, MAX_ASPECT_SCORE, aspectsFor, sanitizeAspects, summarize, aspectShare };
