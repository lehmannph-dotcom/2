'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Einfache .env-Unterstützung ohne Abhängigkeiten.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' ? v : fallback;
};

module.exports = {
  port: num('PORT', 3000),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  adminEmail: (process.env.ADMIN_EMAIL || '').toLowerCase(),
  // Nur setzen, wenn ein Reverse-Proxy davorsteht: dann gelten X-Forwarded-For/-Proto
  // (Client-IP für den Brute-Force-Schutz, HTTPS-Erkennung). Sonst wären sie fälschbar.
  trustProxy: ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY || '').toLowerCase()),
  // Demo-Guthaben ohne echte Zahlung – im Livebetrieb abschalten (ALLOW_DEMO_TOPUP=0).
  allowDemoTopup: !['0', 'false', 'no'].includes(String(process.env.ALLOW_DEMO_TOPUP || '1').toLowerCase()),
  pricing: {
    // Private Fahrgemeinschaft, siehe src/pricing.js: Der Mitfahrer beteiligt sich mit rund zwei
    // Dritteln an den Energiekosten. Daraus ergibt sich der empfohlene Kilometersatz; Fahrer können
    // ihn anpassen – höchstens bis zu den Betriebskosten (§ 1 Abs. 2 Nr. 1 PBefG).
    energyCostPerKmCents: num('ENERGY_COST_PER_KM_CENTS', 12), // Kraftstoff/Strom je km (Richtwert)
    riderEnergySharePercent: num('RIDER_ENERGY_SHARE_PERCENT', 67),
    costPerKmCents: num('COST_PER_KM_CENTS', 30), // Betriebskosten je km = Obergrenze für den Satz
    ...(process.env.RATE_PER_KM_CENTS ? { ratePerKmCents: num('RATE_PER_KM_CENTS', 8) } : {}),
    commissionPercent: num('COMMISSION_PERCENT', 10),  // im Preis enthalten
    donationCentsPerRide: num('DONATION_CENTS_PER_RIDE', 1), // aus der Provision gezahlt
    // Vergleich mit dem Nahverkehr (nur Orientierung, keine Grenze):
    transitDiscountPercent: num('TRANSIT_DISCOUNT_PERCENT', 30),
    // Richtwerte Einzelticket in deutschen Ballungsräumen (2026) – an den regionalen Tarif anpassen.
    transitFares: [
      { maxKm: 3, cents: num('TRANSIT_SHORT_CENTS', 260) },   // Kurzstrecke
      { maxKm: 20, cents: num('TRANSIT_CITY_CENTS', 380) },   // Einzelfahrt Stadtgebiet
      { maxKm: 45, cents: num('TRANSIT_REGION_CENTS', 500) }, // Stadt und Umland
    ],
    transitPerKmBeyondCents: num('TRANSIT_PER_KM_BEYOND_CENTS', 18), // Regionalverkehr darüber hinaus
    // Durchschnittliche CO2-Emission eines Pkw in g pro km (Umweltbundesamt, gerundet).
    co2GramsPerCarKm: num('CO2_GRAMS_PER_CAR_KM', 150),
  },
  // Identitätsprüfung. 'demo' simuliert den Ablauf; für den Livebetrieb einen Anbieter anbinden
  // (POSTIDENT der Deutschen Post, Online-Ausweis/eID, IDnow, Veriff) – siehe README.
  identity: {
    provider: process.env.IDENT_PROVIDER || 'demo',
    // Gemeinsames Geheimnis für signierte Ergebnis-Meldungen des Anbieters (Webhook)
    webhookSecret: process.env.IDENT_WEBHOOK_SECRET || '',
    // Adresse, an die der Nutzer zum Anbieter weitergeleitet wird ({caseId} wird ersetzt)
    startUrl: process.env.IDENT_START_URL || '',
  },
  // Gamification: Punkte = Faktor (NPS-Wert der Bewertung durch den anderen) × CO₂-Ersparnis in kg
  points: {
    // Faktor, solange (noch) keine Bewertung vorliegt – entspricht einer passiven 7.
    unratedFactor: num('POINTS_FACTOR_UNRATED', 7),
  },
  // Nutzungsbedingungen: Sperre bei zu hoher Fahrtabbruchsquote (Entscheidung durch den Betreiber)
  abortPolicy: {
    maxQuote: num('ABORT_QUOTE_LIMIT', 20),  // in Prozent
    minRides: num('ABORT_MIN_RIDES', 5),     // erst ab so vielen Fahrten in der Rolle
  },
  // Funfacts: Gruppe erst ab so vielen Fahrern/Bewertungen anzeigen (kein Rückschluss auf Einzelne)
  funfacts: {
    minDrivers: num('FUNFACTS_MIN_DRIVERS', 2),
    minRatings: num('FUNFACTS_MIN_RATINGS', 3),
  },
  rides: {
    // Bestätigt nur eine Seite das Fahrtende, gilt die Fahrt nach dieser Frist als bestätigt.
    autoConfirmHours: num('AUTO_CONFIRM_HOURS', 24),
  },
  matching: {
    maxDetourKm: num('MAX_DETOUR_KM', 3),
    maxResults: num('MAX_MATCH_RESULTS', 10),
  },
};
