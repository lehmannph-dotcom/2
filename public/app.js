'use strict';

/* joinmyride.com – Frontend (ohne Build-Schritt) */

const state = {
  me: null,
  config: null,
  places: {},          // pickup, dropoff, origin, destination → {label, lat, lng}
  seats: 1,
  matches: [],
  selected: null,
  rides: [],
  trip: null,
  gpsWatch: null,
  simTimer: null,
  pollTimer: null,
};

// ---------- Sprache der Oberfläche ----------
// Ausgangssprache ist Deutsch: Der deutsche Text ist zugleich der Schlüssel in den Übersetzungen
// (public/i18n/<code>.json). Fehlt eine Übersetzung, erscheint der deutsche Text.
// Regeln: t() und N_() nur mit einem einfachen String-Literal aufrufen (das Extraktionsskript
// sammelt sie ein); Platzhalter als {name}; eingesetzte Nutzerdaten vorher mit esc() schützen.
const I18N = { lang: 'de', locale: 'de-DE', dict: Object.create(null), plural: new Intl.PluralRules('de-DE') };
const LANG_STORAGE_KEY = 'joinmyride-lang';

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s);
/** Übersetzt einen deutschen Ausgangstext. */
function t(key, vars) {
  const v = I18N.dict[key];
  return fill(typeof v === 'string' && v ? v : key, vars);
}
/** Mit Zahl: Übersetzungen geben je Pluralkategorie (one, few, many, other …) eine Form an. */
function tn(n, one, other, vars) {
  const v = I18N.dict[other];
  let s = v && typeof v === 'object' ? v[I18N.plural.select(n)] || v.other : typeof v === 'string' ? v : '';
  if (!s) s = n === 1 ? one : other;
  return fill(s, { n: num(n), ...vars });
}
/** Markiert einen Text zur Übersetzung, ohne ihn schon zu übersetzen (Übersetzung bei der Anzeige mit t()). */
const N_ = (s) => s;

// Meldungen des Servers mit eingesetzten Werten (Server und gespeicherte Buchungstexte sind deutsch).
const MSG_TEMPLATES = [
  N_('Dein Konto ist bis auf Weiteres gesperrt ({reason}). Laufende Fahrten kannst du abschließen.'),
  N_('Dein Konto ist bis {date} gesperrt ({reason}). Laufende Fahrten kannst du abschließen.'),
  N_('Passwort darf höchstens {n} Zeichen haben.'),
  N_('Nicht genug Guthaben. Benötigt werden {amount} €.'),
  N_('Aktion im Status „{status}“ nicht möglich.'),
  N_('km zwischen 0 und {km} (geplante Route).'),
  N_('{field}: Koordinaten fehlen.'),
  N_('Fahrer müssen mindestens {n} Jahre alt sein.'),
  N_('Bitte mindestens {n} Zeichen schreiben.'),
  N_('Höchstens {n} Zeichen.'),
  N_('Ungültige Angabe: {field}'),
  N_('Ort nicht gefunden: {place}'),
  N_('Fahrt über {km} km'),
  N_('Mitfahrt {km} km (Fahrtabbruch)'),
  N_('Mitfahrt {km} km'),
  N_('Fahreranteil {km} km'),
  N_('Anfahrt zum Treffpunkt {km} km (ohne Provision)'),
  N_('Provision {n} %'),
];
let msgPatterns = null;
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Übersetzt einen deutschen Text vom Server – exakt oder über eine der Vorlagen mit Platzhaltern. */
function tMsg(msg) {
  if (!msg || I18N.lang === 'de') return msg;
  if (I18N.dict[msg]) return t(msg);
  msgPatterns = msgPatterns || MSG_TEMPLATES.map((tpl) => {
    const keys = [];
    const re = tpl.split(/(\{\w+\})/).map((part) => {
      const m = part.match(/^\{(\w+)\}$/);
      if (!m) return reEscape(part);
      keys.push(m[1]);
      return '(.+?)';
    }).join('');
    return { tpl, keys, re: new RegExp(`^${re}$`) };
  });
  for (const p of msgPatterns) {
    const m = msg.match(p.re);
    if (m) return t(p.tpl, Object.fromEntries(p.keys.map((k, i) => [k, m[i + 1]])));
  }
  return msg;
}

const uiLanguages = () => (state.config && state.config.uiLanguages) || [{ code: 'de', name: 'Deutsch', locale: 'de-DE' }];

/** Profil → gespeicherte Auswahl im Browser → Browsersprache → Deutsch. */
function preferredLanguage() {
  const codes = uiLanguages().map((l) => l.code);
  const fromProfile = state.me && state.me.profile && state.me.profile.uiLanguage;
  if (fromProfile && codes.includes(fromProfile)) return fromProfile;
  let stored = null;
  try { stored = localStorage.getItem(LANG_STORAGE_KEY); } catch {}
  if (stored && codes.includes(stored)) return stored;
  for (const l of navigator.languages || [navigator.language]) {
    const code = String(l || '').toLowerCase().split('-')[0];
    if (codes.includes(code)) return code;
  }
  return 'de';
}

async function loadLanguage(code) {
  const meta = uiLanguages().find((l) => l.code === code) || uiLanguages()[0];
  let dict = Object.create(null);
  if (meta.code !== 'de') {
    try {
      const res = await fetch(`/i18n/${meta.code}.json`);
      if (res.ok) dict = Object.assign(Object.create(null), await res.json());
    } catch {} // ohne Übersetzung bleibt es bei Deutsch
  }
  I18N.lang = meta.code;
  I18N.locale = meta.locale || meta.code;
  I18N.dict = dict;
  I18N.plural = new Intl.PluralRules(I18N.locale);
  document.documentElement.lang = meta.code;
  document.documentElement.dir = meta.dir || 'ltr';
  applyStaticTexts();
}

/** Lädt die Sprache neu, wenn sich die bevorzugte geändert hat (z. B. nach dem Anmelden). */
async function syncLanguage() {
  const code = preferredLanguage();
  if (code === I18N.lang) return false;
  await loadLanguage(code);
  return true;
}

/** Sprache wählen: im Browser merken und – wenn angemeldet – im Profil speichern. */
async function chooseLanguage(code) {
  try { localStorage.setItem(LANG_STORAGE_KEY, code); } catch {}
  if (state.me) {
    const { user } = await api('/api/me/profile', { profile: { uiLanguage: code } }, 'PUT');
    state.me = user;
  }
  await loadLanguage(code);
  render();
}

/** Feste Texte aus index.html (Navigation, Fußzeile) – das Original steht in data-i18n. */
function applyStaticTexts() {
  document.title = t('joinmyride.com – Teilen statt Leerfahren');
  const desc = document.querySelector('meta[name=description]');
  if (desc) desc.content = t('joinmyride.com – die Ad-hoc-Mitfahrzentrale: Fahrer bieten ihre Google-Maps-Route an, Mitfahrer teilen die Kosten pro Kilometer. 1 Cent jeder Fahrt geht an den Umweltschutz.');
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
  const sel = document.getElementById('lang-select');
  if (sel) {
    sel.innerHTML = uiLanguages().map((l) => `<option value="${esc(l.code)}" ${l.code === I18N.lang ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
    sel.setAttribute('aria-label', t('Sprache'));
  }
}

// ---------- Helfer ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, digits) => Number(v).toLocaleString(I18N.locale, digits === undefined ? undefined : { maximumFractionDigits: digits });
const euro = (cents) => (cents / 100).toLocaleString(I18N.locale, { style: 'currency', currency: 'EUR' });
const kg = (v) => num(v, 1);
const km = (v) => t('{n} km', { n: num(v, 1) });
const minutes = (v) => t('{n} min', { n: num(Math.round(v)) });
const fmtDate = (d) => new Date(d).toLocaleDateString(I18N.locale);
const fmtDateTime = (d) => new Date(d).toLocaleString(I18N.locale);
const fmtShortDateTime = (d) => new Date(d).toLocaleString(I18N.locale, { dateStyle: 'short', timeStyle: 'short' });
/** "2026-10" → "Oktober 2026" in der gewählten Sprache */
const fmtMonth = (period, month = 'long') => {
  const [y, m] = String(period).split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(I18N.locale, { month, year: 'numeric' });
};
const shortLabel = (p) => (p && p.label ? p.label.split(',').slice(0, 2).join(',') : '');

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ? tMsg(data.error) : t('Fehler {status}', { status: res.status }));
    err.raw = data.error || '';
    err.details = data.details ? data.details.map(tMsg) : data.details;
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ---------- Info-Kontextmenü: Erklärungen per Mouseover, Fokus oder Antippen ----------
/** ⓘ-Symbol mit Erklärung. html wird so eingefügt – Nutzerdaten vorher mit esc() schützen. */
// Der Inhalt steckt in einem <template>: so darf er Absätze und Tabellen enthalten, ohne das
// umgebende HTML (z. B. ein <p>) aufzubrechen, und wird nicht angezeigt.
const info = (html, label) =>
  `<span class="info" tabindex="0" role="button" aria-label="${esc(label || t('Erklärung'))}">i<template class="tip-content">${html}</template></span>`;
/** Text mit gepunkteter Unterstreichung und Erklärung. */
const withTip = (text, html) => `<span class="has-tip" tabindex="0">${text}<template class="tip-content">${html}</template></span>`;

const tipEl = document.createElement('div');
tipEl.id = 'tooltip';
tipEl.setAttribute('role', 'tooltip');
tipEl.hidden = true;
document.body.appendChild(tipEl);
let tipOwner = null;
let tipShownAt = 0;

function tipHtmlOf(el) {
  const content = el.querySelector(':scope > template.tip-content');
  if (content) return content.innerHTML;
  return el.dataset.tip ? esc(el.dataset.tip) : '';
}

function showTip(el) {
  const html = tipHtmlOf(el);
  if (!html) return;
  if (tipOwner && tipOwner !== el) tipOwner.classList.remove('open');
  if (tipOwner !== el) tipShownAt = Date.now();
  tipOwner = el;
  el.classList.add('open');
  tipEl.innerHTML = html;
  tipEl.hidden = false;
  el.setAttribute('aria-describedby', 'tooltip');
  positionTip();
}

function positionTip() {
  const el = tipOwner;
  if (!el) return;
  if (!document.contains(el)) return hideTip();
  const r = el.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}

function hideTip() {
  if (tipOwner) {
    tipOwner.classList.remove('open');
    tipOwner.removeAttribute('aria-describedby');
  }
  tipOwner = null;
  tipEl.hidden = true;
}

const TIP_SELECTOR = '.info, .has-tip, [data-tip]';
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest(TIP_SELECTOR);
  if (el && el !== tipOwner) showTip(el);
});
document.addEventListener('mouseout', (e) => {
  const el = e.target.closest(TIP_SELECTOR);
  if (el && el === tipOwner && !el.contains(e.relatedTarget)) hideTip();
});
document.addEventListener('focusin', (e) => {
  const el = e.target.closest(TIP_SELECTOR);
  if (el) showTip(el);
});
document.addEventListener('focusout', (e) => {
  if (e.target.closest(TIP_SELECTOR) === tipOwner) hideTip();
});
// Touch: Antippen öffnet/schließt; ⓘ in <summary>/<label> soll nichts anderes auslösen.
document.addEventListener('click', (e) => {
  const el = e.target.closest('.info, .has-tip');
  if (el) {
    e.preventDefault();
    e.stopPropagation();
    // Beim Antippen kommen Fokus/Mouseover kurz vor dem Klick – dann offen lassen statt umschalten.
    if (tipOwner === el && Date.now() - tipShownAt > 400) hideTip();
    else showTip(el);
  } else if (tipOwner && !e.target.closest('[data-tip]')) {
    hideTip();
  }
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
// Beim Scrollen mitwandern (Fokus/Antippen scrollt oft das Element in Sicht).
window.addEventListener('scroll', positionTip, true);
window.addEventListener('resize', positionTip);

async function guard(fn, btn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StaleRender) return undefined;
    toast(err.message + (err.details ? ' ' + err.details.join(' ') : ''));
    // Nur bei abgelaufener Sitzung zur Anmeldung – nicht bei falschem Passwort/Code.
    if (err.code === 'auth_required' && state.me) { state.me = null; stopDriving(); render(); }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- Karte ----------
const map = L.map('map', { zoomControl: true }).setView([51.16, 10.45], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
const layers = L.layerGroup().addTo(map);
let driverMarker = null;

const pin = (color, text) =>
  L.divIcon({
    className: '',
    html: `<div style="background:${color};color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:700;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)">${text}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

function drawMap({ routes = [], points = [], driver = null, fit = true } = {}) {
  layers.clearLayers();
  driverMarker = null;
  const bounds = [];
  routes.forEach((r) => {
    const latlngs = r.coords.map((c) => [c.lat, c.lng]);
    L.polyline(latlngs, { color: r.color || '#78bf96', weight: r.weight || 5, opacity: r.opacity || 0.85, dashArray: r.dash }).addTo(layers);
    bounds.push(...latlngs);
  });
  points.forEach((p) => {
    L.marker([p.lat, p.lng], { icon: pin(p.color, p.text) }).bindTooltip(esc(p.label || '')).addTo(layers);
    bounds.push([p.lat, p.lng]);
  });
  if (driver) updateDriverMarker(driver);
  if (fit && bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
}

function updateDriverMarker(pos) {
  if (!pos) return;
  if (!driverMarker) driverMarker = L.marker([pos.lat, pos.lng], { icon: pin('#4a9a6e', 'F'), zIndexOffset: 1000 }).addTo(layers);
  else driverMarker.setLatLng([pos.lat, pos.lng]);
}

map.on('click', (e) => {
  const view = currentView();
  const p = { lat: e.latlng.lat, lng: e.latlng.lng, label: `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}` };
  if (view === 'mitfahren' && !activeRiderRide()) {
    const key = !state.places.pickup ? 'pickup' : 'dropoff';
    setPlace(key, p);
  } else if (view === 'fahren' && !state.trip && state.me && state.me.canDrive) {
    const key = !state.places.origin ? 'origin' : 'destination';
    setPlace(key, p);
  }
});

// ---------- Ortseingabe mit Vorschlägen ----------
function placeField(key, label, placeholder, withLocate) {
  const p = state.places[key];
  return `
    <label for="f-${key}">${label}</label>
    <div class="row">
      <div class="suggest">
        <input id="f-${key}" data-place="${key}" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(p ? p.label : '')}">
        <ul hidden></ul>
      </div>
      ${withLocate ? `<button type="button" class="secondary shrink" data-locate="${key}" data-tip="${esc(t('Aktuellen Standort verwenden'))}" aria-label="${esc(t('Aktuellen Standort verwenden'))}">${t('Standort')}</button>` : ''}
    </div>`;
}

function bindPlaceFields(root) {
  root.querySelectorAll('input[data-place]').forEach((input) => {
    const list = input.nextElementSibling;
    const key = input.dataset.place;
    let timer;
    input.addEventListener('input', () => {
      delete state.places[key];
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) return (list.hidden = true);
      timer = setTimeout(async () => {
        try {
          const { results } = await api('/api/geocode?q=' + encodeURIComponent(q));
          if (document.activeElement !== input || input.value.trim() !== q) return;
          list.innerHTML = results.map((r, i) => `<li data-i="${i}">${esc(r.label)}</li>`).join('') || `<li class="muted">${t('Nichts gefunden')}</li>`;
          list.hidden = false;
          list.onclick = (e) => {
            const r = results[e.target.dataset.i];
            if (r) setPlace(key, r);
            list.hidden = true;
          };
        } catch (err) {
          toast(err.message);
        }
      }, 350);
    });
    input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 200));
  });
  root.querySelectorAll('[data-locate]').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (!navigator.geolocation) return toast(t('Standortbestimmung nicht verfügbar.'));
      navigator.geolocation.getCurrentPosition(
        (pos) => setPlace(btn.dataset.locate, { lat: pos.coords.latitude, lng: pos.coords.longitude, label: t('Mein Standort') }),
        () => toast(t('Standort konnte nicht ermittelt werden.')),
        { enableHighAccuracy: true, timeout: 10000 },
      );
    }),
  );
}

async function ensurePlace(key) {
  if (state.places[key]) return state.places[key];
  const input = $(`[data-place="${key}"]`);
  const q = input && input.value.trim();
  if (!q) return null;
  const { results } = await api('/api/geocode?q=' + encodeURIComponent(q));
  if (!results.length) throw new Error(t('„{q}“ wurde nicht gefunden.', { q }));
  state.places[key] = results[0];
  input.value = results[0].label;
  return results[0];
}

function setPlace(key, p) {
  state.places[key] = p;
  const input = $(`[data-place="${key}"]`);
  if (input) input.value = p.label;
  state.matches = [];
  state.selected = null;
  previewPlaces();
}

function previewPlaces() {
  const v = currentView();
  const P = state.places;
  const points = [];
  if (v === 'mitfahren') {
    if (P.pickup) points.push({ ...P.pickup, color: '#4a9a6e', text: 'A' });
    if (P.dropoff) points.push({ ...P.dropoff, color: '#1c3a2a', text: 'B' });
  } else if (v === 'fahren') {
    if (P.origin) points.push({ ...P.origin, color: '#4a9a6e', text: 'S' });
    if (P.destination) points.push({ ...P.destination, color: '#1c3a2a', text: 'Z' });
  }
  drawMap({ points });
}

// ---------- Routing / Ansichten ----------
const currentView = () => (location.hash.replace(/^#\//, '') || 'mitfahren').split('/')[0];
window.addEventListener('hashchange', render);
// Klick auf die bereits aktive Ansicht lädt sie neu.
document.querySelector('#nav').addEventListener('click', (e) => {
  if (e.target.dataset.view && e.target.dataset.view === currentView()) render();
});
document.querySelector('#lang-select').addEventListener('change', (e) => guard(() => chooseLanguage(e.target.value)));

function renderHeader() {
  const nav = $('#nav');
  nav.hidden = !state.me;
  $('#nav-admin').hidden = !(state.me && state.me.isAdmin);
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.view === currentView()));
  $('#userbox').innerHTML = state.me
    ? `<a class="points-pill" href="#/punkte" data-tip="${esc(t('Level {name}', { name: t(state.me.level.name) }))}">${t('{n} P', { n: num(state.me.points) })}</a><span>${esc(state.me.name)} · <b>${euro(state.me.walletCents - state.me.reservedCents)}</b></span><button class="secondary" id="logout">${t('Abmelden')}</button>`
    : '';
  const lo = $('#logout');
  if (lo) lo.onclick = () => guard(async () => { await api('/api/logout', {}); state.me = null; stopDriving(); render(); });
}

// Ansichten laden teils asynchron. Wechselt man währenddessen die Seite, darf eine veraltete
// Ansicht das Panel nicht mehr überschreiben: Jede Ansicht bekommt eine laufende Nummer, und
// ein Schreibversuch einer alten Ansicht bricht still ab (StaleRender).
class StaleRender extends Error {}
let renderSeq = 0;

