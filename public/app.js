'use strict';

/* Mitfahrzentrale – Frontend (ohne Build-Schritt) */

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
    if (err.status === 401) { state.me = null; render(); }
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
    ? `<span>${esc(state.me.name)} · <b>${euro(state.me.walletCents - state.me.reservedCents)}</b></span><button class="secondary" id="logout">Abmelden</button>`
    : '';
  const lo = $('#logout');
  if (lo) lo.onclick = () => guard(async () => { await api('/api/logout', {}); state.me = null; stopDriving(); render(); });
}

function render() {
  renderHeader();
  clearInterval(state.pollTimer);
  const panel = $('#panel');
  if (!state.me) return renderAuth(panel);
  const view = currentView();
  if (view === 'fahren') guard(() => renderDriver(panel));
  else if (view === 'konto') guard(() => renderAccount(panel));
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
        <button class="full" style="margin-top:14px" id="a-submit">Anmelden</button>
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
    $('#a-submit').textContent = m === 'login' ? 'Anmelden' : 'Konto erstellen';
    $('#a-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  };
  $('#tab-login').onclick = () => setMode('login');
  $('#tab-register').onclick = () => setMode('register');
  $('#auth-form').onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      const body = { email: $('#a-email').value, password: $('#a-pass').value, name: $('#a-name').value };
      const { user } = await api(mode === 'login' ? '/api/login' : '/api/register', body);
      state.me = user;
      render();
    }, $('#a-submit'));
  };
}

