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
  pricing: {
    // Kostenteilung: Der Preis darf die Betriebskosten nicht übersteigen (§ 1 Abs. 2 Nr. 1 PBefG).
    ratePerKmCents: num('RATE_PER_KM_CENTS', 25),
    commissionPercent: num('COMMISSION_PERCENT', 10),
    donationCentsPerRide: num('DONATION_CENTS_PER_RIDE', 1),
    // Durchschnittliche CO2-Emission eines Pkw in g pro km (Umweltbundesamt, gerundet).
    co2GramsPerCarKm: num('CO2_GRAMS_PER_CAR_KM', 150),
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