function guardedPanel(seq) {
  const el = $('#panel');
  return new Proxy(el, {
    get(target, prop) {
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set(target, prop, value) {
      if (prop === 'innerHTML' && seq !== renderSeq) throw new StaleRender();
      target[prop] = prop === 'innerHTML' ? accountNotice() + value : value;
      return true;
    },
  });
}

function render() {
  hideTip();
  renderHeader();
  clearInterval(state.pollTimer);
  closeModal();
  const panel = guardedPanel(++renderSeq);
  const view = currentView();
  if (view === 'datenschutz') return renderPrivacyPolicy(panel);
  if (view === 'impressum') return renderImprint(panel);
  if (view === 'nutzungsbedingungen') return renderTerms(panel);
  if (view === 'funfacts') return guard(() => renderFunfacts(panel));
  if (!state.me) return renderAuth(panel);
  // Kontodaten bei jedem Seitenwechsel auffrischen (Sperren, Verwarnungen, Guthaben, Punkte)
  const show = (fn) => guard(async () => { await refreshMe(); return fn(panel); });
  if (view === 'fahren') show(renderDriver);
  else if (view === 'konto') show(renderAccount);
  else if (view === 'profil') show(renderProfile);
  else if (view === 'punkte') show(renderPoints);
  else if (view === 'admin' && state.me.isAdmin) show(renderAdmin);
  else show(renderRider);
}

async function refreshMe() {
  const { user } = await api('/api/me');
  state.me = user;
  // Sprache aus dem Profil übernehmen (z. B. auf einem anderen Gerät geändert). Eine laufende
  // Ansicht in der alten Sprache bricht dann still ab (StaleRender), weil render() neu zeichnet.
  if (await syncLanguage()) return render();
  renderHeader();
}

/** Nach dem Anmelden: Sprache aus dem Profil übernehmen, dann neu zeichnen. */
async function signedIn(user) {
  state.me = user;
  await syncLanguage();
  render();
}

// ---------- Anmeldung ----------
function renderAuth(panel) {
  drawMap();
  const cfg = state.config ? state.config.pricing : null;
  panel.innerHTML = `
    <div class="card hero">
      <h2>${t('Teilen statt Leerfahren')}</h2>
      <p>${t('Spontan mitfahren, Kosten pro Kilometer teilen, CO₂ sparen.')}</p>
    </div>
    <div class="card">
      <div class="tabs">
        <button id="tab-login">${t('Anmelden')}</button>
        <button id="tab-register" class="secondary">${t('Registrieren')}</button>
      </div>
      <form id="auth-form">
        <div id="name-field" hidden>
          <label for="a-name">${t('Name')}</label>
          <input id="a-name" autocomplete="name">
        </div>
        <label for="a-email">${t('E-Mail')}</label>
        <input id="a-email" type="email" autocomplete="email" required>
        <label for="a-pass">${t('Passwort')}</label>
        <input id="a-pass" type="password" autocomplete="current-password" minlength="8" required>
        <label class="check" id="consent-field" hidden>
          <input type="checkbox" id="a-consent">
          <span>${t('Ich akzeptiere die <a href="#/nutzungsbedingungen" target="_blank">Nutzungsbedingungen</a>, habe die <a href="#/datenschutz" target="_blank">Datenschutzerklärung</a> gelesen und stimme der Verarbeitung meiner Daten zur Vermittlung und Abrechnung von Fahrten zu.')}</span>
        </label>
        <button class="full" style="margin-top:14px" id="a-submit">${t('Anmelden')}</button>
      </form>
      <form id="mfa-form" hidden>
        <h3>${t('Zwei-Faktor-Bestätigung')} ${info(t('Gib den 6-stelligen Code aus deiner Authenticator-App ein – oder einen deiner Backup-Codes.'))}</h3>
        <input id="mfa-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="9" placeholder="123456" required>
        <button class="full" style="margin-top:14px" id="mfa-submit">${t('Bestätigen')}</button>
        <button type="button" class="secondary full" style="margin-top:8px" id="mfa-back">${t('Zurück')}</button>
      </form>
    </div>
    <div class="card">
      <h3>${t('So funktioniert\'s')}</h3>
      <ol class="steps">
        <li>${t('<b>Fahrer</b> gehen mit ihrer Route online')} ${info(t('Einmalig den Führerschein verifizieren, dann Route eingeben oder einen Google-Maps-Link einfügen.'))}</li>
        <li>${t('<b>Mitfahrer</b> finden den passenden Fahrer')} ${info(t('Ziel eingeben – die App findet den Fahrer mit dem kleinsten Umweg, der kürzesten Wartezeit und guten Bewertungen.'))}</li>
        <li>${t('<b>Kosten teilen</b> pro Kilometer')} ${info(`<p>${cfg ? t('Abgerechnet wird die geplante Route – oder die gefahrene Strecke, wenn sie kürzer ist ({rate}/km).', { rate: euro(cfg.ratePerKmCents) }) : t('Abgerechnet wird die geplante Route – oder die gefahrene Strecke, wenn sie kürzer ist.')}</p><p>${t('Der Großteil geht an den Fahrer, {percent} % Vermittlungsprovision, {donation} Umweltspende je Fahrt.', { percent: cfg ? num(cfg.commissionPercent) : '–', donation: cfg ? euro(cfg.donationCentsPerRide) : euro(1) })}</p>`)}</li>
      </ol>
    </div>`;
  let mode = 'login';
  const setMode = (m) => {
    mode = m;
    $('#tab-login').className = m === 'login' ? '' : 'secondary';
    $('#tab-register').className = m === 'register' ? '' : 'secondary';
    $('#name-field').hidden = m !== 'register';
    $('#consent-field').hidden = m !== 'register';
    $('#a-submit').textContent = m === 'login' ? t('Anmelden') : t('Konto erstellen');
    $('#a-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  };
  $('#tab-login').onclick = () => setMode('login');
  $('#tab-register').onclick = () => setMode('register');
  $('#auth-form').onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      const body = { email: $('#a-email').value, password: $('#a-pass').value, name: $('#a-name').value, acceptPrivacy: $('#a-consent').checked };
      if (mode === 'register' && !body.acceptPrivacy) throw new Error(t('Bitte den Nutzungsbedingungen und der Datenschutzerklärung zustimmen.'));
      // Bei der Registrierung die gerade angezeigte Sprache ins Profil übernehmen
      const res = await api(mode === 'login' ? '/api/login' : '/api/register', mode === 'register' ? { ...body, uiLanguage: I18N.lang } : body);
      if (res.mfaRequired) {
        mfaToken = res.mfaToken;
        $('#auth-form').hidden = true;
        $('.tabs').hidden = true;
        $('#mfa-form').hidden = false;
        $('#mfa-code').focus();
        return;
      }
      await signedIn(res.user);
    }, $('#a-submit'));
  };
  let mfaToken = null;
  $('#mfa-form').onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      try {
        const res = await api('/api/login/mfa', { mfaToken, code: $('#mfa-code').value });
        if (res.usedBackupCode) toast(t('Backup-Code verwendet – noch {n} übrig.', { n: num(res.user.backupCodesLeft) }));
        await signedIn(res.user);
      } catch (err) {
        $('#mfa-code').value = '';
        if (err.status === 429 || /abgelaufen/.test(err.raw || '')) $('#mfa-back').click();
        throw err;
      }
    }, $('#mfa-submit'));
  };
  $('#mfa-back').onclick = () => {
    $('#auth-form').hidden = false;
    $('.tabs').hidden = false;
    $('#mfa-form').hidden = true;
    $('#a-pass').value = '';
  };
}

// ---------- Mitfahrer ----------
const OPEN_STATES = ['requested', 'accepted', 'picked_up', 'confirming'];
const activeRiderRide = () => state.rides.find((r) => r.role === 'rider' && OPEN_STATES.includes(r.status));
const STATUS = {
  requested: [N_('Angefragt – wartet auf Fahrer'), 'warn'],
  accepted: [N_('Bestätigt – Fahrer ist unterwegs'), 'ok'],
  picked_up: [N_('Unterwegs'), 'ok'],
  confirming: [N_('Wartet auf Bestätigung'), 'warn'],
  disputed: [N_('Reklamation – Betreiber prüft'), 'bad'],
  completed: [N_('Abgeschlossen'), 'ok'],
  declined: [N_('Abgelehnt'), 'bad'],
  cancelled: [N_('Storniert'), 'bad'],
};
const statusBadge = (s) => `<span class="badge ${STATUS[s][1]}">${t(STATUS[s][0])}</span>`;
const PLANNED_STYLE = { color: '#2f7350', weight: 4, dash: '10 8', opacity: 0.9 };
const TIP = {
  billing: (who = 'du') => `<p><b>${t('So wird abgerechnet')}</b></p><p>${t('Grundlage ist die <b>schnellste Route laut Plan</b>, die ihr beide vorab bestätigt habt.')}</p><p>${who === 'du' ? t('Mit dem <b>Einsteigen</b> wird der Preis der geplanten Route fällig – auch wenn die Fahrt früher endet. Ist die Strecke länger (Umweg), bleibt es beim geplanten Preis – Umwege zahlst du nie.') : t('Mit dem <b>Einsteigen</b> wird der Preis der geplanten Route fällig – auch wenn die Fahrt früher endet. Ist die Strecke länger (Umweg), bleibt es beim geplanten Preis – Umwege zahlt der Mitfahrer nie.')}</p><p>${t('Nur bei einem <b>begründeten Fahrtabbruch</b> wird die bis dahin gefahrene Strecke (GPS) berechnet. Abbrüche erscheinen als Fahrtabbruchsquote im Profil beider Beteiligten.')}</p>`,
  price: () => {
    const c = state.config ? state.config.pricing : { ratePerKmCents: 25, commissionPercent: 10, donationCentsPerRide: 1 };
    return `<p><b>${t('Kostenteilung pro Kilometer')}</b></p><table><tr><td>${t('Kilometersatz')}</td><td>${euro(c.ratePerKmCents)}/km</td></tr><tr><td>${t('an den Fahrer')}</td><td>${num(100 - c.commissionPercent)} %</td></tr><tr><td>${t('Vermittlungsprovision')}</td><td>${num(c.commissionPercent)} %</td></tr><tr><td>${t('Anfahrt zum Treffpunkt')}</td><td>${t('100 % Fahrer')}</td></tr><tr><td>${t('Umweltspende je Fahrt')}</td><td>${euro(c.donationCentsPerRide)}</td></tr></table><p style="margin-top:6px">${t('Der Preis der geplanten Route ist der Höchstbetrag. Er wird reserviert und erst nach der Fahrt abgebucht.')}</p>`;
  },
  payment: (isRider) => `<p><b>${t('Wann wird bezahlt?')}</b></p><p>${isRider ? t('Sobald der Fahrer dich abgesetzt <b>und</b> du die Fahrt bewertet hast – Reihenfolge egal.') : t('Sobald der Fahrer den Mitfahrer abgesetzt <b>und</b> der Mitfahrer die Fahrt bewertet hat – Reihenfolge egal.')}</p><p>${t('Die Bewertung ändert den Preis nicht. Ohne Rückmeldung gilt die Fahrt nach 24 h als bestätigt.')}</p>`,
  points: () => `<p><b>${t('Punkte = Faktor × eingesparte kg CO₂')}</b></p><p>${t('Der Faktor ist die Bewertung, die du vom jeweils anderen bekommst:')}</p><table><tr><td>10 · 9 · 8 · 7</td><td>×10 · ×9 · ×8 · ×7</td></tr><tr><td>6 · 5 · 4</td><td>×1</td></tr><tr><td>3 · 2 · 1 · 0</td><td>×0</td></tr></table>`,
  nps: () => `<p><b>${t('NPS – Net Promoter Score')}</b></p><p>${t('Frage: „Wie wahrscheinlich empfiehlst du diese Person weiter?“ (0–10)')}</p><table><tr><td>${t('Promotoren')}</td><td>9–10</td></tr><tr><td>${t('Passive')}</td><td>7–8</td></tr><tr><td>${t('Kritiker')}</td><td>0–6</td></tr></table><p style="margin-top:6px">${t('NPS = % Promotoren − % Kritiker (−100 bis +100).')}</p>`,
  detour: () => `<p><b>${t('Anfahrt zum Treffpunkt')}</b></p><p>${t('Der Umweg, den der Fahrer fährt, um dich abzuholen – zum gleichen Kilometersatz.')}</p><p>${t('Dieser Teil geht <b>zu 100 % an den Fahrer</b>: Der Plattformbetreiber nimmt darauf keine Provision.')}</p>`,
  plannedRoute: () => `<p><b>${t('Geplante Route')}</b></p><p>${t('Die schnellste Route vom Abholort zum Ziel (dunkelgrün gestrichelt auf der Karte). Du und der Fahrer bestätigen sie – sie ist Grundlage und Obergrenze für den Preis.')}</p>`,
};
const BASIS = { geplant: N_('geplante Route'), gefahren: N_('gefahrene Strecke'), abbruch: N_('Fahrtabbruch (gefahrene Strecke)'), betreiber: N_('Entscheidung Betreiber') };
const basisLabel = (b) => (BASIS[b] ? t(BASIS[b]) : esc(b));
const abortReasonLabel = (id) => t(((state.config.abortReasons || []).find((x) => x.id === id) || { label: '' }).label);
const aspectLabel = (ratedRole, id) => t(((state.config.aspects[ratedRole] || []).find((a) => a.id === id) || { label: id }).label);

/** Fahrtabbruchsquote als Badge: Anteil abgebrochener Fahrten an allen Fahrten in der Rolle. */
function abortBadge(st, role = '', withRole = false) {
  const label = withRole ? (role === 'driver' ? t('Fahrtabbruchsquote (Fahrer)') : t('Fahrtabbruchsquote (Mitfahrer)')) : t('Fahrtabbruchsquote');
  if (!st || !st.rides) {
    const tip = role === 'driver' ? t('Noch keine abgeschlossenen Fahrten als Fahrer.') : role === 'rider' ? t('Noch keine abgeschlossenen Fahrten als Mitfahrer.') : t('Noch keine abgeschlossenen Fahrten.');
    return `<span class="badge" tabindex="0" data-tip="${esc(tip)}">${label} –</span>`;
  }
  const cls = st.quote <= 5 ? 'ok' : st.quote <= 15 ? 'warn' : 'bad';
  const vars = { aborted: num(st.aborted), rides: num(st.rides), initiated: num(st.initiated) };
  const tip = role === 'driver'
    ? t('{aborted} von {rides} Fahrten als Fahrer abgebrochen, davon {initiated} selbst. Jeder Abbruch zählt für beide Beteiligten.', vars)
    : t('{aborted} von {rides} Fahrten als Mitfahrer abgebrochen, davon {initiated} selbst. Jeder Abbruch zählt für beide Beteiligten.', vars);
  return `<span class="badge ${cls}" tabindex="0" data-tip="${esc(tip)}">${label} ${num(st.quote)} %</span>`;
}

function plannedRouteHtml(route, note) {
  const estimated = route.provider === 'luftlinie' ? `<span class="warn-text">${t('Strecke geschätzt')} ${info(t('Der Routendienst ist gerade nicht erreichbar. Die Strecke wurde aus der Luftlinie × 1,3 geschätzt.'))}</span>` : '';
  return `<div class="planned"><span>${t('<b>Geplante Route:</b> {km} · ca. {min}', { km: km(route.distanceKm), min: minutes(route.durationMin) })}</span>${info(TIP.plannedRoute())}${estimated}${note ? `<span class="muted small" style="width:100%">${note}</span>` : ''}</div>`;
}

// ---------- Bewertung nach NPS-Logik (0–10) ----------
const bewertungen = (n) => tn(n, '{n} Bewertung', '{n} Bewertungen');
const NPS_CAT = (n) => (n >= 9 ? 'promoter' : n >= 7 ? 'passive' : 'detractor');
const NPS_COMMENT = {
  promoter: N_('Was hat dir besonders gefallen? (optional)'),
  passive: N_('Möchtest du noch etwas ergänzen? (optional)'),
  detractor: N_('Möchtest du noch etwas ergänzen? (optional)'),
};
const ASPECT_HEADING = {
  passive: N_('Was hätte besser sein können? (freiwillig)'),
  detractor: N_('Was war der Grund? (freiwillig)'),
};
const npsSplit = (s) => t('{promoters} Promotoren · {passives} Passive · {detractors} Kritiker', { promoters: num(s.promoters), passives: num(s.passives), detractors: num(s.detractors) });
const signed = (n) => `${n > 0 ? '+' : ''}${num(n)}`;

/** NPS-Skala 0–10; ratedRole ('driver'|'rider') bestimmt die möglichen Gründe bei Bewertungen bis 8. */
function npsWidget(question, ratedRole = 'driver') {
  const aspects = (state.config && state.config.aspects && state.config.aspects[ratedRole]) || [];
  const learnTip = ratedRole === 'driver'
    ? t('Der Fahrer sieht deine Hinweise nur gesammelt – frühestens ab 3 Rückmeldungen, ohne Datum und ohne Zuordnung zu dieser Fahrt.')
    : t('Der Mitfahrer sieht deine Hinweise nur gesammelt – frühestens ab 3 Rückmeldungen, ohne Datum und ohne Zuordnung zu dieser Fahrt.');
  return `<div class="nps">
    <p class="nps-q">${esc(question)} ${info(TIP.nps())}</p>
    <div class="nps-scale" role="radiogroup">${Array.from({ length: 11 }, (_, i) => `<button type="button" class="nps-btn ${NPS_CAT(i)}" data-score="${i}" role="radio" aria-checked="false">${i}</button>`).join('')}</div>
    <div class="nps-legend"><span>${t('unwahrscheinlich')}</span><span>${t('sehr wahrscheinlich')}</span></div>
    <div class="nps-aspects" hidden>
      <p class="nps-aspects-q"><span class="nps-aspects-text"></span>${info(`<p><b>${t('Anonymes Feedback zum Lernen')}</b></p><p>${learnTip}</p><p>${t('Bei echten Problemen bitte „Problem melden“.')}</p>`)}</p>
      <div class="aspect-chips">${aspects.map((a) => `<button type="button" class="aspect-chip" data-aspect="${a.id}" aria-pressed="false">${esc(t(a.label))}</button>`).join('')}</div>
    </div>
    <label class="nps-comment-label" hidden></label>
    <textarea class="nps-comment" maxlength="500" hidden></textarea>
  </div>`;
}

function npsBadge(summary) {
  if (!summary || !summary.count) return `<span class="badge">${t('Neu – noch keine Bewertung')}</span>`;
  const cls = summary.score >= 50 ? 'ok' : summary.score >= 0 ? 'warn' : 'bad';
  return `<span class="badge ${cls}" tabindex="0" data-tip="${esc('NPS: ' + npsSplit(summary))}">NPS ${signed(summary.score)} · ${bewertungen(summary.count)}</span>`;
}

/** Macht alle NPS-Formulare in root bedienbar; onSubmit erhält {nps, comment}. */
function bindNpsForms(root, selector, onSubmit) {
  root.querySelectorAll(selector).forEach((form) => {
    const submit = form.querySelector('[data-submit]');
    form.querySelectorAll('.nps-btn').forEach((b) =>
      b.addEventListener('click', () => {
        form.dataset.score = b.dataset.score;
        form.querySelectorAll('.nps-btn').forEach((x) => {
          x.classList.toggle('selected', x === b);
          x.setAttribute('aria-checked', String(x === b));
        });
        const cat = NPS_CAT(Number(b.dataset.score));
        const aspectsBox = form.querySelector('.nps-aspects');
        if (aspectsBox) {
          aspectsBox.hidden = cat === 'promoter';
          aspectsBox.querySelector('.nps-aspects-text').textContent = ASPECT_HEADING[cat] ? t(ASPECT_HEADING[cat]) : '';
        }
        const label = form.querySelector('.nps-comment-label');
        label.textContent = t(NPS_COMMENT[cat]);
        label.hidden = false;
        form.querySelector('.nps-comment').hidden = false;
        if (submit) submit.disabled = false;
      }),
    );
    form.querySelectorAll('.aspect-chip').forEach((c) =>
      c.addEventListener('click', () => {
        c.classList.toggle('selected');
        c.setAttribute('aria-pressed', String(c.classList.contains('selected')));
      }),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = form.dataset.score !== undefined
        ? {
            nps: Number(form.dataset.score),
            comment: form.querySelector('.nps-comment').value,
            aspects: Number(form.dataset.score) <= 8 ? [...form.querySelectorAll('.aspect-chip.selected')].map((c) => c.dataset.aspect) : [],
          }
        : {};
      guard(() => onSubmit(form, body), submit);
    });
  });
}

/**
 * Fahrtende: Gezahlt wird, sobald der Fahrer den Mitfahrer abgesetzt hat
 * und der Mitfahrer die Fahrt bewertet hat (NPS 0–10).
 */
function confirmationCard(r) {
  const p = r.settlementPreview;
  if (!p) return '';
  const measuring = r.status === 'picked_up';
  const isRider = r.role === 'rider';
  const mine = isRider ? (r.myEndConfirmed ? t('✓ Du hast die Fahrt bewertet.') : t('○ Deine Bewertung fehlt.')) : (r.myEndConfirmed ? t('✓ Du hast das Absetzen bestätigt.') : t('○ Absetzen noch nicht bestätigt.'));
  const theirs = isRider ? (r.partnerEndConfirmed ? t('✓ Der Fahrer hat dich abgesetzt.') : t('○ Der Fahrer hat das Absetzen noch nicht bestätigt.')) : (r.partnerEndConfirmed ? t('✓ Der Mitfahrer hat die Fahrt bewertet.') : t('○ Der Mitfahrer hat noch nicht bewertet.'));
  const open = !r.myEndConfirmed && r.status !== 'disputed';
  return `<div class="card confirm-card">
    <h3>${isRider ? t('Angekommen? Bewerten & bezahlen') : t('Mitfahrer absetzen')} ${info(TIP.payment(isRider))}</h3>
    <table class="breakdown">
      <tr><td>${t('Geplante Route')}</td><td>${km(p.plannedKm)}${r.plannedRoute ? ` · ${minutes(r.plannedRoute.durationMin)}` : ''}</td></tr>
      <tr><td>${t('Gefahren (GPS)')}${measuring ? ` <span class="muted small">${t('– läuft')}</span>` : ''}</td><td>${p.trackedKm > 0.2 ? km(p.trackedKm) : '–'}</td></tr>
      <tr class="total"><td>${t('Abgerechnet: {basis}', { basis: basisLabel(p.basis) })} ${info(TIP.billing(isRider ? 'du' : 'mitfahrer'))}</td><td>${km(p.billedKm)}</td></tr>
      ${p.price.detourCents ? `<tr><td>${t('Anfahrt zum Treffpunkt')} ${info(TIP.detour())}</td><td>${km(p.price.detourKm)}</td></tr>` : ''}
      <tr><td>${isRider ? t('Du zahlst') : t('Dein Anteil')}</td><td><b>${euro(isRider ? p.price.totalCents : p.price.driverCents)}</b></td></tr>
    </table>
    <p class="status-lines">${mine}<br>${theirs}
      ${r.autoConfirmAt && !(r.myEndConfirmed && r.partnerEndConfirmed) ? ` ${info(t('Ohne Rückmeldung gilt die Fahrt am {date} als bestätigt.', { date: fmtShortDateTime(r.autoConfirmAt) }))}` : ''}</p>
    ${r.status === 'disputed' ? `<p class="small"><span class="badge bad">${t('Reklamation')}</span> ${esc(r.dispute.reason)}</p>` : ''}
    ${open && isRider ? `<form class="nps-form" data-confirm-form="${r.id}">
        ${npsWidget(t('Wie wahrscheinlich ist es, dass du {name} weiterempfiehlst?', { name: r.driverName }))}
        <div class="btn-row"><button data-submit disabled>${t('Bewerten & bezahlen')}</button><button type="button" class="secondary" data-dispute="${r.id}">${t('Problem melden')}</button>${measuring ? `<button type="button" class="danger" data-abort="${r.id}">${t('Fahrt abbrechen')}</button>` : ''}</div>
      </form>` : ''}
    ${open && !isRider ? `<form class="nps-form" data-confirm-form="${r.id}">
        <details><summary class="small">${t('Optional: {name} bewerten', { name: esc(r.riderName) })}</summary>${npsWidget(t('Wie wahrscheinlich ist es, dass du {name} anderen Fahrern weiterempfiehlst?', { name: r.riderName }), 'rider')}</details>
        <div class="btn-row"><button data-submit>${measuring ? t('Mitfahrer abgesetzt') : t('Absetzen bestätigen')}</button><button type="button" class="secondary" data-dispute="${r.id}">${t('Problem melden')}</button>${measuring ? `<button type="button" class="danger" data-abort="${r.id}">${t('Fahrt abbrechen')}</button>` : ''}</div>
      </form>` : ''}
  </div>`;
}