// ---------- Mitfahrer ----------
const OPEN_STATES = ['requested', 'accepted', 'picked_up'];
const activeRiderRide = () => state.rides.find((r) => r.role === 'rider' && OPEN_STATES.includes(r.status));
const STATUS = {
  requested: ['Angefragt – wartet auf Fahrer', 'warn'],
  accepted: ['Bestätigt – Fahrer ist unterwegs', 'ok'],
  picked_up: ['Unterwegs', 'ok'],
  completed: ['Abgeschlossen', 'ok'],
  declined: ['Abgelehnt', 'bad'],
  cancelled: ['Storniert', 'bad'],
};
const statusBadge = (s) => `<span class="badge ${STATUS[s][1]}">${STATUS[s][0]}</span>`;

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
  const { matches, activeDrivers } = await api('/api/match', { pickup, dropoff, seats: state.seats });
  state.matches = matches;
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
          <div><b>${esc(m.driverName)}</b> ${i === 0 ? '<span class="badge best">Beste Wahl</span>' : ''}<br>
            <span class="muted small">★ ${m.driverRating} · ${esc(m.vehicle || 'Pkw')} · ${m.seatsFree} frei</span></div>
          <div class="price">${euro(m.price.totalCents)}</div>
        </div>
        <div class="muted small" style="margin-top:6px">
          Abholung in ca. ${m.etaMin} min · ${km(m.plannedKm)} Mitfahrt · Umweg für Fahrer ${km(m.detourKm)} · spart ${m.price.co2SavedKg.toLocaleString('de-DE')} kg CO₂
        </div>
        <div class="muted small">Fahrt: ${esc(shortLabel(m.origin))} → ${esc(shortLabel(m.destination))}</div>
      </div>`).join('')}
    </div>
    ${state.selected ? priceCard(state.selected.price, 'Voraussichtlicher Preis') + `<button class="full" id="r-book">Bei ${esc(state.selected.driverName)} mitfahren</button>` : ''}`;
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
    drawMap({ routes: [{ coords: trip.route.coords, color: '#2563eb', weight: 5 }], points, driver: trip.position });
  } catch {
    drawMap({ points });
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
    <p class="muted small">Abgerechnet werden die tatsächlich gefahrenen Kilometer (GPS), höchstens ${Math.round((state.config.pricing.maxBilledKmFactor - 1) * 100)} % über der geplanten Strecke.</p>
  </div>`;
}

async function bookSelected() {
  const m = state.selected;
  try {
    await api('/api/rides', { tripId: m.tripId, pickup: state.places.pickup, dropoff: state.places.dropoff, seats: state.seats });
  } catch (err) {
    if (err.status === 402) {
      toast(err.message + ' Bitte Guthaben im Konto aufladen.');
      location.hash = '#/konto';
      return;
    }
    throw err;
  }
  toast('Anfrage gesendet – der Fahrer wird benachrichtigt.');
  state.matches = [];
  render();
}

async function renderRiderRide(panel, ride) {
  const draw = async (fit) => {
    let trip = null;
    try { trip = (await api('/api/trips/' + ride.tripId)).trip; } catch {}
    drawMap({
      routes: trip ? [{ coords: trip.route.coords, color: '#2563eb' }] : [],
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
      <p><b>${esc(ride.driverName)}</b> ${ride.vehicle ? '· ' + esc(ride.vehicle) : ''}</p>
      <p class="muted small">Abholung: ${esc(shortLabel(ride.pickup))}<br>Ziel: ${esc(shortLabel(ride.dropoff))}</p>
      ${ride.status === 'picked_up' ? `<p>Gefahren: <b>${km(ride.trackedKm)}</b> von ca. ${km(ride.plannedKm)}</p>` : ''}
      ${['requested', 'accepted'].includes(ride.status) ? '<button class="secondary" id="r-cancel">Stornieren</button>' : ''}
    </div>
    ${priceCard(ride.estimate, 'Voraussichtlicher Preis')}`;
  const c = $('#r-cancel');
  if (c) c.onclick = () => guard(async () => { await api(`/api/rides/${ride.id}/cancel`, {}); await refreshMe(); render(); }, c);
  await draw(true);
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try { await loadRides(); } catch { return; }
    const now = state.rides.find((r) => r.id === ride.id);
    if (!now || now.status !== ride.status || (now.status === 'picked_up' && now.trackedKm !== ride.trackedKm)) {
      if (now && now.status === 'completed') toast(`Angekommen! Abgerechnet: ${euro(now.final.totalCents)} – danke fürs Teilen 🌱`);
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
      <p><b>${esc(shortLabel(trip.origin))}</b> → <b>${esc(shortLabel(trip.destination))}</b></p>
      <p class="muted small">${km(trip.route.distanceKm)} · ${trip.seatsFree} von ${trip.seats} Plätzen frei · zurückgelegt ${km(trip.progressKm || 0)}</p>
      <div class="btn-row">
        ${tracking ? '<button class="secondary" id="d-stoptrack">Standort-Übertragung stoppen</button>' : '<button id="d-gps">📡 GPS-Standort teilen</button><button class="secondary" id="d-sim">Fahrt simulieren (Demo)</button>'}
        <button class="danger" id="d-end">Fahrt beenden</button>
      </div>
      <p class="muted small">Die gefahrenen Kilometer jedes Mitfahrers werden aus deinem GPS-Standort berechnet.</p>
    </div>
    <div class="card">
      <h2>Mitfahrer</h2>
      ${rides.length ? rides.map(driverRideCard).join('') : '<p class="muted">Noch keine Anfragen. Sobald jemand auf deiner Route mitfahren möchte, erscheint die Anfrage hier.</p>'}
    </div>`;

  panel.querySelectorAll('[data-act]').forEach((btn) =>
    btn.addEventListener('click', () =>
      guard(async () => {
        const { ride } = await api(`/api/rides/${btn.dataset.id}/${btn.dataset.act}`, {});
        if (ride.status === 'completed') toast(`Abgerechnet: ${km(ride.final.km)} – du erhältst ${euro(ride.final.driverCents)}`);
        await refreshMe();
        render();
      }, btn),
    ),
  );
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
  drawMap({ routes: [{ coords: trip.route.coords }], points, driver: trip.position, fit: !renderActiveTrip.fitted });
  renderActiveTrip.fitted = true;

  const signature = JSON.stringify(rides.map((r) => [r.id, r.status, r.trackedKm]));
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try {
      const [{ trip: t }] = await Promise.all([api('/api/trips/active'), loadRides()]);
      if (!t) return render();
      state.trip = t;
      updateDriverMarker(t.position);
      const now = state.rides.filter((r) => r.tripId === t.id && OPEN_STATES.includes(r.status));
      if (JSON.stringify(now.map((r) => [r.id, r.status, r.trackedKm])) !== signature) {
        if (now.some((r) => r.status === 'requested' && !rides.find((o) => o.id === r.id))) toast('Neue Mitfahranfrage!');
        render();
      }
    } catch {}
  }, 4000);
}

function driverRideCard(r) {
  const actions = {
    requested: `<button data-act="accept" data-id="${r.id}">Annehmen</button><button class="secondary" data-act="decline" data-id="${r.id}">Ablehnen</button>`,
    accepted: `<button data-act="pickup" data-id="${r.id}">Eingestiegen</button><button class="secondary" data-act="cancel" data-id="${r.id}">Stornieren</button>`,
    picked_up: `<button data-act="complete" data-id="${r.id}">Am Ziel abgesetzt</button>`,
  }[r.status];
  return `<div class="match">
    <div class="top"><b>${esc(r.riderName)}</b> ${statusBadge(r.status)}</div>
    <div class="muted small">${r.seats} Pers. · ${esc(shortLabel(r.pickup))} → ${esc(shortLabel(r.dropoff))}</div>
    <div class="muted small">Umweg ca. ${km(r.detourKm)} · Mitfahrt ${km(r.plannedKm)} · dein Anteil ca. <b>${euro(r.estimate.driverCents)}</b></div>
    ${r.status === 'picked_up' ? `<div class="small">Gefahren (GPS): <b>${km(r.trackedKm)}</b></div>` : ''}
    <div class="btn-row">${actions}</div>
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
        <div class="stat"><b>${me.rating ? '★ ' + me.rating : '–'}</b><span>Bewertung (${me.ratingCount})</span></div>
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
          <div class="muted small">${new Date(r.completedAt).toLocaleString('de-DE')} · ${km(r.final.km)} (${r.final.billing === 'gps' ? 'GPS' : 'geplant'}) · ${r.final.co2SavedKg.toLocaleString('de-DE')} kg CO₂ gespart · ${euro(r.final.donationCents)} gespendet</div>
          ${(r.role === 'rider' ? r.ratingByRider : r.ratingByDriver) ? '' : `<div class="stars">${[1, 2, 3, 4, 5].map((s) => `<button data-rate="${r.id}" data-stars="${s}" title="${s} Sterne">☆</button>`).join('')}</div>`}
        </div>`).join('') : '<p class="muted">Noch keine abgeschlossenen Fahrten.</p>'}
    </div>
    <div class="card">
      <h2>Kontobewegungen</h2>
      <table class="breakdown">${transactions.map((t) => `<tr><td>${esc(t.note)}<br><span class="muted small">${new Date(t.at).toLocaleString('de-DE')}</span></td><td>${euro(t.amountCents)}</td></tr>`).join('') || '<tr><td class="muted">Keine Buchungen</td><td></td></tr>'}</table>
    </div>`;
  panel.querySelectorAll('[data-topup]').forEach((b) =>
    (b.onclick = () => guard(async () => { await api('/api/wallet/topup', { amountCents: Number(b.dataset.topup) }); toast('Guthaben aufgeladen.'); render(); }, b)),
  );
  panel.querySelectorAll('[data-rate]').forEach((b) =>
    (b.onclick = () => guard(async () => { await api(`/api/rides/${b.dataset.rate}/rate`, { stars: Number(b.dataset.stars) }); toast('Danke für deine Bewertung!'); render(); }, b)),
  );
}

// ---------- Betreiber ----------
async function renderAdmin(panel) {
  drawMap();
  const [stats, { licenses }] = await Promise.all([api('/api/admin/stats'), api('/api/admin/licenses')]);
  panel.innerHTML = `
    <div class="card">
      <h2>Betreiber-Übersicht</h2>
      <div class="stats">
        <div class="stat"><b>${euro(stats.commissionCents)}</b><span>Provision (deine Einnahmen)</span></div>
        <div class="stat"><b>${euro(stats.donationCents)}</b><span>Umweltspenden gesammelt</span></div>
        <div class="stat"><b>${stats.ridesCompleted}</b><span>abgeschlossene Mitfahrten</span></div>
        <div class="stat"><b>${km(stats.kmShared)}</b><span>geteilte Kilometer</span></div>
        <div class="stat"><b>${stats.co2SavedKg.toLocaleString('de-DE')} kg</b><span>CO₂ eingespart</span></div>
        <div class="stat"><b>${stats.activeTrips} / ${stats.verifiedDrivers}</b><span>Fahrer online / verifiziert</span></div>
      </div>
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
  panel.querySelectorAll('[data-decide]').forEach((b) =>
    (b.onclick = () => guard(async () => {
      const note = panel.querySelector(`[data-note="${b.dataset.user}"]`).value;
      await api(`/api/admin/licenses/${b.dataset.user}`, { decision: b.dataset.decide, note });
      if (b.dataset.user === state.me.id) await refreshMe();
      render();
    }, b)),
  );
}

// ---------- Start ----------
(async function init() {
  try { state.config = await api('/api/config'); } catch {}
  try { state.me = (await api('/api/me')).user; } catch {}
  render();
})();
