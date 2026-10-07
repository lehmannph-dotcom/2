'use strict';

/**
 * Profile von Fahrern und Mitfahrern – mit Privatsphäre-Einstellungen.
 * Grundsatz (Privacy by Default, Art. 25 DSGVO): Andere sehen nur, was für die
 * gemeinsame Fahrt nötig ist; Telefonnummer nur bei bestätigter Buchung und nur mit Freigabe.
 */

const { summary: npsSummary } = require('./nps');
const { normalizeRegion, regionName } = require('./plates');

const BRANDS = ['Audi', 'BMW', 'BYD', 'Citroën', 'Cupra', 'Dacia', 'Fiat', 'Ford', 'Honda', 'Hyundai', 'Jeep', 'Kia', 'Mazda', 'Mercedes-Benz', 'MG', 'Mini', 'Mitsubishi',
  'Nissan', 'Opel', 'Peugeot', 'Polestar', 'Porsche', 'Renault', 'Seat', 'Škoda', 'Smart', 'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'Volvo', 'VW', 'Andere'];

// Gesprochene Sprachen (Profilangabe und Filter). Gespeichert wird der deutsche Name, angezeigt übersetzt.
const LANGUAGES = ['Deutsch', 'Englisch', 'Chinesisch', 'Hindi', 'Spanisch', 'Arabisch', 'Französisch', 'Bengalisch', 'Portugiesisch', 'Russisch',
  'Indonesisch', 'Italienisch', 'Türkisch', 'Polnisch', 'Ukrainisch'];

/**
 * Sprachen der Oberfläche: Deutsch (Ausgangssprache) und die 10 meistgesprochenen Sprachen
 * weltweit (Erst- und Zweitsprecher). Die Übersetzungen liegen in public/i18n/<code>.json.
 */
const UI_LANGUAGES = [
  { code: 'de', name: 'Deutsch', locale: 'de-DE' },
  { code: 'en', name: 'English', locale: 'en-GB' },
  { code: 'zh', name: '中文（简体）', locale: 'zh-CN' },
  { code: 'hi', name: 'हिन्दी', locale: 'hi-IN' },
  { code: 'es', name: 'Español', locale: 'es-ES' },
  { code: 'ar', name: 'العربية', locale: 'ar-u-nu-latn', dir: 'rtl' },
  { code: 'fr', name: 'Français', locale: 'fr-FR' },
  { code: 'bn', name: 'বাংলা', locale: 'bn-BD' },
  { code: 'pt', name: 'Português', locale: 'pt-BR' },
  { code: 'ru', name: 'Русский', locale: 'ru-RU' },
  { code: 'id', name: 'Bahasa Indonesia', locale: 'id-ID' },
];
const UI_LANGUAGE_CODES = UI_LANGUAGES.map((l) => l.code);
const PREFERENCES = {
  smoking: ['nein', 'ja'],
  pets: ['nein', 'nach Absprache', 'ja'],
  music: ['egal', 'gerne', 'lieber leise'],
  chat: ['egal', 'gerne', 'lieber ruhig'],
};
const PHONE_VISIBILITY = ['never', 'booked'];

const DEFAULT_PRIVACY = Object.freeze({
  showFullName: false,   // sonst „Vorname N.“
  showPhoto: true,
  phoneVisibility: 'never',
  showStats: true,       // Anzahl Fahrten, CO₂, Mitglied seit, Punkte/Level
  showOnLeaderboard: false, // Bestenliste nur mit ausdrücklicher Einwilligung
  showGuestbook: true,   // Gästebuch (anonyme positive Einträge von Mitfahrern) im Profil zeigen
});

const DEFAULT_PROFILE = Object.freeze({
  bio: '',
  phone: '',
  photo: null,
  languages: ['Deutsch'],
  uiLanguage: '', // leer = automatisch (Browsersprache)
  preferences: { smoking: 'nein', pets: 'nach Absprache', music: 'egal', chat: 'egal' },
  vehicle: { brand: '', model: '', color: '', plateRegion: '' },
});

const privacyOf = (u) => ({ ...DEFAULT_PRIVACY, ...(u.privacy || {}) });
const profileOf = (u) => ({ ...DEFAULT_PROFILE, ...(u.profile || {}), preferences: { ...DEFAULT_PROFILE.preferences, ...((u.profile || {}).preferences || {}) } });

/** Anzeigename gemäß Privatsphäre: „Doris Fahrer“ oder „Doris F.“ */
function displayName(user, viewer) {
  if (!user) return '?';
  if (user.deleted) return 'Gelöschtes Konto';
  if (viewer && viewer.id === user.id) return user.name;
  if (privacyOf(user).showFullName) return user.name;
  const parts = user.name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}

function sanitizeProfile(input, current) {
  const errors = [];
  const p = profileOf({ profile: current });
  const out = { ...p };
  if (input.bio !== undefined) out.bio = String(input.bio).trim().slice(0, 500);
  if (input.phone !== undefined) {
    const phone = String(input.phone).trim();
    if (phone && !/^\+?[0-9 ()/-]{6,20}$/.test(phone)) errors.push('Telefonnummer ist ungültig.');
    out.phone = phone;
  }
  if (input.languages !== undefined) {
    out.languages = (Array.isArray(input.languages) ? input.languages : []).filter((l) => LANGUAGES.includes(l)).slice(0, 6);
  }
  if (input.uiLanguage !== undefined) {
    const code = String(input.uiLanguage || '');
    if (code && !UI_LANGUAGE_CODES.includes(code)) errors.push('Diese Sprache wird nicht unterstützt.');
    else out.uiLanguage = code;
  }
  if (input.preferences) {
    for (const [k, allowed] of Object.entries(PREFERENCES)) {
      if (input.preferences[k] !== undefined) {
        if (!allowed.includes(input.preferences[k])) errors.push(`Ungültige Angabe: ${k}`);
        else out.preferences = { ...out.preferences, [k]: input.preferences[k] };
      }
    }
  }
  if (input.vehicle) {
    const brand = String(input.vehicle.brand || '');
    if (brand && !BRANDS.includes(brand)) errors.push('Bitte eine Automarke aus der Liste wählen.');
    const plateRegion = normalizeRegion(input.vehicle.plateRegion);
    if (plateRegion === null) errors.push('Ortskürzel des Kennzeichens: 1–3 Buchstaben, z. B. B, HH oder MÜ.');
    out.vehicle = {
      brand: BRANDS.includes(brand) ? brand : '',
      plateRegion: plateRegion || '',
      model: String(input.vehicle.model || '').trim().slice(0, 60),
      color: String(input.vehicle.color || '').trim().slice(0, 30),
    };
  }
  return { errors, profile: out };
}

function sanitizePrivacy(input, current) {
  const out = { ...DEFAULT_PRIVACY, ...(current || {}) };
  for (const k of ['showFullName', 'showPhoto', 'showStats', 'showOnLeaderboard', 'showGuestbook']) if (input[k] !== undefined) out[k] = Boolean(input[k]);
  if (input.phoneVisibility !== undefined) out.phoneVisibility = PHONE_VISIBILITY.includes(input.phoneVisibility) ? input.phoneVisibility : 'never';
  return out;
}

/**
 * Öffentliche Profilansicht für einen anderen Nutzer.
 * hasBooking: Betrachter und Profilinhaber haben eine bestätigte/laufende gemeinsame Fahrt.
 */
function publicProfile(user, viewer, { hasBooking = false, stats = {}, game = null } = {}) {
  const priv = privacyOf(user);
  const prof = profileOf(user);
  const self = viewer && viewer.id === user.id;
  const lic = user.license;
  return {
    id: user.id,
    name: displayName(user, viewer),
    bio: prof.bio,
    languages: prof.languages,
    preferences: prof.preferences,
    vehicle: { ...prof.vehicle, regionName: regionName(prof.vehicle.plateRegion) },
    hasPhoto: Boolean(prof.photo && (priv.showPhoto || self)),
    phone: prof.phone && (self || (hasBooking && priv.phoneVisibility === 'booked')) ? prof.phone : null,
    nps: npsSummary(user),
    verifiedDriver: Boolean(lic && lic.status === 'verified' && new Date(lic.expiry) > new Date()),
    mfaEnabled: Boolean(user.mfa && user.mfa.enabled),
    stats: priv.showStats || self
      ? {
          memberSince: user.createdAt.slice(0, 7),
          ridesAsDriver: stats.asDriver || 0,
          ridesAsRider: stats.asRider || 0,
          co2SavedKg: Math.round((user.co2SavedKg || 0) * 10) / 10,
          points: game ? game.points : 0,
          level: game ? { name: game.level.name, rank: game.level.rank } : null,
          badges: game ? game.badges.filter((b) => b.earned).map((b) => ({ name: b.name })) : [],
        }
      : null,
  };
}

module.exports = {
  BRANDS,
  LANGUAGES,
  UI_LANGUAGES,
  UI_LANGUAGE_CODES,
  PREFERENCES,
  DEFAULT_PRIVACY,
  privacyOf,
  profileOf,
  displayName,
  sanitizeProfile,
  sanitizePrivacy,
  publicProfile,
};