function bindConfirmButtons(root) {
  bindNpsForms(root, '[data-confirm-form]', async (form, body) => {
    const { ride } = await api(`/api/rides/${form.dataset.confirmForm}/confirm`, body);
    if (ride.status === 'completed') toast(t('Bezahlt: {km} · {amount} · +{points}', { km: km(ride.final.km), amount: euro(ride.role === 'driver' ? ride.final.driverCents : ride.final.totalCents), points: pts(ride.myPoints.points) }));
    if (ride.guestbook && ride.guestbook.eligible) {
      await refreshMe();
      render();
      openGuestbookForm(ride, { afterRide: true });
      return;
    }
    else toast(ride.role === 'rider' ? t('Danke für deine Bewertung! Gezahlt wird, sobald der Fahrer das Absetzen bestätigt.') : t('Abgesetzt – gezahlt wird, sobald der Mitfahrer bewertet hat.'));
    await refreshMe();
    render();
  });
  root.querySelectorAll('[data-abort]').forEach((b) => (b.onclick = () => {
    const ride = state.rides.find((x) => x.id === b.dataset.abort) || {};
    const driven = km(ride.trackedKm > 0 ? ride.trackedKm : 0);
    const withDetour = ride.estimate && ride.estimate.detourCents;
    openModal(`<h2>${t('Fahrt abbrechen')}</h2>
      <p>${withDetour ? t('Bei einem Abbruch wird nur die bisher gefahrene Strecke berechnet (zurzeit <b>{km}</b> plus Anfahrt zum Treffpunkt).', { km: driven }) : t('Bei einem Abbruch wird nur die bisher gefahrene Strecke berechnet (zurzeit <b>{km}</b>).', { km: driven })} ${info(`<p>${t('Ohne Abbruch ist mit dem Einsteigen der Preis der geplanten Route fällig – auch wenn ihr früher aussteigt. So lohnt sich ein abgesprochenes vorzeitiges Ende nicht.')}</p><p>${t('Jeder Abbruch zählt in der Fahrtabbruchsquote von Fahrer und Mitfahrer und ist in beiden Profilen sichtbar.')}</p>`)}</p>
      <form id="abort-form">
        <label for="ab-cat">${t('Grund')}</label>
        <select id="ab-cat" required><option value="">${t('Bitte wählen')}</option>${(state.config.abortReasons || []).map((x) => `<option value="${x.id}">${esc(t(x.label))}</option>`).join('')}</select>
        <label for="ab-reason">${t('Begründung')}</label>
        <textarea id="ab-reason" maxlength="500" minlength="10" required placeholder="${esc(t('Was ist passiert?'))}"></textarea>
        <ul class="errors" id="ab-errors"></ul>
        <div class="btn-row"><button class="danger" id="ab-submit">${t('Fahrt abbrechen und abrechnen')}</button><button type="button" class="secondary" id="ab-cancel">${t('Weiterfahren')}</button></div>
      </form>`);
    $('#ab-cancel').onclick = closeModal;
    $('#abort-form').onsubmit = (e) => {
      e.preventDefault();
      guard(async () => {
        try {
          const { ride: done } = await api(`/api/rides/${b.dataset.abort}/abort`, { category: $('#ab-cat').value, reason: $('#ab-reason').value });
          closeModal();
          toast(t('Fahrt abgebrochen. Abgerechnet: {km} · {amount}', { km: km(done.final.km), amount: euro(done.role === 'driver' ? done.final.driverCents : done.final.totalCents) }));
          await refreshMe();
          render();
        } catch (err) {
          if (err.status !== 400) throw err;
          $('#ab-errors').innerHTML = `<li>${esc(err.message)}</li>`;
        }
      }, $('#ab-submit'));
    };
  }));
  root.querySelectorAll('[data-dispute]').forEach((b) => (b.onclick = () => {
    openModal(`<h2>${t('Problem melden')}</h2>
      <p class="muted">${t('Die Fahrt wird dann nicht automatisch abgerechnet. Der Betreiber prüft den Fall und meldet sich bei euch.')}</p>
      <form id="dispute-form"><label for="d-reason">${t('Was ist passiert?')}</label><textarea id="d-reason" maxlength="500" required></textarea>
      <div class="btn-row"><button class="danger">${t('Reklamation senden')}</button></div></form>`);
    $('#d-reason').focus();
    $('#dispute-form').onsubmit = (e) => {
      e.preventDefault();
      guard(async () => {
        await api(`/api/rides/${b.dataset.dispute}/dispute`, { reason: $('#d-reason').value });
        closeModal();
        toast(t('Reklamation gesendet.'));
        render();
      });
    };
  }));
}

async function renderRider(panel) {
  await loadRides();
  const ride = activeRiderRide();
  if (ride) return renderRiderRide(panel, ride);

  panel.innerHTML = `
    <div class="card">
      <h2>${t('Wohin möchtest du?')} ${info(`<p>${t('<b>Tipp:</b> Abholort und Ziel kannst du auch direkt auf der Karte anklicken – erst A, dann B.')}</p><p>${t('„Standort“ nutzt deinen aktuellen Standort.')}</p>`)}</h2>
      ${placeField('pickup', t('Abholort'), t('Adresse oder Ort'), true)}
      ${placeField('dropoff', t('Ziel'), t('Wohin soll es gehen?'))}
      <div class="row">
        <div>
          <label for="r-seats">${t('Personen')}</label>
          <select id="r-seats">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${n === state.seats ? 'selected' : ''}>${num(n)}</option>`).join('')}</select>
        </div>
        <div class="shrink"><button id="r-search">${t('Besten Fahrer finden')}</button></div>
      </div>
    </div>
    <div id="matches"></div>`;
  bindPlaceFields(panel);
  $('#r-seats').onchange = (e) => (state.seats = Number(e.target.value));
  $('#r-search').onclick = (e) => guard(searchMatches, e.target);
  if (state.matches.length) renderMatches();
  else previewPlaces();
}

async function searchMatches() {
  const pickup = await ensurePlace('pickup');
  const dropoff = await ensurePlace('dropoff');
  if (!pickup || !dropoff) throw new Error(t('Bitte Abholort und Ziel angeben.'));
  const res = await api('/api/match', { pickup, dropoff, seats: state.seats, filters: state.filters });
  const { matches, activeDrivers, plannedRoute } = res;
  state.matchResult = res;
  state.matches = matches;
  state.plannedRoute = plannedRoute;
  state.selected = matches[0] || null;
  state.activeDrivers = activeDrivers;
  if (!matches.length) {
    $('#matches').innerHTML = res.hiddenByFilters
      ? `<div class="card"><h3>${t('Kein passender Fahrer')}</h3>${filterSummary(res)}</div>`
      : `<div class="card"><h3>${t('Gerade kein passender Fahrer')} ${info(tn(activeDrivers, '{n} Fahrer ist gerade unterwegs, fährt aber nicht in der Nähe deiner Strecke vorbei. Versuche es in ein paar Minuten erneut.', '{n} Fahrer sind gerade unterwegs, aber keiner fährt in der Nähe deiner Strecke vorbei. Versuche es in ein paar Minuten erneut.'))}</h3><p class="muted">${t('Bitte später noch einmal versuchen.')}</p></div>`;
    previewPlaces();
    return;
  }
  renderMatches();
}

async function renderMatches() {
  const box = $('#matches');
  if (!box) return;
  box.innerHTML = `<div class="card"><h2>${tn(state.matches.length, '{n} passender Fahrer', '{n} passende Fahrer')} ${info(`<p><b>${t('Sortiert nach kürzestem Umweg')}</b></p><p>${t('Ganz oben steht immer der Fahrer, der für dich den geringsten Umweg fährt – das spart die meisten zusätzlichen Kilometer. Bei gleichem Umweg entscheidet die kürzere Wartezeit.')}</p>`)}</h2>
    ${state.matchResult ? filterSummary(state.matchResult) : ''}
    ${state.matches.map((m, i) => `
      <div class="match ${state.selected && state.selected.tripId === m.tripId ? 'selected' : ''}" data-i="${i}">
        <div class="top">
          <div>${profileLink(m.driverId, m.driverName)} ${i === 0 ? `<span class="badge best" tabindex="0" data-tip="${esc(t('Sortiert nach dem kürzesten Umweg des Fahrers – so entstehen die wenigsten zusätzlichen Kilometer.'))}">${t('Kürzester Umweg')}</span>` : ''}<br>
            ${npsBadge(m.driverNps)} ${abortBadge(m.driverAbort, 'driver')} ${prefIcons(m)}<br><span class="muted small">${esc(m.vehicle || t('Pkw'))} · ${t('{n} frei', { n: num(m.seatsFree) })}</span></div>
          <div class="price">${euro(m.price.totalCents)}</div>
        </div>
        <div class="muted small" style="margin-top:6px">
          ${t('{detour} Umweg · {eta} Wartezeit · {co2} kg CO₂ gespart', { detour: km(m.detourKm), eta: minutes(m.etaMin), co2: kg(m.price.co2SavedKg) })} ${info(`<table><tr><td>${t('Abholung in ca.')}</td><td>${minutes(m.etaMin)}</td></tr><tr><td>${t('Umweg für den Fahrer')}</td><td>${km(m.detourKm)}</td></tr><tr><td>${t('davon Anfahrt zum Treffpunkt')}</td><td>${km(m.pickupDetourKm)}</td></tr><tr><td>${t('CO₂-Ersparnis')}</td><td>${kg(m.price.co2SavedKg)} kg</td></tr></table><p style="margin-top:6px">${t('Fahrer fährt (ungefähr): {from} → {to}. Start und Ziel des Fahrers zeigen wir zum Schutz seiner Adresse nur ungefähr.', { from: esc(shortLabel(m.origin)), to: esc(shortLabel(m.destination)) })}</p>`, t('Details zur Fahrt'))}
        </div>
      </div>`).join('')}
    </div>
    ${state.selected ? `<div class="card">
        <h3>${t('Deine Fahrt bestätigen')}</h3>
        ${plannedRouteHtml(state.plannedRoute)}
      </div>` + priceCard(state.selected.price, t('Preis (Höchstbetrag)')) + `<button class="full" id="r-book">${t('Route bestätigen & bei {name} anfragen', { name: esc(state.selected.driverName) })}</button>` : ''}`;
  box.querySelectorAll('.match').forEach((el) =>
    el.addEventListener('click', () => {
      state.selected = state.matches[el.dataset.i];
      renderMatches();
    }),
  );
  const book = $('#r-book');
  if (book) book.onclick = () => guard(bookSelected, book);
  await showMatchOnMap(state.selected);
}

async function showMatchOnMap(m) {
  const points = [
    { ...state.places.pickup, color: '#4a9a6e', text: 'A' },
    { ...state.places.dropoff, color: '#1c3a2a', text: 'B' },
  ];
  if (!m) return drawMap({ points });
  try {
    const { trip } = await api('/api/trips/' + m.tripId);
    drawMap({ routes: [{ coords: trip.route.coords, color: '#b7e0c7', weight: 6, opacity: 0.9 }, { coords: state.plannedRoute.coords, ...PLANNED_STYLE }], points, driver: trip.position });
  } catch {
    drawMap({ routes: state.plannedRoute ? [{ coords: state.plannedRoute.coords, ...PLANNED_STYLE }] : [], points });
  }
}

function priceCard(p, title) {
  const calc = p.seats > 1
    ? t('{km} × {rate} × {seats} Pers.', { km: km(p.km), rate: euro(p.ratePerKmCents), seats: num(p.seats) })
    : `${km(p.km)} × ${euro(p.ratePerKmCents)}`;
  const split = `<table><tr><td>${calc}</td><td>${euro(p.fareCents)}</td></tr><tr><td>${t('davon an den Fahrer')}</td><td>${euro(p.driverCents)}</td></tr><tr><td>${t('davon Vermittlungsprovision')}</td><td>${euro(p.commissionCents)}</td></tr><tr><td>${t('Spende Umweltschutz')}</td><td>${euro(p.donationCents)}</td></tr></table><p style="margin-top:6px">${t('Provision nur auf die gemeinsame Strecke – nicht auf die Anfahrt zum Treffpunkt.')}</p>`;
  return `<div class="card"><h3>${title} ${info(TIP.price())}</h3>
    <table class="breakdown">
      <tr><td>${withTip(t('Fahrtkosten {km}', { km: km(p.km) }), split)}</td><td>${euro(p.fareCents)}</td></tr>
      ${p.detourCents ? `<tr><td>${t('Anfahrt zum Treffpunkt {km}', { km: km(p.detourKm) })} ${info(TIP.detour())}</td><td>${euro(p.detourCents)}</td></tr>` : ''}
      <tr><td>${t('Umweltspende')}</td><td>${euro(p.donationCents)}</td></tr>
      <tr class="total"><td>${t('Gesamt')} ${info(TIP.billing())}</td><td>${euro(p.totalCents)}</td></tr>
    </table>
  </div>`;
}

async function bookSelected() {
  const m = state.selected;
  try {
    await api('/api/rides', {
      tripId: m.tripId,
      pickup: state.places.pickup,
      dropoff: state.places.dropoff,
      seats: state.seats,
      confirmPlannedRoute: true,
      plannedKm: state.plannedRoute.distanceKm,
    });
  } catch (err) {
    if (err.status === 402) {
      toast(err.message + ' ' + t('Bitte Guthaben im Konto aufladen.'));
      location.hash = '#/konto';
      return;
    }
    throw err;
  }
  toast(t('Route bestätigt und angefragt – der Fahrer muss die Route ebenfalls bestätigen.'));
  state.matches = [];
  render();
}

async function renderRiderRide(panel, ride) {
  const draw = async (fit) => {
    let trip = null;
    try { trip = (await api('/api/trips/' + ride.tripId)).trip; } catch {}
    drawMap({
      routes: [...(trip ? [{ coords: trip.route.coords, color: '#b7e0c7', weight: 6, opacity: 0.9 }] : []), ...(ride.plannedRoute ? [{ coords: ride.plannedRoute.coords, ...PLANNED_STYLE }] : [])],
      points: [
        { ...ride.pickup, color: '#4a9a6e', text: 'A' },
        { ...ride.dropoff, color: '#1c3a2a', text: 'B' },
      ],
      driver: trip && trip.position,
      fit,
    });
  };
  const routeNote = [ride.myRouteConfirmed ? t('✓ von dir bestätigt') : '', ride.partnerRouteConfirmed ? t('✓ vom Fahrer bestätigt') : t('○ Fahrer hat noch nicht bestätigt')].filter(Boolean).join(' · ');
  panel.innerHTML = `
    <div class="card">
      <h2>${t('Deine Mitfahrt')}</h2>
      ${statusBadge(ride.status)}
      <p>${profileLink(ride.driverId, ride.driverName)} ${ride.vehicle ? '· ' + esc(ride.vehicle) : ''} ${abortBadge(ride.partnerAbort, 'driver')}</p>
      <p class="muted small">${esc(shortLabel(ride.pickup))} → ${esc(shortLabel(ride.dropoff))}</p>
      ${ride.plannedRoute ? plannedRouteHtml(ride.plannedRoute, routeNote) : ''}
      ${['requested', 'accepted'].includes(ride.status) ? `<button class="secondary" id="r-cancel" style="margin-top:10px">${t('Stornieren')}</button>` : ''}
    </div>
    ${['picked_up', 'confirming'].includes(ride.status) ? confirmationCard(ride) : priceCard(ride.estimate, t('Preis (Höchstbetrag)'))}`;
  bindConfirmButtons(panel);
  const c = $('#r-cancel');
  if (c) c.onclick = () => guard(async () => { await api(`/api/rides/${ride.id}/cancel`, {}); await refreshMe(); render(); }, c);
  await draw(true);
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try { await loadRides(); } catch { return; }
    const now = state.rides.find((r) => r.id === ride.id);
    if (!now || now.status !== ride.status || now.partnerEndConfirmed !== ride.partnerEndConfirmed || (now.status === 'picked_up' && now.trackedKm !== ride.trackedKm)) {
      if (now && now.status === 'completed') toast(t('Fahrt abgerechnet: {km} · {amount} – danke fürs Teilen', { km: km(now.final.km), amount: euro(now.final.totalCents) }));
      if (now && now.status === 'declined') toast(t('Der Fahrer hat abgelehnt. Bitte wähle einen anderen Fahrer.'));
      try { await refreshMe(); } catch {}
      return render();
    }
    await draw(false);
  }, 4000);
}

async function loadRides() {
  const { rides } = await api('/api/rides');
  state.rides = rides;
}

// ---------- Fahrer ----------
async function renderDriver(panel) {
  if (!state.me.canDrive) return renderLicense(panel);
  const { trip } = await api('/api/trips/active');
  state.trip = trip;
  if (trip) return renderActiveTrip(panel);

  panel.innerHTML = `
    <div class="card">
      <h2>${t('Jetzt als Fahrer online gehen')} ${info(`<p>${t('Du fährst sowieso? Gib deine Route ein oder füge den Link deiner Google-Maps-Route ein – Mitfahrer auf deinem Weg finden dich automatisch.')}</p><p>${t('Start und Ziel zeigen wir anderen nur ungefähr.')}</p>`)}</h2>
      <label for="d-link">${t('Google-Maps-Routenlink')} ${info(`<p>${t('In Google Maps die Route planen → „Teilen“ → Link kopieren.')}</p><p>${t('Funktioniert mit google.com/maps/dir/… und Kurzlinks maps.app.goo.gl/…')}</p>`)}</label>
      <input id="d-link" placeholder="${esc(t('https://www.google.com/maps/dir/…  oder  https://maps.app.goo.gl/…'))}">
      <p class="muted small" style="text-align:center;margin:10px 0 0">${t('– oder –')}</p>
      ${placeField('origin', t('Start'), t('Wo startest du?'), true)}
      ${placeField('destination', t('Ziel'), t('Wohin fährst du?'))}
      <div class="row">
        <div><label for="d-seats">${t('Freie Plätze')}</label>
          <select id="d-seats">${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${num(n)}</option>`).join('')}</select></div>
        <div><label for="d-vehicle">${t('Fahrzeug (optional)')}</label><input id="d-vehicle" placeholder="${esc(t('z. B. blauer VW Golf'))}"></div>
      </div>
      <div class="btn-row">
        <button class="secondary" id="d-preview">${t('Route anzeigen')}</button>
        <button id="d-start">${t('Online gehen')}</button>
      </div>
    </div>
    <div id="d-route"></div>`;
  bindPlaceFields(panel);
  const routeBody = async () => {
    const link = $('#d-link').value.trim();
    if (link) return { googleMapsUrl: link };
    const origin = await ensurePlace('origin');
    const destination = await ensurePlace('destination');
    if (!origin || !destination) throw new Error(t('Bitte Start und Ziel oder einen Google-Maps-Link angeben.'));
    return { origin, destination };
  };
  $('#d-preview').onclick = (e) =>
    guard(async () => {
      const { route } = await api('/api/route/preview', await routeBody());
      const share = Math.round(route.distanceKm * state.config.pricing.ratePerKmCents * (1 - state.config.pricing.commissionPercent / 100)) * Number($('#d-seats').value);
      $('#d-route').innerHTML = `<div class="card"><h3>${esc(shortLabel(route.origin))} → ${esc(shortLabel(route.destination))}</h3>
        <p class="muted">${km(route.distanceKm)} · ${t('ca. {min}', { min: minutes(route.durationMin) })} ${info(`<p>${t('Quelle: {provider}', { provider: esc(route.provider) })}</p><p>${t('Bei voll besetzten Plätzen könntest du bis zu <b>{amount}</b> deiner Fahrtkosten teilen.', { amount: euro(share) })}</p>`)}</p></div>`;
      drawMap({ routes: [{ coords: route.coords }], points: [{ ...route.origin, color: '#4a9a6e', text: 'S' }, { ...route.destination, color: '#1c3a2a', text: 'Z' }] });
    }, e.target);
  $('#d-start').onclick = (e) =>
    guard(async () => {
      await api('/api/trips', { ...(await routeBody()), seats: Number($('#d-seats').value), vehicle: $('#d-vehicle').value });
      toast(t('Du bist online – Mitfahrer können dich jetzt finden.'));
      render();
    }, e.target);
  previewPlaces();
}

