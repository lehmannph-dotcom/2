'use strict';

/**
 * Abrechnung nach gefahrenen Kilometern.
 *
 *   Fahrpreis        = km der gemeinsamen Strecke × Kilometersatz × Personen
 *   Provision        = Fahrpreis × Provisionssatz          → Betreiber
 *   Anfahrt          = Umweg-km zum Treffpunkt × Kilometersatz → zu 100 % an den Fahrer (keine Provision)
 *   Fahreranteil     = Fahrpreis − Provision + Anfahrt     → Fahrer
 *   Spende           = fester Betrag pro Fahrt             → Umweltschutz
 *   Gesamt (Mitfahrer zahlt) = Fahrpreis + Anfahrt + Spende
 *
 * Die Anfahrt wird einmal pro Fahrt berechnet (nicht pro Person) und spart kein CO₂ –
 * sie zählt daher nicht zur CO₂-Ersparnis.
 * Alle Beträge in ganzen Cent, um Rundungsfehler zu vermeiden.
 */
function computeFare(km, pricing, seats = 1, { pickupDetourKm = 0 } = {}) {
  const billedKm = Math.max(0, Math.round(km * 100) / 100);
  const detourKm = pickupDetourKm >= 0.1 ? Math.round(pickupDetourKm * 100) / 100 : 0;
  const fareCents = Math.round(billedKm * pricing.ratePerKmCents * seats);
  const commissionCents = Math.round((fareCents * pricing.commissionPercent) / 100);
  const detourCents = Math.round(detourKm * pricing.ratePerKmCents);
  const driverCents = fareCents - commissionCents + detourCents;
  const donationCents = fareCents > 0 ? pricing.donationCentsPerRide : 0;
  return {
    km: billedKm,
    seats,
    ratePerKmCents: pricing.ratePerKmCents,
    fareCents,
    commissionCents,
    detourKm,
    detourCents,
    driverCents,
    donationCents,
    totalCents: fareCents + detourCents + donationCents,
    co2SavedKg: co2SavedKg(billedKm * seats, pricing),
  };
}

/** CO2-Ersparnis: Jeder mitgenommene Fahrgast ersetzt eine eigene Pkw-Fahrt. */
function co2SavedKg(passengerKm, pricing) {
  return Math.round(passengerKm * pricing.co2GramsPerCarKm) / 1000;
}

/**
 * Bestimmt die abzurechnenden Kilometer.
 *
 * Mit dem Fahrtantritt (Einsteigen) wird der Preis der geplanten Route fällig – auch wenn die
 * Fahrt früher endet. So lohnt es sich nicht, dass Fahrer und Mitfahrer sich absprechen und die
 * Fahrt vorzeitig beenden. Umwege zahlt der Mitfahrer nie (höchstens die geplante Route).
 *
 * Ausnahme: begründeter Fahrtabbruch – dann wird nur die bis dahin gefahrene Strecke (GPS)
 * berechnet, höchstens die geplante Route.
 */
function billableKm(plannedKm, trackedKm, { aborted = false } = {}) {
  if (!aborted) return { km: plannedKm, basis: 'geplant' };
  return { km: Math.min(Math.max(trackedKm || 0, 0), plannedKm), basis: 'abbruch' };
}

module.exports = { computeFare, co2SavedKg, billableKm };
