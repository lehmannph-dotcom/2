# 🌿 joinmyride.com – Teilen statt Leerfahren

**joinmyride.com** ist eine Ad-hoc-Mitfahrzentrale: Wer ohnehin fährt, wird mit seiner Route (eingegeben oder als **Google-Maps-Link**) spontan zum Fahrtenanbieter. Mitfahrer geben ihr Ziel ein, die App findet den **besten Fahrer** auf dem Weg. Abgerechnet werden die **gefahrenen Kilometer** – der Großteil geht an den Fahrer, eine Provision an den Betreiber und **1 Cent pro Fahrt an den Umweltschutz**.

## Schnellstart

```bash
cp .env.example .env      # optional: GOOGLE_MAPS_API_KEY, ADMIN_EMAIL, Preise
npm start                 # http://localhost:3000
npm test                  # Unit- und End-to-End-Tests
```

Node.js ≥ 20, **keine npm-Abhängigkeiten**. Das erste registrierte Konto (oder `ADMIN_EMAIL`) ist der Betreiber.
Für den Produktivbetrieb `APP_SECRET` setzen (verschlüsselt die 2FA-Schlüssel; ohne Wert wird `data/secret.key` erzeugt – diese Datei mitsichern!).

## Ablauf

| Rolle | Schritte |
|---|---|
| **Fahrer** | Registrieren → Führerschein einreichen (Nummer, Klassen, Ablaufdatum, Geburtsdatum, Fotos Vorder-/Rückseite) → Betreiber bestätigt → Route oder Google-Maps-Link eingeben → **online** → Anfragen annehmen → „Eingestiegen“ → GPS teilen → „Am Ziel abgesetzt“ |
| **Mitfahrer** | Guthaben aufladen → Abholort + Ziel (Adresse, Standort oder Kartenklick) → Liste der besten Fahrer mit Preis, Wartezeit, Umweg und CO₂-Ersparnis → buchen → Live-Position des Fahrers verfolgen → bewerten |
| **Betreiber** | Führerscheine prüfen (Fotos ansehen, bestätigen/ablehnen), Provisionseinnahmen, gesammelte Spenden, geteilte km und CO₂-Ersparnis einsehen |

## Profile

Fahrer und Mitfahrer haben ein Profil (Seite **Profil**): Foto, „Über mich“, Telefon, Sprachen, Vorlieben (Rauchen, Tiere, Musik, Unterhaltung) und Fahrzeug. Badges zeigen „Führerschein geprüft“, „2FA gesichert“ und die Bewertung. Über den Namen in der Trefferliste bzw. in einer Buchung öffnet sich das Profil des Fahrtpartners. Mit „So sehen mich andere“ prüft man die eigene Außenwirkung.

## Datenschutz (Privacy by Default)

* **Sichtbarkeit:** Profile sind nur für angemeldete Nutzer sichtbar – und nur von Fahrern, die gerade online sind, oder von Fahrtpartnern. Es gibt keine Mitgliedersuche. E-Mail-Adressen sind nie sichtbar.
* **Standardmäßig sparsam:** Nachname abgekürzt („Doris F.“), Telefonnummer verborgen. Freigabe der Telefonnummer nur für bestätigte Fahrtpartner und nur während der Buchung.
* **Wohnadressen-Schutz:** Start und Ziel eines Fahrers sehen andere nur vergröbert (Ort statt Straße, Route ohne die ersten/letzten 500 m). Die Live-Position sehen nur bestätigte Mitfahrer.
* **Führerscheinfotos** werden direkt nach der Prüfung durch den Betreiber gelöscht.
* **Einwilligung** bei der Registrierung (mit Zeitstempel und Version), Datenschutzerklärung unter `#/datenschutz`, Impressum unter `#/impressum` (Vorlagen – bitte ausfüllen und prüfen lassen).
* **Betroffenenrechte zum Selbermachen:** Datenexport als JSON (Art. 15/20 DSGVO), Konto löschen (Art. 17) – persönliche Daten und Fotos werden gelöscht, Abrechnungsbelege bleiben wegen der Aufbewahrungspflicht (§ 147 AO) anonymisiert erhalten.
* Nur ein technisch notwendiges Cookie, kein Tracking. Sicherheits-Header (CSP, `X-Frame-Options: DENY`).