async function renderActiveTrip(panel) {
  const trip = state.trip;
  await loadRides();
  const rides = state.rides.filter((r) => r.tripId === trip.id && OPEN_STATES.includes(r.status));
  const tracking = state.gpsWatch !== null || state.simTimer !== null;
  panel.innerHTML = `
    <div class="card">
      <h2>${t('Du bist online')}</h2>
      ${mfaHint()}
      <p><b>${esc(shortLabel(trip.origin))}</b> → <b>${esc(shortLabel(trip.destination))}</b></p>
      <p class="muted small">${t('{km} · {free} von {seats} Plätzen frei · zurückgelegt {progress}', { km: km(trip.route.distanceKm), free: num(trip.seatsFree), seats: num(trip.seats), progress: km(trip.progressKm || 0) })}</p>
      <div class="btn-row">
        ${tracking ? `<button class="secondary" id="d-stoptrack">${t('Standort-Übertragung stoppen')}</button>` : `<button id="d-gps">${t('GPS-Standort teilen')}</button><button class="secondary" id="d-sim">${t('Fahrt simulieren (Demo)')}</button>`}
        <button class="danger" id="d-end">${t('Fahrt beenden')}</button>
      </div>
      <p class="muted small">${t('GPS misst die gefahrenen Kilometer')} ${info(TIP.billing('mitfahrer') + `<p>${t('Dein Standort wird nur während der aktiven Fahrt übertragen und nur bestätigten Mitfahrern angezeigt.')}</p>`)}</p>
    </div>
    <div class="card">
      <h2>${t('Mitfahrer')}</h2>
      ${rides.length ? rides.map(driverRideCard).join('') : `<p class="muted">${t('Noch keine Anfragen')} ${info(t('Sobald jemand auf deiner Route mitfahren möchte, erscheint die Anfrage hier – du bekommst einen Hinweis.'))}</p>`}
    </div>`;

  panel.querySelectorAll('[data-act]').forEach((btn) =>
    btn.addEventListener('click', () =>
      guard(async () => {
        const body = btn.dataset.act === 'accept' ? { confirmPlannedRoute: true } : {};
        await api(`/api/rides/${btn.dataset.id}/${btn.dataset.act}`, body);
        await refreshMe();
        render();
      }, btn),
    ),
  );
  bindConfirmButtons(panel);
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('#d-gps', startGps);
  on('#d-sim', startSimulation);
  on('#d-stoptrack', () => { stopDriving(); render(); });
  on('#d-end', (e) => guard(async () => {
    await api(`/api/trips/${trip.id}/end`, {});
    stopDriving();
    toast(t('Fahrt beendet. Danke fürs Teilen!'));
    render();
  }, e.target));

  const points = [{ ...trip.origin, color: '#4a9a6e', text: 'S' }, { ...trip.destination, color: '#1c3a2a', text: 'Z' }];
  rides.forEach((r) => {
    points.push({ ...r.pickup, color: '#78bf96', text: '↑', label: t('Abholen: {name}', { name: r.riderName }) });
    points.push({ ...r.dropoff, color: '#2f7350', text: '↓', label: t('Absetzen: {name}', { name: r.riderName }) });
  });
  const planned = rides.filter((r) => r.plannedRoute && ['requested', 'accepted', 'picked_up'].includes(r.status)).map((r) => ({ coords: r.plannedRoute.coords, ...PLANNED_STYLE }));
  drawMap({ routes: [{ coords: trip.route.coords }, ...planned], points, driver: trip.position, fit: !renderActiveTrip.fitted });
  renderActiveTrip.fitted = true;

  const sig = (list) => JSON.stringify(list.map((r) => [r.id, r.status, r.trackedKm, r.partnerEndConfirmed]));
  const signature = sig(rides);
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try {
      const [{ trip: tr }] = await Promise.all([api('/api/trips/active'), loadRides()]);
      if (!tr) return render();
      state.trip = tr;
      updateDriverMarker(tr.position);
      const now = state.rides.filter((r) => r.tripId === tr.id && OPEN_STATES.includes(r.status));
      if (sig(now) !== signature) {
        const done = state.rides.find((r) => r.tripId === tr.id && r.status === 'completed' && rides.find((o) => o.id === r.id));
        if (done) toast(t('Fahrt mit {name} abgerechnet: {km} · du erhältst {amount}', { name: done.riderName, km: km(done.final.km), amount: euro(done.final.driverCents) }));
        if (now.some((r) => r.status === 'requested' && !rides.find((o) => o.id === r.id))) toast(t('Neue Mitfahranfrage!'));
        render();
      }
    } catch {}
  }, 4000);
}

function driverRideCard(r) {
  const actions = {
    requested: `<button data-act="accept" data-id="${r.id}">${t('Route bestätigen & annehmen')}</button><button class="secondary" data-act="decline" data-id="${r.id}">${t('Ablehnen')}</button>`,
    accepted: `<button data-act="pickup" data-id="${r.id}">${t('Eingestiegen')}</button><button class="secondary" data-act="cancel" data-id="${r.id}">${t('Stornieren')}</button>`,
  }[r.status] || '';
  const routeNote = [t('dein Anteil max. <b>{amount}</b>', { amount: euro(r.estimate.driverCents) }), r.partnerRouteConfirmed ? t('✓ Mitfahrer') : '', r.myRouteConfirmed ? t('✓ du') : ''].filter(Boolean).join(' · ');
  return `<div class="match">
    <div class="top"><span>${profileLink(r.riderId, r.riderName)} ${abortBadge(r.partnerAbort, 'rider')}</span> ${statusBadge(r.status)}</div>
    <div class="muted small">${t('{n} Pers.', { n: num(r.seats) })} · ${esc(shortLabel(r.pickup))} → ${esc(shortLabel(r.dropoff))} ${info(t('Umweg für dich: ca. {km}', { km: km(r.detourKm) }))}</div>
    ${r.plannedRoute && ['requested', 'accepted'].includes(r.status) ? plannedRouteHtml(r.plannedRoute, routeNote) : ''}
    ${['picked_up', 'confirming'].includes(r.status) ? confirmationCard(r) : ''}
    ${actions ? `<div class="btn-row">${actions}</div>` : ''}
  </div>`;
}

let lastSent = 0;
async function sendPosition(pos, force) {
  if (!state.trip) return;
  if (!force && Date.now() - lastSent < 3000) return;
  lastSent = Date.now();
  try {
    const { trip } = await api(`/api/trips/${state.trip.id}/position`, pos);
    state.trip.position = trip.position;
    state.trip.progressKm = trip.progressKm;
    updateDriverMarker(trip.position);
  } catch (err) {
    toast(err.message);
    stopDriving();
  }
}

function startGps() {
  if (!navigator.geolocation) return toast(t('GPS ist auf diesem Gerät nicht verfügbar.'));
  state.gpsWatch = navigator.geolocation.watchPosition(
    (p) => sendPosition({ lat: p.coords.latitude, lng: p.coords.longitude }),
    (err) => { toast(t('GPS-Fehler: {message}', { message: err.message })); stopDriving(); render(); },
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
  render();
}

// Demo: bewegt das Fahrzeug entlang der Route, damit der Ablauf ohne echte Fahrt testbar ist.
function startSimulation() {
  const coords = state.trip.route.coords;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distKm(coords[i - 1], coords[i]));
  const total = cum[cum.length - 1];
  const step = Math.max(0.2, total / 120);
  let along = state.trip.progressKm || 0;
  state.simTimer = setInterval(() => {
    along = Math.min(total, along + step);
    sendPosition(pointAlong(coords, cum, along), true);
    if (along >= total) { clearInterval(state.simTimer); state.simTimer = null; toast(t('Simulation: Ziel erreicht.')); }
  }, 1500);
  render();
}

function stopDriving() {
  if (state.gpsWatch !== null) navigator.geolocation.clearWatch(state.gpsWatch);
  clearInterval(state.simTimer);
  state.gpsWatch = null;
  state.simTimer = null;
}

function distKm(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

function pointAlong(coords, cum, along) {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < along) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const f = Math.min(1, Math.max(0, (along - cum[i - 1]) / seg));
  return { lat: coords[i - 1].lat + f * (coords[i].lat - coords[i - 1].lat), lng: coords[i - 1].lng + f * (coords[i].lng - coords[i - 1].lng) };
}

// ---------- Führerschein-Verifizierung ----------
function renderLicense(panel) {
  drawMap();
  const lic = state.me.license;
  if (lic && lic.status === 'pending') {
    panel.innerHTML = `<div class="card"><h2>${t('Führerschein wird geprüft')} ${info(t('Sobald dein Führerschein bestätigt ist, kannst du sofort als Fahrer online gehen.'))}</h2>
      <p><span class="badge warn">${t('In Prüfung')}</span></p>
      <p class="muted">${t('Nr. {number} · Klassen {classes} · gültig bis {date}', { number: esc(lic.number), classes: esc(lic.classes.join(', ')), date: fmtDate(lic.expiry) })}</p>
      <button class="secondary" id="l-refresh">${t('Status aktualisieren')}</button></div>`;
    $('#l-refresh').onclick = () => guard(async () => { await refreshMe(); render(); });
    return;
  }
  panel.innerHTML = `
    <div class="card">
      <h2>${t('Als Fahrer legitimieren')} ${info(`<p>${t('Um Mitfahrer mitzunehmen, brauchst du einen gültigen Führerschein (mind. Klasse B).')}</p><p>${t('Die Fotos sieht nur der Betreiber zur Prüfung – danach werden sie gelöscht.')}</p>`)}</h2>
      ${lic && lic.status === 'rejected' ? `<p><span class="badge bad">${t('Abgelehnt')}</span> ${esc(lic.reviewNote)}</p>` : ''}
      ${lic && lic.status === 'verified' ? `<p><span class="badge bad">${t('Abgelaufen')}</span> ${t('Bitte aktuellen Führerschein einreichen.')}</p>` : ''}
      <form id="l-form">
        <label for="l-name">${t('Name laut Führerschein')}</label><input id="l-name" value="${esc(state.me.name)}" required>
        <label for="l-birth">${t('Geburtsdatum')}</label><input id="l-birth" type="date" required>
        <label for="l-number">${t('Führerscheinnummer (Feld 5)')}</label><input id="l-number" maxlength="13" placeholder="${esc(t('z. B. B072RRE2I55'))}" required>
        <div class="row">
          <div><label for="l-classes">${t('Klassen (Feld 9)')}</label><input id="l-classes" value="AM, B, L" required></div>
          <div><label for="l-expiry">${t('Gültig bis (Feld 4b)')}</label><input id="l-expiry" type="date" required></div>
        </div>
        <label for="l-front">${t('Foto Vorderseite')}</label><input id="l-front" type="file" accept="image/*" capture="environment" required>
        <label for="l-back">${t('Foto Rückseite')}</label><input id="l-back" type="file" accept="image/*" capture="environment" required>
        <ul class="errors" id="l-errors"></ul>
        <button class="full" style="margin-top:12px" id="l-submit">${t('Zur Prüfung einreichen')}</button>
      </form>
    </div>`;
  $('#l-form').onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      try {
        const [frontImage, backImage] = await Promise.all([resizeImage($('#l-front').files[0]), resizeImage($('#l-back').files[0])]);
        const { user } = await api('/api/license', {
          fullName: $('#l-name').value,
          birthdate: $('#l-birth').value,
          number: $('#l-number').value,
          classes: $('#l-classes').value,
          expiry: $('#l-expiry').value,
          frontImage,
          backImage,
        });
        state.me = user;
        toast(t('Eingereicht – wir prüfen deinen Führerschein.'));
        render();
      } catch (err) {
        if (err.details) $('#l-errors').innerHTML = err.details.map((d) => `<li>${esc(d)}</li>`).join('');
        else throw err;
      }
    }, $('#l-submit'));
  };
}

function resizeImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error(t('Bitte beide Fotos auswählen.')));
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error(t('Bild konnte nicht gelesen werden.')));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- Konto ----------
function abortedByText(r) {
  const by = r.abort.by === r.role ? t('Abgebrochen von dir') : r.role === 'rider' ? t('Abgebrochen vom Fahrer') : t('Abgebrochen vom Mitfahrer');
  return `${by}: ${abortReasonLabel(r.abort.category)} – ${r.abort.reason}`;
}

async function renderAccount(panel) {
  drawMap();
  const [{ transactions }] = await Promise.all([api('/api/wallet/transactions'), loadRides()]);
  const me = state.me;
  const done = state.rides.filter((r) => r.status === 'completed');
  const quote = (st) => (st.rides ? `${num(st.quote)} %` : '–');
  panel.innerHTML = `
    <div class="card">
      <h2>${t('Mein Konto')}</h2>
      <div class="stats">
        <div class="stat"><b>${euro(me.walletCents - me.reservedCents)}</b><span>${me.reservedCents ? t('verfügbares Guthaben ({amount} reserviert)', { amount: euro(me.reservedCents) }) : t('verfügbares Guthaben')}</span></div>
        <div class="stat"><b>${kg(me.co2SavedKg)} kg</b><span>${t('CO₂ gemeinsam eingespart')}</span></div>
        <div class="stat"><b>${me.nps.count ? signed(me.nps.score) : '–'}</b><span>${t('dein NPS ({ratings}: {split})', { ratings: bewertungen(me.nps.count), split: npsSplit(me.nps) })}</span></div>
        <div class="stat"><b>${me.abortStats.asDriver.rides || me.abortStats.asRider.rides ? `${quote(me.abortStats.asDriver)} / ${quote(me.abortStats.asRider)}` : '–'}</b><span>${t('Fahrtabbruchsquote Fahrer / Mitfahrer')} ${info(`<p>${t('Anteil abgebrochener Fahrten an allen deinen Fahrten.')}</p><table><tr><td>${t('als Fahrer')}</td><td>${t('{aborted} von {rides}', { aborted: num(me.abortStats.asDriver.aborted), rides: num(me.abortStats.asDriver.rides) })}</td></tr><tr><td>${t('als Mitfahrer')}</td><td>${t('{aborted} von {rides}', { aborted: num(me.abortStats.asRider.aborted), rides: num(me.abortStats.asRider.rides) })}</td></tr></table><p style="margin-top:6px">${t('Sichtbar in deinem Profil für Fahrtpartner.')}</p>`)}</span></div>
        <div class="stat"><b>${me.canDrive ? t('ja') : t('nein')}</b><span>${t('Fahrer verifiziert')}</span></div>
      </div>
      ${state.config && state.config.demoTopup === false ? '' : `<h3 style="margin-top:14px">${t('Guthaben aufladen')} ${info(t('Demo-Zahlung. Im Livebetrieb läuft die Zahlung über einen Zahlungsdienstleister.'))}</h3>
      <div class="btn-row">${[1000, 2000, 5000].map((c) => `<button class="secondary" data-topup="${c}">+ ${euro(c)}</button>`).join('')}</div>`}
    </div>
    <div class="card">
      <h2>${t('Fahrten')}</h2>
      ${done.length ? done.map((r) => `
        <div class="match">
          <div class="top"><span>${r.role === 'rider' ? t('Mitgefahren bei <b>{name}</b>', { name: esc(r.driverName) }) : t('Mitgenommen: <b>{name}</b>', { name: esc(r.riderName) })}${r.abort ? ` <span class="badge warn" tabindex="0" data-tip="${esc(abortedByText(r))}">${t('Fahrtabbruch')}</span>` : ''}</span>
            <b>${r.role === 'rider' ? '−' + euro(r.final.totalCents) : '+' + euro(r.final.driverCents)}</b></div>
          <div class="muted small">${fmtDate(r.completedAt)} · ${km(r.final.km)} · ${kg(r.final.co2SavedKg)} kg CO₂ ${info(`<table><tr><td>${t('Abgerechnet')}</td><td>${km(r.final.km)}</td></tr><tr><td>${t('Grundlage')}</td><td>${basisLabel(r.final.billing)}</td></tr>${r.final.plannedKm ? `<tr><td>${t('Geplante Route')}</td><td>${km(r.final.plannedKm)}</td></tr><tr><td>${t('Gefahren (GPS)')}</td><td>${r.final.trackedKm > 0.2 ? km(r.final.trackedKm) : '–'}</td></tr>` : ''}${r.final.detourCents ? `<tr><td>${t('Anfahrt zum Treffpunkt')}</td><td>${t('{km} · {amount} (ohne Provision)', { km: km(r.final.detourKm), amount: euro(r.final.detourCents) })}</td></tr>` : ''}<tr><td>${t('CO₂ gespart')}</td><td>${kg(r.final.co2SavedKg)} kg</td></tr><tr><td>${t('Umweltspende')}</td><td>${euro(r.final.donationCents)}</td></tr></table><p style="margin-top:6px">${fmtDateTime(r.completedAt)}</p>`, t('Details zur Abrechnung'))}</div>
          <div class="small">${ridePointsLine(r.myPoints)}</div>
          ${r.role === 'rider' ? riderGuestbookLine(r) : ''}
          ${r.myRating ? `<div class="muted small">${t('Deine Bewertung: <b>{score}</b>/10', { score: num(r.myRating.score) })}${r.myRating.aspects && r.myRating.aspects.length ? ` · ${t('Gründe: {list}', { list: r.myRating.aspects.map((id) => esc(aspectLabel(r.role === 'rider' ? 'driver' : 'rider', id))).join(', ') })}` : ''}</div>` : `<form class="nps-form" data-rate-form="${r.id}">${npsWidget(t('Wie wahrscheinlich ist es, dass du {name} weiterempfiehlst?', { name: r.role === 'rider' ? r.driverName : r.riderName }), r.role === 'rider' ? 'driver' : 'rider')}<div class="btn-row"><button data-submit disabled>${t('Bewertung senden')}</button></div></form>`}
        </div>`).join('') : `<p class="muted">${t('Noch keine abgeschlossenen Fahrten.')}</p>`}
    </div>
    <div class="card">
      <h2>${t('Kontobewegungen')}</h2>
      <table class="breakdown">${transactions.map((tx) => `<tr><td>${esc(tMsg(tx.note))}<br><span class="muted small">${fmtDateTime(tx.at)}</span></td><td>${euro(tx.amountCents)}</td></tr>`).join('') || `<tr><td class="muted">${t('Keine Buchungen')}</td><td></td></tr>`}</table>
    </div>`;
  panel.querySelectorAll('[data-topup]').forEach((b) =>
    (b.onclick = () => guard(async () => { await api('/api/wallet/topup', { amountCents: Number(b.dataset.topup) }); toast(t('Guthaben aufgeladen.')); render(); }, b)),
  );
  bindGuestbookButtons(panel);
  bindNpsForms(panel, '[data-rate-form]', async (form, body) => {
    await api(`/api/rides/${form.dataset.rateForm}/rate`, body);
    toast(t('Danke für deine Bewertung!'));
    render();
  });
}

