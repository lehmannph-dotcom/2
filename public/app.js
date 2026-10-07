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

// ---------- Helfer ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euro = (cents) => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const kg = (v) => Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 });
const km = (v) => `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 })} km`;
const shortLabel = (p) => (p && p.label ? p.label.split(',').slice(0, 2).join(',') : '');

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Fehler ${res.status}`);
    err.details = data.details;
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ---------- Info-Kontextmenü: Erklärungen per Mouseover, Fokus oder Antippen ----------
/** ⓘ-Symbol mit Erklärung. html wird so eingefügt – Nutzerdaten vorher mit esc() schützen. */
// Der Inhalt steckt in einem <template>: so darf er Absätze und Tabellen enthalten, ohne das
// umgebende HTML (z. B. ein <p>) aufzubrechen, und wird nicht angezeigt.
const info = (html, label = 'Erklärung') =>
  `<span class="info" tabindex="0" role="button" aria-label="${esc(label)}">i<template class="tip-content">${html}</template></span>`;
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
  attribution: '&copy; OpenStreetMap-Mitwirkende',
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
        <input id="f-${key}" data-place="${key}" autocomplete="off" placeholder="${placeholder}" value="${esc(p ? p.label : '')}">
        <ul hidden></ul>
      </div>
      ${withLocate ? `<button type="button" class="secondary shrink" data-locate="${key}" data-tip="Aktuellen Standort verwenden" aria-label="Aktuellen Standort verwenden">Standort</button>` : ''}
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
          list.innerHTML = results.map((r, i) => `<li data-i="${i}">${esc(r.label)}</li>`).join('') || '<li class="muted">Nichts gefunden</li>';
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
      if (!navigator.geolocation) return toast('Standortbestimmung nicht verfügbar.');
      navigator.geolocation.getCurrentPosition(
        (pos) => setPlace(btn.dataset.locate, { lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Mein Standort' }),
        () => toast('Standort konnte nicht ermittelt werden.'),
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
  if (!results.length) throw new Error(`„${q}“ wurde nicht gefunden.`);
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

function renderHeader() {
  const nav = $('#nav');
  nav.hidden = !state.me;
  $('#nav-admin').hidden = !(state.me && state.me.isAdmin);
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.view === currentView()));
  $('#userbox').innerHTML = state.me
    ? `<a class="points-pill" href="#/punkte" data-tip="Level ${esc(state.me.level.name)}">${Number(state.me.points).toLocaleString('de-DE')} P</a><span>${esc(state.me.name)} · <b>${euro(state.me.walletCents - state.me.reservedCents)}</b></span><button class="secondary" id="logout">Abmelden</button>`
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
  renderHeader();
}

// ---------- Anmeldung ----------
function renderAuth(panel) {
  drawMap();
  const cfg = state.config ? state.config.pricing : null;
  panel.innerHTML = `
    <div class="card hero">
      <h2>Teilen statt Leerfahren </h2>
      <p>Spontan mitfahren, Kosten pro Kilometer teilen, CO₂ sparen.</p>
    </div>
    <div class="card">
      <div class="tabs">
        <button id="tab-login">Anmelden</button>
        <button id="tab-register" class="secondary">Registrieren</button>
      </div>
      <form id="auth-form">
        <div id="name-field" hidden>
          <label for="a-name">Name</label>
          <input id="a-name" autocomplete="name">
        </div>
        <label for="a-email">E-Mail</label>
        <input id="a-email" type="email" autocomplete="email" required>
        <label for="a-pass">Passwort</label>
        <input id="a-pass" type="password" autocomplete="current-password" minlength="8" required>
        <label class="check" id="consent-field" hidden>
          <input type="checkbox" id="a-consent">
          <span>Ich akzeptiere die <a href="#/nutzungsbedingungen" target="_blank">Nutzungsbedingungen</a>, habe die <a href="#/datenschutz" target="_blank">Datenschutzerklärung</a> gelesen und stimme der Verarbeitung meiner Daten zur Vermittlung und Abrechnung von Fahrten zu.</span>
        </label>
        <button class="full" style="margin-top:14px" id="a-submit">Anmelden</button>
      </form>
      <form id="mfa-form" hidden>
        <h3>Zwei-Faktor-Bestätigung ${info('Gib den 6-stelligen Code aus deiner Authenticator-App ein – oder einen deiner Backup-Codes.')}</h3>
        <input id="mfa-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="9" placeholder="123456" required>
        <button class="full" style="margin-top:14px" id="mfa-submit">Bestätigen</button>
        <button type="button" class="secondary full" style="margin-top:8px" id="mfa-back">Zurück</button>
      </form>
    </div>
    <div class="card">
      <h3>So funktioniert's</h3>
      <ol class="steps">
        <li><b>Fahrer</b> gehen mit ihrer Route online ${info('Einmalig den Führerschein verifizieren, dann Route eingeben oder einen Google-Maps-Link einfügen.')}</li>
        <li><b>Mitfahrer</b> finden den passenden Fahrer ${info('Ziel eingeben – die App findet den Fahrer mit dem kleinsten Umweg, der kürzesten Wartezeit und guten Bewertungen.')}</li>
        <li><b>Kosten teilen</b> pro Kilometer ${info(`<p>Abgerechnet wird die geplante Route – oder die gefahrene Strecke, wenn sie kürzer ist${cfg ? ` (${euro(cfg.ratePerKmCents)}/km)` : ''}.</p><p>Der Großteil geht an den Fahrer, ${cfg ? cfg.commissionPercent : '–'} % Vermittlungsprovision, ${cfg ? euro(cfg.donationCentsPerRide) : '1 Cent'} Umweltspende je Fahrt.</p>`)}</li>
      </ol>
    </div>`;
  let mode = 'login';
  const setMode = (m) => {
    mode = m;
    $('#tab-login').className = m === 'login' ? '' : 'secondary';
    $('#tab-register').className = m === 'register' ? '' : 'secondary';
    $('#name-field').hidden = m !== 'register';
    $('#consent-field').hidden = m !== 'register';
    $('#a-submit').textContent = m === 'login' ? 'Anmelden' : 'Konto erstellen';
    $('#a-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  };
  $('#tab-login').onclick = () => setMode('login');
  $('#tab-register').onclick = () => setMode('register');
  $('#auth-form').onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      const body = { email: $('#a-email').value, password: $('#a-pass').value, name: $('#a-name').value, acceptPrivacy: $('#a-consent').checked };
      if (mode === 'register' && !body.acceptPrivacy) throw new Error('Bitte den Nutzungsbedingungen und der Datenschutzerklärung zustimmen.');
      const res = await api(mode === 'login' ? '/api/login' : '/api/register', body);
      if (res.mfaRequired) {
        mfaToken = res.mfaToken;
        $('#auth-form').hidden = true;
        $('.tabs').hidden = true;
        $('#mfa-form').hidden = false;
        $('#mfa-code').focus();
        return;
      }
      state.me = res.user;
      render();
    }, $('#a-submit'));
  };
  let mfaToken = null;
  $('#mfa-form').onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      try {
        const res = await api('/api/login/mfa', { mfaToken, code: $('#mfa-code').value });
        state.me = res.user;
        if (res.usedBackupCode) toast(`Backup-Code verwendet – noch ${res.user.backupCodesLeft} übrig.`);
        render();
      } catch (err) {
        $('#mfa-code').value = '';
        if (err.status === 429 || /abgelaufen/.test(err.message)) $('#mfa-back').click();
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
  requested: ['Angefragt – wartet auf Fahrer', 'warn'],
  accepted: ['Bestätigt – Fahrer ist unterwegs', 'ok'],
  picked_up: ['Unterwegs', 'ok'],
  confirming: ['Wartet auf Bestätigung', 'warn'],
  disputed: ['Reklamation – Betreiber prüft', 'bad'],
  completed: ['Abgeschlossen', 'ok'],
  declined: ['Abgelehnt', 'bad'],
  cancelled: ['Storniert', 'bad'],
};
const statusBadge = (s) => `<span class="badge ${STATUS[s][1]}">${STATUS[s][0]}</span>`;
const PLANNED_STYLE = { color: '#2f7350', weight: 4, dash: '10 8', opacity: 0.9 };
const BILLING_RULE = 'Mit dem Einsteigen wird der Preis der geplanten Route fällig – auch wenn die Fahrt früher endet. Umwege zahlst du nie. Nur bei einem begründeten Fahrtabbruch wird die bis dahin gefahrene Strecke berechnet.';
const TIP = {
  billing: (who = 'du') => `<p><b>So wird abgerechnet</b></p><p>Grundlage ist die <b>schnellste Route laut Plan</b>, die ihr beide vorab bestätigt habt.</p><p>Mit dem <b>Einsteigen</b> wird der Preis der geplanten Route fällig – auch wenn die Fahrt früher endet. Ist die Strecke länger (Umweg), bleibt es beim geplanten Preis – Umwege zahlt ${who === 'du' ? 'du' : 'der Mitfahrer'} nie.</p><p>Nur bei einem <b>begründeten Fahrtabbruch</b> wird die bis dahin gefahrene Strecke (GPS) berechnet. Abbrüche erscheinen als Fahrtabbruchsquote im Profil beider Beteiligten.</p>`,
  price: () => {
    const c = state.config ? state.config.pricing : { ratePerKmCents: 25, commissionPercent: 10, donationCentsPerRide: 1 };
    return `<p><b>Kostenteilung pro Kilometer</b></p><table><tr><td>Kilometersatz</td><td>${euro(c.ratePerKmCents)}/km</td></tr><tr><td>an den Fahrer</td><td>${100 - c.commissionPercent} %</td></tr><tr><td>Vermittlungsprovision</td><td>${c.commissionPercent} %</td></tr><tr><td>Anfahrt zum Treffpunkt</td><td>100 % Fahrer</td></tr><tr><td>Umweltspende je Fahrt</td><td>${euro(c.donationCentsPerRide)}</td></tr></table><p style="margin-top:6px">Der Preis der geplanten Route ist der Höchstbetrag. Er wird reserviert und erst nach der Fahrt abgebucht.</p>`;
  },
  payment: (isRider) => `<p><b>Wann wird bezahlt?</b></p><p>Sobald der Fahrer ${isRider ? 'dich' : 'den Mitfahrer'} abgesetzt <b>und</b> ${isRider ? 'du die Fahrt' : 'der Mitfahrer die Fahrt'} bewertet ${isRider ? 'hast' : 'hat'} – Reihenfolge egal.</p><p>Die Bewertung ändert den Preis nicht. Ohne Rückmeldung gilt die Fahrt nach 24 h als bestätigt.</p>`,
  points: () => `<p><b>Punkte = Faktor × eingesparte kg CO₂</b></p><p>Der Faktor ist die Bewertung, die du vom jeweils anderen bekommst:</p><table><tr><td>10 · 9 · 8 · 7</td><td>×10 · ×9 · ×8 · ×7</td></tr><tr><td>6 · 5 · 4</td><td>×1</td></tr><tr><td>3 · 2 · 1 · 0</td><td>×0</td></tr></table>`,
  nps: () => `<p><b>NPS – Net Promoter Score</b></p><p>Frage: „Wie wahrscheinlich empfiehlst du diese Person weiter?“ (0–10)</p><table><tr><td>Promotoren</td><td>9–10</td></tr><tr><td>Passive</td><td>7–8</td></tr><tr><td>Kritiker</td><td>0–6</td></tr></table><p style="margin-top:6px">NPS = % Promotoren − % Kritiker (−100 bis +100).</p>`,
  detour: () => `<p><b>Anfahrt zum Treffpunkt</b></p><p>Der Umweg, den der Fahrer fährt, um dich abzuholen – zum gleichen Kilometersatz.</p><p>Dieser Teil geht <b>zu 100 % an den Fahrer</b>: Der Plattformbetreiber nimmt darauf keine Provision.</p>`,
  plannedRoute: () => `<p><b>Geplante Route</b></p><p>Die schnellste Route vom Abholort zum Ziel (dunkelgrün gestrichelt auf der Karte). Du und der Fahrer bestätigen sie – sie ist Grundlage und Obergrenze für den Preis.</p>`,
};
const BASIS = { geplant: 'geplante Route', gefahren: 'gefahrene Strecke', abbruch: 'Fahrtabbruch (gefahrene Strecke)', betreiber: 'Entscheidung Betreiber' };

/** Fahrtabbruchsquote als Badge: Anteil abgebrochener Fahrten an allen Fahrten in der Rolle. */
function abortBadge(st, roleLabel = '', short = '') {
  if (!st || !st.rides) return `<span class="badge" tabindex="0" data-tip="Noch keine abgeschlossenen Fahrten${roleLabel ? ' ' + roleLabel : ''}.">Fahrtabbruchsquote${short} –</span>`;
  const cls = st.quote <= 5 ? 'ok' : st.quote <= 15 ? 'warn' : 'bad';
  return `<span class="badge ${cls}" tabindex="0" data-tip="${st.aborted} von ${st.rides} Fahrten${roleLabel ? ' ' + roleLabel : ''} abgebrochen, davon ${st.initiated} selbst. Jeder Abbruch zählt für beide Beteiligten.">Fahrtabbruchsquote${short} ${st.quote} %</span>`;
}

function plannedRouteHtml(route, note) {
  const estimated = route.provider === 'luftlinie' ? `<span class="warn-text">Strecke geschätzt ${info('Der Routendienst ist gerade nicht erreichbar. Die Strecke wurde aus der Luftlinie × 1,3 geschätzt.')}</span>` : '';
  return `<div class="planned"><span><b>Geplante Route:</b> ${km(route.distanceKm)} · ca. ${Math.round(route.durationMin)} min</span>${info(TIP.plannedRoute())}${estimated}${note ? `<span class="muted small" style="width:100%">${note}</span>` : ''}</div>`;
}

// ---------- Bewertung nach NPS-Logik (0–10) ----------
const bewertungen = (n) => `${n} ${n === 1 ? 'Bewertung' : 'Bewertungen'}`;
const NPS_CAT = (n) => (n >= 9 ? 'promoter' : n >= 7 ? 'passive' : 'detractor');
const NPS_COMMENT = {
  promoter: 'Was hat dir besonders gefallen? (optional)',
  passive: 'Möchtest du noch etwas ergänzen? (optional)',
  detractor: 'Möchtest du noch etwas ergänzen? (optional)',
};
const ASPECT_HEADING = {
  passive: 'Was hätte besser sein können? (freiwillig)',
  detractor: 'Was war der Grund? (freiwillig)',
};

/** NPS-Skala 0–10; ratedRole ('driver'|'rider') bestimmt die möglichen Gründe bei Bewertungen bis 8. */
function npsWidget(question, ratedRole = 'driver') {
  const aspects = (state.config && state.config.aspects && state.config.aspects[ratedRole]) || [];
  const partner = ratedRole === 'driver' ? 'Der Fahrer' : 'Der Mitfahrer';
  return `<div class="nps">
    <p class="nps-q">${esc(question)} ${info(TIP.nps())}</p>
    <div class="nps-scale" role="radiogroup">${Array.from({ length: 11 }, (_, i) => `<button type="button" class="nps-btn ${NPS_CAT(i)}" data-score="${i}" role="radio" aria-checked="false">${i}</button>`).join('')}</div>
    <div class="nps-legend"><span>unwahrscheinlich</span><span>sehr wahrscheinlich</span></div>
    <div class="nps-aspects" hidden>
      <p class="nps-aspects-q"><span class="nps-aspects-text"></span>${info(`<p><b>Anonymes Feedback zum Lernen</b></p><p>${partner} sieht deine Hinweise nur gesammelt – frühestens ab 3 Rückmeldungen, ohne Datum und ohne Zuordnung zu dieser Fahrt.</p><p>Bei echten Problemen bitte „Problem melden“.</p>`)}</p>
      <div class="aspect-chips">${aspects.map((a) => `<button type="button" class="aspect-chip" data-aspect="${a.id}" aria-pressed="false">${esc(a.label)}</button>`).join('')}</div>
    </div>
    <label class="nps-comment-label" hidden></label>
    <textarea class="nps-comment" maxlength="500" hidden></textarea>
  </div>`;
}

function npsBadge(summary, label = 'NPS') {
  if (!summary || !summary.count) return '<span class="badge">Neu – noch keine Bewertung</span>';
  const cls = summary.score >= 50 ? 'ok' : summary.score >= 0 ? 'warn' : 'bad';
  return `<span class="badge ${cls}" tabindex="0" data-tip="NPS: ${summary.promoters} Promotoren · ${summary.passives} Passive · ${summary.detractors} Kritiker">${label} ${summary.score > 0 ? '+' : ''}${summary.score} · ${bewertungen(summary.count)}</span>`;
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
          aspectsBox.querySelector('.nps-aspects-text').textContent = ASPECT_HEADING[cat] || '';
        }
        const label = form.querySelector('.nps-comment-label');
        label.textContent = NPS_COMMENT[cat];
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
  const mine = isRider ? (r.myEndConfirmed ? '✓ Du hast die Fahrt bewertet.' : '○ Deine Bewertung fehlt.') : (r.myEndConfirmed ? '✓ Du hast das Absetzen bestätigt.' : '○ Absetzen noch nicht bestätigt.');
  const theirs = isRider ? (r.partnerEndConfirmed ? '✓ Der Fahrer hat dich abgesetzt.' : '○ Der Fahrer hat das Absetzen noch nicht bestätigt.') : (r.partnerEndConfirmed ? '✓ Der Mitfahrer hat die Fahrt bewertet.' : '○ Der Mitfahrer hat noch nicht bewertet.');
  const open = !r.myEndConfirmed && r.status !== 'disputed';
  return `<div class="card confirm-card">
    <h3>${isRider ? 'Angekommen? Bewerten & bezahlen' : 'Mitfahrer absetzen'} ${info(TIP.payment(isRider))}</h3>
    <table class="breakdown">
      <tr><td>Geplante Route</td><td>${km(p.plannedKm)}${r.plannedRoute ? ` · ${Math.round(r.plannedRoute.durationMin)} min` : ''}</td></tr>
      <tr><td>Gefahren (GPS)${measuring ? ' <span class="muted small">– läuft</span>' : ''}</td><td>${p.trackedKm > 0.2 ? km(p.trackedKm) : '–'}</td></tr>
      <tr class="total"><td>Abgerechnet: ${BASIS[p.basis]} ${info(TIP.billing(isRider ? 'du' : 'mitfahrer'))}</td><td>${km(p.billedKm)}</td></tr>
      ${p.price.detourCents ? `<tr><td>Anfahrt zum Treffpunkt ${info(TIP.detour())}</td><td>${km(p.price.detourKm)}</td></tr>` : ''}
      <tr><td>${isRider ? 'Du zahlst' : 'Dein Anteil'}</td><td><b>${euro(isRider ? p.price.totalCents : p.price.driverCents)}</b></td></tr>
    </table>
    <p class="status-lines">${mine}<br>${theirs}
      ${r.autoConfirmAt && !(r.myEndConfirmed && r.partnerEndConfirmed) ? ` ${info(`Ohne Rückmeldung gilt die Fahrt am ${new Date(r.autoConfirmAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} als bestätigt.`)}` : ''}</p>
    ${r.status === 'disputed' ? `<p class="small"><span class="badge bad">Reklamation</span> ${esc(r.dispute.reason)}</p>` : ''}
    ${open && isRider ? `<form class="nps-form" data-confirm-form="${r.id}">
        ${npsWidget(`Wie wahrscheinlich ist es, dass du ${r.driverName} weiterempfiehlst?`)}
        <div class="btn-row"><button data-submit disabled>Bewerten & bezahlen</button><button type="button" class="secondary" data-dispute="${r.id}">Problem melden</button>${measuring ? `<button type="button" class="danger" data-abort="${r.id}">Fahrt abbrechen</button>` : ''}</div>
      </form>` : ''}
    ${open && !isRider ? `<form class="nps-form" data-confirm-form="${r.id}">
        <details><summary class="small">Optional: ${esc(r.riderName)} bewerten</summary>${npsWidget(`Wie wahrscheinlich ist es, dass du ${r.riderName} anderen Fahrern weiterempfiehlst?`, 'rider')}</details>
        <div class="btn-row"><button data-submit>${measuring ? 'Mitfahrer abgesetzt' : 'Absetzen bestätigen'}</button><button type="button" class="secondary" data-dispute="${r.id}">Problem melden</button>${measuring ? `<button type="button" class="danger" data-abort="${r.id}">Fahrt abbrechen</button>` : ''}</div>
      </form>` : ''}
  </div>`;
}

function bindConfirmButtons(root) {
  bindNpsForms(root, '[data-confirm-form]', async (form, body) => {
    const { ride } = await api(`/api/rides/${form.dataset.confirmForm}/confirm`, body);
    if (ride.status === 'completed') toast(`Bezahlt: ${km(ride.final.km)} · ${euro(ride.role === 'driver' ? ride.final.driverCents : ride.final.totalCents)} · +${pts(ride.myPoints.points)}`);
    if (ride.guestbook && ride.guestbook.eligible) {
      await refreshMe();
      render();
      openGuestbookForm(ride, { afterRide: true });
      return;
    }
    else toast(ride.role === 'rider' ? 'Danke für deine Bewertung! Gezahlt wird, sobald der Fahrer das Absetzen bestätigt.' : 'Abgesetzt – gezahlt wird, sobald der Mitfahrer bewertet hat.');
    await refreshMe();
    render();
  });
  root.querySelectorAll('[data-abort]').forEach((b) => (b.onclick = () => {
    const ride = state.rides.find((x) => x.id === b.dataset.abort) || {};
    const driven = ride.trackedKm > 0 ? km(ride.trackedKm) : '0 km';
    openModal(`<h2>Fahrt abbrechen</h2>
      <p>Bei einem Abbruch wird nur die bisher gefahrene Strecke berechnet (zurzeit <b>${driven}</b>${ride.estimate && ride.estimate.detourCents ? ' plus Anfahrt zum Treffpunkt' : ''}). ${info('<p>Ohne Abbruch ist mit dem Einsteigen der Preis der geplanten Route fällig – auch wenn ihr früher aussteigt. So lohnt sich ein abgesprochenes vorzeitiges Ende nicht.</p><p>Jeder Abbruch zählt in der Fahrtabbruchsquote von Fahrer und Mitfahrer und ist in beiden Profilen sichtbar.</p>')}</p>
      <form id="abort-form">
        <label for="ab-cat">Grund</label>
        <select id="ab-cat" required><option value="">Bitte wählen</option>${(state.config.abortReasons || []).map((x) => `<option value="${x.id}">${esc(x.label)}</option>`).join('')}</select>
        <label for="ab-reason">Begründung</label>
        <textarea id="ab-reason" maxlength="500" minlength="10" required placeholder="Was ist passiert?"></textarea>
        <ul class="errors" id="ab-errors"></ul>
        <div class="btn-row"><button class="danger" id="ab-submit">Fahrt abbrechen und abrechnen</button><button type="button" class="secondary" id="ab-cancel">Weiterfahren</button></div>
      </form>`);
    $('#ab-cancel').onclick = closeModal;
    $('#abort-form').onsubmit = (e) => {
      e.preventDefault();
      guard(async () => {
        try {
          const { ride: done } = await api(`/api/rides/${b.dataset.abort}/abort`, { category: $('#ab-cat').value, reason: $('#ab-reason').value });
          closeModal();
          toast(`Fahrt abgebrochen. Abgerechnet: ${km(done.final.km)} · ${euro(done.role === 'driver' ? done.final.driverCents : done.final.totalCents)}`);
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
    openModal(`<h2>Problem melden</h2>
      <p class="muted">Die Fahrt wird dann nicht automatisch abgerechnet. Der Betreiber prüft den Fall und meldet sich bei euch.</p>
      <form id="dispute-form"><label for="d-reason">Was ist passiert?</label><textarea id="d-reason" maxlength="500" required></textarea>
      <div class="btn-row"><button class="danger">Reklamation senden</button></div></form>`);
    $('#d-reason').focus();
    $('#dispute-form').onsubmit = (e) => {
      e.preventDefault();
      guard(async () => {
        await api(`/api/rides/${b.dataset.dispute}/dispute`, { reason: $('#d-reason').value });
        closeModal();
        toast('Reklamation gesendet.');
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
      <h2>Wohin möchtest du? ${info('<p><b>Tipp:</b> Abholort und Ziel kannst du auch direkt auf der Karte anklicken – erst A, dann B.</p><p>„Standort“ nutzt deinen aktuellen Standort.</p>')}</h2>
      ${placeField('pickup', 'Abholort', 'Adresse oder Ort', true)}
      ${placeField('dropoff', 'Ziel', 'Wohin soll es gehen?')}
      <div class="row">
        <div>
          <label for="r-seats">Personen</label>
          <select id="r-seats">${[1, 2, 3, 4].map((n) => `<option ${n === state.seats ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </div>
        <div class="shrink"><button id="r-search">Besten Fahrer finden</button></div>
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
  if (!pickup || !dropoff) throw new Error('Bitte Abholort und Ziel angeben.');
  const res = await api('/api/match', { pickup, dropoff, seats: state.seats, filters: state.filters });
  const { matches, activeDrivers, plannedRoute } = res;
  state.matchResult = res;
  state.matches = matches;
  state.plannedRoute = plannedRoute;
  state.selected = matches[0] || null;
  state.activeDrivers = activeDrivers;
  if (!matches.length) {
    $('#matches').innerHTML = res.hiddenByFilters
      ? `<div class="card"><h3>Kein passender Fahrer</h3>${filterSummary(res)}</div>`
      : `<div class="card"><h3>Gerade kein passender Fahrer ${info(`${activeDrivers} Fahrer sind gerade unterwegs, aber keiner fährt in der Nähe deiner Strecke vorbei. Versuche es in ein paar Minuten erneut.`)}</h3><p class="muted">Bitte später noch einmal versuchen.</p></div>`;
    previewPlaces();
    return;
  }
  renderMatches();
}

async function renderMatches() {
  const box = $('#matches');
  if (!box) return;
  box.innerHTML = `<div class="card"><h2>${state.matches.length} ${state.matches.length === 1 ? 'passender' : 'passende'} Fahrer ${info('<p><b>Sortiert nach kürzestem Umweg</b> </p><p>Ganz oben steht immer der Fahrer, der für dich den geringsten Umweg fährt – das spart die meisten zusätzlichen Kilometer. Bei gleichem Umweg entscheidet die kürzere Wartezeit.</p>')}</h2>
    ${state.matchResult ? filterSummary(state.matchResult) : ''}
    ${state.matches.map((m, i) => `
      <div class="match ${state.selected && state.selected.tripId === m.tripId ? 'selected' : ''}" data-i="${i}">
        <div class="top">
          <div>${profileLink(m.driverId, m.driverName)} ${i === 0 ? `<span class="badge best" tabindex="0" data-tip="Sortiert nach dem kürzesten Umweg des Fahrers – so entstehen die wenigsten zusätzlichen Kilometer.">Kürzester Umweg</span>` : ''}<br>
            ${npsBadge(m.driverNps)} ${abortBadge(m.driverAbort, 'als Fahrer')} ${prefIcons(m)}<br><span class="muted small">${esc(m.vehicle || 'Pkw')} · ${m.seatsFree} frei</span></div>
          <div class="price">${euro(m.price.totalCents)}</div>
        </div>
        <div class="muted small" style="margin-top:6px">
          ${km(m.detourKm)} Umweg · ${m.etaMin} min Wartezeit · ${kg(m.price.co2SavedKg)} kg CO₂ gespart ${info(`<table><tr><td>Abholung in ca.</td><td>${m.etaMin} min</td></tr><tr><td>Umweg für den Fahrer</td><td>${km(m.detourKm)}</td></tr><tr><td>davon Anfahrt zum Treffpunkt</td><td>${km(m.pickupDetourKm)}</td></tr><tr><td>CO₂-Ersparnis</td><td>${kg(m.price.co2SavedKg)} kg</td></tr></table><p style="margin-top:6px">Fahrer fährt (ungefähr): ${esc(shortLabel(m.origin))} → ${esc(shortLabel(m.destination))}. Start und Ziel des Fahrers zeigen wir zum Schutz seiner Adresse nur ungefähr.</p>`, 'Details zur Fahrt')}
        </div>
      </div>`).join('')}
    </div>
    ${state.selected ? `<div class="card">
        <h3>Deine Fahrt bestätigen</h3>
        ${plannedRouteHtml(state.plannedRoute)}
      </div>` + priceCard(state.selected.price, 'Preis (Höchstbetrag)') + `<button class="full" id="r-book">Route bestätigen & bei ${esc(state.selected.driverName)} anfragen</button>` : ''}`;
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
  const split = `<table><tr><td>${km(p.km)} × ${euro(p.ratePerKmCents)}${p.seats > 1 ? ` × ${p.seats} Pers.` : ''}</td><td>${euro(p.fareCents)}</td></tr><tr><td>davon an den Fahrer</td><td>${euro(p.driverCents)}</td></tr><tr><td>davon Vermittlungsprovision</td><td>${euro(p.commissionCents)}</td></tr><tr><td>Spende Umweltschutz</td><td>${euro(p.donationCents)}</td></tr></table><p style="margin-top:6px">Provision nur auf die gemeinsame Strecke – nicht auf die Anfahrt zum Treffpunkt.</p>`;
  return `<div class="card"><h3>${title} ${info(TIP.price())}</h3>
    <table class="breakdown">
      <tr><td>${withTip(`Fahrtkosten ${km(p.km)}`, split)}</td><td>${euro(p.fareCents)}</td></tr>
      ${p.detourCents ? `<tr><td>Anfahrt zum Treffpunkt ${km(p.detourKm)} ${info(TIP.detour())}</td><td>${euro(p.detourCents)}</td></tr>` : ''}
      <tr><td>Umweltspende</td><td>${euro(p.donationCents)}</td></tr>
      <tr class="total"><td>Gesamt ${info(TIP.billing())}</td><td>${euro(p.totalCents)}</td></tr>
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
      toast(err.message + ' Bitte Guthaben im Konto aufladen.');
      location.hash = '#/konto';
      return;
    }
    throw err;
  }
  toast('Route bestätigt und angefragt – der Fahrer muss die Route ebenfalls bestätigen.');
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
  panel.innerHTML = `
    <div class="card">
      <h2>Deine Mitfahrt</h2>
      ${statusBadge(ride.status)}
      <p>${profileLink(ride.driverId, ride.driverName)} ${ride.vehicle ? '· ' + esc(ride.vehicle) : ''} ${abortBadge(ride.partnerAbort, 'als Fahrer')}</p>
      <p class="muted small">${esc(shortLabel(ride.pickup))} → ${esc(shortLabel(ride.dropoff))}</p>
      ${ride.plannedRoute ? plannedRouteHtml(ride.plannedRoute, `${ride.myRouteConfirmed ? '✓ von dir bestätigt' : ''}${ride.partnerRouteConfirmed ? ' · ✓ vom Fahrer bestätigt' : ' · ○ Fahrer hat noch nicht bestätigt'}`) : ''}
      ${['requested', 'accepted'].includes(ride.status) ? '<button class="secondary" id="r-cancel" style="margin-top:10px">Stornieren</button>' : ''}
    </div>
    ${['picked_up', 'confirming'].includes(ride.status) ? confirmationCard(ride) : priceCard(ride.estimate, 'Preis (Höchstbetrag)')}`;
  bindConfirmButtons(panel);
  const c = $('#r-cancel');
  if (c) c.onclick = () => guard(async () => { await api(`/api/rides/${ride.id}/cancel`, {}); await refreshMe(); render(); }, c);
  await draw(true);
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try { await loadRides(); } catch { return; }
    const now = state.rides.find((r) => r.id === ride.id);
    if (!now || now.status !== ride.status || now.partnerEndConfirmed !== ride.partnerEndConfirmed || (now.status === 'picked_up' && now.trackedKm !== ride.trackedKm)) {
      if (now && now.status === 'completed') toast(`Fahrt abgerechnet: ${km(now.final.km)} · ${euro(now.final.totalCents)} – danke fürs Teilen`);
      if (now && now.status === 'declined') toast('Der Fahrer hat abgelehnt. Bitte wähle einen anderen Fahrer.');
      await refreshMe();
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
      <h2>Jetzt als Fahrer online gehen ${info('<p>Du fährst sowieso? Gib deine Route ein oder füge den Link deiner Google-Maps-Route ein – Mitfahrer auf deinem Weg finden dich automatisch.</p><p>Start und Ziel zeigen wir anderen nur ungefähr.</p>')}</h2>
      <label for="d-link">Google-Maps-Routenlink ${info('<p>In Google Maps die Route planen → „Teilen“ → Link kopieren.</p><p>Funktioniert mit google.com/maps/dir/… und Kurzlinks maps.app.goo.gl/…</p>')}</label>
      <input id="d-link" placeholder="https://www.google.com/maps/dir/…  oder  https://maps.app.goo.gl/…">
      <p class="muted small" style="text-align:center;margin:10px 0 0">– oder –</p>
      ${placeField('origin', 'Start', 'Wo startest du?', true)}
      ${placeField('destination', 'Ziel', 'Wohin fährst du?')}
      <div class="row">
        <div><label for="d-seats">Freie Plätze</label>
          <select id="d-seats">${[1, 2, 3, 4, 5, 6].map((n) => `<option ${n === 3 ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div><label for="d-vehicle">Fahrzeug (optional)</label><input id="d-vehicle" placeholder="z. B. blauer VW Golf"></div>
      </div>
      <div class="btn-row">
        <button class="secondary" id="d-preview">Route anzeigen</button>
        <button id="d-start">Online gehen</button>
      </div>
    </div>
    <div id="d-route"></div>`;
  bindPlaceFields(panel);
  const routeBody = async () => {
    const link = $('#d-link').value.trim();
    if (link) return { googleMapsUrl: link };
    const origin = await ensurePlace('origin');
    const destination = await ensurePlace('destination');
    if (!origin || !destination) throw new Error('Bitte Start und Ziel oder einen Google-Maps-Link angeben.');
    return { origin, destination };
  };
  $('#d-preview').onclick = (e) =>
    guard(async () => {
      const { route } = await api('/api/route/preview', await routeBody());
      $('#d-route').innerHTML = `<div class="card"><h3>${esc(shortLabel(route.origin))} → ${esc(shortLabel(route.destination))}</h3>
        <p class="muted">${km(route.distanceKm)} · ca. ${Math.round(route.durationMin)} min ${info(`<p>Quelle: ${esc(route.provider)}</p><p>Bei voll besetzten Plätzen könntest du bis zu <b>${euro(Math.round(route.distanceKm * state.config.pricing.ratePerKmCents * (1 - state.config.pricing.commissionPercent / 100)) * Number($('#d-seats').value))}</b> deiner Fahrtkosten teilen.</p>`)}</p></div>`;
      drawMap({ routes: [{ coords: route.coords }], points: [{ ...route.origin, color: '#4a9a6e', text: 'S' }, { ...route.destination, color: '#1c3a2a', text: 'Z' }] });
    }, e.target);
  $('#d-start').onclick = (e) =>
    guard(async () => {
      await api('/api/trips', { ...(await routeBody()), seats: Number($('#d-seats').value), vehicle: $('#d-vehicle').value });
      toast('Du bist online – Mitfahrer können dich jetzt finden.');
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
      <h2>Du bist online </h2>
      ${mfaHint()}
      <p><b>${esc(shortLabel(trip.origin))}</b> → <b>${esc(shortLabel(trip.destination))}</b></p>
      <p class="muted small">${km(trip.route.distanceKm)} · ${trip.seatsFree} von ${trip.seats} Plätzen frei · zurückgelegt ${km(trip.progressKm || 0)}</p>
      <div class="btn-row">
        ${tracking ? '<button class="secondary" id="d-stoptrack">Standort-Übertragung stoppen</button>' : '<button id="d-gps">GPS-Standort teilen</button><button class="secondary" id="d-sim">Fahrt simulieren (Demo)</button>'}
        <button class="danger" id="d-end">Fahrt beenden</button>
      </div>
      <p class="muted small">GPS misst die gefahrenen Kilometer ${info(TIP.billing('mitfahrer') + '<p>Dein Standort wird nur während der aktiven Fahrt übertragen und nur bestätigten Mitfahrern angezeigt.</p>')}</p>
    </div>
    <div class="card">
      <h2>Mitfahrer</h2>
      ${rides.length ? rides.map(driverRideCard).join('') : `<p class="muted">Noch keine Anfragen ${info('Sobald jemand auf deiner Route mitfahren möchte, erscheint die Anfrage hier – du bekommst einen Hinweis.')}</p>`}
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
    toast('Fahrt beendet. Danke fürs Teilen!');
    render();
  }, e.target));

  const points = [{ ...trip.origin, color: '#4a9a6e', text: 'S' }, { ...trip.destination, color: '#1c3a2a', text: 'Z' }];
  rides.forEach((r) => {
    points.push({ ...r.pickup, color: '#78bf96', text: '↑', label: `Abholen: ${r.riderName}` });
    points.push({ ...r.dropoff, color: '#2f7350', text: '↓', label: `Absetzen: ${r.riderName}` });
  });
  const planned = rides.filter((r) => r.plannedRoute && ['requested', 'accepted', 'picked_up'].includes(r.status)).map((r) => ({ coords: r.plannedRoute.coords, ...PLANNED_STYLE }));
  drawMap({ routes: [{ coords: trip.route.coords }, ...planned], points, driver: trip.position, fit: !renderActiveTrip.fitted });
  renderActiveTrip.fitted = true;

  const sig = (list) => JSON.stringify(list.map((r) => [r.id, r.status, r.trackedKm, r.partnerEndConfirmed]));
  const signature = sig(rides);
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try {
      const [{ trip: t }] = await Promise.all([api('/api/trips/active'), loadRides()]);
      if (!t) return render();
      state.trip = t;
      updateDriverMarker(t.position);
      const now = state.rides.filter((r) => r.tripId === t.id && OPEN_STATES.includes(r.status));
      if (sig(now) !== signature) {
        const done = state.rides.find((r) => r.tripId === t.id && r.status === 'completed' && rides.find((o) => o.id === r.id));
        if (done) toast(`Fahrt mit ${done.riderName} abgerechnet: ${km(done.final.km)} · du erhältst ${euro(done.final.driverCents)}`);
        if (now.some((r) => r.status === 'requested' && !rides.find((o) => o.id === r.id))) toast('Neue Mitfahranfrage!');
        render();
      }
    } catch {}
  }, 4000);
}

function driverRideCard(r) {
  const actions = {
    requested: `<button data-act="accept" data-id="${r.id}">Route bestätigen & annehmen</button><button class="secondary" data-act="decline" data-id="${r.id}">Ablehnen</button>`,
    accepted: `<button data-act="pickup" data-id="${r.id}">Eingestiegen</button><button class="secondary" data-act="cancel" data-id="${r.id}">Stornieren</button>`,
  }[r.status] || '';
  return `<div class="match">
    <div class="top"><span>${profileLink(r.riderId, r.riderName)} ${abortBadge(r.partnerAbort, 'als Mitfahrer')}</span> ${statusBadge(r.status)}</div>
    <div class="muted small">${r.seats} Pers. · ${esc(shortLabel(r.pickup))} → ${esc(shortLabel(r.dropoff))} ${info(`Umweg für dich: ca. ${km(r.detourKm)}`)}</div>
    ${r.plannedRoute && ['requested', 'accepted'].includes(r.status) ? plannedRouteHtml(r.plannedRoute, `dein Anteil max. <b>${euro(r.estimate.driverCents)}</b>${r.partnerRouteConfirmed ? ' · ✓ Mitfahrer' : ''}${r.myRouteConfirmed ? ' · ✓ du' : ''}`) : ''}
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
  if (!navigator.geolocation) return toast('GPS ist auf diesem Gerät nicht verfügbar.');
  state.gpsWatch = navigator.geolocation.watchPosition(
    (p) => sendPosition({ lat: p.coords.latitude, lng: p.coords.longitude }),
    (err) => { toast('GPS-Fehler: ' + err.message); stopDriving(); render(); },
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
    if (along >= total) { clearInterval(state.simTimer); state.simTimer = null; toast('Simulation: Ziel erreicht.'); }
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
  const t = Math.min(1, Math.max(0, (along - cum[i - 1]) / seg));
  return { lat: coords[i - 1].lat + t * (coords[i].lat - coords[i - 1].lat), lng: coords[i - 1].lng + t * (coords[i].lng - coords[i - 1].lng) };
}

// ---------- Führerschein-Verifizierung ----------
function renderLicense(panel) {
  drawMap();
  const lic = state.me.license;
  if (lic && lic.status === 'pending') {
    panel.innerHTML = `<div class="card"><h2>Führerschein wird geprüft ${info('Sobald dein Führerschein bestätigt ist, kannst du sofort als Fahrer online gehen.')}</h2>
      <p><span class="badge warn">In Prüfung</span></p>
      <p class="muted">Nr. ${esc(lic.number)} · Klassen ${esc(lic.classes.join(', '))} · gültig bis ${new Date(lic.expiry).toLocaleDateString('de-DE')}</p>
      <button class="secondary" id="l-refresh">Status aktualisieren</button></div>`;
    $('#l-refresh').onclick = () => guard(async () => { await refreshMe(); render(); });
    return;
  }
  panel.innerHTML = `
    <div class="card">
      <h2>Als Fahrer legitimieren ${info('<p>Um Mitfahrer mitzunehmen, brauchst du einen gültigen Führerschein (mind. Klasse B).</p><p>Die Fotos sieht nur der Betreiber zur Prüfung – danach werden sie gelöscht.</p>')}</h2>
      ${lic && lic.status === 'rejected' ? `<p><span class="badge bad">Abgelehnt</span> ${esc(lic.reviewNote)}</p>` : ''}
      ${lic && lic.status === 'verified' ? '<p><span class="badge bad">Abgelaufen</span> Bitte aktuellen Führerschein einreichen.</p>' : ''}
      <form id="l-form">
        <label for="l-name">Name laut Führerschein</label><input id="l-name" value="${esc(state.me.name)}" required>
        <label for="l-birth">Geburtsdatum</label><input id="l-birth" type="date" required>
        <label for="l-number">Führerscheinnummer (Feld 5)</label><input id="l-number" maxlength="13" placeholder="z. B. B072RRE2I55" required>
        <div class="row">
          <div><label for="l-classes">Klassen (Feld 9)</label><input id="l-classes" value="AM, B, L" required></div>
          <div><label for="l-expiry">Gültig bis (Feld 4b)</label><input id="l-expiry" type="date" required></div>
        </div>
        <label for="l-front">Foto Vorderseite</label><input id="l-front" type="file" accept="image/*" capture="environment" required>
        <label for="l-back">Foto Rückseite</label><input id="l-back" type="file" accept="image/*" capture="environment" required>
        <ul class="errors" id="l-errors"></ul>
        <button class="full" style="margin-top:12px" id="l-submit">Zur Prüfung einreichen</button>
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
        toast('Eingereicht – wir prüfen deinen Führerschein.');
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
    if (!file) return reject(new Error('Bitte beide Fotos auswählen.'));
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
    img.onerror = () => reject(new Error('Bild konnte nicht gelesen werden.'));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- Konto ----------
async function renderAccount(panel) {
  drawMap();
  const [{ transactions }] = await Promise.all([api('/api/wallet/transactions'), loadRides()]);
  const me = state.me;
  const done = state.rides.filter((r) => r.status === 'completed');
  panel.innerHTML = `
    <div class="card">
      <h2>Mein Konto</h2>
      <div class="stats">
        <div class="stat"><b>${euro(me.walletCents - me.reservedCents)}</b><span>verfügbares Guthaben${me.reservedCents ? ` (${euro(me.reservedCents)} reserviert)` : ''}</span></div>
        <div class="stat"><b>${kg(me.co2SavedKg)} kg</b><span>CO₂ gemeinsam eingespart</span></div>
        <div class="stat"><b>${me.nps.count ? (me.nps.score > 0 ? '+' : '') + me.nps.score : '–'}</b><span>dein NPS (${bewertungen(me.nps.count)}: ${me.nps.promoters} Promotoren · ${me.nps.passives} Passive · ${me.nps.detractors} Kritiker)</span></div>
        <div class="stat"><b>${me.abortStats.asDriver.rides || me.abortStats.asRider.rides ? `${me.abortStats.asDriver.rides ? me.abortStats.asDriver.quote + ' %' : '–'} / ${me.abortStats.asRider.rides ? me.abortStats.asRider.quote + ' %' : '–'}` : '–'}</b><span>Fahrtabbruchsquote Fahrer / Mitfahrer ${info(`<p>Anteil abgebrochener Fahrten an allen deinen Fahrten.</p><table><tr><td>als Fahrer</td><td>${me.abortStats.asDriver.aborted} von ${me.abortStats.asDriver.rides}</td></tr><tr><td>als Mitfahrer</td><td>${me.abortStats.asRider.aborted} von ${me.abortStats.asRider.rides}</td></tr></table><p style="margin-top:6px">Sichtbar in deinem Profil für Fahrtpartner.</p>`)}</span></div>
        <div class="stat"><b>${me.canDrive ? 'ja' : 'nein'}</b><span>Fahrer verifiziert</span></div>
      </div>
      <h3 style="margin-top:14px">Guthaben aufladen ${info('Demo-Zahlung. Im Livebetrieb läuft die Zahlung über einen Zahlungsdienstleister.')}</h3>
      <div class="btn-row">${[1000, 2000, 5000].map((c) => `<button class="secondary" data-topup="${c}">+ ${euro(c)}</button>`).join('')}</div>
    </div>
    <div class="card">
      <h2>Fahrten</h2>
      ${done.length ? done.map((r) => `
        <div class="match">
          <div class="top"><span>${r.role === 'rider' ? 'Mitgefahren bei' : 'Mitgenommen:'} <b>${esc(r.role === 'rider' ? r.driverName : r.riderName)}</b>${r.abort ? ` <span class="badge warn" tabindex="0" data-tip="Abgebrochen von ${r.abort.by === r.role ? 'dir' : r.role === 'rider' ? 'dem Fahrer' : 'dem Mitfahrer'}: ${esc(((state.config.abortReasons || []).find((x) => x.id === r.abort.category) || { label: '' }).label)} – ${esc(r.abort.reason)}">Fahrtabbruch</span>` : ''}</span>
            <b>${r.role === 'rider' ? '−' + euro(r.final.totalCents) : '+' + euro(r.final.driverCents)}</b></div>
          <div class="muted small">${new Date(r.completedAt).toLocaleDateString('de-DE')} · ${km(r.final.km)} · ${kg(r.final.co2SavedKg)} kg CO₂ ${info(`<table><tr><td>Abgerechnet</td><td>${km(r.final.km)}</td></tr><tr><td>Grundlage</td><td>${esc(BASIS[r.final.billing] || r.final.billing)}</td></tr>${r.final.plannedKm ? `<tr><td>Geplante Route</td><td>${km(r.final.plannedKm)}</td></tr><tr><td>Gefahren (GPS)</td><td>${r.final.trackedKm > 0.2 ? km(r.final.trackedKm) : '–'}</td></tr>` : ''}${r.final.detourCents ? `<tr><td>Anfahrt zum Treffpunkt</td><td>${km(r.final.detourKm)} · ${euro(r.final.detourCents)} (ohne Provision)</td></tr>` : ''}<tr><td>CO₂ gespart</td><td>${kg(r.final.co2SavedKg)} kg</td></tr><tr><td>Umweltspende</td><td>${euro(r.final.donationCents)}</td></tr></table><p style="margin-top:6px">${new Date(r.completedAt).toLocaleString('de-DE')}</p>`, 'Details zur Abrechnung')}</div>
          <div class="small">${ridePointsLine(r.myPoints)}</div>
          ${r.role === 'rider' ? riderGuestbookLine(r) : ''}
          ${r.myRating ? `<div class="muted small">Deine Bewertung: <b>${r.myRating.score}</b>/10${r.myRating.aspects && r.myRating.aspects.length ? ` · Gründe: ${r.myRating.aspects.map((id) => esc(((state.config.aspects[r.role === 'rider' ? 'driver' : 'rider'] || []).find((a) => a.id === id) || { label: id }).label)).join(', ')}` : ''}</div>` : `<form class="nps-form" data-rate-form="${r.id}">${npsWidget(`Wie wahrscheinlich ist es, dass du ${r.role === 'rider' ? r.driverName : r.riderName} weiterempfiehlst?`, r.role === 'rider' ? 'driver' : 'rider')}<div class="btn-row"><button data-submit disabled>Bewertung senden</button></div></form>`}
        </div>`).join('') : '<p class="muted">Noch keine abgeschlossenen Fahrten.</p>'}
    </div>
    <div class="card">
      <h2>Kontobewegungen</h2>
      <table class="breakdown">${transactions.map((t) => `<tr><td>${esc(t.note)}<br><span class="muted small">${new Date(t.at).toLocaleString('de-DE')}</span></td><td>${euro(t.amountCents)}</td></tr>`).join('') || '<tr><td class="muted">Keine Buchungen</td><td></td></tr>'}</table>
    </div>`;
  panel.querySelectorAll('[data-topup]').forEach((b) =>
    (b.onclick = () => guard(async () => { await api('/api/wallet/topup', { amountCents: Number(b.dataset.topup) }); toast('Guthaben aufgeladen.'); render(); }, b)),
  );
  bindGuestbookButtons(panel);
  bindNpsForms(panel, '[data-rate-form]', async (form, body) => {
    await api(`/api/rides/${form.dataset.rateForm}/rate`, body);
    toast('Danke für deine Bewertung!');
    render();
  });
}

// ---------- Betreiber ----------
async function renderAdmin(panel) {
  drawMap();
  const [stats, { licenses }, { disputes }, { entries: gbEntries }, reviewCard] = await Promise.all([api('/api/admin/stats'), api('/api/admin/licenses'), api('/api/admin/disputes'), api('/api/admin/guestbook'), abortReviewCard()]);
  panel.innerHTML = `
    <div class="card">
      <h2>Betreiber-Übersicht</h2>
      ${mfaHint('Als Betreiber hast du Zugriff auf Führerscheindaten aller Fahrer – bitte unbedingt die Zwei-Faktor-Anmeldung aktivieren.')}
      <div class="stats">
        <div class="stat"><b>${euro(stats.commissionCents)}</b><span>Provision (deine Einnahmen)</span></div>
        <div class="stat"><b>${euro(stats.donationCents)}</b><span>Umweltspenden gesammelt</span></div>
        <div class="stat"><b>${stats.ridesCompleted}</b><span>abgeschlossene Mitfahrten</span></div>
        <div class="stat"><b>${km(stats.kmShared)}</b><span>geteilte Kilometer</span></div>
        <div class="stat"><b>${kg(stats.co2SavedKg)} kg</b><span>CO₂ eingespart</span></div>
        <div class="stat"><b>${stats.driverNps.count ? (stats.driverNps.score > 0 ? '+' : '') + stats.driverNps.score : '–'}</b><span>NPS der Fahrer (${bewertungen(stats.driverNps.count)})</span></div>
        <div class="stat"><b>${stats.openDisputes}</b><span>offene Reklamationen</span></div>
        <div class="stat"><b>${stats.activeTrips} / ${stats.verifiedDrivers}</b><span>Fahrer online / verifiziert</span></div>
      </div>
    </div>
    ${reviewCard}
    <div class="card">
      <h2>Gästebuch-Einträge (${gbEntries.length}) ${info('Neueste Einträge zur Moderation. Verfasser sind auch für dich nicht sichtbar.')}</h2>
      ${gbEntries.length ? gbEntries.map((e) => `<blockquote class="gb-entry ${e.hidden ? 'is-hidden' : ''}"><p>„${esc(e.text)}“</p><footer>bei ${esc(e.driverName)} · ${esc(e.when)} · ${esc(e.kind)}${e.hidden ? ' · vom Fahrer ausgeblendet' : ''} · <button class="linkish" data-gb-delete="${e.id}">löschen</button></footer></blockquote>`).join('') : '<p class="muted">Keine Einträge.</p>'}
    </div>
    <div class="card">
      <h2>Reklamationen (${disputes.length})</h2>
      ${disputes.length ? disputes.map((r) => `
        <div class="match">
          <div class="top"><b>${esc(r.riderName)}</b> bei <b>${esc(r.driverName)}</b></div>
          <div class="small">Gemeldet von ${r.dispute.by === 'rider' ? 'Mitfahrer' : 'Fahrer'}: „${esc(r.dispute.reason)}“</div>
          <div class="muted small">Geplant ${km(r.settlementPreview.plannedKm)} · gefahren ${r.settlementPreview.trackedKm > 0.2 ? km(r.settlementPreview.trackedKm) : '–'} · nach Regel ${km(r.settlementPreview.billedKm)} = ${euro(r.settlementPreview.price.totalCents)}</div>
          <div class="row"><div><label for="km-${r.id}">km abrechnen (leer = Regel, max. ${km(r.plannedKm)})</label><input id="km-${r.id}" type="number" min="0" max="${r.plannedKm}" step="0.1"></div></div>
          <div class="btn-row">
            <button data-resolve="bill" data-ride="${r.id}">Abrechnen</button>
            <button class="danger" data-resolve="cancel" data-ride="${r.id}">Kostenlos stornieren</button>
          </div>
        </div>`).join('') : '<p class="muted">Keine offenen Reklamationen.</p>'}
    </div>
    <div class="card">
      <h2>Führerscheine prüfen (${licenses.length})</h2>
      ${licenses.length ? licenses.map((l) => `
        <div class="match">
          <b>${esc(l.fullName)}</b> <span class="muted small">(${esc(l.email)})</span>
          <div class="muted small">Nr. ${esc(l.number)} · Klassen ${esc(l.classes.join(', '))} · geb. ${new Date(l.birthdate).toLocaleDateString('de-DE')} · gültig bis ${new Date(l.expiry).toLocaleDateString('de-DE')}</div>
          <div class="license-imgs">
            <a href="/api/admin/licenses/${l.userId}/front" target="_blank"><img src="/api/admin/licenses/${l.userId}/front" alt="Vorderseite"></a>
            <a href="/api/admin/licenses/${l.userId}/back" target="_blank"><img src="/api/admin/licenses/${l.userId}/back" alt="Rückseite"></a>
          </div>
          <input placeholder="Notiz (bei Ablehnung)" data-note="${l.userId}">
          <div class="btn-row">
            <button data-decide="verified" data-user="${l.userId}">Bestätigen</button>
            <button class="danger" data-decide="rejected" data-user="${l.userId}">Ablehnen</button>
          </div>
        </div>`).join('') : '<p class="muted">Keine offenen Anträge.</p>'}
    </div>`;
  bindAbortReview(panel);
  bindGuestbookButtons(panel);
  panel.querySelectorAll('[data-resolve]').forEach((b) =>
    (b.onclick = () => guard(async () => {
      await api(`/api/admin/rides/${b.dataset.ride}/resolve`, { decision: b.dataset.resolve, km: $('#km-' + b.dataset.ride).value });
      toast(b.dataset.resolve === 'bill' ? 'Fahrt abgerechnet.' : 'Fahrt storniert.');
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
  return `<button type="button" class="linkish" data-profile="${esc(userId)}" aria-label="Profil von ${esc(name)} ansehen">${esc(name)}</button>`;
}

function avatar(p, cls = '') {
  return p.hasPhoto
    ? `<img class="avatar ${cls}" src="/api/users/${esc(p.id)}/photo?v=${Date.now()}" alt="">`
    : `<span class="avatar ${cls}">${esc((p.name || '?')[0].toUpperCase())}</span>`;
}

const PREF_LABELS = { smoking: 'Rauchen', pets: 'Tiere', music: 'Musik', chat: 'Unterhaltung' };

function profileHtml(p) {
  return `
    <div class="profile-head">${avatar(p)}
      <div><h2 style="margin:0">${esc(p.name)}</h2>
        <div class="chips">
          ${p.verifiedDriver ? '<span class="badge ok">Führerschein geprüft</span>' : ''}
          ${p.mfaEnabled ? '<span class="badge ok">2FA gesichert</span>' : ''}
          ${npsBadge(p.nps)}
          ${p.abortStats && (p.verifiedDriver || p.abortStats.asDriver.rides) ? abortBadge(p.abortStats.asDriver, 'als Fahrer', ' (Fahrer)') : ''}
          ${p.abortStats && p.abortStats.asRider.rides ? abortBadge(p.abortStats.asRider, 'als Mitfahrer', ' (Mitfahrer)') : ''}
        </div>
      </div>
    </div>
    ${p.bio ? `<p>${esc(p.bio)}</p>` : ''}
    ${p.phone ? `<p>Telefon: <a href="tel:${esc(p.phone.replace(/[^+0-9]/g, ''))}">${esc(p.phone)}</a></p>` : ''}
    ${p.vehicle && (p.vehicle.model || p.vehicle.brand) ? `<p class="muted">Fahrzeug: ${esc([p.vehicle.color, p.vehicle.brand, p.vehicle.model].filter(Boolean).join(' '))}${p.vehicle.plateRegion ? ` · <span class="plate"><span class="eu">D</span>${esc(p.vehicle.plateRegion)}</span> ${esc(p.vehicle.regionName)}` : ''}</p>` : ''}
    <div class="chips">${Object.entries(p.preferences).map(([k, v]) => `<span class="badge">${PREF_LABELS[k]}: ${esc(v)}</span>`).join('')}</div>
    ${p.languages.length ? `<p class="muted small">Spricht: ${esc(p.languages.join(', '))}</p>` : ''}
    ${p.stats ? `<div class="stats" style="margin-top:10px">
      <div class="stat"><b>${p.stats.ridesAsDriver}</b><span>Fahrten als Fahrer</span></div>
      <div class="stat"><b>${p.stats.ridesAsRider}</b><span>Fahrten als Mitfahrer</span></div>
      <div class="stat"><b>${kg(p.stats.co2SavedKg)} kg</b><span>CO₂ gespart</span></div>
      <div class="stat"><b>${esc(p.stats.memberSince.split('-').reverse().join('/'))}</b><span>Mitglied seit</span></div>
      ${p.stats.level ? `<div class="stat"><b>${esc(p.stats.level.name)}</b><span>Level</span></div><div class="stat"><b>${Number(p.stats.points).toLocaleString('de-DE')}</b><span>Punkte</span></div>` : ''}
    </div>
    ${p.stats.badges && p.stats.badges.length ? `<div class="chips">${p.stats.badges.map((b) => `<span class="badge">${esc(b.name)}</span>`).join('')}</div>` : ''}` : ''}
    ${guestbookHtml(p.guestbook)}`;
}

async function showProfile(userId, preview) {
  const { profile } = await api(`/api/users/${encodeURIComponent(userId)}/profile${preview ? '?preview=' + preview : ''}`);
  openModal(profileHtml(profile) + (preview ? `<p class="muted small" style="margin-top:12px">Vorschau: ${preview === 'booked' ? 'Sicht eines bestätigten Fahrtpartners' : 'Sicht anderer Mitglieder'}</p>` : ''));
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
function askCredentials(title, text, confirmLabel = 'Bestätigen', danger = false) {
  return new Promise((resolve) => {
    openModal(`<h2>${esc(title)}</h2><p class="muted">${text}</p>
      <form id="cred-form">
        <label for="c-pass">Passwort</label><input id="c-pass" type="password" autocomplete="current-password" required>
        ${state.me.mfaEnabled ? '<label for="c-code">Code aus Authenticator-App oder Backup-Code</label><input id="c-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" required>' : ''}
        <div class="btn-row"><button class="${danger ? 'danger' : ''}">${esc(confirmLabel)}</button><button type="button" class="secondary" id="c-cancel">Abbrechen</button></div>
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
  return `<div class="card notice" style="margin:10px 0"><b>Konto absichern</b><p class="small" style="margin:4px 0 8px">${esc(text || 'Du teilst deinen Standort und erhältst Auszahlungen – schütze dein Konto mit der Zwei-Faktor-Anmeldung.')}</p><a class="btn" href="#/profil">2FA aktivieren</a></div>`;
}

// ---------- Eigenes Profil, Privatsphäre, Sicherheit, Daten ----------
async function renderProfile(panel) {
  drawMap();
  const me = state.me;
  state.filters = me.riderFilters || {};
  const p = me.profile;
  const pv = me.privacy;
  const { sessions } = await api('/api/me/sessions');
  const LANGS = ['Deutsch', 'Englisch', 'Französisch', 'Spanisch', 'Italienisch', 'Türkisch', 'Polnisch', 'Russisch', 'Arabisch', 'Ukrainisch'];
  const PREFS = { smoking: ['nein', 'ja'], pets: ['nein', 'nach Absprache', 'ja'], music: ['egal', 'gerne', 'lieber leise'], chat: ['egal', 'gerne', 'lieber ruhig'] };
  const sel = (k) => `<div><label for="p-${k}">${PREF_LABELS[k]}</label><select id="p-${k}">${PREFS[k].map((o) => `<option ${p.preferences[k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;

  panel.innerHTML = `
    <div class="card">
      <h2>Mein Profil</h2>
      <div class="profile-head">
        ${avatar({ id: me.id, name: me.name, hasPhoto: me.hasPhoto })}
        <div class="btn-row" style="margin:0">
          <label class="btn secondary" style="margin:0;color:var(--text)">Foto wählen<input type="file" id="p-photo" accept="image/*" hidden></label>
          ${me.hasPhoto ? '<button class="secondary" id="p-photo-del">Entfernen</button>' : ''}
        </div>
      </div>
      <form id="profile-form">
        <label for="p-name">Name</label><input id="p-name" value="${esc(me.name)}" required>
        <label for="p-bio">Über mich</label><textarea id="p-bio" maxlength="500" placeholder="z. B. Pendle werktags Berlin → Potsdam, fahre entspannt.">${esc(p.bio)}</textarea>
        <label for="p-phone">Telefon (für Absprachen am Treffpunkt)</label><input id="p-phone" type="tel" value="${esc(p.phone)}" placeholder="+49 …">
        <label>Sprachen</label>
        <div class="checks">${LANGS.map((l) => `<label class="check"><input type="checkbox" name="lang" value="${l}" ${p.languages.includes(l) ? 'checked' : ''}>${l}</label>`).join('')}</div>
        <div class="row">${sel('smoking')}${sel('pets')}</div>
        <div class="row">${sel('music')}${sel('chat')}</div>
        <h3 style="margin:16px 0 0">Fahrzeug (für Fahrer)</h3>
        <div class="row">
          <div><label for="p-brand">Automarke</label><select id="p-brand"><option value="">–</option>${(state.config.brands || []).map((b) => `<option ${p.vehicle.brand === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></div>
          <div><label for="p-model">Modell</label><input id="p-model" value="${esc(p.vehicle.model)}" placeholder="Golf"></div>
        </div>
        <div class="row">
          <div><label for="p-color">Farbe</label><input id="p-color" value="${esc(p.vehicle.color)}" placeholder="blau"></div>
          <div><label for="p-plate">Ortskürzel ${info('Nur das Ortskürzel deines Kennzeichens (z. B. HH). Das vollständige Kennzeichen speichern wir nicht. Marke und Kürzel erscheinen in deinem Profil und fließen anonym in die Funfacts ein.')}</label><input id="p-plate" value="${esc(p.vehicle.plateRegion || '')}" maxlength="3" placeholder="z. B. HH" style="text-transform:uppercase"></div>
        </div>
        <p class="muted small" id="p-plate-name">${p.vehicle.plateRegion ? `Ort: ${esc((state.config.plateRegions || {})[p.vehicle.plateRegion] || 'Kennzeichen ' + p.vehicle.plateRegion)}` : ''}</p>
        <div class="btn-row">
          <button id="p-save">Profil speichern</button>
          <button type="button" class="secondary" data-preview="stranger">So sehen mich andere</button>
        </div>
      </form>
    </div>

    <div class="card">
      <h2>Privatsphäre ${info('<p><b>Privacy by Default</b></p><p>Andere sehen dein Profil nur, wenn du als Fahrer online bist oder ihr gemeinsam fahrt. Deine E-Mail-Adresse ist nie sichtbar.</p><p>Start und Ziel deiner Fahrten sehen andere nur ungefähr (Ort statt Straße, ohne die ersten/letzten 500 m). Deinen Live-Standort sehen nur bestätigte Mitfahrer, solange du online bist.</p>')}</h2>
      <label class="check"><input type="checkbox" id="pv-fullname" ${pv.showFullName ? 'checked' : ''}><span>Vollständigen Nachnamen zeigen ${info(`Sonst erscheinst du als „${esc(me.name.split(/\s+/)[0])} ${esc((me.name.split(/\s+/).slice(-1)[0] || '')[0] || '')}.“`)}</span></label>
      <label class="check"><input type="checkbox" id="pv-photo" ${pv.showPhoto ? 'checked' : ''}><span>Profilfoto zeigen</span></label>
      <label class="check"><input type="checkbox" id="pv-stats" ${pv.showStats ? 'checked' : ''}><span>Statistik zeigen ${info('Anzahl Fahrten, CO₂-Ersparnis, Mitglied seit, Level und Punkte.')}</span></label>
      <label class="check"><input type="checkbox" id="pv-guestbook" ${pv.showGuestbook ? 'checked' : ''}><span>Gästebuch zeigen ${info('Anonyme, positive Einträge von Mitfahrern nach Fahrten über 1 Stunde oder 100 km.')}</span></label>
      <label class="check"><input type="checkbox" id="pv-leaderboard" ${pv.showOnLeaderboard ? 'checked' : ''}><span>In der Bestenliste erscheinen ${info('Mit Anzeigename, Level und Punkten – sonst nichts. Jederzeit widerrufbar.')}</span></label>
      <label for="pv-phone">Telefonnummer sichtbar für</label>
      <select id="pv-phone">
        <option value="never" ${pv.phoneVisibility === 'never' ? 'selected' : ''}>niemanden</option>
        <option value="booked" ${pv.phoneVisibility === 'booked' ? 'selected' : ''}>bestätigte Fahrtpartner während der Fahrt</option>
      </select>
      <div class="btn-row"><button id="pv-save">Privatsphäre speichern</button><button type="button" class="secondary" data-preview="booked">Vorschau für Fahrtpartner</button></div>
    </div>

    <div class="card" id="rider-filters-card">
      <h2>Meine Wünsche an Fahrer ${info('<p>Diese Kriterien muss ein Fahrer erfüllen, damit er dir bei der Suche angezeigt wird.</p><p>Sie gelten automatisch bei jeder Suche – auf allen deinen Geräten. In der Suche siehst du nur, wie viele Fahrer deswegen ausgeblendet wurden.</p>')}</h2>
      ${filterPanel()}
    </div>

    ${await feedbackCard()}

    ${await myGuestbookCard()}

    <div class="card" id="security">
      <h2>Sicherheit & Anmeldung ${info('<p><b>Zwei-Faktor-Anmeldung (2FA)</b></p><p>Beim Anmelden brauchst du zusätzlich einen 6-stelligen Code aus einer Authenticator-App (z. B. Google oder Microsoft Authenticator, Authy, 1Password). Selbst wer dein Passwort kennt, kommt so nicht in dein Konto.</p><p>Backup-Codes helfen, wenn das Handy weg ist – jeder gilt einmal.</p>')}</h2>
      ${me.mfaEnabled
        ? `<p><span class="badge ok">Zwei-Faktor-Anmeldung aktiv</span></p>
           <p class="muted small">${me.backupCodesLeft} Backup-Codes übrig${me.backupCodesLeft < 3 ? ' – <b>bitte neue erzeugen</b>' : ''}</p>
           <div class="btn-row"><button class="secondary" id="mfa-codes">Neue Backup-Codes</button><button class="secondary" id="mfa-off">2FA deaktivieren</button></div>`
        : `<p><span class="badge warn">Zwei-Faktor-Anmeldung aus</span></p>
           <button id="mfa-on">2FA einrichten</button>
           <div id="mfa-setup"></div>`}
      <h3 style="margin-top:16px">Angemeldete Geräte (${sessions.length})</h3>
      <table class="breakdown">${sessions.map((s) => `<tr><td>${esc(shortAgent(s.userAgent))}${s.current ? ' <span class="badge ok">dieses Gerät</span>' : ''}</td><td class="muted small">${s.createdAt ? new Date(s.createdAt).toLocaleDateString('de-DE') : ''}</td></tr>`).join('')}</table>
      ${sessions.length > 1 ? '<div class="btn-row"><button class="secondary" id="sess-revoke">Alle anderen Geräte abmelden</button></div>' : ''}
    </div>

    <div class="card">
      <h2>Meine Daten ${info(`<p>Einwilligung zur Datenschutzerklärung erteilt am ${me.consentAt ? new Date(me.consentAt).toLocaleString('de-DE') : '–'}.</p><p>Der Download enthält alle deine Daten (Auskunft und Datenübertragbarkeit nach Art. 15 und 20 DSGVO).</p>`)}</h2>
      <div class="btn-row">
        <a class="btn secondary" style="color:var(--text)" href="/api/me/export" download>Alle meine Daten herunterladen (JSON)</a>
      </div>
      <h3 style="margin-top:16px">Konto löschen ${info('<p>Profil, Fotos, Telefonnummer, Führerscheindaten, Gästebucheinträge und Anmeldedaten werden sofort gelöscht.</p><p>Abrechnungsbelege müssen wir 10 Jahre aufbewahren – sie bleiben anonymisiert („Gelöschtes Konto“) erhalten. Restguthaben wird ausgezahlt.</p>')}</h3>
      <button class="danger" id="acc-delete">Konto endgültig löschen</button>
    </div>`;

  panel.querySelectorAll('[data-preview]').forEach((b) => (b.onclick = () => guard(() => showProfile(me.id, b.dataset.preview))));
  bindFilterPanel(panel);
  if (state.scrollToFilters) {
    state.scrollToFilters = false;
    $('#rider-filters-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#p-plate').addEventListener('input', (e) => {
    const code = e.target.value.trim().toUpperCase();
    const name = (state.config.plateRegions || {})[code];
    $('#p-plate-name').textContent = code ? (name ? `Ort: ${name}` : /^[A-ZÄÖÜ]{1,3}$/.test(code) ? `Kennzeichen ${code}` : 'Bitte 1–3 Buchstaben, z. B. B, HH oder MÜ') : '';
  });
  bindGuestbookButtons(panel);

  $('#p-photo').onchange = (e) => guard(async () => {
    const image = await resizeImage(e.target.files[0], 512);
    await api('/api/me/photo', { image });
    toast('Profilfoto gespeichert.');
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
        toast('Profil gespeichert.');
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
    toast('Privatsphäre-Einstellungen gespeichert.');
    await refreshMe();
  }, e.target);

  const on = (id, fn) => { const el = $(id); if (el) el.onclick = (e) => guard(() => fn(e), e.target); };
  on('#mfa-on', startMfaSetup);
  on('#mfa-codes', async () => {
    const creds = await askCredentials('Neue Backup-Codes', 'Die bisherigen Backup-Codes werden ungültig.');
    if (!creds) return;
    const { backupCodes } = await api('/api/mfa/backup-codes', creds);
    showBackupCodes(backupCodes);
  });
  on('#mfa-off', async () => {
    const creds = await askCredentials('2FA deaktivieren', 'Dein Konto ist danach nur noch durch das Passwort geschützt.', 'Deaktivieren', true);
    if (!creds) return;
    await api('/api/mfa/disable', creds);
    toast('Zwei-Faktor-Anmeldung deaktiviert.');
    render();
  });
  on('#sess-revoke', async () => {
    await api('/api/me/sessions/revoke-others', {});
    toast('Alle anderen Geräte wurden abgemeldet.');
    render();
  });
  on('#acc-delete', async () => {
    const creds = await askCredentials('Konto endgültig löschen?', 'Das kann nicht rückgängig gemacht werden. Offene Fahrten müssen vorher abgeschlossen sein.', 'Endgültig löschen', true);
    if (!creds) return;
    const { payoutCents } = await api('/api/me/delete', creds);
    state.me = null;
    stopDriving();
    location.hash = '#/mitfahren';
    render();
    toast('Dein Konto wurde gelöscht.' + (payoutCents ? ` Restguthaben von ${euro(payoutCents)} wird ausgezahlt.` : ''));
  });
}

function shortAgent(ua) {
  if (!ua) return 'Unbekanntes Gerät';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return os ? `${br} auf ${os}` : br;
}

async function startMfaSetup() {
  const { secret, otpauthUri } = await api('/api/mfa/setup', {});
  const qr = qrcode(0, 'M');
  qr.addData(otpauthUri);
  qr.make();
  $('#mfa-on').hidden = true;
  $('#mfa-setup').innerHTML = `
    <ol class="steps">
      <li>Öffne deine Authenticator-App und scanne den QR-Code:</li>
    </ol>
    <div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: 'QR-Code für die Authenticator-App' })}</div>
    <p class="muted small">Kein Scan möglich? Schlüssel manuell eingeben:</p>
    <div class="secret">${esc(secret.match(/.{1,4}/g).join(' '))}</div>
    <p class="muted small"><a href="${esc(otpauthUri)}">Auf diesem Gerät in der Authenticator-App öffnen</a></p>
    <form id="mfa-enable">
      <label for="mfa-first">2. Angezeigten 6-stelligen Code eingeben</label>
      <input id="mfa-first" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
      <button class="full" style="margin-top:10px" id="mfa-confirm">2FA aktivieren</button>
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
  const text = `joinmyride.com – Backup-Codes für ${state.me.email}\nJeder Code funktioniert nur einmal.\n\n${codes.join('\n')}\n`;
  const href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  openModal(`<h2>Deine Backup-Codes</h2>
    <p class="muted">Bewahre diese Codes sicher auf (z. B. ausgedruckt oder im Passwortmanager). Wenn du dein Handy verlierst, kommst du nur damit in dein Konto. Jeder Code gilt einmal. <b>Sie werden nur jetzt angezeigt.</b></p>
    <div class="codes">${codes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
    <div class="btn-row"><a class="btn secondary" style="color:var(--text)" href="${href}" download="joinmyride-backup-codes.txt">Als Datei speichern</a><button id="codes-done">Ich habe die Codes gespeichert</button></div>`);
  $('#codes-done').onclick = () => { closeModal(); URL.revokeObjectURL(href); render(); };
}

// ---------- Rechtliches ----------
function renderPrivacyPolicy(panel) {
  drawMap();
  const cfg = state.config ? state.config.pricing : { donationCentsPerRide: 1, commissionPercent: 10 };
  panel.innerHTML = `
    <div class="card legal">
      <h2>Datenschutzerklärung</h2>
      <p class="muted small">Stand: Oktober 2026 · ${state.me ? '<a href="#/profil">Zu meinen Datenschutz-Einstellungen</a>' : '<a href="#/mitfahren">Zur Anmeldung</a>'}</p>
      <div class="card notice small">Vorlage – vor dem Livegang durch eine Datenschutz-Fachkraft prüfen lassen und die Angaben in eckigen Klammern ergänzen.</div>

      <h3>1. Verantwortlicher</h3>
      <p>[Name / Firma], [Anschrift], E-Mail: datenschutz@joinmyride.com. [Ggf. Datenschutzbeauftragte/r: Kontakt]</p>

      <h3>2. Welche Daten wir verarbeiten und warum</h3>
      <ul>
        <li><b>Konto:</b> Name, E-Mail, Passwort (nur als scrypt-Hash), Zeitpunkt der Einwilligung. Zweck: Nutzerkonto, Vertragsdurchführung (Art. 6 Abs. 1 lit. b DSGVO).</li>
        <li><b>Profil (freiwillig):</b> Foto, Über-mich-Text, Telefonnummer, Sprachen, Vorlieben, Fahrzeug. Zweck: Vertrauen und Absprachen zwischen Fahrtpartnern (Art. 6 Abs. 1 lit. b, lit. a DSGVO). Sichtbarkeit steuerst du in den Privatsphäre-Einstellungen.</li>
        <li><b>Führerschein (nur Fahrer):</b> Name, Geburtsdatum, Führerscheinnummer, Klassen, Ablaufdatum, Fotos von Vorder- und Rückseite. Zweck: Sicherheit der Mitfahrer, Prüfung der Fahrberechtigung (Art. 6 Abs. 1 lit. b und f DSGVO). <b>Die Fotos werden direkt nach der Prüfung gelöscht</b>; gespeichert bleiben nur Nummer (anderen nie sichtbar), Klassen, Ablaufdatum und Prüfergebnis.</li>
        <li><b>Standortdaten:</b> Abholort und Ziel von Mitfahrern; Route und – nur während einer aktiv angebotenen Fahrt und nur nach deinem Start der Standortfreigabe – der GPS-Standort von Fahrern. Zweck: Vermittlung und Abrechnung nach gefahrenen Kilometern (Art. 6 Abs. 1 lit. b DSGVO). Andere Mitglieder sehen Start und Ziel eines Fahrers nur vergröbert; den Live-Standort sehen nur bestätigte Mitfahrer.</li>
        <li><b>Fahrten und Zahlungen:</b> Buchungen, gefahrene km, Preise, Provision (${cfg.commissionPercent} %), Umweltspende (${(cfg.donationCentsPerRide / 100).toFixed(2).replace('.', ',')} € pro Fahrt), Bewertungen. Zweck: Abrechnung und gesetzliche Aufbewahrung (Art. 6 Abs. 1 lit. b und c DSGVO).</li>
        <li><b>Gästebuch (freiwillig):</b> Nach Fahrten über 1 Stunde oder 100 km können Mitfahrer ein positives Erlebnis teilen. Veröffentlicht werden nur Text, Monat und Art der Fahrt – ohne Namen. Intern speichern wir, wer den Eintrag verfasst hat, damit du ihn löschen kannst und Missbrauch verhindert wird (Art. 6 Abs. 1 lit. a DSGVO, Einwilligung; jederzeit widerrufbar durch Löschen). Fahrer können Einträge ausblenden oder das Gästebuch abschalten.</li>
        <li><b>Funfacts:</b> Aus den Bewertungen erstellen wir zusammengefasste Statistiken nach Ortskürzel des Kennzeichens und Automarke (freiwillige Profilangaben; das vollständige Kennzeichen speichern wir nicht). Eine Stadt oder Marke wird erst ab mehreren Fahrern und Bewertungen angezeigt, sodass kein Rückschluss auf Einzelne möglich ist (Art. 6 Abs. 1 lit. f DSGVO).</li>
        <li><b>Bewertungen und Punkte:</b> Bewertungen (0–10, optionale Gründe wie Sauberkeit oder Fahrweise und optionaler Kommentar). Gründe und Kommentare sieht der Bewertete nur gesammelt und anonym ab mindestens drei Rückmeldungen, ohne Datum oder Zuordnung zu einer Fahrt – sie dienen dazu, dass Fahrer und Mitfahrer dazulernen können. Daraus berechnen wir NPS, Punkte, Level und Abzeichen. Zweck: Vertrauen zwischen Fahrtpartnern, Qualität, Motivation zum Teilen von Fahrten (Art. 6 Abs. 1 lit. b und f DSGVO). Einzelbewertungen sieht nur, wer sie abgegeben hat; andere sehen nur Zusammenfassungen. In der <b>Bestenliste</b> erscheinst du nur mit deiner Einwilligung (Art. 6 Abs. 1 lit. a DSGVO), die du jederzeit widerrufen kannst.</li>
        <li><b>Fahrtabbrüche, Verwarnungen und Sperren:</b> Abbruchgründe, Fahrtabbruchsquote sowie Verwarnungen und Sperren nach Ziffer 9 der <a href="#/nutzungsbedingungen">Nutzungsbedingungen</a> (Grund, Dauer, Entscheidung). Zweck: faire Abrechnung und Schutz der Teilnehmer vor Missbrauch (Art. 6 Abs. 1 lit. b und f DSGVO). Die Quote ist für Fahrtpartner sichtbar; Gründe und Sperren nur für dich und den Betreiber.</li>
        <li><b>Sicherheit:</b> Angemeldete Geräte (Browser-Kennung, Zeitpunkt), Daten der Zwei-Faktor-Anmeldung (Schlüssel verschlüsselt, Backup-Codes nur als Hash), Schutz vor Passwort-Ausprobieren. Zweck: Schutz deines Kontos (Art. 6 Abs. 1 lit. f, Art. 32 DSGVO).</li>
      </ul>

      <h3>3. Cookies und Tracking</h3>
      <p>Wir verwenden ausschließlich ein technisch notwendiges Sitzungs-Cookie („sid“, HttpOnly, 30 Tage) für die Anmeldung (§ 25 Abs. 2 Nr. 2 TDDDG). Keine Werbe- oder Analyse-Cookies, kein Tracking, keine Weitergabe zu Werbezwecken.</p>

      <h3>4. Empfänger</h3>
      <ul>
        <li><b>Fahrtpartner:</b> Profilangaben gemäß deinen Privatsphäre-Einstellungen, Abhol- und Zielort der gebuchten Fahrt.</li>
        <li><b>Kartendienste:</b> Adress- und Routensuche über Google Maps Platform (Google Ireland Ltd.; ggf. Übermittlung in die USA auf Grundlage des EU-US Data Privacy Framework) bzw. OpenStreetMap (Nominatim/OSRM). Kartenkacheln werden von OpenStreetMap geladen; dabei wird deine IP-Adresse übertragen.</li>
        <li><b>Zahlungsdienstleister:</b> [Name, z. B. Stripe Payments Europe Ltd.] für Zahlungen und Auszahlungen.</li>
        <li><b>Hosting:</b> [Anbieter, Serverstandort EU] als Auftragsverarbeiter (Art. 28 DSGVO).</li>
      </ul>

      <h3>5. Speicherdauer</h3>
      <ul>
        <li>Konto- und Profildaten: bis zur Löschung deines Kontos.</li>
        <li>Führerscheinfotos: bis zum Abschluss der Prüfung (in der Regel wenige Tage).</li>
        <li>GPS-Standort: nur der jeweils letzte Standort während einer aktiven Fahrt; nach Fahrtende nicht mehr sichtbar.</li>
        <li>Abrechnungsdaten: 10 Jahre (§ 147 AO, § 257 HGB) – nach Kontolöschung anonymisiert.</li>
        <li>Anmeldesitzungen: 30 Tage oder bis zur Abmeldung.</li>
      </ul>

      <h3>6. Deine Rechte</h3>
      <p>Du hast das Recht auf Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21 DSGVO) sowie auf Widerruf erteilter Einwilligungen mit Wirkung für die Zukunft (Art. 7 Abs. 3). ${state.me ? 'Datenexport und Kontolöschung kannst du jederzeit selbst in deinem <a href="#/profil">Profil</a> ausführen.' : 'Datenexport und Kontolöschung kannst du nach der Anmeldung jederzeit selbst im Profil ausführen.'} Du kannst dich außerdem bei einer Datenschutz-Aufsichtsbehörde beschweren (Art. 77 DSGVO), z. B. [zuständige Landesbehörde].</p>

      <h3>7. Sicherheit</h3>
      <p>Verschlüsselte Übertragung (HTTPS), Passwörter nur als Hash, optionale Zwei-Faktor-Anmeldung (TOTP), verschlüsselte Speicherung der 2FA-Schlüssel, Begrenzung von Anmeldeversuchen, Zugriff auf Führerscheindaten nur durch den Betreiber.</p>

      <h3>8. Automatisierte Entscheidungen</h3>
      <p>Die Reihenfolge der vorgeschlagenen Fahrer wird automatisch aus Umweg, Wartezeit, Streckenabdeckung und Bewertung berechnet. Es findet kein Profiling mit rechtlicher Wirkung im Sinne von Art. 22 DSGVO statt; du entscheidest selbst, bei wem du mitfährst.</p>
    </div>`;
}

function renderImprint(panel) {
  drawMap();
  panel.innerHTML = `
    <div class="card legal">
      <h2>Impressum</h2>
      <div class="card notice small">Platzhalter – bitte vor dem Livegang vollständig ausfüllen (§ 5 DDG).</div>
      <p><b>joinmyride.com</b><br>[Name / Firma, Rechtsform]<br>[Straße Nr.]<br>[PLZ Ort]</p>
      <p>E-Mail: kontakt@joinmyride.com<br>Telefon: [Nummer]</p>
      <p>[Vertretungsberechtigt: …]<br>[Registergericht, Registernummer]<br>[USt-IdNr.]</p>
      <p>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV: [Name, Anschrift]</p>
      <p class="muted small">Plattform der EU-Kommission zur Online-Streitbeilegung: https://ec.europa.eu/consumers/odr/ – wir sind nicht verpflichtet und nicht bereit, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen. [anpassen]</p>
    </div>`;
}

// ---------- Gamification: Punkte, Level, Abzeichen, Bestenliste ----------
const CAT_LABEL = { promoter: 'Promotor', passive: 'Neutral', detractor: 'Kritiker' };
const pts = (n) => `${Number(n).toLocaleString('de-DE')} ${n === 1 ? 'Punkt' : 'Punkte'}`;


function ridePointsLine(p) {
  if (!p) return '';
  return `<span class="points-chip">+${pts(p.points)} ${info(`<table><tr><td>Faktor</td><td>×${p.factor}</td></tr><tr><td>CO₂ gespart</td><td>${kg(p.co2Kg)} kg</td></tr></table><p style="margin-top:6px">${p.rated ? `Bewertet mit ${p.score} (${CAT_LABEL[p.category]}).` : 'Noch nicht bewertet – vorläufiger Faktor.'}</p>`, 'Punkte-Details')}</span>`;
}

async function renderPoints(panel) {
  drawMap();
  const g = await api('/api/me/points');
  const lvl = g.level;
  panel.innerHTML = `
    <div class="card level-card">
      <div class="level-head">
        <span class="level-icon" aria-hidden="true">${lvl.rank}</span>
        <div><div class="muted small">Level ${lvl.rank}</div><h2 style="margin:0">${esc(lvl.name)}</h2><div class="points-big">${pts(g.points)}</div></div>
      </div>
      <div class="progress"><div style="width:${Math.round(lvl.progress * 100)}%"></div></div>
      <p class="muted small">${lvl.next ? `Noch ${pts(lvl.next.missing)} bis ${esc(lvl.next.name)}` : 'Höchstes Level erreicht – danke!'} · diesen Monat ${pts(g.monthPoints)}</p>
    </div>

    <div class="card">
      <h2>So sammelst du Punkte ${info(`<p>Dein Faktor ist die Bewertung (0–10), die du vom jeweils anderen bekommst: Fahrer werden vom Mitfahrer bewertet, Mitfahrer vom Fahrer.</p><p>Ohne Bewertung zählt vorläufig ×${g.unratedFactor}.</p><p><b>Beispiel:</b> 20 km geteilt ≈ 3 kg CO₂ → mit 10 bewertet 30 Punkte, mit 7 → 21, mit 5 → 3, mit 2 → 0.</p>`)}</h2>
      <p class="formula">Punkte = <b>Faktor</b> × <b>eingesparte kg CO₂</b></p>
      <table class="breakdown">
        <tr><td>Promotor: 10 · 9</td><td><b>×10 · ×9</b></td></tr>
        <tr><td>Passiv: 8 · 7</td><td><b>×8 · ×7</b></td></tr>
        <tr><td>Kritiker: 6 · 5 · 4</td><td><b>×1</b></td></tr>
        <tr><td>Kritiker: 3 · 2 · 1 · 0</td><td><b>×0</b> <span class="muted small">(keine Punkte)</span></td></tr>
      </table>
    </div>

    <div class="card">
      <h2>Abzeichen (${g.badges.filter((b) => b.earned).length}/${g.badges.length})</h2>
      <div class="badges">${g.badges.map((b) => `<div class="badge-tile ${b.earned ? 'earned' : ''}" tabindex="0" data-tip="${esc(b.desc)}${b.earned ? ' (erreicht)' : ''}"><b>${esc(b.name)}</b></div>`).join('')}</div>
    </div>

    <div class="card">
      <h2>Bestenliste ${info('Nur Mitglieder, die zugestimmt haben – mit Anzeigename und Level. Dich selbst siehst du immer.')}</h2>
      <div class="tabs"><button data-period="month">Dieser Monat</button><button class="secondary" data-period="all">Gesamt</button></div>
      <div id="leaderboard"><p class="muted">Lädt …</p></div>
      <label class="check"><input type="checkbox" id="lb-optin" ${g.leaderboardOptIn ? 'checked' : ''}><span>Mich für andere anzeigen</span></label>
    </div>

    <div class="card">
      <h2>Punkte-Verlauf</h2>
      ${g.history.length ? `<table class="breakdown">${g.history.map((h) => `<tr><td>${h.role === 'driver' ? 'Mitgenommen' : 'Mitgefahren bei'} ${esc(h.partner)}<br><span class="muted small">${new Date(h.at).toLocaleDateString('de-DE')} · ${km(h.km)} · ${h.rated ? `bewertet mit ${h.score} (${CAT_LABEL[h.category]})` : 'noch nicht bewertet'}</span></td><td><b>+${h.points}</b><br><span class="muted small">×${h.factor} · ${kg(h.co2Kg)} kg</span></td></tr>`).join('')}</table>` : '<p class="muted">Noch keine Punkte – teile deine erste Fahrt! </p>'}
    </div>`;

  const loadBoard = async (period) => {
    panel.querySelectorAll('[data-period]').forEach((b) => (b.className = b.dataset.period === period ? '' : 'secondary'));
    const lb = await api('/api/leaderboard?period=' + period);
    $('#leaderboard').innerHTML = lb.entries.length
      ? `<table class="breakdown leaderboard">${lb.entries.map((e) => `<tr class="${e.isMe ? 'me' : ''}"><td>${e.rank}. ${esc(e.name)}${e.isMe ? ' <span class="badge ok">du</span>' : ''}</td><td><b>${pts(e.points)}</b></td></tr>`).join('')}</table>
         ${lb.me.rank && !lb.entries.some((e) => e.isMe) ? `<p class="small">Dein Platz: <b>${lb.me.rank}</b> mit ${pts(lb.me.points)}</p>` : ''}`
      : '<p class="muted">Noch keine Punkte in diesem Zeitraum.</p>';
  };
  panel.querySelectorAll('[data-period]').forEach((b) => (b.onclick = () => guard(() => loadBoard(b.dataset.period))));
  $('#lb-optin').onchange = (e) => guard(async () => {
    await api('/api/me/profile', { privacy: { showOnLeaderboard: e.target.checked } }, 'PUT');
    toast(e.target.checked ? 'Du erscheinst jetzt in der Bestenliste.' : 'Du wirst anderen nicht mehr in der Bestenliste angezeigt.');
    await loadBoard('month');
  });
  await loadBoard('month');
}

// ---------- Gästebuch ----------
function guestbookHtml(gb) {
  if (!gb || !gb.enabled) return '';
  return `<div class="guestbook">
    <h3>Gästebuch ${gb.count ? `<span class="muted small">(${gb.count})</span>` : ''} ${info('Mitfahrer können nach Fahrten über 1 Stunde oder 100 km freiwillig und anonym ein positives Erlebnis teilen.')}</h3>
    ${gb.count
      ? gb.entries.map((e) => `<blockquote class="gb-entry"><p>„${esc(e.text)}“</p><footer>Anonym · ${esc(e.when)} · ${esc(e.kind)}</footer></blockquote>`).join('')
      : '<p class="muted small">Noch keine Einträge.</p>'}
  </div>`;
}

/** Freiwilliges Angebot nach langer Fahrt: anonym ins Gästebuch des Fahrers schreiben. */
function openGuestbookForm(ride, { afterRide } = {}) {
  openModal(`<h2>Gästebuch von ${esc(ride.driverName)}</h2>
    <p>${afterRide ? 'Schön, dass die lange Fahrt gut war! ' : ''}Magst du ein positives Erlebnis teilen? Ganz <b>freiwillig</b> – du kannst das auch überspringen.</p>
    <p class="small">Erscheint <b>anonym</b> im Profil des Fahrers ${info('<p>Ohne deinen Namen und ohne Datum – nur mit Monat und „Fahrt über 1 Stunde / 100 km“.</p><p>Bitte keine Namen, Telefonnummern, E-Mail-Adressen oder Links. Du kannst den Eintrag jederzeit im Konto löschen.</p>')}</p>
    <form id="gb-form">
      <label for="gb-text">Was war schön an der Fahrt?</label>
      <textarea id="gb-text" maxlength="500" placeholder="z. B. Super entspannte Fahrt, tolle Musik und spannende Gespräche über Elektroautos!" required></textarea>
      <div class="muted small" style="text-align:right"><span id="gb-count">0</span>/500</div>
      <label class="check"><input type="checkbox" id="gb-consent"><span>Ich bin einverstanden, dass dieser Text anonym im Profil von ${esc(ride.driverName)} veröffentlicht wird.</span></label>
      <ul class="errors" id="gb-errors"></ul>
      <div class="btn-row"><button id="gb-submit" disabled>Anonym teilen</button><button type="button" class="secondary" id="gb-skip">Überspringen</button></div>
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
      toast('Danke! Dein Eintrag steht jetzt anonym im Gästebuch.');
      if (currentView() === 'konto') render();
    }, $('#gb-submit'));
  };
}

function riderGuestbookLine(r) {
  const g = r.guestbook;
  if (!g) return '';
  if (g.entry) return `<div class="small gb-mine">Dein anonymer Gästebucheintrag${g.entry.hidden ? ' <span class="badge">vom Fahrer ausgeblendet</span>' : ''}: „${esc(g.entry.text)}“ <button class="linkish" data-gb-delete="${g.entry.id}">löschen</button></div>`;
  if (g.eligible) return `<button class="secondary" style="margin-top:6px" data-gb-write="${r.id}">Ins Gästebuch von ${esc(r.driverName)} schreiben (anonym, freiwillig)</button>`;
  return '';
}

async function myGuestbookCard() {
  const gb = await api('/api/me/guestbook');
  return `<div class="card" id="my-guestbook">
    <h2>Mein Gästebuch ${info('<p>Mitfahrer können nach Fahrten über 1 Stunde oder 100 km, die sie mit 7–10 bewertet haben, freiwillig und anonym ein positives Erlebnis teilen.</p><p>Du kannst Einträge ausblenden, aber nicht bearbeiten.</p>')}</h2>
    ${gb.entries.length
      ? gb.entries.map((e) => `<blockquote class="gb-entry ${e.hidden ? 'is-hidden' : ''}"><p>„${esc(e.text)}“</p><footer>Anonym · ${esc(e.when)} · ${esc(e.kind)} · <button class="linkish" data-gb-hide="${e.id}" data-hidden="${e.hidden ? '0' : '1'}">${e.hidden ? 'wieder anzeigen' : 'ausblenden'}</button></footer></blockquote>`).join('')
      : '<p class="muted">Noch keine Einträge.</p>'}
  </div>`;
}

function bindGuestbookButtons(root) {
  root.querySelectorAll('[data-gb-write]').forEach((b) => (b.onclick = () => {
    const ride = state.rides.find((r) => r.id === b.dataset.gbWrite);
    if (ride) openGuestbookForm(ride);
  }));
  root.querySelectorAll('[data-gb-delete]').forEach((b) => (b.onclick = () => guard(async () => {
    if (!confirm('Gästebucheintrag wirklich löschen?')) return;
    await api(`/api/guestbook/${b.dataset.gbDelete}`, {}, 'DELETE');
    toast('Eintrag gelöscht.');
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
  return `<div class="nps-bar"><div class="${nps >= 0 ? 'pos' : 'neg'}" style="${nps >= 0 ? 'left:50%' : `left:${50 - width}%`};width:${width}%"></div></div>`;
}

function funfactList(list, labelOf) {
  if (!list.ranked.length) return '<p class="muted">Noch nicht genug Bewertungen – wir brauchen mehr Fahrten.</p>';
  return `<ol class="funfact-list">${list.ranked.map((g, i) => `
    <li>
      <div class="ff-row"><span class="ff-rank">${i + 1}.</span><span class="ff-name">${labelOf(g)}</span><b class="ff-nps ${g.nps >= 50 ? 'good' : g.nps >= 0 ? 'mid' : 'bad'}">${g.nps > 0 ? '+' : ''}${g.nps}</b></div>
      ${npsBar(g.nps)}
      <div class="muted small">${bewertungen(g.count)} · ${g.drivers} Fahrer · ${g.promoters} Promotoren · ${g.passives} Passive · ${g.detractors} Kritiker</div>
    </li>`).join('')}</ol>`;
}

const FUN_QUIPS = [
  (n) => `Hier wird noch gewunken statt gehupt.`,
  (n) => `Gerüchten zufolge gibt es hier Gummibärchen im Handschuhfach.`,
  (n) => `Blinker werden hier noch benutzt. Freiwillig.`,
  (n) => `Hier darf der Mitfahrer sogar die Musik aussuchen.`,
];

async function renderFunfacts(panel) {
  drawMap();
  const f = await api('/api/funfacts');
  const topRegion = f.regions.ranked[0];
  const topBrand = f.brands.ranked[0];
  const quip = FUN_QUIPS[(topRegion ? topRegion.code.length : 0) % FUN_QUIPS.length]();
  panel.innerHTML = `
    <div class="card hero funfacts-hero">
      <h2>Funfacts</h2>
      <p>Wo fahren die nettesten Fahrer – und in welchen Autos? ${info(TIP.nps())}</p>
      ${topRegion ? `<p class="ff-headline">Die nettesten Fahrer kommen aus <b>${esc(topRegion.name)}</b> (${esc(topRegion.code)}) – NPS ${topRegion.nps > 0 ? '+' : ''}${topRegion.nps}. ${quip}</p>` : ''}
      ${topBrand ? `<p class="ff-headline">Am nettesten unterwegs: <b>${esc(topBrand.name)}</b>-Fahrer – NPS ${topBrand.nps > 0 ? '+' : ''}${topBrand.nps}.</p>` : ''}
    </div>

    <div class="card">
      <h2>Nach Stadt / Kennzeichen</h2>
      ${funfactList(f.regions, (g) => `<span class="plate"><span class="eu">D</span>${esc(g.code)}</span> ${esc(g.name)}`)}
    </div>

    <div class="card">
      <h2>Nach Automarke</h2>
      ${funfactList(f.brands, (g) => esc(g.name))}
    </div>

    <div class="card">
      <h3>So wird gezählt ${info(`<p>Grundlage sind alle ${bewertungen(f.totalRatings)} von Mitfahrern (0–10). Stadt und Marke kommen aus dem Fahrerprofil.</p><p>Damit niemand einzeln erkennbar ist, erscheint eine Stadt oder Marke erst ab <b>${f.minDrivers} Fahrern</b> und <b>${bewertungen(f.minRatings)}</b>${f.regions.hiddenGroups + f.brands.hiddenGroups ? ` – ${f.regions.hiddenGroups + f.brands.hiddenGroups} weitere warten noch darauf` : ''}.</p>`)} ${info(TIP.nps(), 'Was ist der NPS?')}</h3>
      ${state.me ? '<p class="small">Deine Stadt fehlt? Trag im <a href="#/profil">Profil</a> Automarke und Ortskürzel deines Kennzeichens ein. </p>' : ''}
      <p class="muted small">Alles nur zum Spaß.</p>
    </div>`;
}

// ---------- Filter des Mitfahrers: Kriterien, die der Fahrer erfüllen muss ----------
const LANGS_ALL = ['Deutsch', 'Englisch', 'Französisch', 'Spanisch', 'Italienisch', 'Türkisch', 'Polnisch', 'Russisch', 'Arabisch', 'Ukrainisch'];

state.filters = {};

function activeFilterCount(f) {
  return ['minNps', 'nonSmoker', 'pets', 'chat', 'music', 'language', 'mfa', 'safeDriving', 'maxEtaMin'].filter((k) => f[k] !== undefined && f[k] !== '' && f[k] !== false).length + (f.includeNew === false ? 1 : 0);
}

function filterPanel() {
  const f = state.filters;
  const opt = (v, label, cur) => `<option value="${v}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${label}</option>`;
  const n = activeFilterCount(f);
  return `<div class="filters" id="filters">
    <p class="muted small" id="flt-count">${n ? `<span class="badge ok">${n} aktiv</span>` : 'Keine Wünsche gesetzt – alle passenden Fahrer werden angezeigt.'}</p>
    <div class="row">
      <div><label for="flt-nps">Mindest-NPS ${info(TIP.nps())}</label><select id="flt-nps">${opt('', 'egal', f.minNps)}${opt(0, '≥ 0', f.minNps)}${opt(30, '≥ +30', f.minNps)}${opt(50, '≥ +50', f.minNps)}${opt(70, '≥ +70', f.minNps)}</select></div>
      <div><label for="flt-eta">Max. Wartezeit</label><select id="flt-eta">${opt('', 'egal', f.maxEtaMin)}${opt(5, '5 min', f.maxEtaMin)}${opt(10, '10 min', f.maxEtaMin)}${opt(15, '15 min', f.maxEtaMin)}${opt(30, '30 min', f.maxEtaMin)}</select></div>
    </div>
    <label class="check"><input type="checkbox" id="flt-new" ${f.includeNew === false ? '' : 'checked'}><span>Neue Fahrer einbeziehen ${info('Fahrer ohne Bewertung bleiben in der Liste, auch wenn ein Mindest-NPS gesetzt ist.')}</span></label>
    <div class="checks">
      <label class="check"><input type="checkbox" id="flt-smoke" ${f.nonSmoker ? 'checked' : ''}><span>Nichtraucher</span></label>
      <label class="check"><input type="checkbox" id="flt-pets" ${f.pets ? 'checked' : ''}><span>Tiere erlaubt</span></label>
      <label class="check"><input type="checkbox" id="flt-mfa" ${f.mfa ? 'checked' : ''}><span>2FA-gesichert</span></label>
      <label class="check"><input type="checkbox" id="flt-safe" ${f.safeDriving ? 'checked' : ''}><span>Sichere Fahrweise ${info('Höchstens 10 % der Bewertungen des Fahrers nennen „Fahrweise“ als Grund (ab 3 Bewertungen).')}</span></label>
    </div>
    <div class="row">
      <div><label for="flt-chat">Unterhaltung</label><select id="flt-chat">${opt('', 'egal', f.chat)}${opt('quiet', 'lieber ruhig', f.chat)}${opt('talkative', 'gerne gesprächig', f.chat)}</select></div>
      <div><label for="flt-music">Musik</label><select id="flt-music">${opt('', 'egal', f.music)}${opt('quiet', 'lieber leise', f.music)}</select></div>
    </div>
    <label for="flt-lang">Fahrer spricht</label><select id="flt-lang">${opt('', 'egal', f.language)}${LANGS_ALL.map((l) => opt(l, l, f.language)).join('')}</select>
    <div class="btn-row"><button type="button" id="flt-save">Wünsche speichern</button><button type="button" class="secondary" id="flt-reset">Zurücksetzen</button></div>
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
    $('#flt-count').innerHTML = n ? `<span class="badge ok">${n} aktiv</span> <span class="muted small">– noch nicht gespeichert</span>` : 'Keine Wünsche gesetzt.';
  };
  const save = async (f, btn) => {
    const { user } = await api('/api/me/profile', { riderFilters: f }, 'PUT');
    state.me = user;
    state.filters = user.riderFilters;
    state.matches = [];
    $('#filters').outerHTML = filterPanel();
    bindFilterPanel(root);
    toast('Deine Wünsche an Fahrer sind gespeichert und gelten ab jetzt bei jeder Suche.');
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
  return `<p class="muted small">${n} ${n === 1 ? 'Fahrer wird' : 'Fahrer werden'} dir wegen deiner Filter nicht angezeigt. <a href="#/profil" data-goto-filters>Filter ändern</a></p>`;
}

function prefIcons(m) {
  const p = m.driverPrefs || {};
  const chips = [];
  if (p.smoking === 'nein') chips.push('Nichtraucher');
  if (p.pets && p.pets !== 'nein') chips.push(`Tiere ${p.pets === 'ja' ? 'ok' : 'nach Absprache'}`);
  if (p.chat === 'lieber ruhig') chips.push('ruhige Fahrt');
  if (p.chat === 'gerne') chips.push('gesprächig');
  if (p.music === 'gerne') chips.push('Musik');
  if (m.driverMfa) chips.push('2FA');
  if (p.languages && p.languages.length > 1) chips.push(esc(p.languages.join(', ')));
  return chips.length ? `<span class="pref-chips">${chips.map((c) => `<span class="pref">${c}</span>`).join('')}</span>` : '';
}

// ---------- Feedback zum Lernen (gesammelt & anonym) ----------
function feedbackSection(title, f) {
  if (!f.entries && !f.ratingsTotal) return '';
  if (!f.ready) {
    return `<h3>${title}</h3><p class="muted small">${f.entries ? `${f.entries} von ${f.minEntries} Rückmeldungen gesammelt` : 'Noch keine Hinweise – weiter so!'} ${info(`Hinweise werden erst ab ${f.minEntries} Rückmeldungen gesammelt angezeigt, damit niemand einzeln erkennbar ist.`)}</p>`;
  }
  const max = Math.max(...f.aspects.map((a) => a.count), 1);
  return `<h3>${title}</h3>
    <p class="muted small">${f.entries} Rückmeldungen ${info(`${f.entries} Rückmeldungen mit Hinweisen aus ${bewertungen(f.ratingsTotal)} insgesamt.`)}</p>
    ${f.aspects.length ? f.aspects.map((a) => `
      <div class="fb-aspect">
        <div class="fb-row"><span>${esc(a.label)} ${info(`<p><b>Tipp</b></p><p>${esc(a.tip)}</p>`, 'Tipp')}</span><b>${a.count}×</b></div>
        <div class="fb-bar"><div style="width:${Math.round((a.count / max) * 100)}%"></div></div>
      </div>`).join('') : ''}
    ${f.comments.length ? `<details><summary class="small">Anonyme Kommentare (${f.comments.length})</summary>${f.comments.map((c) => `<blockquote class="gb-entry"><p>„${esc(c)}“</p></blockquote>`).join('')}</details>` : ''}`;
}

async function feedbackCard() {
  const fb = await api('/api/me/feedback');
  const driver = feedbackSection('Als Fahrer', fb.asDriver);
  const rider = feedbackSection('Als Mitfahrer', fb.asRider);
  return `<div class="card" id="my-feedback">
    <h2>Feedback zum Lernen ${info('<p>Bei Bewertungen bis 8 können deine Fahrtpartner freiwillig Gründe nennen.</p><p>Du siehst sie hier gesammelt und anonym – ohne Namen, Datum oder Fahrt. Fahre mit der Maus über ⓘ für Tipps.</p>')}</h2>
    ${driver || rider ? driver + rider : '<p class="muted">Noch keine Bewertungen.</p>'}
  </div>`;
}

// ---------- Nutzungsbedingungen ----------
function renderTerms(panel) {
  drawMap();
  const c = state.config || {};
  const pr = c.pricing || { ratePerKmCents: 25, commissionPercent: 10, donationCentsPerRide: 1 };
  const ap = c.abortPolicy || { maxQuote: 20, minRides: 5 };
  const reasons = (c.abortReasons || []).map((r) => esc(r.label)).join(', ');
  panel.innerHTML = `
    <div class="card legal">
      <h2>Nutzungsbedingungen</h2>
      <p class="muted small">Stand: Oktober 2026 · Version ${esc(c.termsVersion || '2026-10')}</p>
      <div class="card notice small">Vorlage – vor dem Livegang rechtlich prüfen lassen und die Angaben in eckigen Klammern ergänzen.</div>

      <h3>1. Geltungsbereich und Anbieter</h3>
      <p>Diese Bedingungen gelten für die Nutzung von joinmyride.com, betrieben von [Name / Firma, Anschrift] („Betreiber“). Mit der Registrierung erkennst du sie an.</p>

      <h3>2. Leistungen</h3>
      <p>Der Betreiber vermittelt Mitfahrgelegenheiten zwischen Fahrern, die eine Strecke ohnehin fahren, und Mitfahrern. Der Betreiber befördert selbst nicht; der Beförderungsvertrag kommt zwischen Fahrer und Mitfahrer zustande. Es handelt sich um Kostenteilung, nicht um gewerbliche Personenbeförderung: Das Entgelt darf die Betriebskosten der Fahrt nicht übersteigen.</p>

      <h3>3. Registrierung und Konto</h3>
      <ul>
        <li>Teilnehmen dürfen volljährige Personen mit wahrheitsgemäßen Angaben. Jede Person darf nur ein Konto führen.</li>
        <li>Zugangsdaten sind geheim zu halten. Wir empfehlen die Zwei-Faktor-Anmeldung, für Fahrer und den Betreiber dringend.</li>
      </ul>

      <h3>4. Pflichten der Fahrer</h3>
      <ul>
        <li>Gültige Fahrerlaubnis (mindestens Klasse B), die vor dem ersten Angebot geprüft wird; Änderungen (z. B. Entzug, Ablauf) sind unverzüglich mitzuteilen.</li>
        <li>Verkehrssicheres, zugelassenes und haftpflichtversichertes Fahrzeug; Einhaltung der Verkehrsregeln.</li>
        <li>Fahren nur auf der eigenen Route; keine gewerbliche Personenbeförderung über die Plattform.</li>
      </ul>

      <h3>5. Pflichten der Mitfahrer</h3>
      <ul>
        <li>Pünktliches Erscheinen am vereinbarten Treffpunkt, respektvolles Verhalten, Rücksicht auf Fahrzeug und Fahrer.</li>
        <li>Ausreichendes Guthaben für den bestätigten Höchstbetrag.</li>
      </ul>

      <h3>6. Preise und Zahlung</h3>
      <ul>
        <li>Grundlage ist die vor der Fahrt von beiden bestätigte schnellste Route. Kilometersatz derzeit ${euro(pr.ratePerKmCents)}/km.</li>
        <li>Mit dem Fahrtantritt (Einsteigen) ist der Preis der geplanten Route fällig – auch wenn die Fahrt früher endet. Umwege gehen nicht zulasten des Mitfahrers.</li>
        <li>Die Anfahrt zum Treffpunkt wird zum gleichen Satz berechnet und vollständig an den Fahrer ausgezahlt; auf sie erhebt der Betreiber keine Provision.</li>
        <li>Der Betreiber erhält eine Vermittlungsprovision von ${pr.commissionPercent} % auf die gemeinsame Strecke. Je Fahrt werden ${euro(pr.donationCentsPerRide)} an [Organisation] für den Umweltschutz gespendet.</li>
        <li>Bezahlt wird, sobald der Fahrer den Mitfahrer abgesetzt und der Mitfahrer die Fahrt bewertet hat; ohne Rückmeldung nach 24 Stunden.</li>
      </ul>

      <h3>7. Bewertungen und Gästebuch</h3>
      <p>Bewertungen müssen wahrheitsgemäß und sachlich sein. Beleidigende, falsche oder manipulierte Bewertungen und Gästebucheinträge können entfernt werden.</p>

      <h3>8. Fahrtabbruch und Fahrtabbruchsquote</h3>
      <ul>
        <li>Eine begonnene Fahrt kann von Fahrer oder Mitfahrer abgebrochen werden. Der Abbruch ist zu begründen (${reasons || 'Grund und Freitext'}). Abgerechnet wird dann nur die bis dahin gefahrene Strecke.</li>
        <li>Die <b>Fahrtabbruchsquote</b> ist der Anteil abgebrochener an allen abgeschlossenen Fahrten, getrennt nach der Rolle als Fahrer und als Mitfahrer. Ein Abbruch zählt für beide Beteiligten. Die Quote ist im Profil für Fahrtpartner sichtbar.</li>
        <li>Abbrüche dürfen nicht dazu genutzt werden, Entgelt oder Provision zu umgehen, etwa durch Absprachen über ein vorzeitiges Fahrtende.</li>
      </ul>

      <h3>9. Sperrung von Teilnehmern</h3>
      <p><b>9.1 Zu hohe Fahrtabbruchsquote.</b> Liegt die Fahrtabbruchsquote eines Teilnehmers in einer Rolle über <b>${ap.maxQuote} %</b> und hat er in dieser Rolle mindestens <b>${ap.minRides} Fahrten</b> abgeschlossen, kann der Betreiber den Teilnehmer sperren. Dabei gilt:</p>
      <ul>
        <li>Der Betreiber prüft jeden Fall einzeln, insbesondere die angegebenen Gründe; Abbrüche aus nachvollziehbaren Sicherheits- oder Gesundheitsgründen werden berücksichtigt. Eine Sperre erfolgt nicht automatisch.</li>
        <li>In der Regel erhält der Teilnehmer zunächst eine <b>Verwarnung</b> mit Gelegenheit zur Stellungnahme an [kontakt@joinmyride.com].</li>
        <li>Bleibt die Quote hoch oder gibt es Hinweise auf Missbrauch (z. B. abgesprochene Abbrüche), kann der Betreiber das Konto <b>befristet</b> (in der Regel 7 bis 30 Tage) sperren, im Wiederholungsfall oder bei schwerem Missbrauch <b>unbefristet</b>.</li>
      </ul>
      <p><b>9.2 Weitere Gründe.</b> Eine Sperrung ist außerdem möglich bei falschen Angaben, Fahren ohne gültige Fahrerlaubnis, Gefährdung oder Belästigung anderer, Manipulation von Bewertungen oder Zahlungen sowie sonstigen erheblichen Verstößen gegen diese Bedingungen.</p>
      <p><b>9.3 Folgen.</b> Während einer Sperre kann der Teilnehmer keine Fahrten anbieten, suchen oder buchen; seine aktiven Angebote werden beendet und offene Anfragen storniert. Bereits begonnene Fahrten können abgeschlossen werden. Guthaben, Abrechnungen, Datenexport und Kontolöschung bleiben zugänglich. Befristete Sperren enden automatisch. Der Teilnehmer wird über Grund und Dauer informiert und kann widersprechen; der Betreiber entscheidet erneut.</p>

      <h3>10. Haftung</h3>
      <p>Der Betreiber haftet unbeschränkt bei Vorsatz, grober Fahrlässigkeit sowie für Schäden aus der Verletzung von Leben, Körper oder Gesundheit; im Übrigen nur bei Verletzung wesentlicher Pflichten und begrenzt auf den vorhersehbaren Schaden. Für die Durchführung der Fahrt sind Fahrer und Mitfahrer verantwortlich. [anpassen]</p>

      <h3>11. Datenschutz</h3>
      <p>Es gilt die <a href="#/datenschutz">Datenschutzerklärung</a>.</p>

      <h3>12. Kündigung und Änderungen</h3>
      <p>Du kannst dein Konto jederzeit im Profil löschen. Der Betreiber kann den Vertrag mit einer Frist von [zwei Wochen] kündigen, aus wichtigem Grund fristlos. Änderungen dieser Bedingungen werden rechtzeitig vorher angekündigt; widersprichst du nicht innerhalb von [sechs Wochen], gelten sie als angenommen – darauf weisen wir mit der Ankündigung hin.</p>

      <h3>13. Schlussbestimmungen</h3>
      <p>Es gilt deutsches Recht unter Ausschluss des UN-Kaufrechts; zwingende Verbraucherschutzvorschriften des Wohnsitzstaats bleiben unberührt. [Online-Streitbeilegung / Verbraucherschlichtung anpassen]</p>
    </div>`;
}

/** Hinweis für gesperrte oder verwarnte Teilnehmer (oberhalb jeder Ansicht). */
function accountNotice() {
  const me = state.me;
  if (!me) return '';
  if (me.suspension) {
    return `<div class="card notice bad-notice"><b>Dein Konto ist ${me.suspension.until ? 'bis ' + new Date(me.suspension.until).toLocaleDateString('de-DE') : 'bis auf Weiteres'} gesperrt.</b><p class="small" style="margin:4px 0 0">Grund: ${esc(me.suspension.reason)}. Du kannst keine Fahrten anbieten oder buchen; laufende Fahrten kannst du abschließen. Widerspruch an [kontakt@joinmyride.com] – siehe <a href="#/nutzungsbedingungen">Nutzungsbedingungen, Ziffer 9</a>.</p></div>`;
  }
  const w = (me.warnings || []).slice(-1)[0];
  if (w && Date.now() - new Date(w.at).getTime() < 90 * 864e5) {
    return `<div class="card notice"><b>Verwarnung vom ${new Date(w.at).toLocaleDateString('de-DE')}</b><p class="small" style="margin:4px 0 0">${esc(w.note)}. Bei weiterhin hoher Fahrtabbruchsquote kann dein Konto gesperrt werden (<a href="#/nutzungsbedingungen">Nutzungsbedingungen, Ziffer 9</a>).</p></div>`;
  }
  return '';
}

/** Betreiber: Prüfliste nach Ziffer 9 der Nutzungsbedingungen. */
async function abortReviewCard() {
  const r = await api('/api/admin/abort-review');
  const roleName = { driver: 'Fahrer', rider: 'Mitfahrer' };
  const row = (m, suspended) => `
    <div class="match">
      <div class="top"><span><b>${esc(m.name)}</b> <span class="muted small">${esc(m.email || '')}</span></span>${m.warnings.length ? `<span class="badge warn">${m.warnings.length} × verwarnt</span>` : ''}</div>
      <div class="small">${m.flags.length ? m.flags.map((f) => `${roleName[f.role]}: <b>${f.quote} %</b> (${f.aborted} von ${f.rides})`).join(' · ') : `Fahrer ${m.abortStats.asDriver.quote ?? '–'} % · Mitfahrer ${m.abortStats.asRider.quote ?? '–'} %`}</div>
      ${suspended ? `<div class="small">Gesperrt ${m.suspension.until ? 'bis ' + new Date(m.suspension.until).toLocaleDateString('de-DE') : 'unbefristet'}: ${esc(m.suspension.reason)}</div>` : ''}
      <div class="btn-row">
        ${suspended
          ? `<button class="secondary" data-unsuspend="${m.id}">Entsperren</button>`
          : `<button class="secondary" data-warn="${m.id}">Verwarnen</button><button class="danger" data-suspend="${m.id}" data-name="${esc(m.name)}">Sperren …</button>`}
      </div>
    </div>`;
  return `<div class="card" id="abort-review">
    <h2>Fahrtabbruchsquote – Prüfung ${info(`<p>Teilnehmer mit einer Quote über <b>${r.policy.maxQuote} %</b> bei mindestens <b>${r.policy.minRides} Fahrten</b> in einer Rolle (Nutzungsbedingungen, Ziffer 9).</p><p>Bitte jeden Fall einzeln prüfen – Abbrüche aus Sicherheits- oder Gesundheitsgründen sind nachvollziehbar. In der Regel erst verwarnen.</p>`)}</h2>
    ${r.flagged.length ? r.flagged.map((m) => row(m, false)).join('') : '<p class="muted">Niemand über dem Grenzwert.</p>'}
    ${r.suspended.length ? `<h3 style="margin-top:14px">Gesperrt (${r.suspended.length})</h3>${r.suspended.map((m) => row(m, true)).join('')}` : ''}
  </div>`;
}

function bindAbortReview(root) {
  root.querySelectorAll('[data-warn]').forEach((b) => (b.onclick = () => guard(async () => {
    await api(`/api/admin/users/${b.dataset.warn}/warn`, { note: 'Hohe Fahrtabbruchsquote – bitte Abbrüche vermeiden' });
    toast('Verwarnung gesendet.');
    render();
  }, b)));
  root.querySelectorAll('[data-unsuspend]').forEach((b) => (b.onclick = () => guard(async () => {
    await api(`/api/admin/users/${b.dataset.unsuspend}/unsuspend`, {});
    toast('Sperre aufgehoben.');
    render();
  }, b)));
  root.querySelectorAll('[data-suspend]').forEach((b) => (b.onclick = () => {
    openModal(`<h2>${esc(b.dataset.name)} sperren</h2>
      <p class="small">Nach Ziffer 9 der Nutzungsbedingungen. Aktive Angebote werden beendet, offene Anfragen storniert; laufende Fahrten können abgeschlossen werden.</p>
      <form id="suspend-form">
        <label for="sp-days">Dauer</label>
        <select id="sp-days"><option value="7">7 Tage</option><option value="30">30 Tage</option><option value="unbefristet">unbefristet</option></select>
        <label for="sp-reason">Grund (wird dem Teilnehmer angezeigt)</label>
        <textarea id="sp-reason" required minlength="5">Fahrtabbruchsquote über dem Grenzwert trotz Verwarnung</textarea>
        <div class="btn-row"><button class="danger" id="sp-submit">Sperren</button><button type="button" class="secondary" id="sp-cancel">Abbrechen</button></div>
      </form>`);
    $('#sp-cancel').onclick = closeModal;
    $('#suspend-form').onsubmit = (e) => {
      e.preventDefault();
      guard(async () => {
        const days = $('#sp-days').value;
        await api(`/api/admin/users/${b.dataset.suspend}/suspend`, { days: days === 'unbefristet' ? null : Number(days), reason: $('#sp-reason').value });
        closeModal();
        toast('Teilnehmer gesperrt.');
        render();
      }, $('#sp-submit'));
    };
  }));
}

// ---------- Start ----------
(async function init() {
  try { state.config = await api('/api/config'); } catch {}
  try { state.me = (await api('/api/me')).user; } catch {}
  render();
})();
