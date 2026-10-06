'use strict';

/**
 * Formale Prüfung der Führerscheindaten. Die Echtheitsprüfung erfolgt anschließend
 * durch den Betreiber im Admin-Bereich anhand der hochgeladenen Fotos
 * (oder produktiv durch einen Ident-Dienstleister, siehe README).
 */

// EU-Kartenführerschein (DE): 11 Zeichen, alphanumerisch.
const DE_LICENSE_PATTERN = /^[A-Z0-9]{11}$/;
const CAR_CLASSES = ['B', 'BE', 'C1', 'C1E', 'C', 'CE', 'D1', 'D1E', 'D', 'DE'];
const MIN_DRIVER_AGE = 18;

function validateLicense(input, now = new Date()) {
  const errors = [];
  const number = String(input.number || '').toUpperCase().replace(/\s+/g, '');
  const classes = (Array.isArray(input.classes) ? input.classes : String(input.classes || '').split(/[\s,;]+/))
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  const expiry = new Date(input.expiry);
  const birthdate = new Date(input.birthdate);
  const fullName = String(input.fullName || '').trim();

  if (!DE_LICENSE_PATTERN.test(number)) errors.push('Führerscheinnummer muss aus 11 Buchstaben/Ziffern bestehen (Feld 5).');
  if (fullName.length < 3) errors.push('Name laut Führerschein fehlt.');
  if (!classes.some((c) => CAR_CLASSES.includes(c))) errors.push('Für Pkw-Fahrten ist mindestens Klasse B erforderlich.');
  if (Number.isNaN(expiry.getTime())) errors.push('Ablaufdatum (Feld 4b) fehlt oder ist ungültig.');
  else if (expiry <= now) errors.push('Der Führerschein ist abgelaufen.');
  if (Number.isNaN(birthdate.getTime())) errors.push('Geburtsdatum fehlt oder ist ungültig.');
  else if (ageOn(birthdate, now) < MIN_DRIVER_AGE) errors.push(`Fahrer müssen mindestens ${MIN_DRIVER_AGE} Jahre alt sein.`);
  if (!isImageDataUrl(input.frontImage)) errors.push('Foto der Vorderseite fehlt.');
  if (!isImageDataUrl(input.backImage)) errors.push('Foto der Rückseite fehlt.');

  return {
    ok: errors.length === 0,
    errors,
    normalized: { number, classes, expiry: input.expiry, birthdate: input.birthdate, fullName },
  };
}

function ageOn(birthdate, now) {
  let age = now.getFullYear() - birthdate.getFullYear();
  const m = now.getMonth() - birthdate.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birthdate.getDate())) age--;
  return age;
}

function isImageDataUrl(v) {
  return typeof v === 'string' && /^data:image\/(png|jpe?g|webp|heic);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 7_000_000;
}

/** Ein Fahrer darf nur anbieten, wenn verifiziert und der Führerschein noch gültig ist. */
function canDrive(user, now = new Date()) {
  const lic = user && user.license;
  return Boolean(lic && lic.status === 'verified' && new Date(lic.expiry) > now);
}

module.exports = { validateLicense, canDrive, isImageDataUrl };
