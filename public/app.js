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

async function guard(fn, btn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
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
    L.polyline(latlngs, { color: r.color || '#1f8a5b', weight: r.weight || 5, opacity: r.opacity || 0.85, dashArray: r.dash }).addTo(layers);
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
  if (!driverMarker) driverMarker = L.marker([pos.lat, pos.lng], { icon: pin('#2563eb', '🚗'), zIndexOffset: 1000 }).addTo(layers);
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
      ${withLocate ? `<button type="button" class="secondary shrink" data-locate="${key}" title="Aktuellen Standort verwenden">📍</button>` : ''}
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
    if (P.pickup) points.push({ ...P.pickup, color: '#1f8a5b', text: 'A' });
    if (P.dropoff) points.push({ ...P.dropoff, color: '#b91c1c', text: 'B' });
  } else if (v === 'fahren') {
    if (P.origin) points.push({ ...P.origin, color: '#1f8a5b', text: 'S' });
    if (P.destination) points.push({ ...P.destination, color: '#b91c1c', text: 'Z' });
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
    ? `<a class="points-pill" href="#/punkte" title="Level ${esc(state.me.level.name)}">${state.me.level.icon} ${Number(state.me.points).toLocaleString('de-DE')} P</a><span>${esc(state.me.name)} · <b>${euro(state.me.walletCents - state.me.reservedCents)}</b></span><button class="secondary" id="logout">Abmelden</button>`
    : '';
  const lo = $('#logout');
  if (lo) lo.onclick = () => guard(async () => { await api('/api/logout', {}); state.me = null; stopDriving(); render(); });
}