// ---------- Betreiber ----------
async function renderAdmin(panel) {
  drawMap();
  const [stats, { licenses }, { disputes }, { entries: gbEntries }, reviewCard] = await Promise.all([api('/api/admin/stats'), api('/api/admin/licenses'), api('/api/admin/disputes'), api('/api/admin/guestbook'), abortReviewCard()]);
  panel.innerHTML = `
    <div class="card">
      <h2>${t('Betreiber-Übersicht')}</h2>
      ${mfaHint(t('Als Betreiber hast du Zugriff auf Führerscheindaten aller Fahrer – bitte unbedingt die Zwei-Faktor-Anmeldung aktivieren.'))}
      <div class="stats">
        <div class="stat"><b>${euro(stats.commissionCents)}</b><span>${t('Provision (deine Einnahmen)')}</span></div>
        <div class="stat"><b>${euro(stats.donationCents)}</b><span>${t('Umweltspenden gesammelt')}</span></div>
        <div class="stat"><b>${num(stats.ridesCompleted)}</b><span>${t('abgeschlossene Mitfahrten')}</span></div>
        <div class="stat"><b>${km(stats.kmShared)}</b><span>${t('geteilte Kilometer')}</span></div>
        <div class="stat"><b>${kg(stats.co2SavedKg)} kg</b><span>${t('CO₂ eingespart')}</span></div>
        <div class="stat"><b>${stats.driverNps.count ? signed(stats.driverNps.score) : '–'}</b><span>${t('NPS der Fahrer ({ratings})', { ratings: bewertungen(stats.driverNps.count) })}</span></div>
        <div class="stat"><b>${num(stats.openDisputes)}</b><span>${t('offene Reklamationen')}</span></div>
        <div class="stat"><b>${num(stats.activeTrips)} / ${num(stats.verifiedDrivers)}</b><span>${t('Fahrer online / verifiziert')}</span></div>
      </div>
    </div>
    ${reviewCard}
    <div class="card">
      <h2>${t('Gästebuch-Einträge ({n})', { n: num(gbEntries.length) })} ${info(t('Neueste Einträge zur Moderation. Verfasser sind auch für dich nicht sichtbar.'))}</h2>
      ${gbEntries.length ? gbEntries.map((e) => `<blockquote class="gb-entry ${e.hidden ? 'is-hidden' : ''}"><p>${quoted(e.text)}</p><footer>${t('bei {name}', { name: esc(e.driverName) })} · ${gbMeta(e)}${e.hidden ? ` · ${t('vom Fahrer ausgeblendet')}` : ''} · <button class="linkish" data-gb-delete="${e.id}">${t('löschen')}</button></footer></blockquote>`).join('') : `<p class="muted">${t('Keine Einträge.')}</p>`}
    </div>
    <div class="card">
      <h2>${t('Reklamationen ({n})', { n: num(disputes.length) })}</h2>
      ${disputes.length ? disputes.map((r) => `
        <div class="match">
          <div class="top">${t('<b>{rider}</b> bei <b>{driver}</b>', { rider: esc(r.riderName), driver: esc(r.driverName) })}</div>
          <div class="small">${r.dispute.by === 'rider' ? t('Gemeldet von Mitfahrer: {reason}', { reason: quoted(r.dispute.reason) }) : t('Gemeldet von Fahrer: {reason}', { reason: quoted(r.dispute.reason) })}</div>
          <div class="muted small">${t('Geplant {planned} · gefahren {tracked} · nach Regel {billed} = {amount}', { planned: km(r.settlementPreview.plannedKm), tracked: r.settlementPreview.trackedKm > 0.2 ? km(r.settlementPreview.trackedKm) : '–', billed: km(r.settlementPreview.billedKm), amount: euro(r.settlementPreview.price.totalCents) })}</div>
          <div class="row"><div><label for="km-${r.id}">${t('km abrechnen (leer = Regel, max. {km})', { km: km(r.plannedKm) })}</label><input id="km-${r.id}" type="number" min="0" max="${r.plannedKm}" step="0.1"></div></div>
          <div class="btn-row">
            <button data-resolve="bill" data-ride="${r.id}">${t('Abrechnen')}</button>
            <button class="danger" data-resolve="cancel" data-ride="${r.id}">${t('Kostenlos stornieren')}</button>
          </div>
        </div>`).join('') : `<p class="muted">${t('Keine offenen Reklamationen.')}</p>`}
    </div>
    <div class="card">
      <h2>${t('Führerscheine prüfen ({n})', { n: num(licenses.length) })}</h2>
      ${licenses.length ? licenses.map((l) => `
        <div class="match">
          <b>${esc(l.fullName)}</b> <span class="muted small">(${esc(l.email)})</span>
          <div class="muted small">${t('Nr. {number} · Klassen {classes} · geb. {birth} · gültig bis {date}', { number: esc(l.number), classes: esc(l.classes.join(', ')), birth: fmtDate(l.birthdate), date: fmtDate(l.expiry) })}</div>
          <div class="license-imgs">
            <a href="/api/admin/licenses/${l.userId}/front" target="_blank"><img src="/api/admin/licenses/${l.userId}/front" alt="${esc(t('Vorderseite'))}"></a>
            <a href="/api/admin/licenses/${l.userId}/back" target="_blank"><img src="/api/admin/licenses/${l.userId}/back" alt="${esc(t('Rückseite'))}"></a>
          </div>
          <input placeholder="${esc(t('Notiz (bei Ablehnung)'))}" data-note="${l.userId}">
          <div class="btn-row">
            <button data-decide="verified" data-user="${l.userId}">${t('Bestätigen')}</button>
            <button class="danger" data-decide="rejected" data-user="${l.userId}">${t('Ablehnen')}</button>
          </div>
        </div>`).join('') : `<p class="muted">${t('Keine offenen Anträge.')}</p>`}
    </div>`;
  bindAbortReview(panel);
  bindGuestbookButtons(panel);
  panel.querySelectorAll('[data-resolve]').forEach((b) =>
    (b.onclick = () => guard(async () => {
      await api(`/api/admin/rides/${b.dataset.ride}/resolve`, { decision: b.dataset.resolve, km: $('#km-' + b.dataset.ride).value });
      toast(b.dataset.resolve === 'bill' ? t('Fahrt abgerechnet.') : t('Fahrt storniert.'));
      render();
    }, b)),
  );
  panel.querySelectorAll('[data-decide]').forEach((b) =>
    (b.onclick = () => guard(async () => {
      const note = panel.querySelector(`[data-note="${b.dataset.user}"]`).value;
      await api(`/api/admin/licenses/${b.dataset.user}`, { decision: b.dataset.decide, note });
      if (b.dataset.user === state.me.id) await refreshMe();
      render();
    }, b)),
  );
}

// ---------- Profile anderer Nutzer (Popup) ----------
function profileLink(userId, name) {
  return `<button type="button" class="linkish" data-profile="${esc(userId)}" aria-label="${esc(t('Profil von {name} ansehen', { name }))}">${esc(name)}</button>`;
}

function avatar(p, cls = '') {
  return p.hasPhoto
    ? `<img class="avatar ${cls}" src="/api/users/${esc(p.id)}/photo?v=${Date.now()}" alt="">`
    : `<span class="avatar ${cls}">${esc((p.name || '?')[0].toUpperCase())}</span>`;
}

const PREF_LABELS = { smoking: N_('Rauchen'), pets: N_('Tiere'), music: N_('Musik'), chat: N_('Unterhaltung') };
/** Zitat mit den Anführungszeichen der gewählten Sprache; text wird hier geschützt. */
const quoted = (text) => t('„{text}“', { text: esc(text) });
/** Gästebuch: Monat und Art der Fahrt */
const gbMeta = (e) => `${e.period ? esc(fmtMonth(e.period)) : esc(e.when)} · ${esc(tMsg(e.kind))}`;

function profileHtml(p) {
  return `
    <div class="profile-head">${avatar(p)}
      <div><h2 style="margin:0">${esc(p.name)}</h2>
        <div class="chips">
          ${p.verifiedDriver ? `<span class="badge ok">${t('Führerschein geprüft')}</span>` : ''}
          ${p.mfaEnabled ? `<span class="badge ok">${t('2FA gesichert')}</span>` : ''}
          ${npsBadge(p.nps)}
          ${p.abortStats && (p.verifiedDriver || p.abortStats.asDriver.rides) ? abortBadge(p.abortStats.asDriver, 'driver', true) : ''}
          ${p.abortStats && p.abortStats.asRider.rides ? abortBadge(p.abortStats.asRider, 'rider', true) : ''}
        </div>
      </div>
    </div>
    ${p.bio ? `<p>${esc(p.bio)}</p>` : ''}
    ${p.phone ? `<p>${t('Telefon:')} <a href="tel:${esc(p.phone.replace(/[^+0-9]/g, ''))}">${esc(p.phone)}</a></p>` : ''}
    ${p.vehicle && (p.vehicle.model || p.vehicle.brand) ? `<p class="muted">${t('Fahrzeug:')} ${esc([p.vehicle.color, p.vehicle.brand === 'Andere' ? t('Andere') : p.vehicle.brand, p.vehicle.model].filter(Boolean).join(' '))}${p.vehicle.plateRegion ? ` · <span class="plate"><span class="eu">D</span>${esc(p.vehicle.plateRegion)}</span> ${esc(p.vehicle.regionName)}` : ''}</p>` : ''}
    <div class="chips">${Object.entries(p.preferences).map(([k, v]) => `<span class="badge">${t(PREF_LABELS[k])}: ${esc(t(v))}</span>`).join('')}</div>
    ${p.languages.length ? `<p class="muted small">${t('Spricht: {list}', { list: esc(p.languages.map((l) => t(l)).join(', ')) })}</p>` : ''}
    ${p.stats ? `<div class="stats" style="margin-top:10px">
      <div class="stat"><b>${num(p.stats.ridesAsDriver)}</b><span>${t('Fahrten als Fahrer')}</span></div>
      <div class="stat"><b>${num(p.stats.ridesAsRider)}</b><span>${t('Fahrten als Mitfahrer')}</span></div>
      <div class="stat"><b>${kg(p.stats.co2SavedKg)} kg</b><span>${t('CO₂ gespart')}</span></div>
      <div class="stat"><b>${esc(fmtMonth(p.stats.memberSince, 'short'))}</b><span>${t('Mitglied seit')}</span></div>
      ${p.stats.level ? `<div class="stat"><b>${esc(t(p.stats.level.name))}</b><span>${t('Level')}</span></div><div class="stat"><b>${num(p.stats.points)}</b><span>${t('Punkte')}</span></div>` : ''}
    </div>
    ${p.stats.badges && p.stats.badges.length ? `<div class="chips">${p.stats.badges.map((b) => `<span class="badge">${esc(t(b.name))}</span>`).join('')}</div>` : ''}` : ''}
    ${guestbookHtml(p.guestbook)}`;
}

async function showProfile(userId, preview) {
  const { profile } = await api(`/api/users/${encodeURIComponent(userId)}/profile${preview ? '?preview=' + preview : ''}`);
  openModal(profileHtml(profile) + (preview ? `<p class="muted small" style="margin-top:12px">${preview === 'booked' ? t('Vorschau: Sicht eines bestätigten Fahrtpartners') : t('Vorschau: Sicht anderer Mitglieder')}</p>` : ''));
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-goto-filters]')) state.scrollToFilters = true;
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-profile]');
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  guard(() => showProfile(el.dataset.profile));
}, true);