## Zwei-Faktor-Anmeldung (MFA)

* TOTP nach RFC 6238 – funktioniert mit Google Authenticator, Microsoft Authenticator, Authy, 1Password usw. Einrichtung per QR-Code (oder Schlüssel abtippen) unter **Profil → Sicherheit**.
* 10 einmalig nutzbare **Backup-Codes** (gespeichert nur als Hash), neu erzeugbar.
* Login in zwei Schritten: Passwort → kurzlebiges Token (5 Min., max. 5 Versuche) → Code. Ein Code kann nicht zweimal verwendet werden.
* 2FA-Schlüssel liegen AES-256-GCM-verschlüsselt im Datenspeicher.
* Sensible Aktionen (2FA abschalten, Backup-Codes erneuern, Konto löschen) verlangen Passwort **und** Code.
* Bremse gegen Passwort-Ausprobieren (10 Versuche / 15 Min. pro IP und E-Mail), Übersicht der angemeldeten Geräte, „Alle anderen Geräte abmelden“.
* Fahrer und Betreiber werden aktiv aufgefordert, 2FA zu aktivieren.

## Matching – wie der „beste Fahrer“ gefunden wird

Für jede aktive Fahrt (`src/matching.js`):

1. Abholort und Ziel werden auf die Route des Fahrers projiziert – beide müssen höchstens `MAX_DETOUR_KM` (Standard 3 km) entfernt liegen.
2. Der Abholort muss in Fahrtrichtung **vor** dem Ziel liegen, und der Fahrer darf ihn noch nicht passiert haben (Live-GPS).
3. Genug freie Plätze, Führerschein verifiziert und gültig.
4. Bewertung (kleiner = besser): `2 × Umweg-km + 0,5 × Wartezeit-min + 10 × (1 − Streckenabdeckung) + 8 × (100 − geglätteter NPS) / 200`.

## Bestätigung der Fahrt durch Fahrer und Mitfahrer

Grundlage ist die **schnellste Route laut Plan** vom Abholort zum Ziel (Google Directions bzw. OSRM). Sie wird beiden Seiten angezeigt (auf der Karte lila gestrichelt) und muss von beiden bestätigt werden:

| Schritt | Mitfahrer | Fahrer |
|---|---|---|
| **Vor der Fahrt** | sieht geplante Route, km, Dauer und Höchstpreis → „Route bestätigen & anfragen“ | sieht dieselbe Route und seinen Anteil → „Route bestätigen & annehmen“ |
| **Nach der Fahrt** | **bewertet** die Fahrt (NPS 0–10) → „Bewerten & bezahlen“ – oder „Problem melden“ | „Mitfahrer abgesetzt“ (Mitfahrer optional bewerten) – oder „Problem melden“ |

* **Gezahlt wird mit dem Absetzen durch den Fahrer und der Bewertung durch den Mitfahrer** – Reihenfolge egal. Ohne Bewertung keine Zahlung (außer nach Ablauf der Frist, s. u.).
* Beide sehen beim Abschluss: geplante Route · gefahrene km (GPS) · abgerechnete km · Betrag.
* Mit dem **ersten** Schritt endet die km-Messung, mit dem **zweiten** wird abgerechnet.
* Bestätigt nur eine Seite, gilt die Fahrt nach `AUTO_CONFIRM_HOURS` (Standard 24 h) als bestätigt – damit Fahrer nicht unbegrenzt auf ihr Geld warten.
* **Problem melden** stoppt die Abrechnung; der Betreiber entscheidet im Bereich „Betreiber“ (abrechnen nach Regel, mit weniger km oder kostenlos stornieren).
* Hat sich die geplante Route zwischen Anzeige und Buchung geändert (> 0,5 km), muss der Mitfahrer neu bestätigen.

## Bewertung nach NPS-Logik

Statt Sternen fragt joinmyride.com: **„Wie wahrscheinlich ist es, dass du *Name* weiterempfiehlst?“** – Skala 0 bis 10.

