'use strict';

/* joinmyride.com – Startseite: Sprache, Beispielrechnung, Anmeldestatus (ohne Build-Schritt) */

(function () {
  const LANG_STORAGE_KEY = 'joinmyride-lang'; // dieselbe Auswahl wie in der App
  let config = null;
  let dict = Object.create(null);
  let locale = 'de-DE';

  const t = (key, vars) => {
    const s = typeof dict[key] === 'string' && dict[key] ? dict[key] : key;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s;
  };
  const euro = (cents) => (cents / 100).toLocaleString(locale, { style: 'currency', currency: 'EUR' });
  const languages = () => (config && config.uiLanguages) || [{ code: 'de', name: 'Deutsch', locale: 'de-DE' }];

  function preferredLanguage() {
    const codes = languages().map((l) => l.code);
    let stored = null;
    try { stored = localStorage.getItem(LANG_STORAGE_KEY); } catch {}
    if (stored && codes.includes(stored)) return stored;
    for (const l of navigator.languages || [navigator.language]) {
      const code = String(l || '').toLowerCase().split('-')[0];
      if (codes.includes(code)) return code;
    }
    return 'de';
  }

  async function applyLanguage(code) {
    const meta = languages().find((l) => l.code === code) || languages()[0];
    dict = Object.create(null);
    if (meta.code !== 'de') {
      try {
        const res = await fetch(`/i18n/${meta.code}.json`);
        if (res.ok) dict = Object.assign(Object.create(null), await res.json());
      } catch {}
    }
    locale = meta.locale || meta.code;
    document.documentElement.lang = meta.code;
    document.documentElement.dir = meta.dir || 'ltr';
    // Original (deutsch) einmal merken, damit ein Sprachwechsel zurück möglich ist
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      if (!el.dataset.i18nSrc) el.dataset.i18nSrc = el.dataset.i18n;
      el.textContent = t(el.dataset.i18nSrc);
    });
    const sel = document.getElementById('lang-select');
    sel.innerHTML = languages().map((l) => `<option value="${l.code}" ${l.code === meta.code ? 'selected' : ''}>${l.name.replace(/[<>&"]/g, '')}</option>`).join('');
    sel.setAttribute('aria-label', t('Sprache'));
    fillExample();
  }

  /** Beispiel 20 km: Energiekosten, Anteil Mitfahrer (Empfehlung), Ersparnis Fahrer, ÖPNV-Ticket */
  function fillExample() {
    const p = config && config.pricing;
    if (!p) return;
    const km = 20;
    const energy = Math.round(km * (p.energyCostPerKmCents || 12));
    const driver = Math.round(km * (p.ratePerKmCents || 8));
    const commission = Math.round(km * (p.commissionPerKmCents || 0));
    const donation = Math.round(km * (p.donationPerKmCents || 0));
    const rider = driver + commission + donation;
    const transit = (p.transitFares || []).find((f) => f.maxKm >= km);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('ex-energy', euro(energy));
    set('ex-rider', euro(rider));
    set('ex-driver', euro(driver));
    set('ex-commission', euro(commission));
    set('ex-donation', euro(donation));
    set('ex-transit', transit ? euro(transit.cents) : '–');
    if (p.avgFuelPriceCentsPerLiter) {
      set('ex-basis', t('Gerechnet mit Durchschnittswerten: {price} je Liter, {consumption} l auf 100 km. Für alle gilt derselbe faire Preis.', {
        price: euro(p.avgFuelPriceCentsPerLiter),
        consumption: Number(p.avgConsumptionLitersPer100Km).toLocaleString(locale, { maximumFractionDigits: 1 }),
      }));
    }
    const share = Math.max(5, Math.min(95, Math.round((driver / energy) * 100)));
    const bar = document.querySelector('.share-bar .rider-part');
    if (bar) bar.style.width = `${share}%`;
    const rest = document.querySelector('.share-bar .driver-part');
    if (rest) rest.style.width = `${100 - share}%`;
  }

  document.getElementById('lang-select').addEventListener('change', (e) => {
    try { localStorage.setItem(LANG_STORAGE_KEY, e.target.value); } catch {}
    applyLanguage(e.target.value);
  });

  (async function init() {
    try { config = await (await fetch('/api/config')).json(); } catch {}
    await applyLanguage(preferredLanguage());
    // Bereits angemeldet? Dann direkt in die App.
    try {
      const res = await fetch('/api/me');
      if (res.ok) {
        const login = document.getElementById('cta-login');
        login.dataset.i18nSrc = 'Zur App';
        login.textContent = t('Zur App');
        login.href = '/app';
        document.getElementById('cta-register').hidden = true;
      }
    } catch {}
  })();
})();
