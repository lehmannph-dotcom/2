'use strict';

/**
 * Abrechnung nach gefahrenen Kilometern.
 *
 *   Fahrpreis   = km × Kilometersatz
 *   Provision   = Fahrpreis × Provisionssatz   → Betreiber
 *   Fahreranteil = Fahrpreis − Provision        → Fahrer
 *   Spende      = fester Betrag pro Fahrt       → Umweltschutz
 *   Gesamt (Mitfahrer zahlt) = Fahrpreis + Spende
 *
 * Alle Beträge in ganzen Cent, um Rundungsfehler zu vermeiden.
 */
function computeFare(km, pricing, seats = 1) {
  const billedKm = Math.max(0, Math.round(km * 100) / 100);
  const fareCents = Math.round(billedKm * pricing.ratePerKmCents * seats);
  const commissionCents = Math.round((fareCents * pricing.commissionPercent) / 100);
  const driverCents = fareCents - commissionCents;
  const donationCents = fareCents > 0 ? pricing.donationCentsPerRide : 0;
  return {
    km: billedKm,
    seats,
    ratePerKmCents: pricing.ratePerKmCents,
    fareCents,
    commissionCents,
    driverCents,
    donationCents,
    totalCents: fareCents + donationCents,
    co2SavedKg: co2SavedKg(billedKm * seats, pricing),
  };
}

/** CO2-Ersparnis: Jeder mitgenommene Fahrgast ersetzt eine eigene Pkw-Fahrt. */
function co2SavedKg(passengerKm, pricing) {
  return Math.round(passengerKm * pricing.co2GramsPerCarKm) / 1000;
}

/**
 * Bestimmt die abzurechnenden Kilometer.
 * Gemessene GPS-Kilometer werden bevorzugt, aber auf plannedKm × Faktor begrenzt,
 * damit Mitfahrer nicht für Umwege des Fahrers zahlen.
 */
function billableKm(plannedKm, trackedKm, pricing) {
  if (!(trackedKm > 0.2)) return plannedKm;
  return Math.min(trackedKm, plannedKm * pricing.maxBilledKmFactor);
}

const formatEuro = (cents) => (cents / 100).toFixed(2).replace('.', ',') + ' €';

module.exports = { computeFare, co2SavedKg, billableKm, formatEuro };
