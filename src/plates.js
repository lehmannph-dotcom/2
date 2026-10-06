'use strict';

/**
 * Unterscheidungszeichen deutscher Kfz-Kennzeichen (Auswahl: Großstädte und große Kreise).
 * Gespeichert wird nur das Ortskürzel – nie das vollständige Kennzeichen.
 */
const REGIONS = {
  A: 'Augsburg', AA: 'Aalen', AC: 'Aachen', AK: 'Altenkirchen', AM: 'Amberg', AN: 'Ansbach', AÖ: 'Altötting', AW: 'Ahrweiler', AZ: 'Alzey-Worms',
  B: 'Berlin', BA: 'Bamberg', BB: 'Böblingen', BC: 'Biberach', BGL: 'Berchtesgadener Land', BI: 'Bielefeld', BK: 'Börde', BM: 'Rhein-Erft-Kreis',
  BN: 'Bonn', BO: 'Bochum', BOR: 'Borken', BOT: 'Bottrop', BS: 'Braunschweig', BT: 'Bayreuth', BZ: 'Bautzen',
  C: 'Chemnitz', CB: 'Cottbus', CE: 'Celle', CLP: 'Cloppenburg', CO: 'Coburg', CUX: 'Cuxhaven', CW: 'Calw',
  D: 'Düsseldorf', DA: 'Darmstadt', DAH: 'Dachau', DD: 'Dresden', DE: 'Dessau-Roßlau', DEG: 'Deggendorf', DH: 'Diepholz', DN: 'Düren', DO: 'Dortmund', DU: 'Duisburg',
  E: 'Essen', EBE: 'Ebersberg', ED: 'Erding', EF: 'Erfurt', EM: 'Emmendingen', EN: 'Ennepe-Ruhr-Kreis', ER: 'Erlangen', ERH: 'Erlangen-Höchstadt', ES: 'Esslingen', EU: 'Euskirchen',
  F: 'Frankfurt am Main', FB: 'Wetteraukreis', FD: 'Fulda', FF: 'Frankfurt (Oder)', FFB: 'Fürstenfeldbruck', FL: 'Flensburg', FN: 'Bodenseekreis', FR: 'Freiburg', FS: 'Freising', FÜ: 'Fürth',
  G: 'Gera', GE: 'Gelsenkirchen', GI: 'Gießen', GL: 'Rheinisch-Bergischer Kreis', GM: 'Oberbergischer Kreis', GÖ: 'Göttingen', GP: 'Göppingen', GT: 'Gütersloh',
  H: 'Hannover', HA: 'Hagen', HAM: 'Hamm', HB: 'Bremen', HD: 'Heidelberg', HDH: 'Heidenheim', HF: 'Herford', HG: 'Hochtaunuskreis', HGW: 'Greifswald', HH: 'Hamburg',
  HI: 'Hildesheim', HL: 'Lübeck', HM: 'Hameln-Pyrmont', HN: 'Heilbronn', HO: 'Hof', HRO: 'Rostock', HS: 'Heinsberg', HSK: 'Hochsauerlandkreis', HX: 'Höxter',
  IN: 'Ingolstadt', J: 'Jena', K: 'Köln', KA: 'Karlsruhe', KE: 'Kempten', KI: 'Kiel', KL: 'Kaiserslautern', KLE: 'Kleve', KN: 'Konstanz', KO: 'Koblenz', KR: 'Krefeld', KS: 'Kassel',
  L: 'Leipzig', LA: 'Landshut', LB: 'Ludwigsburg', LD: 'Landau', LER: 'Leer', LG: 'Lüneburg', LI: 'Lindau', LIP: 'Lippe', LL: 'Landsberg am Lech', LM: 'Limburg-Weilburg', LU: 'Ludwigshafen',
  M: 'München', MA: 'Mannheim', MD: 'Magdeburg', ME: 'Mettmann', MG: 'Mönchengladbach', MH: 'Mülheim an der Ruhr', MI: 'Minden-Lübbecke', MK: 'Märkischer Kreis', MKK: 'Main-Kinzig-Kreis',
  MR: 'Marburg-Biedenkopf', MS: 'Münster', MTK: 'Main-Taunus-Kreis', MYK: 'Mayen-Koblenz', MZ: 'Mainz',
  N: 'Nürnberg', NE: 'Rhein-Kreis Neuss', NM: 'Neumarkt', NMS: 'Neumünster', NR: 'Neuwied', NU: 'Neu-Ulm',
  OA: 'Oberallgäu', OB: 'Oberhausen', OD: 'Stormarn', OF: 'Offenbach', OG: 'Ortenaukreis', OH: 'Ostholstein', OL: 'Oldenburg', OS: 'Osnabrück',
  P: 'Potsdam', PA: 'Passau', PB: 'Paderborn', PF: 'Pforzheim', PI: 'Pinneberg', PM: 'Potsdam-Mittelmark',
  R: 'Regensburg', RA: 'Rastatt', RD: 'Rendsburg-Eckernförde', RE: 'Recklinghausen', RO: 'Rosenheim', RS: 'Remscheid', RT: 'Reutlingen', RV: 'Ravensburg', RW: 'Rottweil',
  S: 'Stuttgart', SB: 'Saarbrücken', SE: 'Segeberg', SG: 'Solingen', SHA: 'Schwäbisch Hall', SI: 'Siegen-Wittgenstein', SN: 'Schwerin', SO: 'Soest', SP: 'Speyer', ST: 'Steinfurt', STA: 'Starnberg', SU: 'Rhein-Sieg-Kreis', SW: 'Schweinfurt',
  TR: 'Trier', TS: 'Traunstein', TÜ: 'Tübingen', UL: 'Ulm', UN: 'Unna', V: 'Vogtlandkreis', VS: 'Schwarzwald-Baar-Kreis',
  W: 'Wuppertal', WAF: 'Warendorf', WES: 'Wesel', WI: 'Wiesbaden', WN: 'Rems-Murr-Kreis', WOB: 'Wolfsburg', WÜ: 'Würzburg', WW: 'Westerwaldkreis',
  Z: 'Zwickau', ZW: 'Zweibrücken',
};

/** Normalisiert die Eingabe („hh“, „HH-AB 123“ → „HH“). Gibt null bei ungültigem Format zurück. */
function normalizeRegion(input) {
  const code = String(input || '').trim().toUpperCase().split(/[\s-]/)[0];
  if (!code) return '';
  return /^[A-ZÄÖÜ]{1,3}$/.test(code) ? code : null;
}

const regionName = (code) => (code ? REGIONS[code] || `Kennzeichen ${code}` : null);

module.exports = { REGIONS, normalizeRegion, regionName };
