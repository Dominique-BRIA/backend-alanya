#!/usr/bin/env node
/**
 * LE BANC DES PLAGES HORAIRES DU RÉPONDEUR.
 *
 *   node scripts/banc-plages-repondeur.mjs
 *
 * 🔴 CE BANC EXISTE PARCE QU'UNE PLAGE QUI NE S'ACTIVE PAS NE DIT RIEN.
 *
 * 🐛 « 21 h à 6 h » n'a jamais pris un seul appel — signalé par le user le
 * 26/09/2026. La condition était `minutes >= 1260 && minutes < 360` : aucune
 * minute de la journée ne satisfait les deux. La plage s'enregistrait, elle
 * s'affichait dans la liste, et elle restait lettre morte. Une condition qui ne
 * peut pas être vraie ne lève pas d'erreur — elle rend `false`, poliment, pour
 * toujours.
 *
 * ⚠️ IL NE TOUCHE NI BASE NI RÉSEAU. La règle est une fonction pure de l'heure
 * et de la plage ; c'est ce qui la rend vérifiable ici, en une seconde, sans
 * rien monter.
 *
 * ⚠️ ET IL VÉRIFIE AUSSI LES PLAGES ORDINAIRES ET LA JOURNÉE ENTIÈRE. Corriger
 * la nuit sans casser le jour est la moitié du travail — la moitié qu'on oublie.
 */

import { plageCouvreMaintenant } from "../src/lib/repondeur.mjs";

const VraiDate = Date;
const LOIN = new Date("2030-01-01").toISOString();

/*
 * ⚠️ `maintenantDans` LIT L'HEURE AVEC `new Date()`, PAS `Date.now()`. Remplacer
 * le second ne fige donc rien : mon premier banc rendait « false » partout, y
 * compris pour la plage ordinaire qui fonctionnait déjà — le banc mentait, pas
 * la règle. On remplace la CLASSE, le temps de l'appel.
 */
function fige(instant, action) {
  class DateFigee extends VraiDate {
    constructor(...args) {
      super(...(args.length === 0 ? [instant] : args));
    }
    static now() {
      return instant;
    }
  }
  globalThis.Date = DateFigee;
  try {
    return action();
  } finally {
    globalThis.Date = VraiDate;
  }
}

function essai(titre, plage, jour, heure, minute, attendu) {
  /*
   * Le 2026-09-27 est un DIMANCHE, donc `jour` 0 au sens de `getUTCDay()`. On
   * construit une date UTC au jour voulu de cette semaine, à l'heure voulue.
   *
   * ⚠️ FUSEAU « UTC » DANS LA PLAGE, et il le faut : sans cela le résultat
   * dépendrait du fuseau de la machine qui lance le banc, et le banc passerait
   * à Douala pour échouer à Paris.
   */
  const base = VraiDate.UTC(2026, 8, 27 + jour, heure, minute, 0);
  const obtenu = fige(base, () =>
    plageCouvreMaintenant({ ...plage, fuseau: "UTC", expireLe: LOIN }),
  );
  const bon = obtenu === attendu;
  console.log(`${bon ? "  ok " : "  ÉCHEC"} ${titre} → ${obtenu}${bon ? "" : ` (attendu ${attendu})`}`);
  return bon;
}

// Lundi = jour 1. Plage « lundi 21 h → 6 h », soit 1260 → 360.
const nuit = { jour: 1, debutMin: 21 * 60, finMin: 6 * 60 };
let tout = true;
console.log("\nPlage de NUIT — lundi 21 h → mardi 6 h");
tout &= essai("lundi 20 h 59 (avant)        ", nuit, 1, 20, 59, false);
tout &= essai("lundi 21 h 00 (début inclus) ", nuit, 1, 21, 0, true);
tout &= essai("lundi 23 h 59                ", nuit, 1, 23, 59, true);
tout &= essai("mardi 00 h 00 (après minuit) ", nuit, 2, 0, 0, true);
tout &= essai("mardi 05 h 59                ", nuit, 2, 5, 59, true);
tout &= essai("mardi 06 h 00 (fin exclue)   ", nuit, 2, 6, 0, false);
tout &= essai("mardi 21 h 00 (autre nuit)   ", nuit, 2, 21, 0, false);
tout &= essai("mercredi 02 h 00             ", nuit, 3, 2, 0, false);

// Dimanche = 0 : la nuit se termine un lundi. Le modulo doit refermer la semaine.
const dimanche = { jour: 0, debutMin: 22 * 60, finMin: 7 * 60 };
console.log("\nPlage de NUIT — dimanche 22 h → lundi 7 h (bouclage de semaine)");
tout &= essai("dimanche 23 h 00             ", dimanche, 0, 23, 0, true);
tout &= essai("lundi 06 h 30                ", dimanche, 1, 6, 30, true);
tout &= essai("lundi 07 h 00 (fin exclue)   ", dimanche, 1, 7, 0, false);
tout &= essai("samedi 23 h 00               ", dimanche, 6, 23, 0, false);

// La plage ordinaire ne doit pas avoir changé de comportement.
const jour = { jour: 1, debutMin: 10 * 60, finMin: 12 * 60 };
console.log("\nPlage ORDINAIRE — lundi 10 h → 12 h (inchangée)");
tout &= essai("lundi 09 h 59                ", jour, 1, 9, 59, false);
tout &= essai("lundi 10 h 00                ", jour, 1, 10, 0, true);
tout &= essai("lundi 11 h 59                ", jour, 1, 11, 59, true);
tout &= essai("lundi 12 h 00 (fin exclue)   ", jour, 1, 12, 0, false);
tout &= essai("mardi 11 h 00                ", jour, 2, 11, 0, false);

// Journée entière : 0 h → 24 h ne traverse pas minuit.
const entiere = { jour: 3, debutMin: 0, finMin: 1440 };
console.log("\nJournée ENTIÈRE — mercredi 0 h → 24 h");
tout &= essai("mercredi 00 h 00             ", entiere, 3, 0, 0, true);
tout &= essai("mercredi 23 h 59             ", entiere, 3, 23, 59, true);
tout &= essai("jeudi 00 h 00                ", entiere, 4, 0, 0, false);

console.log(tout ? "\n\x1b[32m══ tous les cas passent ══\x1b[0m\n" : "\n\x1b[31m══ des cas échouent ══\x1b[0m\n");
process.exit(tout ? 0 : 1);