function render() {
  renderHeader();
  clearInterval(state.pollTimer);
  closeModal();
  const panel = $('#panel');
  const view = currentView();
  if (view === 'datenschutz') return renderPrivacyPolicy(panel);
  if (view === 'impressum') return renderImprint(panel);
  if (!state.me) return renderAuth(panel);
  if (view === 'fahren') guard(() => renderDriver(panel));
  else if (view === 'konto') guard(() => renderAccount(panel));
  else if (view === 'profil') guard(() => renderProfile(panel));
  else if (view === 'punkte') guard(() => renderPoints(panel));
  else if (view === 'admin' && state.me.isAdmin) guard(() => renderAdmin(panel));
  else guard(() => renderRider(panel));
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
      <h2>Teilen statt Leerfahren 🌍</h2>
      <p>Jeder, der ohnehin fährt, nimmt spontan Mitfahrer auf seiner Google-Maps-Route mit. Kosten werden pro Kilometer geteilt – und jede Fahrt spendet 1 Cent für den Umweltschutz.</p>
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
          <span>Ich habe die <a href="#/datenschutz" target="_blank">Datenschutzerklärung</a> gelesen und stimme der Verarbeitung meiner Daten zur Vermittlung und Abrechnung von Fahrten zu.</span>
        </label>
        <button class="full" style="margin-top:14px" id="a-submit">Anmelden</button>
      </form>
      <form id="mfa-form" hidden>
        <h3>🔐 Zwei-Faktor-Bestätigung</h3>
        <p class="muted small">Gib den 6-stelligen Code aus deiner Authenticator-App ein – oder einen deiner Backup-Codes.</p>
        <input id="mfa-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="9" placeholder="123456" required>
        <button class="full" style="margin-top:14px" id="mfa-submit">Bestätigen</button>
        <button type="button" class="secondary full" style="margin-top:8px" id="mfa-back">Zurück</button>
      </form>
    </div>
    <div class="card">
      <h3>So funktioniert's</h3>
      <ol class="steps">
        <li><b>Fahrer</b> verifizieren einmalig ihren Führerschein und gehen mit ihrer Route (oder einem Google-Maps-Link) online.</li>
        <li><b>Mitfahrer</b> geben ihr Ziel ein – die App findet den Fahrer mit dem kleinsten Umweg und der kürzesten Wartezeit.</li>
        <li>Abgerechnet werden die <b>gefahrenen Kilometer</b>${cfg ? ` (${euro(cfg.ratePerKmCents)}/km)` : ''}. Der Großteil geht an den Fahrer, ${cfg ? cfg.commissionPercent : '–'} % Vermittlungsprovision, ${cfg ? euro(cfg.donationCentsPerRide) : '1 Cent'} Umweltspende.</li>
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
      if (mode === 'register' && !body.acceptPrivacy) throw new Error('Bitte der Datenschutzerklärung zustimmen.');
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
const PLANNED_STYLE = { color: '#7c3aed', weight: 5, dash: '10 8', opacity: 0.9 };
const BILLING_RULE = 'Abgerechnet wird die geplante Route – oder die tatsächlich gefahrene Strecke, falls sie kürzer ist. Umwege zahlst du nie.';
const BASIS = { geplant: 'geplante Route', gefahren: 'gefahrene Strecke (kürzer)', betreiber: 'Entscheidung Betreiber' };

function plannedRouteHtml(route, note) {
  const estimated = route.provider === 'luftlinie' ? '<div class="small" style="color:var(--warn)">⚠ Routendienst nicht erreichbar – Strecke geschätzt (Luftlinie × 1,3).</div>' : '';
  return `<div class="planned"><b>🗺️ Geplante Route (schnellste):</b> ${km(route.distanceKm)} · ca. ${Math.round(route.durationMin)} min${estimated}${note ? `<div class="muted small">${note}</div>` : ''}</div>`;
}

// ---------- Bewertung nach NPS-Logik (0–10) ----------
const bewertungen = (n) => `${n} ${n === 1 ? 'Bewertung' : 'Bewertungen'}`;
const NPS_CAT = (n) => (n >= 9 ? 'promoter' : n >= 7 ? 'passive' : 'detractor');
const NPS_COMMENT = {
  promoter: 'Was hat dir besonders gefallen? (optional)',
  passive: 'Was hätte die Fahrt noch besser gemacht? (optional)',
  detractor: 'Was ist schiefgelaufen? (optional – für echte Probleme bitte „Problem melden“)',
};

function npsWidget(question) {
  return `<div class="nps">
    <p class="nps-q">${esc(question)}</p>
    <div class="nps-scale" role="radiogroup">${Array.from({ length: 11 }, (_, i) => `<button type="button" class="nps-btn ${NPS_CAT(i)}" data-score="${i}" role="radio" aria-checked="false">${i}</button>`).join('')}</div>
    <div class="nps-legend"><span>unwahrscheinlich</span><span>sehr wahrscheinlich</span></div>
    <label class="nps-comment-label" hidden></label>
    <textarea class="nps-comment" maxlength="500" hidden></textarea>
  </div>`;
}

function npsBadge(summary, label = 'NPS') {
  if (!summary || !summary.count) return '<span class="badge">Neu – noch keine Bewertung</span>';
  const cls = summary.score >= 50 ? 'ok' : summary.score >= 0 ? 'warn' : 'bad';
  return `<span class="badge ${cls}" title="${summary.promoters} Promotoren · ${summary.passives} Passive · ${summary.detractors} Kritiker">${label} ${summary.score > 0 ? '+' : ''}${summary.score} · ${bewertungen(summary.count)}</span>`;
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
        const label = form.querySelector('.nps-comment-label');
        label.textContent = NPS_COMMENT[NPS_CAT(Number(b.dataset.score))];
        label.hidden = false;
        form.querySelector('.nps-comment').hidden = false;
        if (submit) submit.disabled = false;
      }),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = form.dataset.score !== undefined ? { nps: Number(form.dataset.score), comment: form.querySelector('.nps-comment').value } : {};
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
  const mine = isRider ? (r.myEndConfirmed ? '✔ Du hast die Fahrt bewertet.' : '○ Deine Bewertung fehlt.') : (r.myEndConfirmed ? '✔ Du hast das Absetzen bestätigt.' : '○ Absetzen noch nicht bestätigt.');
  const theirs = isRider ? (r.partnerEndConfirmed ? '✔ Der Fahrer hat dich abgesetzt.' : '○ Der Fahrer hat das Absetzen noch nicht bestätigt.') : (r.partnerEndConfirmed ? '✔ Der Mitfahrer hat die Fahrt bewertet.' : '○ Der Mitfahrer hat noch nicht bewertet.');
  const open = !r.myEndConfirmed && r.status !== 'disputed';
  return `<div class="card confirm-card">
    <h3>${isRider ? '🏁 Angekommen? Bewerten & bezahlen' : '🏁 Mitfahrer absetzen'}</h3>
    <table class="breakdown">
      <tr><td>Geplante Route (schnellste)</td><td>${km(p.plannedKm)}${r.plannedRoute ? ` · ${Math.round(r.plannedRoute.durationMin)} min` : ''}</td></tr>
      <tr><td>Gefahren (GPS)${measuring ? ' <span class="muted small">– läuft</span>' : ''}</td><td>${p.trackedKm > 0.2 ? km(p.trackedKm) : '–'}</td></tr>
      <tr class="total"><td>Abgerechnet: ${BASIS[p.basis]}</td><td>${km(p.billedKm)}</td></tr>
      <tr><td>${isRider ? 'Du zahlst' : 'Dein Anteil'}</td><td><b>${euro(isRider ? p.price.totalCents : p.price.driverCents)}</b></td></tr>
    </table>
    <p class="muted small">${isRider ? BILLING_RULE : BILLING_RULE.replace('zahlst du', 'zahlt der Mitfahrer')}<br>
      <b>Gezahlt wird, sobald der Fahrer ${isRider ? 'dich' : 'den Mitfahrer'} abgesetzt und ${isRider ? 'du die Fahrt' : 'der Mitfahrer die Fahrt'} bewertet ${isRider ? 'hast' : 'hat'}.</b> Die Bewertung ändert den Preis nicht.</p>
    ${pointsHint(isRider ? r.driverName : r.riderName)}
    <p class="small">${mine}<br>${theirs}
      ${r.autoConfirmAt && !(r.myEndConfirmed && r.partnerEndConfirmed) ? `<br><span class="muted">Ohne Rückmeldung gilt die Fahrt am ${new Date(r.autoConfirmAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} als bestätigt.</span>` : ''}</p>
    ${r.status === 'disputed' ? `<p class="small"><span class="badge bad">Reklamation</span> ${esc(r.dispute.reason)}</p>` : ''}
    ${open && isRider ? `<form class="nps-form" data-confirm-form="${r.id}">
        ${npsWidget(`Wie wahrscheinlich ist es, dass du ${r.driverName} weiterempfiehlst?`)}
        <div class="btn-row"><button data-submit disabled>Bewerten & bezahlen</button><button type="button" class="secondary" data-dispute="${r.id}">Problem melden</button></div>
      </form>` : ''}
    ${open && !isRider ? `<form class="nps-form" data-confirm-form="${r.id}">
        <details><summary class="small">Optional: ${esc(r.riderName)} bewerten</summary>${npsWidget(`Wie wahrscheinlich ist es, dass du ${r.riderName} anderen Fahrern weiterempfiehlst?`)}</details>
        <div class="btn-row"><button data-submit>${measuring ? 'Mitfahrer abgesetzt' : 'Absetzen bestätigen'}</button><button type="button" class="secondary" data-dispute="${r.id}">Problem melden</button></div>
      </form>` : ''}
  </div>`;
}

