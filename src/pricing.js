'use strict';

/**
 * Preismodell: private Fahrgemeinschaft – keine Fahrdienstleistung.
 *
 * Der Fahrer stellt Auto und Fahrleistung und zahlt nichts. Der Mitfahrer übernimmt die
 * Fahrzeugkosten seiner Strecke; dazu kommt die Vermittlungsprovision des Betreibers.
 * Jede Buchung zahlt den normalen Tarif. Ermäßigt sind nur die 2. und jede weitere Person
 * DERSELBEN Buchung – sie steigen gemeinsam am gleichen Ort ein:
 *
 *                                     Fahrer   Provision   zusammen (je km und Person)
 *   Buchung (1. Person)                25 ct      5 ct       30 ct
 *   jede weitere Person der Buchung    12 ct      2 ct       14 ct
 *
 *   Anfahrt zum Treffpunkt  = Umweg-km × normaler Fahrersatz, einmal je Buchung → zu 100 % an den Fahrer
 *   Rabatt                  = Prozent der Provision bei Bezahlung aus Vorkasse-Guthaben
 *   Gesamt (Mitfahrer zahlt) = Fahreranteil + Provision − Rabatt + Anfahrt
 *
 * Die Provision fällt nur auf die gemeinsame Strecke an, nicht auf die Anfahrt.
 * Die Sätze werden bei der Buchung festgehalten (tariff), damit spätere Änderungen eine bestätigte
 * Fahrt nicht verändern. Alle Beträge in ganzen Cent.
 */

/** Vorkasse-Stufen: Guthaben beim Betreiber, Rabatt auf die Provision (Stufe 1 = je Fahrt zahlen). */
const PREPAID_PACKAGES = Object.freeze([
  Object.freeze({ id: 'p10', amountCents: 1000, discountPercent: 6 }),
  Object.freeze({ id: 'p20', amountCents: 2000, discountPercent: 10 }),
  Object.freeze({ id: 'p50', amountCents: 5000, discountPercent: 20 }),
]);

/** Durchschnittliche Energiekosten je km in Cent (Ø-Preis × Ø-Verbrauch), falls konfiguriert. */
const energyCostPerKmCents = (pricing) =>
  pricing.avgFuelPriceCentsPerLiter ? (pricing.avgFuelPriceCentsPerLiter * pricing.avgConsumptionLitersPer100Km) / 100 : null;

/** Satz an den Fahrer je Buchung (fest oder aus Ø-Energiekosten). */
function kmRateCents(pricing) {
  if (pricing.ratePerKmCents) return pricing.ratePerKmCents;
  return Math.max(1, Math.round((energyCostPerKmCents(pricing) * (pricing.riderEnergySharePercent ?? 67)) / 100));
}

/** Alle Sätze je km: je Buchung und für weitere Personen derselben Buchung (ohne Angabe wie die erste). */
function tariffOf(pricing) {
  const rate = kmRateCents(pricing);
  const commission = pricing.commissionPerKmCents || 0;
  return {
    ratePerKmCents: rate,
    commissionPerKmCents: commission,
    extraRatePerKmCents: pricing.extraRatePerKmCents ?? rate,
    extraCommissionPerKmCents: pricing.extraCommissionPerKmCents ?? commission,
  };
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
 * @param seats               Personen dieser Buchung (gemeinsamer Einstieg); ab der 2. Person ermäßigt
 * @param tariff              bei der Buchung festgehaltene Sätze (sonst die aktuellen)
 * @param pickupDetourKm      Anfahrt zum Treffpunkt
 * @param commissionDiscountPercent  Rabatt auf die Provision (Vorkasse-Stufe)
 */
function computeFare(km, pricing, seats = 1, { pickupDetourKm = 0, commissionDiscountPercent = 0, tariff } = {}) {
  const tf = tariff || tariffOf(pricing);
  const billedKm = Math.max(0, Math.round(km * 100) / 100);
  const detourKm = pickupDetourKm >= 0.1 ? Math.round(pickupDetourKm * 100) / 100 : 0;
  const first = Math.min(1, seats);
  const extra = seats - first; // weitere Personen derselben Buchung
  const perKm = (base, more) => base * first + more * extra; // Summe je km über alle Personen
  const driverPerKm = perKm(tf.ratePerKmCents, tf.extraRatePerKmCents);
  const commissionPerKm = perKm(tf.commissionPerKmCents, tf.extraCommissionPerKmCents);

  const driverFareCents = Math.round(billedKm * driverPerKm);
  const detourCents = Math.round(detourKm * tf.ratePerKmCents);
  const commissionFullCents = Math.round(billedKm * commissionPerKm);
  const discountPercent = Math.max(0, Math.min(100, commissionDiscountPercent || 0));
  const discountCents = Math.round((commissionFullCents * discountPercent) / 100);
  const commissionCents = commissionFullCents - discountCents;
  // Fahrtkosten der gemeinsamen Strecke (ohne Anfahrt, vor Rabatt)
  const fareCents = driverFareCents + commissionFullCents;
  const totalCents = fareCents + detourCents - discountCents;
  const transit = transitFareCents(billedKm, pricing);
  const ownCar = pricing.ownCarCostPerKmCents ? Math.round(billedKm * pricing.ownCarCostPerKmCents) : null;
  return {
    km: billedKm,
    seats,
    extraRiders: extra,
    tariff: tf,
    ratePerKmCents: tf.ratePerKmCents,
    driverPerKmCents: driverPerKm,
    commissionPerKmCents: commissionPerKm,
    totalPerKmCents: driverPerKm + commissionPerKm,
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
    totalCents,
    // Vergleichswerte (Orientierung): ÖPNV-Einzeltickets und eigenes Auto (Vollkosten) für alle Personen
    transitFareCents: transit === null ? null : transit * seats,
    savingsVsTransitPercent: transit ? Math.round((1 - totalCents / (transit * seats)) * 100) : null,
    ownCarCents: ownCar,
    savingsVsOwnCarPercent: ownCar ? Math.round((1 - totalCents / (ownCar * seats)) * 100) : null,
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
  tariffOf,
  energyCostPerKmCents,
  transitFareCents,
  prepaidDiscountPercent,
  consumePrepaid,
  prepaidRemainingCents,
};