function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
  $('.modal-close').focus();
}
function closeModal() {
  $('#modal').hidden = true;
  $('#modal-body').innerHTML = '';
}
$('.modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

/** Fragt Passwort (und ggf. 2FA-Code) zur Bestätigung sensibler Aktionen ab. */
function askCredentials(title, text, confirmLabel, danger = false) {
  return new Promise((resolve) => {
    openModal(`<h2>${esc(title)}</h2><p class="muted">${text}</p>
      <form id="cred-form">
        <label for="c-pass">${t('Passwort')}</label><input id="c-pass" type="password" autocomplete="current-password" required>
        ${state.me.mfaEnabled ? `<label for="c-code">${t('Code aus Authenticator-App oder Backup-Code')}</label><input id="c-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" required>` : ''}
        <div class="btn-row"><button class="${danger ? 'danger' : ''}">${esc(confirmLabel || t('Bestätigen'))}</button><button type="button" class="secondary" id="c-cancel">${t('Abbrechen')}</button></div>
      </form>`);
    $('#c-pass').focus();
    $('#c-cancel').onclick = () => { closeModal(); resolve(null); };
    $('#cred-form').onsubmit = (e) => {
      e.preventDefault();
      const creds = { password: $('#c-pass').value, code: $('#c-code') ? $('#c-code').value : undefined };
      closeModal();
      resolve(creds);
    };
  });
}

function mfaHint(text) {
  if (!state.me || state.me.mfaEnabled) return '';
  return `<div class="card notice" style="margin:10px 0"><b>${t('Konto absichern')}</b><p class="small" style="margin:4px 0 8px">${esc(text || t('Du teilst deinen Standort und erhältst Auszahlungen – schütze dein Konto mit der Zwei-Faktor-Anmeldung.'))}</p><a class="btn" href="#/profil">${t('2FA aktivieren')}</a></div>`;
}

// ---------- Eigenes Profil, Privatsphäre, Sicherheit, Daten ----------
async function renderProfile(panel) {
  drawMap();
  const me = state.me;
  state.filters = me.riderFilters || {};
  const p = me.profile;
  const pv = me.privacy;
  const { sessions } = await api('/api/me/sessions');
  const LANGS = languages();
  const PREFS = { smoking: ['nein', 'ja'], pets: ['nein', 'nach Absprache', 'ja'], music: ['egal', 'gerne', 'lieber leise'], chat: ['egal', 'gerne', 'lieber ruhig'] };
  const sel = (k) => `<div><label for="p-${k}">${t(PREF_LABELS[k])}</label><select id="p-${k}">${PREFS[k].map((o) => `<option value="${esc(o)}" ${p.preferences[k] === o ? 'selected' : ''}>${esc(t(o))}</option>`).join('')}</select></div>`;
  const firstName = me.name.split(/\s+/)[0];
  const initial = (me.name.split(/\s+/).slice(-1)[0] || '')[0] || '';

  panel.innerHTML = `
    <div class="card" id="ui-language-card">
      <h2>${t('Sprache')} ${info(t('Sprache der Oberfläche auf allen deinen Geräten. „Automatisch“ richtet sich nach der Spracheinstellung deines Browsers.'))}</h2>
      <label for="p-uilang">${t('Sprache der Oberfläche')}</label>
      <select id="p-uilang">
        <option value="" ${p.uiLanguage ? '' : 'selected'}>${t('Automatisch (Browsersprache)')}</option>
        ${uiLanguages().map((l) => `<option value="${esc(l.code)}" lang="${esc(l.code)}" ${p.uiLanguage === l.code ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
      </select>
      ${I18N.lang !== 'de' ? `<p class="muted small">${t('Übersetzungen dienen der Information. Rechtlich verbindlich sind die deutschen Fassungen von Nutzungsbedingungen und Datenschutzerklärung.')}</p>` : ''}
    </div>

    <div class="card">
      <h2>${t('Mein Profil')}</h2>
      <div class="profile-head">
        ${avatar({ id: me.id, name: me.name, hasPhoto: me.hasPhoto })}
        <div class="btn-row" style="margin:0">
          <label class="btn secondary" style="margin:0;color:var(--text)">${t('Foto wählen')}<input type="file" id="p-photo" accept="image/*" hidden></label>
          ${me.hasPhoto ? `<button class="secondary" id="p-photo-del">${t('Entfernen')}</button>` : ''}
        </div>
      </div>
      <form id="profile-form">
        <label for="p-name">${t('Name')}</label><input id="p-name" value="${esc(me.name)}" required>
        <label for="p-bio">${t('Über mich')}</label><textarea id="p-bio" maxlength="500" placeholder="${esc(t('z. B. Pendle werktags Berlin → Potsdam, fahre entspannt.'))}">${esc(p.bio)}</textarea>
        <label for="p-phone">${t('Telefon (für Absprachen am Treffpunkt)')}</label><input id="p-phone" type="tel" value="${esc(p.phone)}" placeholder="+49 …">
        <label>${t('Sprachen, die ich spreche')}</label>
        <div class="checks">${LANGS.map((l) => `<label class="check"><input type="checkbox" name="lang" value="${esc(l)}" ${p.languages.includes(l) ? 'checked' : ''}>${esc(t(l))}</label>`).join('')}</div>
        <div class="row">${sel('smoking')}${sel('pets')}</div>
        <div class="row">${sel('music')}${sel('chat')}</div>
        <h3 style="margin:16px 0 0">${t('Fahrzeug (für Fahrer)')}</h3>
        <div class="row">
          <div><label for="p-brand">${t('Automarke')}</label><select id="p-brand"><option value="">–</option>${(state.config.brands || []).map((b) => `<option value="${esc(b)}" ${p.vehicle.brand === b ? 'selected' : ''}>${esc(b === 'Andere' ? t('Andere') : b)}</option>`).join('')}</select></div>
          <div><label for="p-model">${t('Modell')}</label><input id="p-model" value="${esc(p.vehicle.model)}" placeholder="Golf"></div>
        </div>
        <div class="row">
          <div><label for="p-color">${t('Farbe')}</label><input id="p-color" value="${esc(p.vehicle.color)}" placeholder="${esc(t('blau'))}"></div>
          <div><label for="p-plate">${t('Ortskürzel')} ${info(t('Nur das Ortskürzel deines Kennzeichens (z. B. HH). Das vollständige Kennzeichen speichern wir nicht. Marke und Kürzel erscheinen in deinem Profil und fließen anonym in die Funfacts ein.'))}</label><input id="p-plate" value="${esc(p.vehicle.plateRegion || '')}" maxlength="3" placeholder="${esc(t('z. B. HH'))}" style="text-transform:uppercase"></div>
        </div>
        <p class="muted small" id="p-plate-name">${p.vehicle.plateRegion ? plateNameText(p.vehicle.plateRegion) : ''}</p>
        <div class="btn-row">
          <button id="p-save">${t('Profil speichern')}</button>
          <button type="button" class="secondary" data-preview="stranger">${t('So sehen mich andere')}</button>
        </div>
      </form>
    </div>

    <div class="card">
      <h2>${t('Privatsphäre')} ${info(`<p><b>${t('Privacy by Default')}</b></p><p>${t('Andere sehen dein Profil nur, wenn du als Fahrer online bist oder ihr gemeinsam fahrt. Deine E-Mail-Adresse ist nie sichtbar.')}</p><p>${t('Start und Ziel deiner Fahrten sehen andere nur ungefähr (Ort statt Straße, ohne die ersten/letzten 500 m). Deinen Live-Standort sehen nur bestätigte Mitfahrer, solange du online bist.')}</p>`)}</h2>
      <label class="check"><input type="checkbox" id="pv-fullname" ${pv.showFullName ? 'checked' : ''}><span>${t('Vollständigen Nachnamen zeigen')} ${info(t('Sonst erscheinst du als „{name}“.', { name: esc(`${firstName} ${initial}.`) }))}</span></label>
      <label class="check"><input type="checkbox" id="pv-photo" ${pv.showPhoto ? 'checked' : ''}><span>${t('Profilfoto zeigen')}</span></label>
      <label class="check"><input type="checkbox" id="pv-stats" ${pv.showStats ? 'checked' : ''}><span>${t('Statistik zeigen')} ${info(t('Anzahl Fahrten, CO₂-Ersparnis, Mitglied seit, Level und Punkte.'))}</span></label>
      <label class="check"><input type="checkbox" id="pv-guestbook" ${pv.showGuestbook ? 'checked' : ''}><span>${t('Gästebuch zeigen')} ${info(t('Anonyme, positive Einträge von Mitfahrern nach Fahrten über 1 Stunde oder 100 km.'))}</span></label>
      <label class="check"><input type="checkbox" id="pv-leaderboard" ${pv.showOnLeaderboard ? 'checked' : ''}><span>${t('In der Bestenliste erscheinen')} ${info(t('Mit Anzeigename, Level und Punkten – sonst nichts. Jederzeit widerrufbar.'))}</span></label>
      <label for="pv-phone">${t('Telefonnummer sichtbar für')}</label>
      <select id="pv-phone">
        <option value="never" ${pv.phoneVisibility === 'never' ? 'selected' : ''}>${t('niemanden')}</option>
        <option value="booked" ${pv.phoneVisibility === 'booked' ? 'selected' : ''}>${t('bestätigte Fahrtpartner während der Fahrt')}</option>
      </select>
      <div class="btn-row"><button id="pv-save">${t('Privatsphäre speichern')}</button><button type="button" class="secondary" data-preview="booked">${t('Vorschau für Fahrtpartner')}</button></div>
    </div>

    <div class="card" id="rider-filters-card">
      <h2>${t('Meine Wünsche an Fahrer')} ${info(`<p>${t('Diese Kriterien muss ein Fahrer erfüllen, damit er dir bei der Suche angezeigt wird.')}</p><p>${t('Sie gelten automatisch bei jeder Suche – auf allen deinen Geräten. In der Suche siehst du nur, wie viele Fahrer deswegen ausgeblendet wurden.')}</p>`)}</h2>
      ${filterPanel()}
    </div>

    ${await feedbackCard()}

    ${await myGuestbookCard()}

    <div class="card" id="security">
      <h2>${t('Sicherheit & Anmeldung')} ${info(`<p><b>${t('Zwei-Faktor-Anmeldung (2FA)')}</b></p><p>${t('Beim Anmelden brauchst du zusätzlich einen 6-stelligen Code aus einer Authenticator-App (z. B. Google oder Microsoft Authenticator, Authy, 1Password). Selbst wer dein Passwort kennt, kommt so nicht in dein Konto.')}</p><p>${t('Backup-Codes helfen, wenn das Handy weg ist – jeder gilt einmal.')}</p>`)}</h2>
      ${me.mfaEnabled
        ? `<p><span class="badge ok">${t('Zwei-Faktor-Anmeldung aktiv')}</span></p>
           <p class="muted small">${tn(me.backupCodesLeft, '{n} Backup-Code übrig', '{n} Backup-Codes übrig')}${me.backupCodesLeft < 3 ? ` – <b>${t('bitte neue erzeugen')}</b>` : ''}</p>
           <div class="btn-row"><button class="secondary" id="mfa-codes">${t('Neue Backup-Codes')}</button><button class="secondary" id="mfa-off">${t('2FA deaktivieren')}</button></div>`
        : `<p><span class="badge warn">${t('Zwei-Faktor-Anmeldung aus')}</span></p>
           <button id="mfa-on">${t('2FA einrichten')}</button>
           <div id="mfa-setup"></div>`}
      <h3 style="margin-top:16px">${t('Angemeldete Geräte ({n})', { n: num(sessions.length) })}</h3>
      <table class="breakdown">${sessions.map((s) => `<tr><td>${esc(shortAgent(s.userAgent))}${s.current ? ` <span class="badge ok">${t('dieses Gerät')}</span>` : ''}</td><td class="muted small">${s.createdAt ? fmtDate(s.createdAt) : ''}</td></tr>`).join('')}</table>
      ${sessions.length > 1 ? `<div class="btn-row"><button class="secondary" id="sess-revoke">${t('Alle anderen Geräte abmelden')}</button></div>` : ''}
    </div>

    <div class="card">
      <h2>${t('Meine Daten')} ${info(`<p>${t('Einwilligung zur Datenschutzerklärung erteilt am {date}.', { date: me.consentAt ? fmtDateTime(me.consentAt) : '–' })}</p><p>${t('Der Download enthält alle deine Daten (Auskunft und Datenübertragbarkeit nach Art. 15 und 20 DSGVO).')}</p>`)}</h2>
      <div class="btn-row">
        <a class="btn secondary" style="color:var(--text)" href="/api/me/export" download>${t('Alle meine Daten herunterladen (JSON)')}</a>
      </div>
      <h3 style="margin-top:16px">${t('Konto löschen')} ${info(`<p>${t('Profil, Fotos, Telefonnummer, Führerscheindaten, Gästebucheinträge und Anmeldedaten werden sofort gelöscht.')}</p><p>${t('Abrechnungsbelege müssen wir 10 Jahre aufbewahren – sie bleiben anonymisiert („Gelöschtes Konto“) erhalten. Restguthaben wird ausgezahlt.')}</p>`)}</h3>
      <button class="danger" id="acc-delete">${t('Konto endgültig löschen')}</button>
    </div>`;

  $('#p-uilang').onchange = (e) => guard(async () => {
    const code = e.target.value;
    const { user } = await api('/api/me/profile', { profile: { uiLanguage: code } }, 'PUT');
    state.me = user;
    try {
      if (code) localStorage.setItem(LANG_STORAGE_KEY, code);
      else localStorage.removeItem(LANG_STORAGE_KEY);
    } catch {}
    await loadLanguage(preferredLanguage());
    toast(t('Sprache gespeichert.'));
    render();
  }, e.target);
  panel.querySelectorAll('[data-preview]').forEach((b) => (b.onclick = () => guard(() => showProfile(me.id, b.dataset.preview))));
  bindFilterPanel(panel);
  if (state.scrollToFilters) {
    state.scrollToFilters = false;
    $('#rider-filters-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#p-plate').addEventListener('input', (e) => {
    const code = e.target.value.trim().toUpperCase();
    $('#p-plate-name').innerHTML = code ? ((state.config.plateRegions || {})[code] || /^[A-ZÄÖÜ]{1,3}$/.test(code) ? plateNameText(code) : t('Bitte 1–3 Buchstaben, z. B. B, HH oder MÜ')) : '';
  });
  bindGuestbookButtons(panel);

  $('#p-photo').onchange = (e) => guard(async () => {
    const image = await resizeImage(e.target.files[0], 512);
    await api('/api/me/photo', { image });
    toast(t('Profilfoto gespeichert.'));
    render();
  });
  const del = $('#p-photo-del');
  if (del) del.onclick = () => guard(async () => { await api('/api/me/photo', {}, 'DELETE'); render(); }, del);

  $('#profile-form').onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      try {
        await api('/api/me/profile', {
          name: $('#p-name').value,
          profile: {
            bio: $('#p-bio').value,
            phone: $('#p-phone').value,
            languages: [...panel.querySelectorAll('input[name=lang]:checked')].map((i) => i.value),
            preferences: Object.fromEntries(Object.keys(PREFS).map((k) => [k, $('#p-' + k).value])),
            vehicle: { brand: $('#p-brand').value, model: $('#p-model').value, color: $('#p-color').value, plateRegion: $('#p-plate').value },
          },
        }, 'PUT');
        toast(t('Profil gespeichert.'));
        await refreshMe();
      } catch (err) {
        if (err.details) err.message += ' ' + err.details.join(' ');
        err.details = null;
        throw err;
      }
    }, $('#p-save'));
  };

  $('#pv-save').onclick = (e) => guard(async () => {
    await api('/api/me/profile', {
      privacy: { showFullName: $('#pv-fullname').checked, showPhoto: $('#pv-photo').checked, showStats: $('#pv-stats').checked, showOnLeaderboard: $('#pv-leaderboard').checked, showGuestbook: $('#pv-guestbook').checked, phoneVisibility: $('#pv-phone').value },
    }, 'PUT');
    toast(t('Privatsphäre-Einstellungen gespeichert.'));
    await refreshMe();
  }, e.target);

  const on = (id, fn) => { const el = $(id); if (el) el.onclick = (e) => guard(() => fn(e), e.target); };
  on('#mfa-on', startMfaSetup);
  on('#mfa-codes', async () => {
    const creds = await askCredentials(t('Neue Backup-Codes'), t('Die bisherigen Backup-Codes werden ungültig.'));
    if (!creds) return;
    const { backupCodes } = await api('/api/mfa/backup-codes', creds);
    showBackupCodes(backupCodes);
  });
  on('#mfa-off', async () => {
    const creds = await askCredentials(t('2FA deaktivieren'), t('Dein Konto ist danach nur noch durch das Passwort geschützt.'), t('Deaktivieren'), true);
    if (!creds) return;
    await api('/api/mfa/disable', creds);
    toast(t('Zwei-Faktor-Anmeldung deaktiviert.'));
    render();
  });
  on('#sess-revoke', async () => {
    await api('/api/me/sessions/revoke-others', {});
    toast(t('Alle anderen Geräte wurden abgemeldet.'));
    render();
  });
  on('#acc-delete', async () => {
    const creds = await askCredentials(t('Konto endgültig löschen?'), t('Das kann nicht rückgängig gemacht werden. Offene Fahrten müssen vorher abgeschlossen sein.'), t('Endgültig löschen'), true);
    if (!creds) return;
    const { payoutCents } = await api('/api/me/delete', creds);
    state.me = null;
    stopDriving();
    location.hash = '#/mitfahren';
    render();
    toast(payoutCents ? t('Dein Konto wurde gelöscht. Restguthaben von {amount} wird ausgezahlt.', { amount: euro(payoutCents) }) : t('Dein Konto wurde gelöscht.'));
  });
}

/** Name zum Ortskürzel des Kennzeichens; Ortsnamen bleiben unübersetzt. */
function plateNameText(code) {
  const name = (state.config.plateRegions || {})[code];
  return name ? t('Ort: {name}', { name: esc(name) }) : t('Kennzeichen {code}', { code: esc(code) });
}

function shortAgent(ua) {
  if (!ua) return t('Unbekanntes Gerät');
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return os ? t('{browser} auf {os}', { browser: br, os }) : br;
}

async function startMfaSetup() {
  const { secret, otpauthUri } = await api('/api/mfa/setup', {});
  const qr = qrcode(0, 'M');
  qr.addData(otpauthUri);
  qr.make();
  $('#mfa-on').hidden = true;
  $('#mfa-setup').innerHTML = `
    <ol class="steps">
      <li>${t('Öffne deine Authenticator-App und scanne den QR-Code:')}</li>
    </ol>
    <div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: t('QR-Code für die Authenticator-App') })}</div>
    <p class="muted small">${t('Kein Scan möglich? Schlüssel manuell eingeben:')}</p>
    <div class="secret">${esc(secret.match(/.{1,4}/g).join(' '))}</div>
    <p class="muted small"><a href="${esc(otpauthUri)}">${t('Auf diesem Gerät in der Authenticator-App öffnen')}</a></p>
    <form id="mfa-enable">
      <label for="mfa-first">${t('2. Angezeigten 6-stelligen Code eingeben')}</label>
      <input id="mfa-first" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
      <button class="full" style="margin-top:10px" id="mfa-confirm">${t('2FA aktivieren')}</button>
    </form>`;
  $('#mfa-first').focus();
  $('#mfa-enable').onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      const { backupCodes } = await api('/api/mfa/enable', { code: $('#mfa-first').value });
      await refreshMe();
      showBackupCodes(backupCodes);
    }, $('#mfa-confirm'));
  };
}

function showBackupCodes(codes) {
  const text = `${t('joinmyride.com – Backup-Codes für {email}', { email: state.me.email })}\n${t('Jeder Code funktioniert nur einmal.')}\n\n${codes.join('\n')}\n`;
  const href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  openModal(`<h2>${t('Deine Backup-Codes')}</h2>
    <p class="muted">${t('Bewahre diese Codes sicher auf (z. B. ausgedruckt oder im Passwortmanager). Wenn du dein Handy verlierst, kommst du nur damit in dein Konto. Jeder Code gilt einmal. <b>Sie werden nur jetzt angezeigt.</b>')}</p>
    <div class="codes">${codes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
    <div class="btn-row"><a class="btn secondary" style="color:var(--text)" href="${href}" download="joinmyride-backup-codes.txt">${t('Als Datei speichern')}</a><button id="codes-done">${t('Ich habe die Codes gespeichert')}</button></div>`);
  $('#codes-done').onclick = () => { closeModal(); URL.revokeObjectURL(href); render(); };
}

// ---------- Rechtliches ----------
/** In Übersetzungen: Hinweis, dass die deutsche Fassung verbindlich ist. */
const legalTranslationNote = () => (I18N.lang === 'de' ? '' : `<div class="card notice small">${t('Übersetzung zur Information – rechtlich verbindlich ist die deutsche Fassung.')}</div>`);

function renderPrivacyPolicy(panel) {
  drawMap();
  const cfg = state.config ? state.config.pricing : { donationCentsPerRide: 1, commissionPercent: 10 };
  panel.innerHTML = `
    <div class="card legal">
      <h2>${t('Datenschutzerklärung')}</h2>
      <p class="muted small">${t('Stand: Oktober 2026')} · ${state.me ? `<a href="#/profil">${t('Zu meinen Datenschutz-Einstellungen')}</a>` : `<a href="#/mitfahren">${t('Zur Anmeldung')}</a>`}</p>
      ${legalTranslationNote()}
      <div class="card notice small">${t('Vorlage – vor dem Livegang durch eine Datenschutz-Fachkraft prüfen lassen und die Angaben in eckigen Klammern ergänzen.')}</div>

      <h3>${t('1. Verantwortlicher')}</h3>
      <p>${t('[Name / Firma], [Anschrift], E-Mail: datenschutz@joinmyride.com. [Ggf. Datenschutzbeauftragte/r: Kontakt]')}</p>

      <h3>${t('2. Welche Daten wir verarbeiten und warum')}</h3>
      <ul>
        <li>${t('<b>Konto:</b> Name, E-Mail, Passwort (nur als scrypt-Hash), Zeitpunkt der Einwilligung. Zweck: Nutzerkonto, Vertragsdurchführung (Art. 6 Abs. 1 lit. b DSGVO).')}</li>
        <li>${t('<b>Profil (freiwillig):</b> Foto, Über-mich-Text, Telefonnummer, Sprachen, Sprache der Oberfläche, Vorlieben, Fahrzeug. Zweck: Vertrauen und Absprachen zwischen Fahrtpartnern (Art. 6 Abs. 1 lit. b, lit. a DSGVO). Sichtbarkeit steuerst du in den Privatsphäre-Einstellungen.')}</li>
        <li>${t('<b>Führerschein (nur Fahrer):</b> Name, Geburtsdatum, Führerscheinnummer, Klassen, Ablaufdatum, Fotos von Vorder- und Rückseite. Zweck: Sicherheit der Mitfahrer, Prüfung der Fahrberechtigung (Art. 6 Abs. 1 lit. b und f DSGVO). <b>Die Fotos werden direkt nach der Prüfung gelöscht</b>; gespeichert bleiben nur Nummer (anderen nie sichtbar), Klassen, Ablaufdatum und Prüfergebnis.')}</li>
        <li>${t('<b>Standortdaten:</b> Abholort und Ziel von Mitfahrern; Route und – nur während einer aktiv angebotenen Fahrt und nur nach deinem Start der Standortfreigabe – der GPS-Standort von Fahrern. Zweck: Vermittlung und Abrechnung nach gefahrenen Kilometern (Art. 6 Abs. 1 lit. b DSGVO). Andere Mitglieder sehen Start und Ziel eines Fahrers nur vergröbert; den Live-Standort sehen nur bestätigte Mitfahrer.')}</li>
        <li>${t('<b>Fahrten und Zahlungen:</b> Buchungen, gefahrene km, Preise, Provision ({percent} %), Umweltspende ({donation} pro Fahrt), Bewertungen. Zweck: Abrechnung und gesetzliche Aufbewahrung (Art. 6 Abs. 1 lit. b und c DSGVO).', { percent: num(cfg.commissionPercent), donation: euro(cfg.donationCentsPerRide) })}</li>
        <li>${t('<b>Gästebuch (freiwillig):</b> Nach Fahrten über 1 Stunde oder 100 km können Mitfahrer ein positives Erlebnis teilen. Veröffentlicht werden nur Text, Monat und Art der Fahrt – ohne Namen. Intern speichern wir, wer den Eintrag verfasst hat, damit du ihn löschen kannst und Missbrauch verhindert wird (Art. 6 Abs. 1 lit. a DSGVO, Einwilligung; jederzeit widerrufbar durch Löschen). Fahrer können Einträge ausblenden oder das Gästebuch abschalten.')}</li>
        <li>${t('<b>Funfacts:</b> Aus den Bewertungen erstellen wir zusammengefasste Statistiken nach Ortskürzel des Kennzeichens und Automarke (freiwillige Profilangaben; das vollständige Kennzeichen speichern wir nicht). Eine Stadt oder Marke wird erst ab mehreren Fahrern und Bewertungen angezeigt, sodass kein Rückschluss auf Einzelne möglich ist (Art. 6 Abs. 1 lit. f DSGVO).')}</li>
        <li>${t('<b>Bewertungen und Punkte:</b> Bewertungen (0–10, optionale Gründe wie Sauberkeit oder Fahrweise und optionaler Kommentar). Gründe und Kommentare sieht der Bewertete nur gesammelt und anonym ab mindestens drei Rückmeldungen, ohne Datum oder Zuordnung zu einer Fahrt – sie dienen dazu, dass Fahrer und Mitfahrer dazulernen können. Daraus berechnen wir NPS, Punkte, Level und Abzeichen. Zweck: Vertrauen zwischen Fahrtpartnern, Qualität, Motivation zum Teilen von Fahrten (Art. 6 Abs. 1 lit. b und f DSGVO). Einzelbewertungen sieht nur, wer sie abgegeben hat; andere sehen nur Zusammenfassungen. In der <b>Bestenliste</b> erscheinst du nur mit deiner Einwilligung (Art. 6 Abs. 1 lit. a DSGVO), die du jederzeit widerrufen kannst.')}</li>
        <li>${t('<b>Fahrtabbrüche, Verwarnungen und Sperren:</b> Abbruchgründe, Fahrtabbruchsquote sowie Verwarnungen und Sperren nach Ziffer 9 der <a href="#/nutzungsbedingungen">Nutzungsbedingungen</a> (Grund, Dauer, Entscheidung). Zweck: faire Abrechnung und Schutz der Teilnehmer vor Missbrauch (Art. 6 Abs. 1 lit. b und f DSGVO). Die Quote ist für Fahrtpartner sichtbar; Gründe und Sperren nur für dich und den Betreiber.')}</li>
        <li>${t('<b>Sicherheit:</b> Angemeldete Geräte (Browser-Kennung, Zeitpunkt), Daten der Zwei-Faktor-Anmeldung (Schlüssel verschlüsselt, Backup-Codes nur als Hash), Schutz vor Passwort-Ausprobieren. Zweck: Schutz deines Kontos (Art. 6 Abs. 1 lit. f, Art. 32 DSGVO).')}</li>
      </ul>

      <h3>${t('3. Cookies und Tracking')}</h3>
      <p>${t('Wir verwenden ausschließlich ein technisch notwendiges Sitzungs-Cookie („sid“, HttpOnly, 30 Tage) für die Anmeldung (§ 25 Abs. 2 Nr. 2 TDDDG). Die gewählte Sprache speichert dein Browser lokal, wenn du sie auswählst. Keine Werbe- oder Analyse-Cookies, kein Tracking, keine Weitergabe zu Werbezwecken.')}</p>

      <h3>${t('4. Empfänger')}</h3>
      <ul>
        <li>${t('<b>Fahrtpartner:</b> Profilangaben gemäß deinen Privatsphäre-Einstellungen, Abhol- und Zielort der gebuchten Fahrt.')}</li>
        <li>${t('<b>Kartendienste:</b> Adress- und Routensuche über Google Maps Platform (Google Ireland Ltd.; ggf. Übermittlung in die USA auf Grundlage des EU-US Data Privacy Framework) bzw. OpenStreetMap (Nominatim/OSRM). Kartenkacheln werden von OpenStreetMap geladen; dabei wird deine IP-Adresse übertragen.')}</li>
        <li>${t('<b>Zahlungsdienstleister:</b> [Name, z. B. Stripe Payments Europe Ltd.] für Zahlungen und Auszahlungen.')}</li>
        <li>${t('<b>Hosting:</b> [Anbieter, Serverstandort EU] als Auftragsverarbeiter (Art. 28 DSGVO).')}</li>
      </ul>

      <h3>${t('5. Speicherdauer')}</h3>
      <ul>
        <li>${t('Konto- und Profildaten: bis zur Löschung deines Kontos.')}</li>
        <li>${t('Führerscheinfotos: bis zum Abschluss der Prüfung (in der Regel wenige Tage).')}</li>
        <li>${t('GPS-Standort: nur der jeweils letzte Standort während einer aktiven Fahrt; nach Fahrtende nicht mehr sichtbar.')}</li>
        <li>${t('Abrechnungsdaten: 10 Jahre (§ 147 AO, § 257 HGB) – nach Kontolöschung anonymisiert.')}</li>
        <li>${t('Anmeldesitzungen: 30 Tage oder bis zur Abmeldung.')}</li>
      </ul>

      <h3>${t('6. Deine Rechte')}</h3>
      <p>${t('Du hast das Recht auf Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21 DSGVO) sowie auf Widerruf erteilter Einwilligungen mit Wirkung für die Zukunft (Art. 7 Abs. 3).')} ${state.me ? t('Datenexport und Kontolöschung kannst du jederzeit selbst in deinem <a href="#/profil">Profil</a> ausführen.') : t('Datenexport und Kontolöschung kannst du nach der Anmeldung jederzeit selbst im Profil ausführen.')} ${t('Du kannst dich außerdem bei einer Datenschutz-Aufsichtsbehörde beschweren (Art. 77 DSGVO), z. B. [zuständige Landesbehörde].')}</p>

      <h3>${t('7. Sicherheit')}</h3>
      <p>${t('Verschlüsselte Übertragung (HTTPS), Passwörter nur als Hash, optionale Zwei-Faktor-Anmeldung (TOTP), verschlüsselte Speicherung der 2FA-Schlüssel, Begrenzung von Anmeldeversuchen, Zugriff auf Führerscheindaten nur durch den Betreiber.')}</p>

      <h3>${t('8. Automatisierte Entscheidungen')}</h3>
      <p>${t('Die Reihenfolge der vorgeschlagenen Fahrer wird automatisch aus Umweg, Wartezeit, Streckenabdeckung und Bewertung berechnet. Es findet kein Profiling mit rechtlicher Wirkung im Sinne von Art. 22 DSGVO statt; du entscheidest selbst, bei wem du mitfährst.')}</p>
    </div>`;
}

function renderImprint(panel) {
  drawMap();
  panel.innerHTML = `
    <div class="card legal">
      <h2>${t('Impressum')}</h2>
      ${legalTranslationNote()}
      <div class="card notice small">${t('Platzhalter – bitte vor dem Livegang vollständig ausfüllen (§ 5 DDG).')}</div>
      <p>${t('<b>joinmyride.com</b><br>[Name / Firma, Rechtsform]<br>[Straße Nr.]<br>[PLZ Ort]')}</p>
      <p>${t('E-Mail: kontakt@joinmyride.com<br>Telefon: [Nummer]')}</p>
      <p>${t('[Vertretungsberechtigt: …]<br>[Registergericht, Registernummer]<br>[USt-IdNr.]')}</p>
      <p>${t('Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV: [Name, Anschrift]')}</p>
      <p class="muted small">${t('Plattform der EU-Kommission zur Online-Streitbeilegung: https://ec.europa.eu/consumers/odr/ – wir sind nicht verpflichtet und nicht bereit, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen. [anpassen]')}</p>
    </div>`;
}

// ---------- Gamification: Punkte, Level, Abzeichen, Bestenliste ----------
const CAT_LABEL = { promoter: N_('Promotor'), passive: N_('Neutral'), detractor: N_('Kritiker') };
const pts = (n) => tn(n, '{n} Punkt', '{n} Punkte');
const ratedWith = (score, category) => t('bewertet mit {score} ({category})', { score: num(score), category: t(CAT_LABEL[category]) });

function ridePointsLine(p) {
  if (!p) return '';
  return `<span class="points-chip">+${pts(p.points)} ${info(`<table><tr><td>${t('Faktor')}</td><td>×${num(p.factor)}</td></tr><tr><td>${t('CO₂ gespart')}</td><td>${kg(p.co2Kg)} kg</td></tr></table><p style="margin-top:6px">${p.rated ? t('Bewertet mit {score} ({category}).', { score: num(p.score), category: t(CAT_LABEL[p.category]) }) : t('Noch nicht bewertet – vorläufiger Faktor.')}</p>`, t('Punkte-Details'))}</span>`;
}

async function renderPoints(panel) {
  drawMap();
  const g = await api('/api/me/points');
  const lvl = g.level;
  panel.innerHTML = `
    <div class="card level-card">
      <div class="level-head">
        <span class="level-icon" aria-hidden="true">${num(lvl.rank)}</span>
        <div><div class="muted small">${t('Level {n}', { n: num(lvl.rank) })}</div><h2 style="margin:0">${esc(t(lvl.name))}</h2><div class="points-big">${pts(g.points)}</div></div>
      </div>
      <div class="progress"><div style="width:${Math.round(lvl.progress * 100)}%"></div></div>
      <p class="muted small">${lvl.next ? t('Noch {points} bis {level}', { points: pts(lvl.next.missing), level: esc(t(lvl.next.name)) }) : t('Höchstes Level erreicht – danke!')} · ${t('diesen Monat {points}', { points: pts(g.monthPoints) })}</p>
    </div>

    <div class="card">
      <h2>${t('So sammelst du Punkte')} ${info(`<p>${t('Dein Faktor ist die Bewertung (0–10), die du vom jeweils anderen bekommst: Fahrer werden vom Mitfahrer bewertet, Mitfahrer vom Fahrer.')}</p><p>${t('Ohne Bewertung zählt vorläufig ×{n}.', { n: num(g.unratedFactor) })}</p><p>${t('<b>Beispiel:</b> 20 km geteilt ≈ 3 kg CO₂ → mit 10 bewertet 30 Punkte, mit 7 → 21, mit 5 → 3, mit 2 → 0.')}</p>`)}</h2>
      <p class="formula">${t('Punkte = <b>Faktor</b> × <b>eingesparte kg CO₂</b>')}</p>
      <table class="breakdown">
        <tr><td>${t('Promotor: 10 · 9')}</td><td><b>×10 · ×9</b></td></tr>
        <tr><td>${t('Passiv: 8 · 7')}</td><td><b>×8 · ×7</b></td></tr>
        <tr><td>${t('Kritiker: 6 · 5 · 4')}</td><td><b>×1</b></td></tr>
        <tr><td>${t('Kritiker: 3 · 2 · 1 · 0')}</td><td><b>×0</b> <span class="muted small">${t('(keine Punkte)')}</span></td></tr>
      </table>
    </div>

    <div class="card">
      <h2>${t('Abzeichen ({earned}/{total})', { earned: num(g.badges.filter((b) => b.earned).length), total: num(g.badges.length) })}</h2>
      <div class="badges">${g.badges.map((b) => `<div class="badge-tile ${b.earned ? 'earned' : ''}" tabindex="0" data-tip="${esc(t(b.desc))}${b.earned ? esc(' ' + t('(erreicht)')) : ''}"><b>${esc(t(b.name))}</b></div>`).join('')}</div>
    </div>

    <div class="card">
      <h2>${t('Bestenliste')} ${info(t('Nur Mitglieder, die zugestimmt haben – mit Anzeigename und Level. Dich selbst siehst du immer.'))}</h2>
      <div class="tabs"><button data-period="month">${t('Dieser Monat')}</button><button class="secondary" data-period="all">${t('Gesamt')}</button></div>
      <div id="leaderboard"><p class="muted">${t('Lädt …')}</p></div>
      <label class="check"><input type="checkbox" id="lb-optin" ${g.leaderboardOptIn ? 'checked' : ''}><span>${t('Mich für andere anzeigen')}</span></label>
    </div>

    <div class="card">
      <h2>${t('Punkte-Verlauf')}</h2>
      ${g.history.length ? `<table class="breakdown">${g.history.map((h) => `<tr><td>${h.role === 'driver' ? t('Mitgenommen: {name}', { name: esc(h.partner) }) : t('Mitgefahren bei {name}', { name: esc(h.partner) })}<br><span class="muted small">${fmtDate(h.at)} · ${km(h.km)} · ${h.rated ? ratedWith(h.score, h.category) : t('noch nicht bewertet')}</span></td><td><b>+${num(h.points)}</b><br><span class="muted small">×${num(h.factor)} · ${kg(h.co2Kg)} kg</span></td></tr>`).join('')}</table>` : `<p class="muted">${t('Noch keine Punkte – teile deine erste Fahrt!')}</p>`}
    </div>`;

  const loadBoard = async (period) => {
    panel.querySelectorAll('[data-period]').forEach((b) => (b.className = b.dataset.period === period ? '' : 'secondary'));
    const lb = await api('/api/leaderboard?period=' + period);
    $('#leaderboard').innerHTML = lb.entries.length
      ? `<table class="breakdown leaderboard">${lb.entries.map((e) => `<tr class="${e.isMe ? 'me' : ''}"><td>${num(e.rank)}. ${esc(e.name)}${e.isMe ? ` <span class="badge ok">${t('du')}</span>` : ''}</td><td><b>${pts(e.points)}</b></td></tr>`).join('')}</table>
         ${lb.me.rank && !lb.entries.some((e) => e.isMe) ? `<p class="small">${t('Dein Platz: <b>{rank}</b> mit {points}', { rank: num(lb.me.rank), points: pts(lb.me.points) })}</p>` : ''}`
      : `<p class="muted">${t('Noch keine Punkte in diesem Zeitraum.')}</p>`;
  };
  panel.querySelectorAll('[data-period]').forEach((b) => (b.onclick = () => guard(() => loadBoard(b.dataset.period))));
  $('#lb-optin').onchange = (e) => guard(async () => {
    await api('/api/me/profile', { privacy: { showOnLeaderboard: e.target.checked } }, 'PUT');
    toast(e.target.checked ? t('Du erscheinst jetzt in der Bestenliste.') : t('Du wirst anderen nicht mehr in der Bestenliste angezeigt.'));
    await loadBoard('month');
  });
  await loadBoard('month');
}

// ---------- Gästebuch ----------
function guestbookHtml(gb) {
  if (!gb || !gb.enabled) return '';
  return `<div class="guestbook">
    <h3>${t('Gästebuch')} ${gb.count ? `<span class="muted small">(${num(gb.count)})</span>` : ''} ${info(t('Mitfahrer können nach Fahrten über 1 Stunde oder 100 km freiwillig und anonym ein positives Erlebnis teilen.'))}</h3>
    ${gb.count
      ? gb.entries.map((e) => `<blockquote class="gb-entry"><p>${quoted(e.text)}</p><footer>${t('Anonym')} · ${gbMeta(e)}</footer></blockquote>`).join('')
      : `<p class="muted small">${t('Noch keine Einträge.')}</p>`}
  </div>`;
}

/** Freiwilliges Angebot nach langer Fahrt: anonym ins Gästebuch des Fahrers schreiben. */
function openGuestbookForm(ride, { afterRide } = {}) {
  openModal(`<h2>${t('Gästebuch von {name}', { name: esc(ride.driverName) })}</h2>
    <p>${afterRide ? t('Schön, dass die lange Fahrt gut war!') + ' ' : ''}${t('Magst du ein positives Erlebnis teilen? Ganz <b>freiwillig</b> – du kannst das auch überspringen.')}</p>
    <p class="small">${t('Erscheint <b>anonym</b> im Profil des Fahrers')} ${info(`<p>${t('Ohne deinen Namen und ohne Datum – nur mit Monat und „Fahrt über 1 Stunde / 100 km“.')}</p><p>${t('Bitte keine Namen, Telefonnummern, E-Mail-Adressen oder Links. Du kannst den Eintrag jederzeit im Konto löschen.')}</p>`)}</p>
    <form id="gb-form">
      <label for="gb-text">${t('Was war schön an der Fahrt?')}</label>
      <textarea id="gb-text" maxlength="500" placeholder="${esc(t('z. B. Super entspannte Fahrt, tolle Musik und spannende Gespräche über Elektroautos!'))}" required></textarea>
      <div class="muted small" style="text-align:end"><span id="gb-count">0</span>/500</div>
      <label class="check"><input type="checkbox" id="gb-consent"><span>${t('Ich bin einverstanden, dass dieser Text anonym im Profil von {name} veröffentlicht wird.', { name: esc(ride.driverName) })}</span></label>
      <ul class="errors" id="gb-errors"></ul>
      <div class="btn-row"><button id="gb-submit" disabled>${t('Anonym teilen')}</button><button type="button" class="secondary" id="gb-skip">${t('Überspringen')}</button></div>
    </form>`);
  const update = () => {
    $('#gb-count').textContent = $('#gb-text').value.length;
    $('#gb-errors').innerHTML = '';
    $('#gb-submit').disabled = !($('#gb-consent').checked && $('#gb-text').value.trim().length >= 10);
  };
  $('#gb-text').addEventListener('input', update);
  $('#gb-consent').addEventListener('change', update);
  $('#gb-skip').onclick = closeModal;
  $('#gb-form').onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      try {
        await api(`/api/rides/${ride.id}/guestbook`, { text: $('#gb-text').value, consent: $('#gb-consent').checked });
      } catch (err) {
        if (!err.details) throw err;
        $('#gb-errors').innerHTML = err.details.map((d) => `<li>${esc(d)}</li>`).join('');
        return;
      }
      closeModal();
      toast(t('Danke! Dein Eintrag steht jetzt anonym im Gästebuch.'));
      if (currentView() === 'konto') render();
    }, $('#gb-submit'));
  };
}

function riderGuestbookLine(r) {
  const g = r.guestbook;
  if (!g) return '';
  if (g.entry) return `<div class="small gb-mine">${t('Dein anonymer Gästebucheintrag')}${g.entry.hidden ? ` <span class="badge">${t('vom Fahrer ausgeblendet')}</span>` : ''}: ${quoted(g.entry.text)} <button class="linkish" data-gb-delete="${g.entry.id}">${t('löschen')}</button></div>`;
  if (g.eligible) return `<button class="secondary" style="margin-top:6px" data-gb-write="${r.id}">${t('Ins Gästebuch von {name} schreiben (anonym, freiwillig)', { name: esc(r.driverName) })}</button>`;
  return '';
}

async function myGuestbookCard() {
  const gb = await api('/api/me/guestbook');
  return `<div class="card" id="my-guestbook">
    <h2>${t('Mein Gästebuch')} ${info(`<p>${t('Mitfahrer können nach Fahrten über 1 Stunde oder 100 km, die sie mit 7–10 bewertet haben, freiwillig und anonym ein positives Erlebnis teilen.')}</p><p>${t('Du kannst Einträge ausblenden, aber nicht bearbeiten.')}</p>`)}</h2>
    ${gb.entries.length
      ? gb.entries.map((e) => `<blockquote class="gb-entry ${e.hidden ? 'is-hidden' : ''}"><p>${quoted(e.text)}</p><footer>${t('Anonym')} · ${gbMeta(e)} · <button class="linkish" data-gb-hide="${e.id}" data-hidden="${e.hidden ? '0' : '1'}">${e.hidden ? t('wieder anzeigen') : t('ausblenden')}</button></footer></blockquote>`).join('')
      : `<p class="muted">${t('Noch keine Einträge.')}</p>`}
  </div>`;
}

function bindGuestbookButtons(root) {
  root.querySelectorAll('[data-gb-write]').forEach((b) => (b.onclick = () => {
    const ride = state.rides.find((r) => r.id === b.dataset.gbWrite);
    if (ride) openGuestbookForm(ride);
  }));
  root.querySelectorAll('[data-gb-delete]').forEach((b) => (b.onclick = () => guard(async () => {
    if (!confirm(t('Gästebucheintrag wirklich löschen?'))) return;
    await api(`/api/guestbook/${b.dataset.gbDelete}`, {}, 'DELETE');
    toast(t('Eintrag gelöscht.'));
    render();
  }, b)));
  root.querySelectorAll('[data-gb-hide]').forEach((b) => (b.onclick = () => guard(async () => {
    await api(`/api/guestbook/${b.dataset.gbHide}/hide`, { hidden: b.dataset.hidden === '1' });
    render();
  }, b)));
}

// ---------- Funfacts: die nettesten Fahrer nach Stadt und Automarke ----------
function npsBar(nps) {
  // −100 … +100 als Balken um die Mitte
  const width = Math.abs(nps) / 2;
  return `<div class="nps-bar"><div class="${nps >= 0 ? 'pos' : 'neg'}" style="${nps >= 0 ? 'inset-inline-start:50%' : `inset-inline-start:${50 - width}%`};width:${width}%"></div></div>`;
}

function funfactList(list, labelOf) {
  if (!list.ranked.length) return `<p class="muted">${t('Noch nicht genug Bewertungen – wir brauchen mehr Fahrten.')}</p>`;
  return `<ol class="funfact-list">${list.ranked.map((g, i) => `
    <li>
      <div class="ff-row"><span class="ff-rank">${num(i + 1)}.</span><span class="ff-name">${labelOf(g)}</span><b class="ff-nps ${g.nps >= 50 ? 'good' : g.nps >= 0 ? 'mid' : 'bad'}">${signed(g.nps)}</b></div>
      ${npsBar(g.nps)}
      <div class="muted small">${bewertungen(g.count)} · ${t('{n} Fahrer', { n: num(g.drivers) })} · ${npsSplit(g)}</div>
    </li>`).join('')}</ol>`;
}

const FUN_QUIPS = [
  N_('Hier wird noch gewunken statt gehupt.'),
  N_('Gerüchten zufolge gibt es hier Gummibärchen im Handschuhfach.'),
  N_('Blinker werden hier noch benutzt. Freiwillig.'),
  N_('Hier darf der Mitfahrer sogar die Musik aussuchen.'),
];

async function renderFunfacts(panel) {
  drawMap();
  const f = await api('/api/funfacts');
  const topRegion = f.regions.ranked[0];
  const topBrand = f.brands.ranked[0];
  const quip = t(FUN_QUIPS[(topRegion ? topRegion.code.length : 0) % FUN_QUIPS.length]);
  const hiddenGroups = f.regions.hiddenGroups + f.brands.hiddenGroups;
  panel.innerHTML = `
    <div class="card hero funfacts-hero">
      <h2>${t('Funfacts')}</h2>
      <p>${t('Wo fahren die nettesten Fahrer – und in welchen Autos?')} ${info(TIP.nps())}</p>
      ${topRegion ? `<p class="ff-headline">${t('Die nettesten Fahrer kommen aus <b>{name}</b> ({code}) – NPS {nps}.', { name: esc(topRegion.name), code: esc(topRegion.code), nps: signed(topRegion.nps) })} ${quip}</p>` : ''}
      ${topBrand ? `<p class="ff-headline">${t('Am nettesten unterwegs: <b>{brand}</b>-Fahrer – NPS {nps}.', { brand: esc(topBrand.name === 'Andere' ? t('Andere') : topBrand.name), nps: signed(topBrand.nps) })}</p>` : ''}
    </div>

    <div class="card">
      <h2>${t('Nach Stadt / Kennzeichen')}</h2>
      ${funfactList(f.regions, (g) => `<span class="plate"><span class="eu">D</span>${esc(g.code)}</span> ${esc(g.name)}`)}
    </div>

    <div class="card">
      <h2>${t('Nach Automarke')}</h2>
      ${funfactList(f.brands, (g) => esc(g.name === 'Andere' ? t('Andere') : g.name))}
    </div>

    <div class="card">
      <h3>${t('So wird gezählt')} ${info(`<p>${t('Grundlage sind alle {ratings} von Mitfahrern (0–10). Stadt und Marke kommen aus dem Fahrerprofil.', { ratings: bewertungen(f.totalRatings) })}</p><p>${t('Damit niemand einzeln erkennbar ist, erscheint eine Stadt oder Marke erst ab <b>{drivers} Fahrern</b> und <b>{ratings}</b>.', { drivers: num(f.minDrivers), ratings: bewertungen(f.minRatings) })}${hiddenGroups ? ' ' + tn(hiddenGroups, '{n} weitere wartet noch darauf.', '{n} weitere warten noch darauf.') : ''}</p>`)} ${info(TIP.nps(), t('Was ist der NPS?'))}</h3>
      ${state.me ? `<p class="small">${t('Deine Stadt fehlt? Trag im <a href="#/profil">Profil</a> Automarke und Ortskürzel deines Kennzeichens ein.')}</p>` : ''}
      <p class="muted small">${t('Alles nur zum Spaß.')}</p>
    </div>`;
}

// ---------- Filter des Mitfahrers: Kriterien, die der Fahrer erfüllen muss ----------
// Sprachliste kommt vom Server (dieselbe Liste wie bei der Profil-Prüfung)
const languages = () => (state.config && state.config.languages) || ['Deutsch', 'Englisch'];

state.filters = {};

function activeFilterCount(f) {
  return ['minNps', 'nonSmoker', 'pets', 'chat', 'music', 'language', 'mfa', 'safeDriving', 'maxEtaMin'].filter((k) => f[k] !== undefined && f[k] !== '' && f[k] !== false).length + (f.includeNew === false ? 1 : 0);
}

function filterPanel() {
  const f = state.filters;
  const opt = (v, label, cur) => `<option value="${v}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${label}</option>`;
  const n = activeFilterCount(f);
  const any = t('egal');
  return `<div class="filters" id="filters">
    <p class="muted small" id="flt-count">${n ? `<span class="badge ok">${t('{n} aktiv', { n: num(n) })}</span>` : t('Keine Wünsche gesetzt – alle passenden Fahrer werden angezeigt.')}</p>
    <div class="row">
      <div><label for="flt-nps">${t('Mindest-NPS')} ${info(TIP.nps())}</label><select id="flt-nps">${opt('', any, f.minNps)}${opt(0, '≥ 0', f.minNps)}${opt(30, '≥ +30', f.minNps)}${opt(50, '≥ +50', f.minNps)}${opt(70, '≥ +70', f.minNps)}</select></div>
      <div><label for="flt-eta">${t('Max. Wartezeit')}</label><select id="flt-eta">${opt('', any, f.maxEtaMin)}${[5, 10, 15, 30].map((m) => opt(m, minutes(m), f.maxEtaMin)).join('')}</select></div>
    </div>
    <label class="check"><input type="checkbox" id="flt-new" ${f.includeNew === false ? '' : 'checked'}><span>${t('Neue Fahrer einbeziehen')} ${info(t('Fahrer ohne Bewertung bleiben in der Liste, auch wenn ein Mindest-NPS gesetzt ist.'))}</span></label>
    <div class="checks">
      <label class="check"><input type="checkbox" id="flt-smoke" ${f.nonSmoker ? 'checked' : ''}><span>${t('Nichtraucher')}</span></label>
      <label class="check"><input type="checkbox" id="flt-pets" ${f.pets ? 'checked' : ''}><span>${t('Tiere erlaubt')}</span></label>
      <label class="check"><input type="checkbox" id="flt-mfa" ${f.mfa ? 'checked' : ''}><span>${t('2FA-gesichert')}</span></label>
      <label class="check"><input type="checkbox" id="flt-safe" ${f.safeDriving ? 'checked' : ''}><span>${t('Sichere Fahrweise')} ${info(t('Höchstens 10 % der Bewertungen des Fahrers nennen „Fahrweise“ als Grund (ab 3 Bewertungen).'))}</span></label>
    </div>
    <div class="row">
      <div><label for="flt-chat">${t('Unterhaltung')}</label><select id="flt-chat">${opt('', any, f.chat)}${opt('quiet', t('lieber ruhig'), f.chat)}${opt('talkative', t('gerne gesprächig'), f.chat)}</select></div>
      <div><label for="flt-music">${t('Musik')}</label><select id="flt-music">${opt('', any, f.music)}${opt('quiet', t('lieber leise'), f.music)}</select></div>
    </div>
    <label for="flt-lang">${t('Fahrer spricht')}</label><select id="flt-lang">${opt('', any, f.language)}${languages().map((l) => opt(esc(l), esc(t(l)), f.language)).join('')}</select>
    <div class="btn-row"><button type="button" id="flt-save">${t('Wünsche speichern')}</button><button type="button" class="secondary" id="flt-reset">${t('Zurücksetzen')}</button></div>
  </div>`;
}