function bindConfirmButtons(root) {
  bindNpsForms(root, '[data-confirm-form]', async (form, body) => {
    const { ride } = await api(`/api/rides/${form.dataset.confirmForm}/confirm`, body);
    if (ride.status === 'completed') toast(`Bezahlt: ${km(ride.final.km)} · ${euro(ride.role === 'driver' ? ride.final.driverCents : ride.final.totalCents)} · +${pts(ride.myPoints.points)} 🌱`);
    else toast(ride.role === 'rider' ? 'Danke für deine Bewertung! Gezahlt wird, sobald der Fahrer das Absetzen bestätigt.' : 'Abgesetzt – gezahlt wird, sobald der Mitfahrer bewertet hat.');
    await refreshMe();
    render();
  });
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
      <h2>Wohin möchtest du?</h2>
      <p class="muted small">Tipp: Du kannst Abholort und Ziel auch auf der Karte anklicken.</p>
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
  const { matches, activeDrivers, plannedRoute } = await api('/api/match', { pickup, dropoff, seats: state.seats });
  state.matches = matches;
  state.plannedRoute = plannedRoute;
  state.selected = matches[0] || null;
  state.activeDrivers = activeDrivers;
  if (!matches.length) {
    $('#matches').innerHTML = `<div class="card"><h3>Gerade kein passender Fahrer</h3><p class="muted">${activeDrivers} Fahrer sind gerade unterwegs, aber keiner fährt in der Nähe deiner Strecke vorbei. Versuche es in ein paar Minuten erneut.</p></div>`;
    previewPlaces();
    return;
  }
  renderMatches();
}

async function renderMatches() {
  const box = $('#matches');
  if (!box) return;
  box.innerHTML = `<div class="card"><h2>${state.matches.length} passende Fahrer</h2>
    ${state.matches.map((m, i) => `
      <div class="match ${state.selected && state.selected.tripId === m.tripId ? 'selected' : ''}" data-i="${i}">
        <div class="top">
          <div>${profileLink(m.driverId, m.driverName)} ${i === 0 ? '<span class="badge best">Beste Wahl</span>' : ''}<br>
            ${npsBadge(m.driverNps)}<br><span class="muted small">${esc(m.vehicle || 'Pkw')} · ${m.seatsFree} frei</span></div>
          <div class="price">${euro(m.price.totalCents)}</div>
        </div>
        <div class="muted small" style="margin-top:6px">
          Abholung in ca. ${m.etaMin} min · Umweg für Fahrer ${km(m.detourKm)} · spart ${m.price.co2SavedKg.toLocaleString('de-DE')} kg CO₂
        </div>
        <div class="muted small">Fahrt: ${esc(shortLabel(m.origin))} → ${esc(shortLabel(m.destination))}</div>
      </div>`).join('')}
    </div>
    ${state.selected ? `<div class="card">
        <h3>Deine Fahrt bestätigen</h3>
        ${plannedRouteHtml(state.plannedRoute, 'Lila gestrichelt auf der Karte. Diese Route bestätigen du und der Fahrer – sie ist die Grundlage für den Preis.')}
      </div>` + priceCard(state.selected.price, 'Preis für die geplante Route (Höchstbetrag)') + `<button class="full" id="r-book">Route bestätigen & bei ${esc(state.selected.driverName)} anfragen</button>` : ''}`;
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
    { ...state.places.pickup, color: '#1f8a5b', text: 'A' },
    { ...state.places.dropoff, color: '#b91c1c', text: 'B' },
  ];
  if (!m) return drawMap({ points });
  try {
    const { trip } = await api('/api/trips/' + m.tripId);
    drawMap({ routes: [{ coords: trip.route.coords, color: '#2563eb', weight: 5, opacity: 0.5 }, { coords: state.plannedRoute.coords, ...PLANNED_STYLE }], points, driver: trip.position });
  } catch {
    drawMap({ routes: state.plannedRoute ? [{ coords: state.plannedRoute.coords, ...PLANNED_STYLE }] : [], points });
  }
}