| Wert | Kategorie |
|---|---|
| 9–10 | Promotor 😊 |
| 7–8 | Passiver 😐 |
| 0–6 | Kritiker 🙁 |

**NPS = % Promotoren − % Kritiker** (−100 bis +100). Er wird in Profilen, in der Trefferliste und im Konto angezeigt; der Betreiber sieht den NPS aller Fahrer.

* Die Bewertung des Mitfahrers ist **Pflicht für die Zahlung**, ändert aber **nicht den Preis**. Für echte Probleme gibt es „Problem melden“.
* Optionaler Kommentar, Frage passend zur Kategorie („Was hat dir gefallen?“ / „Was ist schiefgelaufen?“).
* Fahrer können Mitfahrer optional bewerten (beim Absetzen oder später im Konto).
* Jeder sieht nur die eigene abgegebene Bewertung; die Bewertungen anderer fließen nur zusammengefasst in den NPS ein.
* Im Matching zählt ein **geglätteter NPS** (3 gedachte passive Bewertungen dazu), damit neue Fahrer bei 0 starten und ein einzelner Kritiker nicht gleich −100 ergibt.

## Gamification: Punkte für geteiltes CO₂

**Punkte je Fahrt = Faktor × eingesparte kg CO₂ der Fahrt.** Der Faktor ist die **NPS-Bewertung (0–10), die man vom jeweils anderen bekommt**:

| Erhaltene Bewertung | Faktor |
|---|---|
| 😊 Promotor 10 / 9 | ×10 / ×9 |
| 😐 Passiv 8 / 7 | ×8 / ×7 |
| 🙁 Kritiker 4–6 | ×1 |
| 🙁 Kritiker 0–3 | ×0 (keine Punkte) |

* Fahrer werden vom Mitfahrer bewertet (Pflicht), Mitfahrer vom Fahrer (optional). Ohne Bewertung zählt vorläufig ×7 (`POINTS_FACTOR_UNRATED`); kommt die Bewertung später, wird neu berechnet.
* Beispiel: 20 km geteilt → 3 kg CO₂ → mit 10 bewertet 30 Punkte, mit 8 → 24, mit 5 → 3, mit 2 → 0.
* **Level:** 🌱 Setzling (0) → 🌿 Sprössling (50) → 🪴 Jungbaum (200) → 🌳 Baum (500) → 🌲 Wald (1.500) → 🌍 Klimaheld (5.000).
* **Abzeichen:** Erste Fahrt, Stammgast (10), Vielteiler (50), Beide Seiten, 10 kg / 100 kg CO₂, Empfehlenswert (5 Promotoren), Promotor-Serie (5 in Folge).
* **Bestenliste** (Monat / gesamt): nur Mitglieder, die zugestimmt haben (Standard: aus), mit Anzeigenamen gemäß Privatsphäre. Den eigenen Platz sieht man immer.
* Punkte erscheinen im Header, auf der Seite **Punkte** (Level, Fortschritt, Abzeichen, Bestenliste, Verlauf), in der Fahrten-Historie, beim Abschluss und im Profil.
* Punkte haben keinen Geldwert. Sie werden aus den Fahrten berechnet und nicht separat gespeichert.

## Gästebuch bei Fahrern

Mitfahrer können nach **Fahrten über 1 Stunde oder über 100 km** **freiwillig und anonym** ein **positives Erlebnis** im Gästebuch des Fahrers teilen.

* **Wann:** abgeschlossene Fahrt, die länger als 60 Minuten gedauert hat (Einsteigen bis Absetzen oder laut geplanter Route) oder mehr als 100 km lang war (geplant oder gefahren), und die der Mitfahrer mit **7–10** bewertet hat. Für schlechte Erfahrungen gibt es „Problem melden“ und die Bewertung.
* **Freiwillig:** Nach dem Bezahlen erscheint ein Angebot, das man überspringen kann. Später geht es über das Konto. Veröffentlicht wird nur mit ausdrücklicher Einwilligung (Häkchen).
* **Anonym:** Öffentlich sind nur Text, Monat und „Fahrt über 1 Stunde / 100 km“, ohne Namen, Datum oder Strecke. Links, E-Mail-Adressen und Telefonnummern werden abgelehnt. Intern wird der Verfasser gespeichert (ein Eintrag pro Fahrt, Löschen durch den Verfasser).
* **Kontrolle:** Verfasser können ihren Eintrag jederzeit löschen. Fahrer können Einträge ausblenden (nicht bearbeiten) oder das Gästebuch in den Privatsphäre-Einstellungen abschalten. Der Betreiber kann Einträge löschen.
* Sichtbar im Fahrerprofil (Popup über den Namen) für alle, die das Profil sehen dürfen. Bei Kontolöschung werden die eigenen Einträge und das eigene Gästebuch gelöscht.

