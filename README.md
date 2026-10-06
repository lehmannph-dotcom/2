# 🌿 Mitfahrzentrale – Teilen statt Leerfahren

Ad-hoc-Mitfahrzentrale: Wer ohnehin fährt, wird mit seiner Route (eingegeben oder als **Google-Maps-Link**) spontan zum Fahrtenanbieter. Mitfahrer geben ihr Ziel ein, die App findet den **besten Fahrer** auf dem Weg. Abgerechnet werden die **gefahrenen Kilometer** – der Großteil geht an den Fahrer, eine Provision an den Betreiber und **1 Cent pro Fahrt an den Umweltschutz**.

## Schnellstart

```bash
cp .env.example .env      # optional: GOOGLE_MAPS_API_KEY, ADMIN_EMAIL, Preise
npm start                 # http://localhost:3000
npm test                  # Unit- und End-to-End-Tests
```

Node.js ≥ 20, **keine npm-Abhängigkeiten**. Das erste registrierte Konto (oder `ADMIN_EMAIL`) ist der Betreiber.

## Ablauf

| Rolle | Schritte |
|---|---|
| **Fahrer** | Registrieren → Führerschein einreichen (Nummer, Klassen, Ablaufdatum, Geburtsdatum, Fotos Vorder-/Rückseite) → Betreiber bestätigt → Route oder Google-Maps-Link eingeben → **online** → Anfragen annehmen → „Eingestiegen“ → GPS teilen → „Am Ziel abgesetzt“ |
| **Mitfahrer** | Guthaben aufladen → Abholort + Ziel (Adresse, Standort oder Kartenklick) → Liste der besten Fahrer mit Preis, Wartezeit, Umweg und CO₂-Ersparnis → buchen → Live-Position des Fahrers verfolgen → bewerten |
| **Betreiber** | Führerscheine prüfen (Fotos ansehen, bestätigen/ablehnen), Provisionseinnahmen, gesammelte Spenden, geteilte km und CO₂-Ersparnis einsehen |

## Matching – wie der „beste Fahrer“ gefunden wird

Für jede aktive Fahrt (`src/matching.js`):

1. Abholort und Ziel werden auf die Route des Fahrers projiziert – beide müssen höchstens `MAX_DETOUR_KM` (Standard 3 km) entfernt liegen.
2. Der Abholort muss in Fahrtrichtung **vor** dem Ziel liegen, und der Fahrer darf ihn noch nicht passiert haben (Live-GPS).
3. Genug freie Plätze, Führerschein verifiziert und gültig.
4. Bewertung (kleiner = besser): `2 × Umweg-km + 0,5 × Wartezeit-min + 10 × (1 − Streckenabdeckung) + 2 × (5 − Sterne)`.

## Abrechnung

```
Fahrpreis    = gefahrene km × Kilometersatz (Standard 0,25 €/km) × Personen
Provision    = Fahrpreis × 10 %         → Betreiber
Fahreranteil = Fahrpreis − Provision    → Fahrer
Spende       = 0,01 € pro Fahrt         → Umweltschutz
Mitfahrer zahlt = Fahrpreis + Spende
```

* Gefahrene km werden aus dem **GPS-Standort des Fahrers** zwischen „Eingestiegen“ und „Abgesetzt“ gemessen. Ohne GPS gilt die geplante Strecke. Zum Schutz der Mitfahrer wird höchstens die geplante Strecke + 25 % berechnet (`MAX_BILLED_KM_FACTOR`).
* Bei Annahme wird der Höchstbetrag auf dem Guthaben des Mitfahrers reserviert, bei Abschluss der tatsächliche Betrag gebucht.
* Alle Beträge in ganzen Cent; jede Buchung landet im Journal (`ledger`). Mitfahrer-Zahlung = Fahrer + Provision + Spende (durch Tests abgesichert).
* CO₂-Ersparnis: 150 g pro geteiltem Personen-km (eine ersetzte Pkw-Fahrt).

Alle Werte sind über `.env` einstellbar (siehe `.env.example`).

