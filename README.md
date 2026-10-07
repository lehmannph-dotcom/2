# joinmyride.com – Teilen statt Leerfahren

**joinmyride.com** ist eine Ad-hoc-Mitfahrzentrale: Wer ohnehin fährt, wird mit seiner Route (eingegeben oder als **Google-Maps-Link**) spontan zum Fahrtenanbieter. Mitfahrer geben ihr Ziel ein, die App findet den **besten Fahrer** auf dem Weg. Abgerechnet werden die **gefahrenen Kilometer** – der Großteil geht an den Fahrer, eine Provision an den Betreiber und **1 Cent pro Fahrt an den Umweltschutz**.

## Schnellstart

```bash
cp .env.example .env      # optional: GOOGLE_MAPS_API_KEY, ADMIN_EMAIL, Preise
npm start                 # http://localhost:3000
npm test                  # Unit- und End-to-End-Tests
```

Node.js ≥ 20, **keine npm-Abhängigkeiten**. Das erste registrierte Konto (oder `ADMIN_EMAIL`) ist der Betreiber.
Für den Produktivbetrieb `APP_SECRET` setzen (verschlüsselt die 2FA-Schlüssel; ohne Wert wird `data/secret.key` erzeugt – diese Datei mitsichern!).

## Oberfläche

* **Farbwelt:** Weiß mit grünen Pastelltönen (Minze, Salbei) – passend zum ökologischen Ansatz. Alle Farben sind als CSS-Variablen in `public/styles.css` definiert; die Bewertungsampel (rot/gelb/grün) bleibt in Pastell erhalten. Kartenkacheln werden dezent entsättigt.
* **Erklärungen im Info-Kontextmenü (ⓘ):** Definitionen und längere Erklärungen (Abrechnung, NPS, Punkte, Datenschutz, 2FA, Gästebuch, Filter …) erscheinen per **Mouseover**, **Tastatur-Fokus** oder **Antippen** (Handy) – die Oberfläche zeigt nur das Wesentliche. Escape schließt. Rechtlich nötige Texte (Einwilligung, Datenschutzerklärung) bleiben sichtbar.
* Im Code: `info(html)` für ein ⓘ-Symbol, `withTip(text, html)` für unterstrichenen Text mit Erklärung, `data-tip="…"` für kurze Hinweise an Symbolen.

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
* **Einwilligung** bei der Registrierung (mit Zeitstempel und Version), Datenschutzerklärung unter `#/datenschutz`, Impressum unter `#/impressum`, Nutzungsbedingungen unter `#/nutzungsbedingungen` (Vorlagen – bitte ausfüllen und prüfen lassen).
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

## Matching – welcher Fahrer oben steht

Für jede aktive Fahrt (`src/matching.js`):

1. Abholort und Ziel werden auf die Route des Fahrers projiziert – beide müssen höchstens `MAX_DETOUR_KM` (Standard 3 km) entfernt liegen.
2. Der Abholort muss in Fahrtrichtung **vor** dem Ziel liegen, und der Fahrer darf ihn noch nicht passiert haben (Live-GPS).
3. Genug freie Plätze, Führerschein verifiziert und gültig, Wünsche des Mitfahrers erfüllt.
4. **Sortierung – ökologisch:** immer zuerst der Fahrer mit dem **kürzesten Umweg**, damit möglichst wenige zusätzliche Kilometer entstehen. Bei gleichem Umweg (±100 m) entscheidet die kürzere Wartezeit, danach Streckenabdeckung und geglätteter NPS.

## Bestätigung der Fahrt durch Fahrer und Mitfahrer

Grundlage ist die **schnellste Route laut Plan** vom Abholort zum Ziel (Google Directions bzw. OSRM). Sie wird beiden Seiten angezeigt (auf der Karte dunkelgrün gestrichelt) und muss von beiden bestätigt werden:

| Schritt | Mitfahrer | Fahrer |
|---|---|---|
| **Vor der Fahrt** | sieht geplante Route, km, Dauer und Höchstpreis → „Route bestätigen & anfragen“ | sieht dieselbe Route und seinen Anteil → „Route bestätigen & annehmen“ |
| **Während der Fahrt** | „Fahrt abbrechen“ (mit Begründung) | „Fahrt abbrechen“ (mit Begründung) |
| **Nach der Fahrt** | **bewertet** die Fahrt (NPS 0–10) → „Bewerten & bezahlen“ – oder „Problem melden“ | „Mitfahrer abgesetzt“ (Mitfahrer optional bewerten) – oder „Problem melden“ |

* **Gezahlt wird mit dem Absetzen durch den Fahrer und der Bewertung durch den Mitfahrer** – Reihenfolge egal. Ohne Bewertung keine Zahlung (außer nach Ablauf der Frist, s. u.).
* Beide sehen beim Abschluss: geplante Route · gefahrene km (GPS) · abgerechnete km · Betrag.
* Mit dem **ersten** Schritt endet die km-Messung, mit dem **zweiten** wird abgerechnet.
* Bestätigt nur eine Seite, gilt die Fahrt nach `AUTO_CONFIRM_HOURS` (Standard 24 h) als bestätigt – damit Fahrer nicht unbegrenzt auf ihr Geld warten.
* **Problem melden** stoppt die Abrechnung; der Betreiber entscheidet im Bereich „Betreiber“ (abrechnen nach Regel, mit weniger km oder kostenlos stornieren).
* Hat sich die geplante Route zwischen Anzeige und Buchung geändert (> 0,5 km), muss der Mitfahrer neu bestätigen.

## Wünsche an den Fahrer (Filter für Mitfahrer)

Im **Profil** unter „Meine Wünsche an Fahrer“ legt der Mitfahrer fest, welche Kriterien der Fahrer erfüllen muss. Die Wünsche werden im Konto gespeichert und gelten automatisch bei jeder Suche (auf allen Geräten):

| Kriterium | Bedeutung |
|---|---|
| Mindest-NPS | ≥ 0 / +30 / +50 / +70; neue Fahrer ohne Bewertung wahlweise einbeziehen |
| Nichtraucher · Tiere erlaubt | aus den Vorlieben im Fahrerprofil |
| Unterhaltung · Musik | „lieber ruhig“ / „gerne gesprächig“, „lieber leise“ |
| Sprache | Fahrer spricht z. B. Englisch |
| 2FA-gesichert | Konto des Fahrers mit Zwei-Faktor-Anmeldung |
| Sichere Fahrweise | höchstens 10 % der Bewertungen nennen „Fahrweise“ als Grund (ab 3 Bewertungen) |
| Max. Wartezeit | Abholung in höchstens 5 / 10 / 15 / 30 min |

Die Suche zeigt dazu nur einen Satz: „X Fahrer werden dir wegen deiner Filter nicht angezeigt.“ – mit Link zu den Wünschen im Profil. Die Vorlieben der Fahrer erscheinen als Symbole ().

## Gründe bei kritischen Bewertungen & Feedback zum Lernen

Bei Bewertungen **0–6** (und optional 7–8) können **freiwillig Gründe** gewählt werden (Mehrfachauswahl) – plus optionaler Freitext:

* **Fahrer bewertet durch Mitfahrer:** Sauberkeit des Autos · Zustand des Autos · Fahrweise · Zwischenmenschliches · Pünktlichkeit · Route/Umwege · Kommunikation/Treffpunkt · Gerüche/Rauchen · Musik/Lautstärke · Platz/Komfort/Temperatur
* **Mitfahrer bewertet durch Fahrer:** Pünktlichkeit · Zwischenmenschliches · Sauberkeit/Verhalten im Auto · Kommunikation/Treffpunkt · Gepäck

Unter **Profil → Feedback zum Lernen** sieht der Bewertete die Gründe **gesammelt** (Häufigkeit, Balken) mit einem **konkreten Tipp** je Aspekt und die Kommentare. Damit niemand einzeln erkennbar ist und es keine Gegenbewertungen gibt:

* Anzeige erst ab **3 Rückmeldungen** mit Hinweisen,
* Kommentare **ohne Datum** und in gemischter Reihenfolge,
* auch der Datenexport enthält die Einzelbewertungen des Partners nicht (nur das gesammelte Feedback).

Die Gründe ändern weder den Preis noch die Zahlung.