## Abrechnung

```
abgerechnete km = geplante Route – oder die gefahrene Strecke (GPS), sofern diese kürzer ist
Fahrpreis       = abgerechnete km × Kilometersatz (Standard 0,25 €/km) × Personen
Provision       = Fahrpreis × 10 %         → Betreiber
Fahreranteil    = Fahrpreis − Provision    → Fahrer
Spende          = 0,01 € pro Fahrt         → Umweltschutz
Mitfahrer zahlt = Fahrpreis + Spende
```

* **Umwege zahlt der Mitfahrer nie**: Ist die gefahrene Strecke länger als geplant, gilt die geplante Route. Ohne GPS-Daten gilt ebenfalls die geplante Route.
* Der Preis der geplanten Route ist damit der **Höchstbetrag**. Er wird bei der Annahme durch den Fahrer auf dem Guthaben reserviert; abgebucht wird erst nach beiden Bestätigungen.
* Alle Beträge in ganzen Cent; jede Buchung landet im Journal (`ledger`). Mitfahrer-Zahlung = Fahrer + Provision + Spende (durch Tests abgesichert).
* CO₂-Ersparnis: 150 g pro geteiltem Personen-km (eine ersetzte Pkw-Fahrt).

Alle Werte sind über `.env` einstellbar (siehe `.env.example`).

## Google Maps

* Mit `GOOGLE_MAPS_API_KEY` (Geocoding API + Directions API aktivieren) laufen Adresssuche und Routenberechnung über Google.
* Fahrer können einen **Google-Maps-Routenlink** einfügen (`google.com/maps/dir/Start/Ziel`, `?api=1&origin=…&destination=…` oder Kurzlink `maps.app.goo.gl/…`) – Start und Ziel werden daraus gelesen und die Route berechnet.
* Ohne Key: OpenStreetMap (Nominatim + OSRM-Demoserver). Fällt der Routingdienst aus, wird die Luftlinie × 1,3 verwendet.
* Kartenanzeige: Leaflet (lokal in `public/vendor/`, BSD-2-Lizenz) mit OpenStreetMap-Kacheln. QR-Codes: qrcode-generator (MIT).

## Projektstruktur

```
server.js            HTTP-Server
src/app.js           REST-API (Konten, Führerschein, Fahrten, Matching, Buchungen, Abrechnung, Admin)
src/matching.js      Fahrer-Suche und Bewertung
src/pricing.js       Kilometerabrechnung, Provision, Spende, CO₂
src/license.js       Führerschein-Prüfung
src/profile.js       Profile, Anzeigenamen, Privatsphäre-Regeln
src/mfa.js           TOTP, Backup-Codes, Verschlüsselung der 2FA-Schlüssel
src/nps.js           Bewertung nach NPS-Logik
src/gamification.js  Punkte, Level, Abzeichen, Bestenliste
src/guestbook.js     Gästebuch: Berechtigung, Textprüfung, anonyme Anzeige
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
7. **Rechtliches:** Impressum und Datenschutzerklärung (Vorlagen in der App) ausfüllen und prüfen lassen, AGB ergänzen, Auftragsverarbeitungsverträge (Hosting, Zahlungsdienst) abschließen, Verarbeitungsverzeichnis anlegen.
8. **Domain & Betrieb:** joinmyride.com mit HTTPS (z. B. hinter einem Reverse-Proxy mit `X-Forwarded-Proto`), `APP_SECRET` sicher setzen, regelmäßige Backups von `data/`.
