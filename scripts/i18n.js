'use strict';

/**
 * Übersetzungen der Oberfläche pflegen.
 *
 *   node scripts/i18n.js extract   sammelt alle deutschen Ausgangstexte in public/i18n/_source.json
 *   node scripts/i18n.js check     prüft jede Übersetzung auf fehlende Texte, Platzhalter und HTML
 *
 * Quellen: t('…'), tn(n, '…', '…') und N_('…') in public/app.js, data-i18n in index.html sowie
 * Meldungen und Bezeichnungen des Servers (der Server antwortet deutsch, die Oberfläche übersetzt).
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const I18N_DIR = path.join(ROOT, 'public', 'i18n');
const SOURCE_FILE = path.join(I18N_DIR, '_source.json');

const LIT = String.raw`'(?:[^'\\]|\\.)*'`;
// Eigener Quelltext, daher darf das String-Literal per Function ausgewertet werden.
const unquote = (lit) => Function(`"use strict"; return (${lit});`)();
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function extract({ write = true } = {}) {
  const keys = new Map(); // Schlüssel → { one, other } bei Pluralformen, sonst null
  const add = (s, plural = null) => {
    if (typeof s !== 'string' || !s.trim()) return;
    if (plural || !keys.has(s)) keys.set(s, plural);
  };

  // 1. Oberfläche
  const app = readSrc('public/app.js');
  for (const m of app.matchAll(new RegExp(String.raw`\b(?:t|N_)\(\s*(${LIT})`, 'g'))) add(unquote(m[1]));
  for (const m of app.matchAll(new RegExp(String.raw`\btn\([^,()]+(?:\([^()]*\))?[^,()]*,\s*(${LIT})\s*,\s*(${LIT})`, 'g'))) {
    const one = unquote(m[1]);
    const other = unquote(m[2]);
    add(other, { one, other });
  }
  const html = readSrc('public/index.html');
  for (const m of html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)) add(m[1]);

  // 2. Server: Meldungen (Status + Text), Formularfehler, Fehler der Routensuche, Buchungstexte
  for (const file of fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js'))) {
    const src = readSrc(`src/${file}`);
    for (const m of src.matchAll(new RegExp(String.raw`\b\d{3},\s*(${LIT})`, 'g'))) add(unquote(m[1]));
    for (const m of src.matchAll(new RegExp(String.raw`errors\.push\((${LIT})\)`, 'g'))) add(unquote(m[1]));
    for (const m of src.matchAll(new RegExp(String.raw`new Error\((${LIT})\)`, 'g'))) {
      const msg = unquote(m[1]);
      if (/[äöüß]|\s/.test(msg)) add(msg);
    }
    for (const m of src.matchAll(new RegExp(String.raw`\bbook\([^;]*,\s*(${LIT})\);`, 'g'))) add(unquote(m[1]));
    for (const m of src.matchAll(new RegExp(String.raw`\blabel:\s*(${LIT})`, 'g'))) add(unquote(m[1]));
  }
  add('Fahrt über 1 Stunde'); // Art der Fahrt im Gästebuch (src/guestbook.js)

  // 3. Server: Bezeichnungen aus den Modulen
  const { LANGUAGES, PREFERENCES } = require('../src/profile');
  const { DRIVER_ASPECTS, RIDER_ASPECTS } = require('../src/feedback');
  const { LEVELS, BADGES } = require('../src/gamification');
  LANGUAGES.forEach((l) => add(l));
  Object.values(PREFERENCES).flat().forEach((v) => add(v));
  [...DRIVER_ASPECTS, ...RIDER_ASPECTS].forEach((a) => { add(a.label); add(a.tip); });
  LEVELS.forEach((l) => add(l.name));
  BADGES.forEach((b) => { add(b.name); add(b.desc); });

  const out = {};
  for (const [k, plural] of [...keys].sort(([a], [b]) => a.localeCompare(b, 'de'))) out[k] = plural || k;
  if (write) {
    fs.mkdirSync(I18N_DIR, { recursive: true });
    fs.writeFileSync(SOURCE_FILE, JSON.stringify(out, null, 2) + '\n');
  }
  return out;
}

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s) => [...String(s).matchAll(/<\/?([a-z]+)\b[^>]*>/gi)].map((m) => m[0].replace(/\s+/g, ' ').replace(/^<\/?(\w+).*$/, (all, n) => (all.startsWith('</') ? '/' : '') + n.toLowerCase())).sort();
const hrefs = (s) => [...String(s).matchAll(/href="([^"]*)"/g)].map((m) => m[1]).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Prüft eine Übersetzung gegen die Ausgangstexte; liefert eine Liste von Fehlern. */
function checkCatalog(source, catalog) {
  const errors = [];
  for (const [key, src] of Object.entries(source)) {
    const tr = catalog[key];
    if (tr === undefined || tr === '') { errors.push(`fehlt: ${key}`); continue; }
    if (typeof src === 'object') {
      if (typeof tr !== 'object' || typeof tr.other !== 'string') { errors.push(`Pluralformen fehlen (mindestens "other"): ${key}`); continue; }
      for (const [cat, form] of Object.entries(tr)) {
        if (!['zero', 'one', 'two', 'few', 'many', 'other'].includes(cat)) errors.push(`unbekannte Pluralkategorie ${cat}: ${key}`);
        // {n} darf fehlen (z. B. „ein Fahrer“), andere Platzhalter nicht
        const want = placeholders(src.other).filter((p) => p !== 'n');
        if (!same(placeholders(form).filter((p) => p !== 'n'), want)) errors.push(`Platzhalter (${cat}): ${key}`);
      }
      continue;
    }
    if (typeof tr !== 'string') { errors.push(`kein Text: ${key}`); continue; }
    if (!same(placeholders(tr), placeholders(src))) errors.push(`Platzhalter: ${key} → ${tr}`);
    if (!same(tags(tr), tags(src))) errors.push(`HTML: ${key} → ${tr}`);
    if (!same(hrefs(tr), hrefs(src))) errors.push(`Links: ${key} → ${tr}`);
  }
  for (const key of Object.keys(catalog)) if (!(key in source)) errors.push(`überzählig: ${key}`);
  return errors;
}

function check() {
  const source = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
  const { UI_LANGUAGE_CODES } = require('../src/profile');
  let failed = false;
  for (const code of UI_LANGUAGE_CODES.filter((c) => c !== 'de')) {
    const file = path.join(I18N_DIR, `${code}.json`);
    if (!fs.existsSync(file)) { console.log(`${code}: Datei fehlt`); failed = true; continue; }
    const errors = checkCatalog(source, JSON.parse(fs.readFileSync(file, 'utf8')));
    console.log(`${code}: ${errors.length ? errors.length + ' Fehler' : 'ok'}`);
    errors.slice(0, 20).forEach((e) => console.log('  ' + e));
    if (errors.length) failed = true;
  }
  return !failed;
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'extract') {
    const out = extract();
    console.log(`${Object.keys(out).length} Texte in ${path.relative(ROOT, SOURCE_FILE)}`);
  } else if (cmd === 'check') {
    process.exit(check() ? 0 : 1);
  } else {
    console.log('Aufruf: node scripts/i18n.js extract|check');
    process.exit(2);
  }
}

module.exports = { extract, checkCatalog, SOURCE_FILE, I18N_DIR };