## Bewertung nach NPS-Logik

Statt Sternen fragt joinmyride.com: **„Wie wahrscheinlich ist es, dass du *Name* weiterempfiehlst?“** – Skala 0 bis 10.

| Wert | Kategorie |
|---|---|
| 9–10 | Promotor |
| 7–8 | Passiver |
| 0–6 | Kritiker |

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
| Promotor 10 / 9 | ×10 / ×9 |
| Passiv 8 / 7 | ×8 / ×7 |
| Kritiker 4–6 | ×1 |
| Kritiker 0–3 | ×0 (keine Punkte) |

* Fahrer werden vom Mitfahrer bewertet (Pflicht), Mitfahrer vom Fahrer (optional). Ohne Bewertung zählt vorläufig ×7 (`POINTS_FACTOR_UNRATED`); kommt die Bewertung später, wird neu berechnet.
* Beispiel: 20 km geteilt → 3 kg CO₂ → mit 10 bewertet 30 Punkte, mit 8 → 24, mit 5 → 3, mit 2 → 0.
* **Level:** Setzling (0) → Sprössling (50) → Jungbaum (200) → Baum (500) → Wald (1.500) → Klimaheld (5.000).
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

## Funfacts

Eigenes Menü **Funfacts** (auch ohne Anmeldung): Wo und in welchen Autos sitzen die nettesten Fahrer, gemessen am **NPS** aus den Bewertungen der Mitfahrer?

* **Nach Stadt / Kennzeichen:** Ortskürzel aus dem Fahrerprofil (z. B. „HH“ → Hamburg, ~190 Kürzel hinterlegt in `src/plates.js`; unbekannte erscheinen als „Kennzeichen XY“). Gespeichert wird nur das Ortskürzel, nie das ganze Kennzeichen.
* **Nach Automarke:** Auswahlliste im Profil (Audi bis VW).
* Ranglisten mit NPS-Balken, Promotoren/Passive/Kritiker und einer augenzwinkernden Schlagzeile („Die nettesten Fahrer kommen aus …“).
* **Datenschutz:** Eine Stadt oder Marke erscheint erst ab `FUNFACTS_MIN_DRIVERS` (Standard 2) verschiedenen Fahrern und `FUNFACTS_MIN_RATINGS` (Standard 3) Bewertungen, damit sich kein einzelner Fahrer ablesen lässt. Die Funfacts haben keinen Einfluss auf das Matching.

## Fahrtabbruch und Fahrtabbruchsquote

* Während der Fahrt (nach „Eingestiegen“) können Fahrer **und** Mitfahrer die Fahrt **abbrechen** – mit Pflicht-Begründung: Grund (Sicherheitsbedenken, Verhalten des Fahrtpartners, Panne/Fahrzeugproblem, Gesundheit/Notfall, geänderte Pläne, Sonstiges) plus Text (mind. 10 Zeichen).
* Dann wird **nur die bis dahin gefahrene Strecke** (GPS) berechnet, höchstens die geplante Route. Die Anfahrt zum Treffpunkt bleibt fällig. Die Fahrt wird sofort abgerechnet; bewerten lässt sie sich danach im Konto.
* **Fahrtabbruchsquote** = abgebrochene Fahrten / alle abgeschlossenen Fahrten in der jeweiligen Rolle (Fahrer bzw. Mitfahrer). Ein Abbruch zählt für **beide** Beteiligten – sonst könnte man sich absprechen, wer abbricht. Wer selbst abgebrochen hat, steht im Info-Menü.
* Sichtbar in der Trefferliste (Quote des Fahrers), bei Anfragen (Quote des Mitfahrers), im Profil und im eigenen Konto. Farbe: bis 5 % grün, bis 15 % gelb, darüber rot.

## Nutzungsbedingungen und Sperren