function bindFilterPanel(root) {
  const read = () => {
    const v = (id) => $(id).value;
    const f = {};
    if (v('#flt-nps') !== '') f.minNps = Number(v('#flt-nps'));
    if (v('#flt-eta') !== '') f.maxEtaMin = Number(v('#flt-eta'));
    if (!$('#flt-new').checked) f.includeNew = false;
    if ($('#flt-smoke').checked) f.nonSmoker = true;
    if ($('#flt-pets').checked) f.pets = true;
    if ($('#flt-mfa').checked) f.mfa = true;
    if ($('#flt-safe').checked) f.safeDriving = true;
    if (v('#flt-chat')) f.chat = v('#flt-chat');
    if (v('#flt-music')) f.music = v('#flt-music');
    if (v('#flt-lang')) f.language = v('#flt-lang');
    state.filters = f;
    const n = activeFilterCount(f);
    $('#flt-count').innerHTML = n ? `<span class="badge ok">${t('{n} aktiv', { n: num(n) })}</span> <span class="muted small">${t('– noch nicht gespeichert')}</span>` : t('Keine Wünsche gesetzt.');
  };
  const save = async (f, btn) => {
    const { user } = await api('/api/me/profile', { riderFilters: f }, 'PUT');
    state.me = user;
    state.filters = user.riderFilters;
    state.matches = [];
    $('#filters').outerHTML = filterPanel();
    bindFilterPanel(root);
    toast(t('Deine Wünsche an Fahrer sind gespeichert und gelten ab jetzt bei jeder Suche.'));
    return btn;
  };
  root.querySelectorAll('#filters select, #filters input').forEach((el) => el.addEventListener('change', read));
  $('#flt-save').onclick = (e) => guard(() => save(state.filters, e.target), e.target);
  $('#flt-reset').onclick = (e) => guard(() => save({}, e.target), e.target);
}