function priceCard(p, title) {
  return `<div class="card"><h3>${title}</h3>
    <table class="breakdown">
      <tr><td>${km(p.km)} × ${euro(p.ratePerKmCents)}${p.seats > 1 ? ` × ${p.seats} Pers.` : ''}</td><td>${euro(p.fareCents)}</td></tr>
      <tr><td class="muted">davon an den Fahrer</td><td class="muted">${euro(p.driverCents)}</td></tr>
      <tr><td class="muted">davon Vermittlungsprovision</td><td class="muted">${euro(p.commissionCents)}</td></tr>
      <tr><td>🌱 Spende Umweltschutz</td><td>${euro(p.donationCents)}</td></tr>
      <tr class="total"><td>Gesamt</td><td>${euro(p.totalCents)}</td></tr>
    </table>
    <p class="muted small">${BILLING_RULE}</p>
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
      routes: [...(trip ? [{ coords: trip.route.coords, color: '#2563eb', opacity: 0.5 }] : []), ...(ride.plannedRoute ? [{ coords: ride.plannedRoute.coords, ...PLANNED_STYLE }] : [])],
      points: [
        { ...ride.pickup, color: '#1f8a5b', text: 'A' },
        { ...ride.dropoff, color: '#b91c1c', text: 'B' },
      ],
      driver: trip && trip.position,
      fit,
    });
  };
  panel.innerHTML = `
    <div class="card">
      <h2>Deine Mitfahrt</h2>
      ${statusBadge(ride.status)}
      <p>${profileLink(ride.driverId, ride.driverName)} ${ride.vehicle ? '· ' + esc(ride.vehicle) : ''}</p>
      <p class="muted small">Abholung: ${esc(shortLabel(ride.pickup))}<br>Ziel: ${esc(shortLabel(ride.dropoff))}</p>
      ${ride.plannedRoute ? plannedRouteHtml(ride.plannedRoute, `${ride.myRouteConfirmed ? '✔ von dir bestätigt' : ''}${ride.partnerRouteConfirmed ? ' · ✔ vom Fahrer bestätigt' : ' · ○ Fahrer hat noch nicht bestätigt'}`) : ''}
      ${['requested', 'accepted'].includes(ride.status) ? '<button class="secondary" id="r-cancel" style="margin-top:10px">Stornieren</button>' : ''}
    </div>
    ${['picked_up', 'confirming'].includes(ride.status) ? confirmationCard(ride) : priceCard(ride.estimate, 'Preis für die geplante Route (Höchstbetrag)')}`;
  bindConfirmButtons(panel);
  const c = $('#r-cancel');
  if (c) c.onclick = () => guard(async () => { await api(`/api/rides/${ride.id}/cancel`, {}); await refreshMe(); render(); }, c);
  await draw(true);
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try { await loadRides(); } catch { return; }
    const now = state.rides.find((r) => r.id === ride.id);
    if (!now || now.status !== ride.status || now.partnerEndConfirmed !== ride.partnerEndConfirmed || (now.status === 'picked_up' && now.trackedKm !== ride.trackedKm)) {
      if (now && now.status === 'completed') toast(`Fahrt abgerechnet: ${km(now.final.km)} · ${euro(now.final.totalCents)} – danke fürs Teilen 🌱`);
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
      <h2>Jetzt als Fahrer online gehen</h2>
      <p class="muted small">Du fährst sowieso? Gib deine Route ein oder füge den Link deiner Google-Maps-Route ein – Mitfahrer auf deinem Weg finden dich automatisch.</p>
      <label for="d-link">Google-Maps-Routenlink</label>
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
        <p class="muted">${km(route.distanceKm)} · ca. ${Math.round(route.durationMin)} min · Quelle: ${esc(route.provider)}</p>
        <p class="muted small">Bei voll besetzten Plätzen könntest du bis zu ${euro(Math.round(route.distanceKm * state.config.pricing.ratePerKmCents * (1 - state.config.pricing.commissionPercent / 100)) * Number($('#d-seats').value))} deiner Fahrtkosten teilen.</p></div>`;
      drawMap({ routes: [{ coords: route.coords }], points: [{ ...route.origin, color: '#1f8a5b', text: 'S' }, { ...route.destination, color: '#b91c1c', text: 'Z' }] });
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
      <h2>Du bist online 🚗</h2>
      ${mfaHint()}
      <p><b>${esc(shortLabel(trip.origin))}</b> → <b>${esc(shortLabel(trip.destination))}</b></p>
      <p class="muted small">${km(trip.route.distanceKm)} · ${trip.seatsFree} von ${trip.seats} Plätzen frei · zurückgelegt ${km(trip.progressKm || 0)}</p>
      <div class="btn-row">
        ${tracking ? '<button class="secondary" id="d-stoptrack">Standort-Übertragung stoppen</button>' : '<button id="d-gps">📡 GPS-Standort teilen</button><button class="secondary" id="d-sim">Fahrt simulieren (Demo)</button>'}
        <button class="danger" id="d-end">Fahrt beenden</button>
      </div>
      <p class="muted small">Die gefahrenen Kilometer jedes Mitfahrers werden aus deinem GPS-Standort gemessen. ${BILLING_RULE.replace('zahlst du', 'zahlt der Mitfahrer')}</p>
    </div>
    <div class="card">
      <h2>Mitfahrer</h2>
      ${rides.length ? rides.map(driverRideCard).join('') : '<p class="muted">Noch keine Anfragen. Sobald jemand auf deiner Route mitfahren möchte, erscheint die Anfrage hier.</p>'}
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

  const points = [{ ...trip.origin, color: '#1f8a5b', text: 'S' }, { ...trip.destination, color: '#b91c1c', text: 'Z' }];
  rides.forEach((r) => {
    points.push({ ...r.pickup, color: '#f59e0b', text: '↑', label: `Abholen: ${r.riderName}` });
    points.push({ ...r.dropoff, color: '#7c3aed', text: '↓', label: `Absetzen: ${r.riderName}` });
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
    <div class="top">${profileLink(r.riderId, r.riderName)} ${statusBadge(r.status)}</div>
    <div class="muted small">${r.seats} Pers. · ${esc(shortLabel(r.pickup))} → ${esc(shortLabel(r.dropoff))} · Umweg ca. ${km(r.detourKm)}</div>
    ${r.plannedRoute && ['requested', 'accepted'].includes(r.status) ? plannedRouteHtml(r.plannedRoute, `dein Anteil höchstens <b>${euro(r.estimate.driverCents)}</b> · ${r.partnerRouteConfirmed ? '✔ vom Mitfahrer bestätigt' : ''}${r.myRouteConfirmed ? ' · ✔ von dir bestätigt' : ''}`) : ''}
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
    panel.innerHTML = `<div class="card"><h2>Führerschein wird geprüft</h2>
      <p><span class="badge warn">In Prüfung</span></p>
      <p class="muted">Nr. ${esc(lic.number)} · Klassen ${esc(lic.classes.join(', '))} · gültig bis ${new Date(lic.expiry).toLocaleDateString('de-DE')}</p>
      <p class="muted small">Sobald dein Führerschein bestätigt ist, kannst du sofort als Fahrer online gehen.</p>
      <button class="secondary" id="l-refresh">Status aktualisieren</button></div>`;
    $('#l-refresh').onclick = () => guard(async () => { await refreshMe(); render(); });
    return;
  }
  panel.innerHTML = `
    <div class="card">
      <h2>Als Fahrer legitimieren</h2>
      <p class="muted small">Um Mitfahrer mitzunehmen, brauchst du einen gültigen Führerschein (mind. Klasse B). Die Fotos werden nur vom Betreiber zur Prüfung eingesehen.</p>
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
  await refreshMe();
  const [{ transactions }] = await Promise.all([api('/api/wallet/transactions'), loadRides()]);
  const me = state.me;
  const done = state.rides.filter((r) => r.status === 'completed');
  panel.innerHTML = `
    <div class="card">
      <h2>Mein Konto</h2>
      <div class="stats">
        <div class="stat"><b>${euro(me.walletCents - me.reservedCents)}</b><span>verfügbares Guthaben${me.reservedCents ? ` (${euro(me.reservedCents)} reserviert)` : ''}</span></div>
        <div class="stat"><b>${me.co2SavedKg.toLocaleString('de-DE')} kg</b><span>CO₂ gemeinsam eingespart</span></div>
        <div class="stat"><b>${me.nps.count ? (me.nps.score > 0 ? '+' : '') + me.nps.score : '–'}</b><span>dein NPS (${bewertungen(me.nps.count)}: ${me.nps.promoters} 😊 · ${me.nps.passives} 😐 · ${me.nps.detractors} 🙁)</span></div>
        <div class="stat"><b>${me.canDrive ? '✅' : '—'}</b><span>Fahrer verifiziert</span></div>
      </div>
      <h3 style="margin-top:14px">Guthaben aufladen</h3>
      <p class="muted small">Demo-Zahlung. Im Produktivbetrieb erfolgt die Zahlung über einen Zahlungsdienstleister.</p>
      <div class="btn-row">${[1000, 2000, 5000].map((c) => `<button class="secondary" data-topup="${c}">+ ${euro(c)}</button>`).join('')}</div>
    </div>
    <div class="card">
      <h2>Fahrten</h2>
      ${done.length ? done.map((r) => `
        <div class="match">
          <div class="top"><span>${r.role === 'rider' ? 'Mitgefahren bei' : 'Mitgenommen:'} <b>${esc(r.role === 'rider' ? r.driverName : r.riderName)}</b></span>
            <b>${r.role === 'rider' ? '−' + euro(r.final.totalCents) : '+' + euro(r.final.driverCents)}</b></div>
          <div class="muted small">${new Date(r.completedAt).toLocaleString('de-DE')} · abgerechnet ${km(r.final.km)} (${BASIS[r.final.billing] || r.final.billing}${r.final.plannedKm ? `; geplant ${km(r.final.plannedKm)}, gefahren ${r.final.trackedKm > 0.2 ? km(r.final.trackedKm) : '–'}` : ''}) · ${r.final.co2SavedKg.toLocaleString('de-DE')} kg CO₂ gespart · ${euro(r.final.donationCents)} gespendet</div>
          <div class="small">${ridePointsLine(r.myPoints)}</div>
          ${r.myRating ? `<div class="muted small">Deine Bewertung: <b>${r.myRating.score}</b>/10</div>` : `<form class="nps-form" data-rate-form="${r.id}">${npsWidget(`Wie wahrscheinlich ist es, dass du ${r.role === 'rider' ? r.driverName : r.riderName} weiterempfiehlst?`)}<div class="btn-row"><button data-submit disabled>Bewertung senden</button></div></form>`}
        </div>`).join('') : '<p class="muted">Noch keine abgeschlossenen Fahrten.</p>'}
    </div>
    <div class="card">
      <h2>Kontobewegungen</h2>
      <table class="breakdown">${transactions.map((t) => `<tr><td>${esc(t.note)}<br><span class="muted small">${new Date(t.at).toLocaleString('de-DE')}</span></td><td>${euro(t.amountCents)}</td></tr>`).join('') || '<tr><td class="muted">Keine Buchungen</td><td></td></tr>'}</table>
    </div>`;
  panel.querySelectorAll('[data-topup]').forEach((b) =>
    (b.onclick = () => guard(async () => { await api('/api/wallet/topup', { amountCents: Number(b.dataset.topup) }); toast('Guthaben aufgeladen.'); render(); }, b)),
  );
  bindNpsForms(panel, '[data-rate-form]', async (form, body) => {
    await api(`/api/rides/${form.dataset.rateForm}/rate`, body);
    toast('Danke für deine Bewertung!');
    render();
  });
}

// ---------- Betreiber ----------
async function renderAdmin(panel) {
  drawMap();
  const [stats, { licenses }, { disputes }] = await Promise.all([api('/api/admin/stats'), api('/api/admin/licenses'), api('/api/admin/disputes')]);
  panel.innerHTML = `
    <div class="card">
      <h2>Betreiber-Übersicht</h2>
      ${mfaHint('Als Betreiber hast du Zugriff auf Führerscheindaten aller Fahrer – bitte unbedingt die Zwei-Faktor-Anmeldung aktivieren.')}
      <div class="stats">
        <div class="stat"><b>${euro(stats.commissionCents)}</b><span>Provision (deine Einnahmen)</span></div>
        <div class="stat"><b>${euro(stats.donationCents)}</b><span>Umweltspenden gesammelt</span></div>
        <div class="stat"><b>${stats.ridesCompleted}</b><span>abgeschlossene Mitfahrten</span></div>
        <div class="stat"><b>${km(stats.kmShared)}</b><span>geteilte Kilometer</span></div>
        <div class="stat"><b>${stats.co2SavedKg.toLocaleString('de-DE')} kg</b><span>CO₂ eingespart</span></div>
        <div class="stat"><b>${stats.driverNps.count ? (stats.driverNps.score > 0 ? '+' : '') + stats.driverNps.score : '–'}</b><span>NPS der Fahrer (${bewertungen(stats.driverNps.count)})</span></div>
        <div class="stat"><b>${stats.openDisputes}</b><span>offene Reklamationen</span></div>
        <div class="stat"><b>${stats.activeTrips} / ${stats.verifiedDrivers}</b><span>Fahrer online / verifiziert</span></div>
      </div>
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
            <button data-decide="verified" data-user="${l.userId}">✔ Bestätigen</button>
            <button class="danger" data-decide="rejected" data-user="${l.userId}">✖ Ablehnen</button>
          </div>
        </div>`).join('') : '<p class="muted">Keine offenen Anträge.</p>'}
    </div>`;
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
  return `<button type="button" class="linkish" data-profile="${esc(userId)}" title="Profil ansehen">${esc(name)}</button>`;
}

function avatar(p, cls = '') {
  return p.hasPhoto
    ? `<img class="avatar ${cls}" src="/api/users/${esc(p.id)}/photo?v=${Date.now()}" alt="">`
    : `<span class="avatar ${cls}">${esc((p.name || '?')[0].toUpperCase())}</span>`;
}

const PREF_LABELS = { smoking: '🚬 Rauchen', pets: '🐾 Tiere', music: '🎵 Musik', chat: '💬 Unterhaltung' };

function profileHtml(p) {
  return `
    <div class="profile-head">${avatar(p)}
      <div><h2 style="margin:0">${esc(p.name)}</h2>
        <div class="chips">
          ${p.verifiedDriver ? '<span class="badge ok">✔ Führerschein geprüft</span>' : ''}
          ${p.mfaEnabled ? '<span class="badge ok">🔐 2FA gesichert</span>' : ''}
          ${npsBadge(p.nps)}
        </div>
      </div>
    </div>
    ${p.bio ? `<p>${esc(p.bio)}</p>` : ''}
    ${p.phone ? `<p>📞 <a href="tel:${esc(p.phone.replace(/[^+0-9]/g, ''))}">${esc(p.phone)}</a></p>` : ''}
    ${p.vehicle && p.vehicle.model ? `<p class="muted">🚗 ${esc([p.vehicle.color, p.vehicle.model].filter(Boolean).join(' '))}</p>` : ''}
    <div class="chips">${Object.entries(p.preferences).map(([k, v]) => `<span class="badge">${PREF_LABELS[k]}: ${esc(v)}</span>`).join('')}</div>
    ${p.languages.length ? `<p class="muted small">Spricht: ${esc(p.languages.join(', '))}</p>` : ''}
    ${p.stats ? `<div class="stats" style="margin-top:10px">
      <div class="stat"><b>${p.stats.ridesAsDriver}</b><span>Fahrten als Fahrer</span></div>
      <div class="stat"><b>${p.stats.ridesAsRider}</b><span>Fahrten als Mitfahrer</span></div>
      <div class="stat"><b>${p.stats.co2SavedKg.toLocaleString('de-DE')} kg</b><span>CO₂ gespart</span></div>
      <div class="stat"><b>${esc(p.stats.memberSince.split('-').reverse().join('/'))}</b><span>Mitglied seit</span></div>
      ${p.stats.level ? `<div class="stat"><b>${p.stats.level.icon} ${esc(p.stats.level.name)}</b><span>Level</span></div><div class="stat"><b>${Number(p.stats.points).toLocaleString('de-DE')}</b><span>Punkte</span></div>` : ''}
    </div>
    ${p.stats.badges && p.stats.badges.length ? `<div class="chips">${p.stats.badges.map((b) => `<span class="badge" title="${esc(b.name)}">${b.icon} ${esc(b.name)}</span>`).join('')}</div>` : ''}` : ''}`;
}

async function showProfile(userId, preview) {
  const { profile } = await api(`/api/users/${encodeURIComponent(userId)}/profile${preview ? '?preview=' + preview : ''}`);
  openModal(profileHtml(profile) + (preview ? `<p class="muted small" style="margin-top:12px">Vorschau: So sieht dich ${preview === 'booked' ? 'ein bestätigter Fahrtpartner' : 'ein anderes Mitglied vor einer Buchung'}.</p>` : ''));
}

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
  return `<div class="card notice" style="margin:10px 0"><b>🔐 Konto absichern</b><p class="small" style="margin:4px 0 8px">${esc(text || 'Du teilst deinen Standort und erhältst Auszahlungen – schütze dein Konto mit der Zwei-Faktor-Anmeldung.')}</p><a class="btn" href="#/profil">2FA aktivieren</a></div>`;
}