* Seite **Nutzungsbedingungen** (`#/nutzungsbedingungen`, Link im Footer; Vorlage – bitte rechtlich prüfen lassen). Bei der Registrierung muss man ihnen zustimmen (Version wird gespeichert).
* **Ziffer 9 – Sperrung bei zu hoher Fahrtabbruchsquote:** Liegt die Quote in einer Rolle über `ABORT_QUOTE_LIMIT` (Standard 20 %) bei mindestens `ABORT_MIN_RIDES` (Standard 5) Fahrten, **kann** der Betreiber sperren – nach Einzelfallprüfung, in der Regel erst Verwarnung mit Gelegenheit zur Stellungnahme, dann befristete Sperre (7–30 Tage), bei Wiederholung oder Missbrauch unbefristet. Weitere Sperrgründe: falsche Angaben, Fahren ohne Fahrerlaubnis, Gefährdung/Belästigung, Manipulation.
* **Betreiber-Bereich → „Fahrtabbruchsquote – Prüfung“:** Liste aller Teilnehmer über dem Grenzwert (je Rolle mit Quote) und der gesperrten Teilnehmer; Aktionen *Verwarnen*, *Sperren* (7 Tage / 30 Tage / unbefristet, mit Begründung) und *Entsperren*. Es wird **nie automatisch** gesperrt.
* **Wirkung einer Sperre:** keine Angebote, keine Suche, keine Buchung; aktive Angebote ohne Mitfahrer an Bord werden beendet, offene Anfragen storniert; laufende Fahrten können abgeschlossen werden. Konto, Guthaben, Datenexport und Löschung bleiben zugänglich. Befristete Sperren enden automatisch. Gesperrte und verwarnte Teilnehmer sehen einen Hinweis über jeder Seite.

## Startseite und App

* **`/`** – Startseite mit der Idee in Kürze: *Du fährst sowieso. Nimm jemanden mit.* Ziel eingeben, nette Gesellschaft mitnehmen, der Umwelt etwas Gutes tun. Der Fahrer stellt Auto und Fahrt, der Mitfahrer trägt rund zwei Drittel der Energiekosten – alle gewinnen: leerere Straßen, besser genutzte Ressourcen, weniger CO₂. Die Beispielrechnung kommt aus der aktuellen Preiskonfiguration.
* **`/app`** – die eigentliche Anwendung mit Anmeldung (`/app#/registrieren` öffnet direkt die Registrierung).

## Preis: Empfehlung statt Grenze

joinmyride.com ist eine Plattform für **private Fahrgemeinschaften**, keine Fahrdienstleistung wie Taxi oder Uber.

* **Empfehlung:** Der Mitfahrer beteiligt sich mit rund **2/3 an Kraftstoff bzw. Strom**. Bei 12 ct Energiekosten je km ergibt das **8 ct/km** (einstellbar).
* **Der Fahrer wählt** beim Online-Gehen seinen Satz mit einem Schieberegler. Die App zeigt dazu den Preis für 10 km, den Vergleich mit einem ÖPNV-Einzelticket und den Anteil an den Energiekosten – und warnt, wenn der Preis über dem Nahverkehr liegt. Es gibt keine Deckelung nach ÖPNV oder Anteil; einzige Obergrenze ist der gesetzliche Rahmen: höchstens die **Betriebskosten je km** (Standard 30 ct, § 1 Abs. 2 Nr. 1 PBefG).
* Mitfahrer sehen bei jedem Angebot den Vergleich mit dem Nahverkehr und, falls der Fahrer abweicht, die Empfehlung.

```
abgerechnete km = geplante Route (fällig mit dem Einsteigen) – bei Fahrtabbruch: gefahrene Strecke (GPS), höchstens die geplante Route
Fahrpreis       = abgerechnete km × Kilometersatz des Fahrers × Personen
Anfahrt         = Umweg zum Treffpunkt (km) × Kilometersatz → zu 100 % Fahrer, KEINE Provision
Provision       = Fahrpreis × 10 % (im Preis enthalten)      → Betreiber, davon 1 Cent Umweltspende
Rabatt          = 6 / 10 / 20 % der Provision bei Vorkasse   → senkt den Preis, nicht den Fahreranteil
Fahreranteil    = Fahrpreis − volle Provision + Anfahrt      → Fahrer
Mitfahrer zahlt = Fahrpreis + Anfahrt − Rabatt
```

