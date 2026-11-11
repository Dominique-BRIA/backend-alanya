/**
 * BANC DES RÈGLES du chiffrement des groupes v2 (11/11/2026) — sans base.
 *
 *   node scripts/e2ee-v2-regles-banc.ts
 *
 * Vérifie ce qui décide de QUI reçoit QUELLE clé : les versions dues selon le
 * réglage d'historique, le calcul de ce qui manque, et les refus de dépôt.
 * Conception : docs/2026-11-11-e2ee-groupes-v2-conception.md.
 */
import { calculerManquants, motifRefusDepot, versionsCompletes, versionsDues } from "../src/lib/e2ee-v2-regles.ts";

let echecs = 0;
function verifier(nom: string, obtenu: unknown, attendu: unknown) {
  const a = JSON.stringify(obtenu);
  const b = JSON.stringify(attendu);
  if (a === b) console.log(`  ✓ ${nom}`);
  else {
    echecs++;
    console.log(`  ✗ ${nom}\n      obtenu  ${a}\n      attendu ${b}`);
  }
}

const j = (jour: number) => new Date(Date.UTC(2026, 10, jour));
// Un groupe à trois versions : 1 le 1er, 2 le 5, 3 le 10 (tirée pour l'arrivée de Chloé).
const versions = versionsCompletes(3, [
  { version: 1, creeLe: j(1) },
  { version: 2, creeLe: j(5) },
  { version: 3, creeLe: j(10) },
]);

console.log("Versions dues");
verifier("historique visible : toutes", versionsDues(versions, null), [1, 2, 3]);
verifier("historique caché, arrivée le 10 : seulement la 3", versionsDues(versions, j(10)), [3]);
verifier("historique caché, arrivée le 6 : 3 seulement", versionsDues(versions, j(6)), [3]);
verifier(
  "version sans date connue : datée de 1970, donc cachée à un arrivant",
  versionsDues(versionsCompletes(2, [{ version: 2, creeLe: j(5) }]), j(3)),
  [2],
);

console.log("Manquants");
const r = calculerManquants(
  versions,
  [
    { userId: "ana", historiqueDepuis: null },
    { userId: "bob", historiqueDepuis: null },
    { userId: "chloe", historiqueDepuis: j(10) },
    { userId: "dan", historiqueDepuis: null },
  ],
  [
    { userId: "ana", version: 1, publique: "A" },
    { userId: "bob", version: 2, publique: "B" },
    { userId: "chloe", version: 1, publique: "C" },
  ],
  [
    { userId: "ana", version: 1, versionCompte: 1 },
    { userId: "ana", version: 2, versionCompte: 1 },
    { userId: "ana", version: 3, versionCompte: 1 },
    // Bob a changé de clé de compte : ses anciens emballages (compte 1) ne comptent plus.
    { userId: "bob", version: 1, versionCompte: 1 },
    { userId: "bob", version: 2, versionCompte: 1 },
  ],
);
verifier(
  "Ana a tout ; Bob (nouvelle clé) doit tout recevoir ; Chloé seulement la 3",
  r.manquants,
  [
    { userId: "bob", versionCompte: 2, publique: "B", versions: [1, 2, 3] },
    { userId: "chloe", versionCompte: 1, publique: "C", versions: [3] },
  ],
);
verifier("Dan n'a pas encore de clé de compte", r.sansCle, ["dan"]);

console.log("Refus de dépôt");
const base = {
  deposant: "ana",
  destinataire: "chloe",
  version: 3,
  versionCompte: 1,
  cleVersionGroupe: 3,
  membre: { historiqueDepuis: j(10) },
  versionCompteDestinataire: 1,
  detenues: new Set([1, 2, 3]),
  versions,
};
verifier("dépôt valide", motifRefusDepot(base), null);
verifier("non membre", motifRefusDepot({ ...base, membre: null }), "PAS_MEMBRE");
verifier("clé de compte périmée", motifRefusDepot({ ...base, versionCompte: 2 }), "VERSION_COMPTE");
verifier("version qui n'existe pas", motifRefusDepot({ ...base, version: 4 }), "VERSION_INCONNUE");
verifier(
  "version que le déposant n'a pas",
  motifRefusDepot({ ...base, detenues: new Set([1, 2]) }),
  "VERSION_NON_DETENUE",
);
verifier(
  "pour soi-même, sans la détenir encore : permis",
  motifRefusDepot({ ...base, destinataire: "ana", membre: { historiqueDepuis: null }, detenues: new Set() }),
  null,
);
verifier("passé d'un arrivant à historique caché", motifRefusDepot({ ...base, version: 2 }), "HISTORIQUE_CACHE");

console.log(echecs === 0 ? "\nTout est vert." : `\n${echecs} échec(s).`);
process.exit(echecs === 0 ? 0 : 1);