/** In der Suche nur ein Satz – die Wünsche selbst stehen im Profil. */
function filterSummary(res) {
  if (!res.hiddenByFilters) return '';
  const n = res.hiddenByFilters;
  return `<p class="muted small">${tn(n, '{n} Fahrer wird dir wegen deiner Filter nicht angezeigt.', '{n} Fahrer werden dir wegen deiner Filter nicht angezeigt.')} <a href="#/profil" data-goto-filters>${t('Filter ändern')}</a></p>`;
}

function prefIcons(m) {
  const p = m.driverPrefs || {};
  const chips = [];
  if (p.smoking === 'nein') chips.push(t('Nichtraucher'));
  if (p.pets && p.pets !== 'nein') chips.push(p.pets === 'ja' ? t('Tiere ok') : t('Tiere nach Absprache'));
  if (p.chat === 'lieber ruhig') chips.push(t('ruhige Fahrt'));
  if (p.chat === 'gerne') chips.push(t('gesprächig'));
  if (p.music === 'gerne') chips.push(t('Musik'));
  if (m.driverMfa) chips.push('2FA');
  if (p.languages && p.languages.length > 1) chips.push(esc(p.languages.map((l) => t(l)).join(', ')));
  return chips.length ? `<span class="pref-chips">${chips.map((c) => `<span class="pref">${c}</span>`).join('')}</span>` : '';
}

// ---------- Feedback zum Lernen (gesammelt & anonym) ----------
function feedbackSection(title, f) {
  if (!f.entries && !f.ratingsTotal) return '';
  if (!f.ready) {
    return `<h3>${title}</h3><p class="muted small">${f.entries ? t('{n} von {min} Rückmeldungen gesammelt', { n: num(f.entries), min: num(f.minEntries) }) : t('Noch keine Hinweise – weiter so!')} ${info(t('Hinweise werden erst ab {min} Rückmeldungen gesammelt angezeigt, damit niemand einzeln erkennbar ist.', { min: num(f.minEntries) }))}</p>`;
  }
  const max = Math.max(...f.aspects.map((a) => a.count), 1);
  return `<h3>${title}</h3>
    <p class="muted small">${tn(f.entries, '{n} Rückmeldung', '{n} Rückmeldungen')} ${info(t('{entries} mit Hinweisen aus {ratings} insgesamt.', { entries: tn(f.entries, '{n} Rückmeldung', '{n} Rückmeldungen'), ratings: bewertungen(f.ratingsTotal) }))}</p>
    ${f.aspects.length ? f.aspects.map((a) => `
      <div class="fb-aspect">
        <div class="fb-row"><span>${esc(t(a.label))} ${info(`<p><b>${t('Tipp')}</b></p><p>${esc(t(a.tip))}</p>`, t('Tipp'))}</span><b>${num(a.count)}×</b></div>
        <div class="fb-bar"><div style="width:${Math.round((a.count / max) * 100)}%"></div></div>
      </div>`).join('') : ''}
    ${f.comments.length ? `<details><summary class="small">${t('Anonyme Kommentare ({n})', { n: num(f.comments.length) })}</summary>${f.comments.map((c) => `<blockquote class="gb-entry"><p>${quoted(c)}</p></blockquote>`).join('')}</details>` : ''}`;
}

async function feedbackCard() {
  const fb = await api('/api/me/feedback');
  const driver = feedbackSection(t('Als Fahrer'), fb.asDriver);
  const rider = feedbackSection(t('Als Mitfahrer'), fb.asRider);
  return `<div class="card" id="my-feedback">
    <h2>${t('Feedback zum Lernen')} ${info(`<p>${t('Bei Bewertungen bis 8 können deine Fahrtpartner freiwillig Gründe nennen.')}</p><p>${t('Du siehst sie hier gesammelt und anonym – ohne Namen, Datum oder Fahrt. Fahre mit der Maus über ⓘ für Tipps.')}</p>`)}</h2>
    ${driver || rider ? driver + rider : `<p class="muted">${t('Noch keine Bewertungen.')}</p>`}
  </div>`;
}

// ---------- Nutzungsbedingungen ----------
function renderTerms(panel) {
  drawMap();
  const c = state.config || {};
  const pr = c.pricing || { ratePerKmCents: 25, commissionPercent: 10, donationCentsPerRide: 1 };
  const ap = c.abortPolicy || { maxQuote: 20, minRides: 5 };
  const reasons = (c.abortReasons || []).map((r) => esc(t(r.label))).join(', ');
  panel.innerHTML = `
    <div class="card legal">
      <h2>${t('Nutzungsbedingungen')}</h2>
      <p class="muted small">${t('Stand: Oktober 2026 · Version {version}', { version: esc(c.termsVersion || '2026-10') })}</p>
      ${legalTranslationNote()}
      <div class="card notice small">${t('Vorlage – vor dem Livegang rechtlich prüfen lassen und die Angaben in eckigen Klammern ergänzen.')}</div>

      <h3>${t('1. Geltungsbereich und Anbieter')}</h3>
      <p>${t('Diese Bedingungen gelten für die Nutzung von joinmyride.com, betrieben von [Name / Firma, Anschrift] („Betreiber“). Mit der Registrierung erkennst du sie an.')}</p>

      <h3>${t('2. Leistungen')}</h3>
      <p>${t('Der Betreiber vermittelt Mitfahrgelegenheiten zwischen Fahrern, die eine Strecke ohnehin fahren, und Mitfahrern. Der Betreiber befördert selbst nicht; der Beförderungsvertrag kommt zwischen Fahrer und Mitfahrer zustande. Es handelt sich um Kostenteilung, nicht um gewerbliche Personenbeförderung: Das Entgelt darf die Betriebskosten der Fahrt nicht übersteigen.')}</p>

      <h3>${t('3. Registrierung und Konto')}</h3>
      <ul>
        <li>${t('Teilnehmen dürfen volljährige Personen mit wahrheitsgemäßen Angaben. Jede Person darf nur ein Konto führen.')}</li>
        <li>${t('Zugangsdaten sind geheim zu halten. Wir empfehlen die Zwei-Faktor-Anmeldung, für Fahrer und den Betreiber dringend.')}</li>
      </ul>

      <h3>${t('4. Pflichten der Fahrer')}</h3>
      <ul>
        <li>${t('Gültige Fahrerlaubnis (mindestens Klasse B), die vor dem ersten Angebot geprüft wird; Änderungen (z. B. Entzug, Ablauf) sind unverzüglich mitzuteilen.')}</li>
        <li>${t('Verkehrssicheres, zugelassenes und haftpflichtversichertes Fahrzeug; Einhaltung der Verkehrsregeln.')}</li>
        <li>${t('Fahren nur auf der eigenen Route; keine gewerbliche Personenbeförderung über die Plattform.')}</li>
      </ul>

      <h3>${t('5. Pflichten der Mitfahrer')}</h3>
      <ul>
        <li>${t('Pünktliches Erscheinen am vereinbarten Treffpunkt, respektvolles Verhalten, Rücksicht auf Fahrzeug und Fahrer.')}</li>
        <li>${t('Ausreichendes Guthaben für den bestätigten Höchstbetrag.')}</li>
      </ul>

      <h3>${t('6. Preise und Zahlung')}</h3>
      <ul>
        <li>${t('Grundlage ist die vor der Fahrt von beiden bestätigte schnellste Route. Kilometersatz derzeit {rate}/km.', { rate: euro(pr.ratePerKmCents) })}</li>
        <li>${t('Mit dem Fahrtantritt (Einsteigen) ist der Preis der geplanten Route fällig – auch wenn die Fahrt früher endet. Umwege gehen nicht zulasten des Mitfahrers.')}</li>
        <li>${t('Die Anfahrt zum Treffpunkt wird zum gleichen Satz berechnet und vollständig an den Fahrer ausgezahlt; auf sie erhebt der Betreiber keine Provision.')}</li>
        <li>${t('Der Betreiber erhält eine Vermittlungsprovision von {percent} % auf die gemeinsame Strecke. Je Fahrt werden {donation} an [Organisation] für den Umweltschutz gespendet.', { percent: num(pr.commissionPercent), donation: euro(pr.donationCentsPerRide) })}</li>
        <li>${t('Bezahlt wird, sobald der Fahrer den Mitfahrer abgesetzt und der Mitfahrer die Fahrt bewertet hat; ohne Rückmeldung nach 24 Stunden.')}</li>
      </ul>

      <h3>${t('7. Bewertungen und Gästebuch')}</h3>
      <p>${t('Bewertungen müssen wahrheitsgemäß und sachlich sein. Beleidigende, falsche oder manipulierte Bewertungen und Gästebucheinträge können entfernt werden.')}</p>

      <h3>${t('8. Fahrtabbruch und Fahrtabbruchsquote')}</h3>
      <ul>
        <li>${t('Eine begonnene Fahrt kann von Fahrer oder Mitfahrer abgebrochen werden. Der Abbruch ist zu begründen ({reasons}). Abgerechnet wird dann nur die bis dahin gefahrene Strecke.', { reasons: reasons || t('Grund und Freitext') })}</li>
        <li>${t('Die <b>Fahrtabbruchsquote</b> ist der Anteil abgebrochener an allen abgeschlossenen Fahrten, getrennt nach der Rolle als Fahrer und als Mitfahrer. Ein Abbruch zählt für beide Beteiligten. Die Quote ist im Profil für Fahrtpartner sichtbar.')}</li>
        <li>${t('Abbrüche dürfen nicht dazu genutzt werden, Entgelt oder Provision zu umgehen, etwa durch Absprachen über ein vorzeitiges Fahrtende.')}</li>
      </ul>

      <h3>${t('9. Sperrung von Teilnehmern')}</h3>
      <p>${t('<b>9.1 Zu hohe Fahrtabbruchsquote.</b> Liegt die Fahrtabbruchsquote eines Teilnehmers in einer Rolle über <b>{quote} %</b> und hat er in dieser Rolle mindestens <b>{rides} Fahrten</b> abgeschlossen, kann der Betreiber den Teilnehmer sperren. Dabei gilt:', { quote: num(ap.maxQuote), rides: num(ap.minRides) })}</p>
      <ul>
        <li>${t('Der Betreiber prüft jeden Fall einzeln, insbesondere die angegebenen Gründe; Abbrüche aus nachvollziehbaren Sicherheits- oder Gesundheitsgründen werden berücksichtigt. Eine Sperre erfolgt nicht automatisch.')}</li>
        <li>${t('In der Regel erhält der Teilnehmer zunächst eine <b>Verwarnung</b> mit Gelegenheit zur Stellungnahme an [kontakt@joinmyride.com].')}</li>
        <li>${t('Bleibt die Quote hoch oder gibt es Hinweise auf Missbrauch (z. B. abgesprochene Abbrüche), kann der Betreiber das Konto <b>befristet</b> (in der Regel 7 bis 30 Tage) sperren, im Wiederholungsfall oder bei schwerem Missbrauch <b>unbefristet</b>.')}</li>
      </ul>
      <p>${t('<b>9.2 Weitere Gründe.</b> Eine Sperrung ist außerdem möglich bei falschen Angaben, Fahren ohne gültige Fahrerlaubnis, Gefährdung oder Belästigung anderer, Manipulation von Bewertungen oder Zahlungen sowie sonstigen erheblichen Verstößen gegen diese Bedingungen.')}</p>
      <p>${t('<b>9.3 Folgen.</b> Während einer Sperre kann der Teilnehmer keine Fahrten anbieten, suchen oder buchen; seine aktiven Angebote werden beendet und offene Anfragen storniert. Bereits begonnene Fahrten können abgeschlossen werden. Guthaben, Abrechnungen, Datenexport und Kontolöschung bleiben zugänglich. Befristete Sperren enden automatisch. Der Teilnehmer wird über Grund und Dauer informiert und kann widersprechen; der Betreiber entscheidet erneut.')}</p>

      <h3>${t('10. Haftung')}</h3>
      <p>${t('Der Betreiber haftet unbeschränkt bei Vorsatz, grober Fahrlässigkeit sowie für Schäden aus der Verletzung von Leben, Körper oder Gesundheit; im Übrigen nur bei Verletzung wesentlicher Pflichten und begrenzt auf den vorhersehbaren Schaden. Für die Durchführung der Fahrt sind Fahrer und Mitfahrer verantwortlich. [anpassen]')}</p>

      <h3>${t('11. Datenschutz')}</h3>
      <p>${t('Es gilt die <a href="#/datenschutz">Datenschutzerklärung</a>.')}</p>

      <h3>${t('12. Kündigung und Änderungen')}</h3>
      <p>${t('Du kannst dein Konto jederzeit im Profil löschen. Der Betreiber kann den Vertrag mit einer Frist von [zwei Wochen] kündigen, aus wichtigem Grund fristlos. Änderungen dieser Bedingungen werden rechtzeitig vorher angekündigt; widersprichst du nicht innerhalb von [sechs Wochen], gelten sie als angenommen – darauf weisen wir mit der Ankündigung hin.')}</p>

      <h3>${t('13. Schlussbestimmungen')}</h3>
      <p>${t('Es gilt deutsches Recht unter Ausschluss des UN-Kaufrechts; zwingende Verbraucherschutzvorschriften des Wohnsitzstaats bleiben unberührt. [Online-Streitbeilegung / Verbraucherschlichtung anpassen]')}</p>
    </div>`;
}

/** Hinweis für gesperrte oder verwarnte Teilnehmer (oberhalb jeder Ansicht). */
function accountNotice() {
  const me = state.me;
  if (!me) return '';
  const terms = `<a href="#/nutzungsbedingungen">${t('Nutzungsbedingungen, Ziffer 9')}</a>`;
  if (me.suspension) {
    const head = me.suspension.until ? t('Dein Konto ist bis {date} gesperrt.', { date: fmtDate(me.suspension.until) }) : t('Dein Konto ist bis auf Weiteres gesperrt.');
    return `<div class="card notice bad-notice"><b>${head}</b><p class="small" style="margin:4px 0 0">${t('Grund: {reason}. Du kannst keine Fahrten anbieten oder buchen; laufende Fahrten kannst du abschließen. Widerspruch an [kontakt@joinmyride.com] – siehe {terms}.', { reason: esc(tMsg(me.suspension.reason)), terms })}</p></div>`;
  }
  const w = (me.warnings || []).slice(-1)[0];
  if (w && Date.now() - new Date(w.at).getTime() < 90 * 864e5) {
    return `<div class="card notice"><b>${t('Verwarnung vom {date}', { date: fmtDate(w.at) })}</b><p class="small" style="margin:4px 0 0">${t('{note}. Bei weiterhin hoher Fahrtabbruchsquote kann dein Konto gesperrt werden ({terms}).', { note: esc(tMsg(w.note)), terms })}</p></div>`;
  }
  return '';
}

// Vorschläge für den Betreiber – deutsch gespeichert, beim Teilnehmer in dessen Sprache angezeigt
const WARN_NOTE = N_('Hohe Fahrtabbruchsquote – bitte Abbrüche vermeiden');
const SUSPEND_REASON = N_('Fahrtabbruchsquote über dem Grenzwert trotz Verwarnung');

/** Betreiber: Prüfliste nach Ziffer 9 der Nutzungsbedingungen. */
async function abortReviewCard() {
  const r = await api('/api/admin/abort-review');
  const roleName = { driver: t('Fahrer'), rider: t('Mitfahrer') };
  const q = (v) => (v === null || v === undefined ? '–' : num(v));
  const row = (m, suspended) => `
    <div class="match">
      <div class="top"><span><b>${esc(m.name)}</b> <span class="muted small">${esc(m.email || '')}</span></span>${m.warnings.length ? `<span class="badge warn">${t('{n} × verwarnt', { n: num(m.warnings.length) })}</span>` : ''}</div>
      <div class="small">${m.flags.length ? m.flags.map((f) => `${roleName[f.role]}: <b>${num(f.quote)} %</b> (${t('{aborted} von {rides}', { aborted: num(f.aborted), rides: num(f.rides) })})`).join(' · ') : t('Fahrer {driver} % · Mitfahrer {rider} %', { driver: q(m.abortStats.asDriver.quote), rider: q(m.abortStats.asRider.quote) })}</div>
      ${suspended ? `<div class="small">${m.suspension.until ? t('Gesperrt bis {date}: {reason}', { date: fmtDate(m.suspension.until), reason: esc(tMsg(m.suspension.reason)) }) : t('Gesperrt unbefristet: {reason}', { reason: esc(tMsg(m.suspension.reason)) })}</div>` : ''}
      <div class="btn-row">
        ${suspended
          ? `<button class="secondary" data-unsuspend="${m.id}">${t('Entsperren')}</button>`
          : `<button class="secondary" data-warn="${m.id}">${t('Verwarnen')}</button><button class="danger" data-suspend="${m.id}" data-name="${esc(m.name)}">${t('Sperren …')}</button>`}
      </div>
    </div>`;
  return `<div class="card" id="abort-review">
    <h2>${t('Fahrtabbruchsquote – Prüfung')} ${info(`<p>${t('Teilnehmer mit einer Quote über <b>{quote} %</b> bei mindestens <b>{rides} Fahrten</b> in einer Rolle (Nutzungsbedingungen, Ziffer 9).', { quote: num(r.policy.maxQuote), rides: num(r.policy.minRides) })}</p><p>${t('Bitte jeden Fall einzeln prüfen – Abbrüche aus Sicherheits- oder Gesundheitsgründen sind nachvollziehbar. In der Regel erst verwarnen.')}</p>`)}</h2>
    ${r.flagged.length ? r.flagged.map((m) => row(m, false)).join('') : `<p class="muted">${t('Niemand über dem Grenzwert.')}</p>`}
    ${r.suspended.length ? `<h3 style="margin-top:14px">${t('Gesperrt ({n})', { n: num(r.suspended.length) })}</h3>${r.suspended.map((m) => row(m, true)).join('')}` : ''}
  </div>`;
}

function bindAbortReview(root) {
  root.querySelectorAll('[data-warn]').forEach((b) => (b.onclick = () => guard(async () => {
    await api(`/api/admin/users/${b.dataset.warn}/warn`, { note: WARN_NOTE });
    toast(t('Verwarnung gesendet.'));
    render();
  }, b)));
  root.querySelectorAll('[data-unsuspend]').forEach((b) => (b.onclick = () => guard(async () => {
    await api(`/api/admin/users/${b.dataset.unsuspend}/unsuspend`, {});
    toast(t('Sperre aufgehoben.'));
    render();
  }, b)));
  root.querySelectorAll('[data-suspend]').forEach((b) => (b.onclick = () => {
    openModal(`<h2>${t('{name} sperren', { name: esc(b.dataset.name) })}</h2>
      <p class="small">${t('Nach Ziffer 9 der Nutzungsbedingungen. Aktive Angebote werden beendet, offene Anfragen storniert; laufende Fahrten können abgeschlossen werden.')}</p>
      <form id="suspend-form">
        <label for="sp-days">${t('Dauer')}</label>
        <select id="sp-days"><option value="7">${tn(7, '{n} Tag', '{n} Tage')}</option><option value="30">${tn(30, '{n} Tag', '{n} Tage')}</option><option value="unbefristet">${t('unbefristet')}</option></select>
        <label for="sp-reason">${t('Grund (wird dem Teilnehmer angezeigt)')}</label>
        <textarea id="sp-reason" required minlength="5">${esc(t(SUSPEND_REASON))}</textarea>
        <div class="btn-row"><button class="danger" id="sp-submit">${t('Sperren')}</button><button type="button" class="secondary" id="sp-cancel">${t('Abbrechen')}</button></div>
      </form>`);
    $('#sp-cancel').onclick = closeModal;
    $('#suspend-form').onsubmit = (e) => {
      e.preventDefault();
      guard(async () => {
        const days = $('#sp-days').value;
        // Unveränderten Vorschlag deutsch speichern, damit er beim Teilnehmer übersetzt erscheint
        const text = $('#sp-reason').value;
        const reason = text === t(SUSPEND_REASON) ? SUSPEND_REASON : text;
        await api(`/api/admin/users/${b.dataset.suspend}/suspend`, { days: days === 'unbefristet' ? null : Number(days), reason });
        closeModal();
        toast(t('Teilnehmer gesperrt.'));
        render();
      }, $('#sp-submit'));
    };
  }));
}

// ---------- Start ----------
(async function init() {
  try { state.config = await api('/api/config'); } catch {}
  try { state.me = (await api('/api/me')).user; } catch {}
  await loadLanguage(preferredLanguage());
  render();
})();