* **Anfahrt zum Treffpunkt:** der Weg von der Route des Fahrers zum Abholort (Abstand × Straßenfaktor 1,3), einmal pro Fahrt, als eigene Buchung im Journal, ohne CO₂-Gutschrift.
* **Fällig mit dem Fahrtantritt:** Mit „Eingestiegen“ wird der Preis der geplanten Route fällig – auch wenn die Fahrt früher endet. Umwege zahlt der Mitfahrer nie. Der Preis der geplanten Route ist der **Höchstbetrag**.
* Alle Beträge in ganzen Cent; jede Buchung landet im Journal (`ledger`). Mitfahrer-Zahlung = Fahrer + Betreiber + Spende (durch Tests abgesichert).

## Bezahlen in 4 Stufen

| Stufe | Bezahlung | Rabatt auf die Provision |
|---|---|---|
| 1 | je Fahrt (hinterlegtes Zahlungsmittel) | – |
| 2 | 10 € Vorkasse | 6 % |
| 3 | 20 € Vorkasse | 10 % |
| 4 | 50 € Vorkasse | 20 % |

Vorkasse-Guthaben wird in der Reihenfolge der Einzahlung verbraucht; der Rabatt der ältesten noch nicht verbrauchten Einzahlung gilt. Reicht das Guthaben nicht, wird automatisch je Fahrt bezahlt (falls ein Zahlungsmittel hinterlegt ist). Restguthaben wird bei Kontolöschung ausgezahlt. Zahlungsmittel und Aufladen sind im Prototyp Demo-Funktionen (`ALLOW_DEMO_TOPUP`).

## Rollen für heute, Fahrerprofil, Pop-up vor Fahrtantritt

* **Schiebeschalter oben:** Jeder stellt für die heutige Nutzung ein, ob er **Mitfahrer** und/oder **Fahrer** ist; die Navigation passt sich an. An einem neuen Tag ist man zunächst nur Mitfahrer.
* Der **Fahrer-Schalter ist ausgegraut**, solange im Fahrerprofil etwas fehlt (geprüfte Identität, geprüfter Führerschein, Fahrzeug mit Marke/Modell/Farbe). Ein Klick führt zur Checkliste unter `#/fahrerprofil`.
* **Vor Fahrtantritt** bestätigt der Fahrer Fahrtauglichkeit und Fahrerlaubnis. Mit Häkchen gilt die Bestätigung **einen Monat**; ohne fragt die App vor jeder Fahrt. Der Server lehnt Fahrten ohne Bestätigung ab (HTTP 428).

## Identitätsprüfung

Ablauf anbieterunabhängig (`src/identity.js`): Prüfung starten → Weiterleitung zum Prüfdienst → signierte Ergebnis-Meldung an `POST /api/identity/webhook` (`HMAC-SHA256(caseId|result|timestamp)`, höchstens 10 Minuten alt). Gespeichert werden nur Ergebnis, Verfahren und Datum – keine Ausweiskopie. Für **POSTIDENT** (Deutsche Post), Online-Ausweis (eID), IDnow oder Veriff wird ein Vertrag benötigt und ein kleiner Adapter, der deren Ergebnis in dieses Format übersetzt. `IDENT_PROVIDER=demo` simuliert den Ablauf. Geprüfte Mitglieder tragen das Abzeichen „Identität geprüft“; Mitfahrer können danach filtern.

## Verhaltensregeln

Unter `#/verhaltensregeln` (auch auf der Startseite verlinkt): Regeln für alle, für Fahrer und für Mitfahrer, die auf gegenseitiger Rücksichtnahme beruhen. Sie sind Teil der Nutzungsbedingungen und werden bei der Registrierung akzeptiert; Verstöße können zur Verwarnung oder Sperre führen (Ziffer 9).

## Google Maps

* Mit `GOOGLE_MAPS_API_KEY` (Geocoding API + Directions API aktivieren) laufen Adresssuche und Routenberechnung über Google.
* Fahrer können einen **Google-Maps-Routenlink** einfügen (`google.com/maps/dir/Start/Ziel`, `?api=1&origin=…&destination=…` oder Kurzlink `maps.app.goo.gl/…`) – Start und Ziel werden daraus gelesen und die Route berechnet.
* Ohne Key: OpenStreetMap (Nominatim + OSRM-Demoserver). Fällt der Routingdienst aus, wird die Luftlinie × 1,3 verwendet.
* Kartenanzeige: Leaflet (lokal in `public/vendor/`, BSD-2-Lizenz) mit OpenStreetMap-Kacheln. QR-Codes: qrcode-generator (MIT).

