'use strict';

/**
 * Preismodell: private Fahrgemeinschaft – keine Fahrdienstleistung.
 *
 * Der Fahrer stellt Auto und Zeit, der Mitfahrer beteiligt sich mit rund zwei Dritteln an den
 * Energiekosten. Gerechnet wird mit DURCHSCHNITTSWERTEN (Ø-Kraftstoffpreis × Ø-Verbrauch), nicht mit
 * einem selbst gewählten Satz – so zahlen alle für dieselbe Strecke denselben fairen Preis.
 * Vergleichswerte (Nahverkehr, Energiekosten) helfen bei der Einordnung, sind aber keine Grenze.
 *
 *   Fahreranteil     = km × Kilometersatz × Personen + Anfahrt   → Fahrer
 *   Anfahrt          = Umweg-km zum Treffpunkt × Kilometersatz   → zu 100 % an den Fahrer
 *   Provision        = km × Provision je km × Personen           → Betreiber (abzüglich Rabatt)
 *   Umweltspende     = km × Spende je km × Personen              → Umweltschutz
 *   Rabatt           = Prozent der Provision bei Bezahlung aus Vorkasse-Guthaben
 *   Gesamt (Mitfahrer zahlt) = Fahreranteil + Provision − Rabatt + Umweltspende
 *
 * Provision und Spende fallen nur auf die gemeinsame Strecke an, nicht auf die Anfahrt.
 *
 * Alle Beträge in ganzen Cent.
 */

/** Vorkasse-Stufen: Guthaben beim Betreiber, Rabatt auf die Provision (Stufe 1 = je Fahrt zahlen). */
const PREPAID_PACKAGES = Object.freeze([
  Object.freeze({ id: 'p10', amountCents: 1000, discountPercent: 6 }),
  Object.freeze({ id: 'p20', amountCents: 2000, discountPercent: 10 }),
  Object.freeze({ id: 'p50', amountCents: 5000, discountPercent: 20 }),
]);

/** Durchschnittliche Energiekosten je km in Cent (Ø-Preis × Ø-Verbrauch). */
const energyCostPerKmCents = (pricing) =>
  pricing.avgFuelPriceCentsPerLiter ? (pricing.avgFuelPriceCentsPerLiter * pricing.avgConsumptionLitersPer100Km) / 100 : null;

/** Kilometersatz: rund zwei Drittel der durchschnittlichen Energiekosten (oder fest konfiguriert). */
function kmRateCents(pricing) {
  if (pricing.ratePerKmCents) return pricing.ratePerKmCents;
  return Math.max(1, Math.round((energyCostPerKmCents(pricing) * (pricing.riderEnergySharePercent ?? 67)) / 100));
}

/** Richtpreis eines ÖPNV-Einzeltickets für die Entfernung (null, wenn nicht konfiguriert). */
function transitFareCents(km, pricing) {
  const fares = pricing.transitFares;
  if (!fares || !fares.length) return null;
  const tier = fares.find((f) => km <= f.maxKm);
  if (tier) return tier.cents;
  const last = fares[fares.length - 1];
  return Math.round(last.cents + (km - last.maxKm) * (pricing.transitPerKmBeyondCents || 0));
}

/**
 * @param km                  abzurechnende km der gemeinsamen Strecke
 * @param seats               Personen
 * @param ratePerKmCents      bei der Buchung festgehaltener Satz (sonst der aktuelle)
 * @param pickupDetourKm      Anfahrt zum Treffpunkt
 * @param commissionDiscountPercent  Rabatt auf die Provision (Vorkasse-Stufe)
 */
function computeFare(km, pricing, seats = 1, { pickupDetourKm = 0, commissionDiscountPercent = 0, ratePerKmCents } = {}) {
  const rate = ratePerKmCents || kmRateCents(pricing);
  const energyPerKm = energyCostPerKmCents(pricing);
  const billedKm = Math.max(0, Math.round(km * 100) / 100);
  const detourKm = pickupDetourKm >= 0.1 ? Math.round(pickupDetourKm * 100) / 100 : 0;
  const driverFareCents = Math.round(billedKm * rate * seats);
  const detourCents = Math.round(detourKm * rate);
  const commissionFullCents = Math.round(billedKm * (pricing.commissionPerKmCents || 0) * seats);
  const discountPercent = Math.max(0, Math.min(100, commissionDiscountPercent || 0));
  const discountCents = Math.round((commissionFullCents * discountPercent) / 100);
  const commissionCents = commissionFullCents - discountCents;
  const donationCents = Math.round(billedKm * (pricing.donationPerKmCents || 0) * seats);
  // Fahrtkosten der gemeinsamen Strecke (ohne Anfahrt, vor Rabatt)
  const fareCents = driverFareCents + commissionFullCents + donationCents;
  const totalCents = fareCents + detourCents - discountCents;
  const transitTotal = transitFareCents(billedKm, pricing);
  const energyCents = energyPerKm ? Math.round((billedKm + detourKm) * energyPerKm) : null;
  return {
    km: billedKm,
    seats,
    ratePerKmCents: rate,
    commissionPerKmCents: pricing.commissionPerKmCents || 0,
    donationPerKmCents: pricing.donationPerKmCents || 0,
    totalPerKmCents: rate + (pricing.commissionPerKmCents || 0) + (pricing.donationPerKmCents || 0),
    driverFareCents,
    fareCents,
    commissionFullCents,
    commissionDiscountPercent: discountPercent,
    discountCents,
    commissionCents,
    platformCents: commissionCents,
    detourKm,
    detourCents,
    driverCents: driverFareCents + detourCents,
    donationCents,
    totalCents,
    // Orientierung für einen angemessenen Preis
    transitFareCents: transitTotal === null ? null : transitTotal * seats,
    savingsVsTransitPercent: transitTotal ? Math.round((1 - totalCents / (transitTotal * seats)) * 100) : null,
    energyCostCents: energyCents,
    // Anteil des Mitfahrers an den Energiekosten (was der Fahrer erhält)
    energySharePercent: energyCents ? Math.round(((driverFareCents + detourCents) / energyCents) * 100) : null,
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

/** Rabattstufe des Vorkasse-Guthabens: das älteste noch nicht verbrauchte Paket (FIFO). */
function prepaidDiscountPercent(user) {
  const lot = (user.prepaidLots || []).find((l) => l.remainingCents > 0);
  return lot ? lot.discountPercent : 0;
}

/** Verbraucht Vorkasse-Guthaben in der Reihenfolge der Käufe. */
function consumePrepaid(user, cents) {
  let rest = cents;
  for (const lot of user.prepaidLots || []) {
    if (rest <= 0) break;
    const take = Math.min(lot.remainingCents, rest);
    lot.remainingCents -= take;
    rest -= take;
  }
}

const prepaidRemainingCents = (user) => (user.prepaidLots || []).reduce((s, l) => s + l.remainingCents, 0);

module.exports = {
  PREPAID_PACKAGES,
  computeFare,
  co2SavedKg,
  billableKm,
  kmRateCents,
  energyCostPerKmCents,
  transitFareCents,
  prepaidDiscountPercent,
  consumePrepaid,
  prepaidRemainingCents,
};