## Google Maps

* Mit `GOOGLE_MAPS_API_KEY` (Geocoding API + Directions API aktivieren) laufen Adresssuche und Routenberechnung über Google.
* Fahrer können einen **Google-Maps-Routenlink** einfügen (`google.com/maps/dir/Start/Ziel`, `?api=1&origin=…&destination=…` oder Kurzlink `maps.app.goo.gl/…`) – Start und Ziel werden daraus gelesen und die Route berechnet.
* Ohne Key: OpenStreetMap (Nominatim + OSRM-Demoserver). Fällt der Routingdienst aus, wird die Luftlinie × 1,3 verwendet.
* Kartenanzeige: Leaflet (lokal in `public/vendor/`, BSD-2-Lizenz) mit OpenStreetMap-Kacheln.

## Projektstruktur

```
server.js            HTTP-Server
src/app.js           REST-API (Konten, Führerschein, Fahrten, Matching, Buchungen, Abrechnung, Admin)
src/matching.js      Fahrer-Suche und Bewertung
src/pricing.js       Kilometerabrechnung, Provision, Spende, CO₂
src/license.js       Führerschein-Prüfung
src/routing.js       Google Maps / OSM, Google-Maps-Link-Parser
src/geo.js           Distanzen, Polylines, Projektion auf Routen
src/db.js            JSON-Dateispeicher (data/db.json)
public/              Frontend (HTML/CSS/JS, kein Build-Schritt)
test/                node:test – Unit-Tests + kompletter API-Ablauf
```

## Vor dem Livegang – bitte beachten

Dieser Code ist ein funktionsfähiger Prototyp. Für den echten Betrieb fehlen bewusst Dinge, die Verträge, Lizenzen oder Rechtsberatung erfordern:

1. **Zahlungen:** Das Guthaben-Aufladen ist eine Demo. Für echtes Geld einen Zahlungsdienstleister mit Marktplatz-Funktion nutzen (z. B. Stripe Connect, Mangopay, Adyen for Platforms) – sie übernehmen die Auszahlung an Fahrer, KYC und die Trennung der Gelder. Ein Plattformbetreiber, der fremdes Geld selbst verwahrt und weiterleitet, braucht sonst ggf. eine Erlaubnis nach dem ZAG.
2. **Personenbeförderungsgesetz:** Genehmigungsfrei ist nur die Mitnahme, bei der das Entgelt die **Betriebskosten der Fahrt nicht übersteigt** (§ 1 Abs. 2 Nr. 1 PBefG). Den Kilometersatz deshalb nicht über die tatsächlichen Kosten setzen (die Provision ist im Preis enthalten, nicht obendrauf). Rechtlich prüfen lassen, insbesondere zur Provision.
3. **Führerscheinprüfung:** Aktuell manuelle Sichtprüfung durch den Betreiber. Für Skalierung einen Identdienst anbinden (z. B. IDnow, Veriff, Onfido) und Führerscheine regelmäßig erneut prüfen. Führerscheinfotos sind personenbezogene Daten → DSGVO (Verarbeitungsverzeichnis, Löschfristen, Verschlüsselung).
4. **Versicherung:** Klären, wie Mitfahrer abgesichert sind (Kfz-Haftpflicht des Fahrers deckt Insassen grundsätzlich ab, bei gewerblicher Nutzung aber nicht zwingend).
5. **Spende:** Empfängerorganisation festlegen und die gesammelten Beträge (Admin-Übersicht) regelmäßig überweisen; transparent ausweisen.
6. **Technik:** JSON-Datei durch eine Datenbank (z. B. PostgreSQL/PostGIS) ersetzen, HTTPS erzwingen, Rate-Limiting für Login, Push-Benachrichtigungen statt Polling, Google-Maps-Nutzungsbedingungen beachten (Google-Daten auf Google-Karten anzeigen oder Maps JavaScript API verwenden).
7. **Rechtliches:** Impressum, AGB, Datenschutzerklärung.