// ---------- Eigenes Profil, Privatsphäre, Sicherheit, Daten ----------
async function renderProfile(panel) {
  drawMap();
  await refreshMe();
  const me = state.me;
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
          <label class="btn secondary" style="margin:0;color:var(--text)">📷 Foto wählen<input type="file" id="p-photo" accept="image/*" hidden></label>
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
        <div class="row">
          <div><label for="p-model">Fahrzeug (Fahrer)</label><input id="p-model" value="${esc(p.vehicle.model)}" placeholder="VW Golf"></div>
          <div><label for="p-color">Farbe</label><input id="p-color" value="${esc(p.vehicle.color)}" placeholder="blau"></div>
        </div>
        <div class="btn-row">
          <button id="p-save">Profil speichern</button>
          <button type="button" class="secondary" data-preview="stranger">So sehen mich andere</button>
        </div>
      </form>
    </div>

    <div class="card">
      <h2>Privatsphäre</h2>
      <p class="muted small">Andere Mitglieder sehen dein Profil nur, wenn du gerade als Fahrer online bist oder ihr gemeinsam fahrt. Deine E-Mail-Adresse ist nie sichtbar.</p>
      <label class="check"><input type="checkbox" id="pv-fullname" ${pv.showFullName ? 'checked' : ''}><span>Vollständigen Nachnamen zeigen <span class="muted">(sonst „${esc(me.name.split(/\s+/)[0])} ${esc((me.name.split(/\s+/).slice(-1)[0] || '')[0] || '')}.“)</span></span></label>
      <label class="check"><input type="checkbox" id="pv-photo" ${pv.showPhoto ? 'checked' : ''}><span>Profilfoto zeigen</span></label>
      <label class="check"><input type="checkbox" id="pv-stats" ${pv.showStats ? 'checked' : ''}><span>Statistik zeigen (Anzahl Fahrten, CO₂, Mitglied seit, Level & Punkte)</span></label>
      <label class="check"><input type="checkbox" id="pv-leaderboard" ${pv.showOnLeaderboard ? 'checked' : ''}><span>In der Bestenliste erscheinen (Anzeigename, Level, Punkte)</span></label>
      <label for="pv-phone">Telefonnummer sichtbar für</label>
      <select id="pv-phone">
        <option value="never" ${pv.phoneVisibility === 'never' ? 'selected' : ''}>niemanden</option>
        <option value="booked" ${pv.phoneVisibility === 'booked' ? 'selected' : ''}>bestätigte Fahrtpartner während der Fahrt</option>
      </select>
      <p class="muted small">Start und Ziel deiner Fahrten sehen andere nur ungefähr (Ort statt Straße, Route ohne die ersten und letzten 500 m). Deinen Live-Standort sehen nur bestätigte Mitfahrer – und nur, solange du online bist.</p>
      <div class="btn-row"><button id="pv-save">Privatsphäre speichern</button><button type="button" class="secondary" data-preview="booked">Vorschau für Fahrtpartner</button></div>
    </div>

    <div class="card" id="security">
      <h2>Sicherheit & Anmeldung</h2>
      ${me.mfaEnabled
        ? `<p><span class="badge ok">🔐 Zwei-Faktor-Anmeldung aktiv</span></p>
           <p class="muted small">Noch ${me.backupCodesLeft} Backup-Codes übrig.${me.backupCodesLeft < 3 ? ' <b>Bitte neue erzeugen.</b>' : ''}</p>
           <div class="btn-row"><button class="secondary" id="mfa-codes">Neue Backup-Codes</button><button class="secondary" id="mfa-off">2FA deaktivieren</button></div>`
        : `<p><span class="badge warn">Zwei-Faktor-Anmeldung aus</span></p>
           <p class="muted small">Mit 2FA brauchst du beim Anmelden zusätzlich einen Code aus einer Authenticator-App (z. B. Google Authenticator, Microsoft Authenticator, Authy, 1Password). Selbst wer dein Passwort kennt, kommt so nicht in dein Konto.</p>
           <button id="mfa-on">2FA einrichten</button>
           <div id="mfa-setup"></div>`}
      <h3 style="margin-top:16px">Angemeldete Geräte (${sessions.length})</h3>
      <table class="breakdown">${sessions.map((s) => `<tr><td>${esc(shortAgent(s.userAgent))}${s.current ? ' <span class="badge ok">dieses Gerät</span>' : ''}</td><td class="muted small">${s.createdAt ? new Date(s.createdAt).toLocaleDateString('de-DE') : ''}</td></tr>`).join('')}</table>
      ${sessions.length > 1 ? '<div class="btn-row"><button class="secondary" id="sess-revoke">Alle anderen Geräte abmelden</button></div>' : ''}
    </div>

    <div class="card">
      <h2>Meine Daten</h2>
      <p class="muted small">Einwilligung zur <a href="#/datenschutz">Datenschutzerklärung</a> erteilt am ${me.consentAt ? new Date(me.consentAt).toLocaleString('de-DE') : '–'}.</p>
      <div class="btn-row">
        <a class="btn secondary" style="color:var(--text)" href="/api/me/export" download>⬇ Alle meine Daten herunterladen (JSON)</a>
      </div>
      <p class="muted small">Auskunft und Datenübertragbarkeit nach Art. 15 und 20 DSGVO.</p>
      <h3 style="margin-top:16px">Konto löschen</h3>
      <p class="muted small">Profil, Fotos, Telefonnummer, Führerscheindaten und Anmeldedaten werden sofort gelöscht. Abrechnungsbelege müssen wir gesetzlich 10 Jahre aufbewahren – sie bleiben anonymisiert („Gelöschtes Konto“) erhalten. Restguthaben wird ausgezahlt.</p>
      <button class="danger" id="acc-delete">Konto endgültig löschen</button>
    </div>`;

  panel.querySelectorAll('[data-preview]').forEach((b) => (b.onclick = () => guard(() => showProfile(me.id, b.dataset.preview))));

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
            vehicle: { model: $('#p-model').value, color: $('#p-color').value },
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
      privacy: { showFullName: $('#pv-fullname').checked, showPhoto: $('#pv-photo').checked, showStats: $('#pv-stats').checked, showOnLeaderboard: $('#pv-leaderboard').checked, phoneVisibility: $('#pv-phone').value },
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
  openModal(`<h2>🔐 Deine Backup-Codes</h2>
    <p class="muted">Bewahre diese Codes sicher auf (z. B. ausgedruckt oder im Passwortmanager). Wenn du dein Handy verlierst, kommst du nur damit in dein Konto. Jeder Code gilt einmal. <b>Sie werden nur jetzt angezeigt.</b></p>
    <div class="codes">${codes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
    <div class="btn-row"><a class="btn secondary" style="color:var(--text)" href="${href}" download="joinmyride-backup-codes.txt">⬇ Als Datei speichern</a><button id="codes-done">Ich habe die Codes gespeichert</button></div>`);
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
        <li><b>Bewertungen und Punkte:</b> Bewertungen (0–10, optionaler Kommentar), daraus berechneter NPS, Punkte, Level und Abzeichen. Zweck: Vertrauen zwischen Fahrtpartnern, Qualität, Motivation zum Teilen von Fahrten (Art. 6 Abs. 1 lit. b und f DSGVO). Einzelbewertungen sieht nur, wer sie abgegeben hat; andere sehen nur Zusammenfassungen. In der <b>Bestenliste</b> erscheinst du nur mit deiner Einwilligung (Art. 6 Abs. 1 lit. a DSGVO), die du jederzeit widerrufen kannst.</li>
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

function pointsHint(partnerName) {
  const f = state.config && state.config.points;
  if (!f) return '';
  return `<p class="muted small">🎯 Punkte: Je besser dich ${esc(partnerName)} bewertet, desto mehr Punkte gibt es – Promotor ×${f.promoter}, neutral ×${f.passive}, Kritiker ×${f.detractor}, jeweils × eingesparte kg CO₂.</p>`;
}

function ridePointsLine(p) {
  if (!p) return '';
  return `<span class="points-chip" title="${p.rated ? `Bewertung: ${CAT_LABEL[p.category]}` : 'Noch nicht bewertet – neutraler Faktor'}">+${pts(p.points)} <span class="muted">(×${p.factor} · ${p.co2Kg.toLocaleString('de-DE')} kg CO₂${p.rated ? '' : ' · vorläufig'})</span></span>`;
}

async function renderPoints(panel) {
  drawMap();
  const g = await api('/api/me/points');
  const lvl = g.level;
  panel.innerHTML = `
    <div class="card level-card">
      <div class="level-head">
        <span class="level-icon">${lvl.icon}</span>
        <div><div class="muted small">Level ${lvl.rank}</div><h2 style="margin:0">${esc(lvl.name)}</h2><div class="points-big">${pts(g.points)}</div></div>
      </div>
      <div class="progress"><div style="width:${Math.round(lvl.progress * 100)}%"></div></div>
      <p class="muted small">${lvl.next ? `Noch ${pts(lvl.next.missing)} bis ${lvl.next.icon} ${esc(lvl.next.name)}` : 'Höchstes Level erreicht – danke! 🌍'} · diesen Monat ${pts(g.monthPoints)}</p>
    </div>

    <div class="card">
      <h2>So sammelst du Punkte</h2>
      <p class="formula">Punkte = <b>Faktor</b> × <b>eingesparte kg CO₂</b></p>
      <table class="breakdown">
        <tr><td>😊 Promotor (9–10)</td><td><b>×${g.factors.promoter}</b></td></tr>
        <tr><td>😐 Neutral (7–8)</td><td><b>×${g.factors.passive}</b></td></tr>
        <tr><td>🙁 Kritiker (0–6)</td><td><b>×${g.factors.detractor}</b></td></tr>
      </table>
      <p class="muted small">Der Faktor richtet sich nach der Bewertung, die du vom jeweils anderen bekommst: Fahrer werden vom Mitfahrer bewertet, Mitfahrer vom Fahrer. Solange keine Bewertung vorliegt, zählt der neutrale Faktor. Längere geteilte Strecken und mehr Mitfahrer sparen mehr CO₂ – und bringen mehr Punkte.</p>
    </div>

    <div class="card">
      <h2>Abzeichen (${g.badges.filter((b) => b.earned).length}/${g.badges.length})</h2>
      <div class="badges">${g.badges.map((b) => `<div class="badge-tile ${b.earned ? 'earned' : ''}" title="${esc(b.desc)}"><span>${b.icon}</span><b>${esc(b.name)}</b><small>${esc(b.desc)}</small></div>`).join('')}</div>
    </div>

    <div class="card">
      <h2>Bestenliste</h2>
      <div class="tabs"><button data-period="month">Dieser Monat</button><button class="secondary" data-period="all">Gesamt</button></div>
      <div id="leaderboard"><p class="muted">Lädt …</p></div>
      <label class="check"><input type="checkbox" id="lb-optin" ${g.leaderboardOptIn ? 'checked' : ''}><span>Mich in der Bestenliste für andere anzeigen (mit Anzeigename und Level, ohne weitere Daten). Jederzeit widerrufbar.</span></label>
    </div>

    <div class="card">
      <h2>Punkte-Verlauf</h2>
      ${g.history.length ? `<table class="breakdown">${g.history.map((h) => `<tr><td>${h.role === 'driver' ? '🚗 Mitgenommen' : '🧍 Mitgefahren bei'} ${esc(h.partner)}<br><span class="muted small">${new Date(h.at).toLocaleDateString('de-DE')} · ${km(h.km)} · ${h.rated ? `bewertet als ${CAT_LABEL[h.category]}` : 'noch nicht bewertet'}</span></td><td><b>+${h.points}</b><br><span class="muted small">×${h.factor} · ${h.co2Kg.toLocaleString('de-DE')} kg</span></td></tr>`).join('')}</table>` : '<p class="muted">Noch keine Punkte – teile deine erste Fahrt! 🌱</p>'}
    </div>`;

  const loadBoard = async (period) => {
    panel.querySelectorAll('[data-period]').forEach((b) => (b.className = b.dataset.period === period ? '' : 'secondary'));
    const lb = await api('/api/leaderboard?period=' + period);
    $('#leaderboard').innerHTML = lb.entries.length
      ? `<table class="breakdown leaderboard">${lb.entries.map((e) => `<tr class="${e.isMe ? 'me' : ''}"><td>${e.rank <= 3 ? ['🥇', '🥈', '🥉'][e.rank - 1] : e.rank + '.'} ${e.level.icon} ${esc(e.name)}${e.isMe ? ' <span class="badge ok">du</span>' : ''}</td><td><b>${pts(e.points)}</b></td></tr>`).join('')}</table>
         ${lb.me.rank && !lb.entries.some((e) => e.isMe) ? `<p class="small">Dein Platz: <b>${lb.me.rank}</b> mit ${pts(lb.me.points)}</p>` : ''}`
      : '<p class="muted">Noch keine Punkte in diesem Zeitraum.</p>';
    if (!lb.optedIn) $('#leaderboard').insertAdjacentHTML('beforeend', '<p class="muted small">Du siehst dich selbst, andere sehen dich erst nach deiner Zustimmung.</p>');
  };
  panel.querySelectorAll('[data-period]').forEach((b) => (b.onclick = () => guard(() => loadBoard(b.dataset.period))));
  $('#lb-optin').onchange = (e) => guard(async () => {
    await api('/api/me/profile', { privacy: { showOnLeaderboard: e.target.checked } }, 'PUT');
    toast(e.target.checked ? 'Du erscheinst jetzt in der Bestenliste.' : 'Du wirst anderen nicht mehr in der Bestenliste angezeigt.');
    await loadBoard('month');
  });
  await loadBoard('month');
}

// ---------- Start ----------
(async function init() {
  try { state.config = await api('/api/config'); } catch {}
  try { state.me = (await api('/api/me')).user; } catch {}
  render();
})();