## Mehrsprachigkeit

Die Oberfläche gibt es auf **Deutsch** (Ausgangssprache) und in den **10 meistgesprochenen Sprachen der Welt**: Englisch, Chinesisch (vereinfacht), Hindi, Spanisch, Arabisch (von rechts nach links), Französisch, Bengalisch, Portugiesisch, Russisch und Indonesisch.

- **Auswahl:** im Profil unter „Sprache“ (gilt auf allen Geräten) oder über die Auswahl in der Kopfzeile. Ohne Auswahl richtet sich die Sprache nach dem Browser; bei der Registrierung wird die angezeigte Sprache übernommen.
- **Zahlen, Beträge, Datumsangaben** werden im Format der gewählten Sprache angezeigt (Euro bleibt die Währung).
- **Server-Meldungen** (Fehler, Buchungstexte, Bezeichnungen wie Bewertungsgründe oder Level) übersetzt die Oberfläche; der Server selbst bleibt deutsch.
- **Rechtstexte** sind übersetzt, mit dem Hinweis, dass die deutsche Fassung verbindlich ist. Vor dem Livegang sollten Nutzungsbedingungen und Datenschutzerklärung zusätzlich fachkundig übersetzt bzw. geprüft werden.
- **Neue Texte:** in `public/app.js` immer `t('…')` bzw. `tn(n, 'Singular', 'Plural')` verwenden, dann `npm run i18n:extract` und `npm run i18n:placeholders`. Solange sich die Inhalte noch stark ändern, stehen neue Texte in den anderen Sprachen vorläufig als **Lorem ipsum** (Platzhalter, HTML und Links bleiben erhalten); die Übersetzung folgt, wenn die Texte stabil sind. `npm run i18n:check` (und `npm test`) prüft Vollständigkeit, Platzhalter, HTML und Links jeder Sprache.

## Projektstruktur

```
server.js            HTTP-Server
src/app.js           REST-API (Konten, Führerschein, Fahrten, Matching, Buchungen, Abrechnung, Admin)
src/matching.js      Fahrer-Suche und Bewertung
src/pricing.js       Kilometerabrechnung, Provision, Spende, CO₂
src/license.js       Führerschein-Prüfung
src/identity.js      Identitätsprüfung (Anbieter-Ablauf, signierte Ergebnis-Meldung)
src/profile.js       Profile, Anzeigenamen, Privatsphäre-Regeln
src/mfa.js           TOTP, Backup-Codes, Verschlüsselung der 2FA-Schlüssel
src/nps.js           Bewertung nach NPS-Logik
src/gamification.js  Punkte, Level, Abzeichen, Bestenliste
src/guestbook.js     Gästebuch: Berechtigung, Textprüfung, anonyme Anzeige
src/funfacts.js      Funfacts: NPS nach Stadt/Kennzeichen und Automarke
src/plates.js        Ortskürzel deutscher Kfz-Kennzeichen
src/filters.js       Wünsche/Filter des Mitfahrers an den Fahrer
src/feedback.js      Gründe bei Bewertungen, Tipps, anonymes Lern-Feedback
src/routing.js       Google Maps / OSM, Google-Maps-Link-Parser
src/geo.js           Distanzen, Polylines, Projektion auf Routen
src/db.js            JSON-Dateispeicher (data/db.json)
public/              Frontend (HTML/CSS/JS, kein Build-Schritt): start.html = Startseite, index.html = App
public/i18n/         Übersetzungen der Oberfläche (_source.json = deutsche Ausgangstexte)
scripts/i18n.js      Ausgangstexte einsammeln und Übersetzungen prüfen
test/                node:test – Unit-Tests + kompletter API-Ablauf
```

## Vor dem Livegang – bitte beachten

Dieser Code ist ein funktionsfähiger Prototyp. Für den echten Betrieb fehlen bewusst Dinge, die Verträge, Lizenzen oder Rechtsberatung erfordern:

1. **Zahlungen:** Das Guthaben-Aufladen ist eine Demo. Für echtes Geld einen Zahlungsdienstleister mit Marktplatz-Funktion nutzen (z. B. Stripe Connect, Mangopay, Adyen for Platforms) – sie übernehmen die Auszahlung an Fahrer, KYC und die Trennung der Gelder. Ein Plattformbetreiber, der fremdes Geld selbst verwahrt und weiterleitet, braucht sonst ggf. eine Erlaubnis nach dem ZAG.
2. **Personenbeförderungsgesetz:** Genehmigungsfrei ist nur die Mitnahme, bei der das Entgelt die **Betriebskosten der Fahrt nicht übersteigt** (§ 1 Abs. 2 Nr. 1 PBefG). Den Kilometersatz deshalb nicht über die tatsächlichen Kosten setzen (die Provision ist im Preis enthalten, nicht obendrauf). Rechtlich prüfen lassen, insbesondere zur Provision.
3. **Führerscheinprüfung:** Aktuell manuelle Sichtprüfung durch den Betreiber. Für Skalierung einen Identdienst anbinden (z. B. IDnow, Veriff, Onfido) und Führerscheine regelmäßig erneut prüfen. Führerscheinfotos sind personenbezogene Daten → DSGVO (Verarbeitungsverzeichnis, Löschfristen, Verschlüsselung).
4. **Versicherung:** Klären, wie Mitfahrer abgesichert sind (Kfz-Haftpflicht des Fahrers deckt Insassen grundsätzlich ab, bei gewerblicher Nutzung aber nicht zwingend).
5. **Spende:** Empfängerorganisation festlegen und die gesammelten Beträge (Admin-Übersicht) regelmäßig überweisen; transparent ausweisen.
6. **Technik:** JSON-Datei durch eine Datenbank (z. B. PostgreSQL/PostGIS) ersetzen, Push-Benachrichtigungen statt Polling, Google-Maps-Nutzungsbedingungen beachten (Google-Daten auf Google-Karten anzeigen oder Maps JavaScript API verwenden).
7. **Rechtliches:** Impressum und Datenschutzerklärung (Vorlagen in der App) ausfüllen und prüfen lassen, AGB ergänzen, Auftragsverarbeitungsverträge (Hosting, Zahlungsdienst) abschließen, Verarbeitungsverzeichnis anlegen.
8. **Domain & Betrieb:** joinmyride.com mit HTTPS (z. B. hinter einem Reverse-Proxy mit `X-Forwarded-Proto`), `APP_SECRET` sicher setzen, regelmäßige Backups von `data/`.
9. **Konfiguration für den Livebetrieb:** `ALLOW_DEMO_TOPUP=0` (schaltet das Demo-Aufladen ab) und – nur hinter einem eigenen Reverse-Proxy – `TRUST_PROXY=1`, damit `X-Forwarded-For`/`X-Forwarded-Proto` ausgewertet werden. Ohne Proxy bleibt `TRUST_PROXY` aus, sonst könnten Clients ihre IP für das Rate-Limiting fälschen.

## Sicherheit und Performance (Code-Review)

- Sitzungstoken werden nur als SHA-256-Hash gespeichert; Logins prüfen auch bei unbekannter E-Mail einen Passwort-Hash (kein Timing-Hinweis auf existierende Konten).
- Rate-Limiting für Login, MFA, Identitätsbestätigung sowie Geocoding/Routing pro Nutzer.
- Datenbank-Objekte ohne Prototyp (Schutz vor Prototype Pollution über IDs wie `__proto__`), fehlerhafte URLs führen zu 400 statt Absturz, interne Fehler werden ohne Details gemeldet.
- Statische Dateien mit `Last-Modified`/304, Cache für `/vendor/`, HSTS bei HTTPS, `nosniff` auch für API-Antworten.
- Abgeleitete Kennzahlen (Bewertungen, Abbruchquoten, Punkte, Funfacts, Fahrten je Nutzer) werden einmal pro Datenänderung berechnet statt bei jeder Anfrage; Speichern ist gebündelt.
- Hinweis: Durch das Hashen der Sitzungen müssen sich bestehende Nutzer nach dem Update einmal neu anmelden.
