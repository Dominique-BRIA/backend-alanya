/**
 * L'ENVOI DE FICHIERS EN MORCEAUX — les règles de calcul (10/10/2026).
 *
 * Demande du user : envoyer plus vite, et que l'envoi continue application
 * fermée. Décision du 10/10 : les morceaux passent PAR LE VPS.
 *
 * Le fichier est coupé en morceaux de taille fixe (le dernier est plus court).
 * Chaque morceau est une requête indépendante, numérotée : plusieurs partent
 * en même temps, un morceau coupé se renvoie SEUL, et l'ordre d'arrivée ne
 * compte pas — chaque morceau s'écrit à sa place dans le fichier.
 *
 * 🔴 1 Mio PAR DÉFAUT, ET C'EST LE CŒUR DU CHOIX « PAR LE VPS ». Une coupure
 * réseau ne coûte qu'un morceau : au pire 1 Mio à renvoyer, quelques secondes
 * même en 3G. Directement chez R2, le minimum aurait été 5 Mio.
 *
 * ⚠️ SANS AUCUN IMPORT, pour pouvoir l'exécuter : `node src/lib/envoi-morceaux.mjs`
 * lance les contrôles en bas du fichier. Le client mobile refait les mêmes
 * calculs : toute évolution se fait ICI d'abord.
 */

/** Taille d'un morceau quand le `.env` n'en dit rien : 1 Mio. */
export const TAILLE_MORCEAU_DEFAUT = 1024 * 1024;

/**
 * Bornes de la taille réglable (`ENVOI_TAILLE_MORCEAU_KO`). En dessous de
 * 256 Kio, le coût fixe d'une requête l'emporte ; au-dessus de 8 Mio, une
 * coupure redevient chère.
 */
export const TAILLE_MORCEAU_MIN = 256 * 1024;
export const TAILLE_MORCEAU_MAX = 8 * 1024 * 1024;

/**
 * Un envoi sans aucun morceau pendant 7 jours est effacé, disque compris.
 *
 * ⚠️ PAS 24 HEURES : un téléphone éteint une nuit, ou un week-end sans
 * réseau, ne doit pas perdre son envoi. C'est aussi le délai au bout duquel
 * R2 abandonne de lui-même un envoi inachevé.
 */
export const INACTIVITE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Un assemblage resté « en cours » plus longtemps que ça a été interrompu
 * (serveur redémarré au milieu) : on a le droit de le reprendre.
 */
export const ASSEMBLAGE_BLOQUE_MS = 10 * 60 * 1000;

/** Envois en cours simultanés par compte : une borne contre l'abus du disque. */
export const ENVOIS_EN_COURS_MAX = 20;

/** La taille d'un morceau lue dans le `.env`, ramenée dans ses bornes. */
export function tailleMorceauConfiguree(brutKo) {
  const ko = Number(brutKo);
  if (!Number.isFinite(ko) || ko <= 0) return TAILLE_MORCEAU_DEFAUT;
  const octets = Math.floor(ko) * 1024;
  return Math.min(TAILLE_MORCEAU_MAX, Math.max(TAILLE_MORCEAU_MIN, octets));
}

/** Combien de morceaux pour un fichier de `taille` octets. */
export function nombreDeMorceaux(taille, tailleMorceau) {
  return Math.ceil(taille / tailleMorceau);
}

/** Position du premier octet du morceau `indice` dans le fichier. */
export function debutDuMorceau(indice, tailleMorceau) {
  return indice * tailleMorceau;
}

/**
 * Taille EXACTE attendue pour le morceau `indice`, ou `null` s'il n'existe pas.
 *
 * Exacte, et pas « au plus » : un morceau plus court est un morceau coupé en
 * route, qu'il ne faut surtout pas marquer comme reçu.
 */
export function tailleDuMorceau(indice, taille, tailleMorceau) {
  const nb = nombreDeMorceaux(taille, tailleMorceau);
  if (!Number.isInteger(indice) || indice < 0 || indice >= nb) return null;
  if (indice < nb - 1) return tailleMorceau;
  return taille - (nb - 1) * tailleMorceau;
}

/**
 * Lit le numéro de morceau dans l'adresse. Des chiffres seulement : « 1e3 »,
 * « 0x10 » ou « 2.0 » passeraient `Number()` et désigneraient un autre morceau
 * que celui que le client croit envoyer.
 */
export function lireIndice(brut) {
  if (typeof brut !== "string" || !/^\d{1,7}$/.test(brut)) return null;
  return Number(brut);
}

/** Les morceaux qui manquent encore, dans l'ordre. */
export function morceauxManquants(recus, nbMorceaux) {
  const deja = new Set(recus);
  const manquants = [];
  for (let i = 0; i < nbMorceaux; i++) if (!deja.has(i)) manquants.push(i);
  return manquants;
}

/** Une empreinte SHA-256 en hexadécimal (minuscules), ou `null`. */
export function lireEmpreinte(brut) {
  if (brut === undefined || brut === null || brut === "") return undefined;
  if (typeof brut !== "string") return null;
  const e = brut.toLowerCase();
  return /^[0-9a-f]{64}$/.test(e) ? e : null;
}

/** L'envoi est-il abandonné depuis trop longtemps ? */
export function estExpire(majLe, maintenant = Date.now()) {
  const t = majLe instanceof Date ? majLe.getTime() : new Date(majLe).getTime();
  if (!Number.isFinite(t)) return false;
  return maintenant - t > INACTIVITE_MAX_MS;
}

// -----------------------------------------------------------------------------
// Contrôles : `node src/lib/envoi-morceaux.mjs`
// -----------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("envoi-morceaux.mjs")) {
  let echecs = 0;
  const verifie = (nom, obtenu, attendu) => {
    const bon = JSON.stringify(obtenu) === JSON.stringify(attendu);
    if (!bon) echecs++;
    console.log(`${bon ? "✓" : "✗"} ${nom}${bon ? "" : ` — obtenu ${JSON.stringify(obtenu)}, attendu ${JSON.stringify(attendu)}`}`);
  };
  const Mo = 1024 * 1024;

  verifie("défaut sans réglage", tailleMorceauConfiguree(undefined), Mo);
  verifie("réglage 2048 Ko", tailleMorceauConfiguree("2048"), 2 * Mo);
  verifie("réglage trop petit → 256 Kio", tailleMorceauConfiguree("10"), 256 * 1024);
  verifie("réglage trop grand → 8 Mio", tailleMorceauConfiguree("999999"), 8 * Mo);
  verifie("réglage illisible → défaut", tailleMorceauConfiguree("abc"), Mo);

  verifie("1 octet = 1 morceau", nombreDeMorceaux(1, Mo), 1);
  verifie("1 Mio pile = 1 morceau", nombreDeMorceaux(Mo, Mo), 1);
  verifie("1 Mio + 1 = 2 morceaux", nombreDeMorceaux(Mo + 1, Mo), 2);
  verifie("250 Mo = 250 morceaux", nombreDeMorceaux(250 * Mo, Mo), 250);

  // Même règle que la contrainte SQL `envoi_morceaux_decoupage`.
  const sql = (t, m) => Math.floor((t + m - 1) / m);
  verifie("accord avec la contrainte SQL (cas limites)",
    [1, Mo - 1, Mo, Mo + 1, 7 * Mo + 123].every((t) => sql(t, Mo) === nombreDeMorceaux(t, Mo)), true);

  verifie("morceau 0 d'un fichier de 2,5 Mio", tailleDuMorceau(0, 2.5 * Mo, Mo), Mo);
  verifie("dernier morceau d'un fichier de 2,5 Mio", tailleDuMorceau(2, 2.5 * Mo, Mo), 0.5 * Mo);
  verifie("dernier morceau d'un fichier de 2 Mio pile", tailleDuMorceau(1, 2 * Mo, Mo), Mo);
  verifie("morceau au-delà de la fin", tailleDuMorceau(3, 2.5 * Mo, Mo), null);
  verifie("morceau négatif", tailleDuMorceau(-1, 2.5 * Mo, Mo), null);
  verifie("somme des morceaux = taille",
    [0, 1, 2].reduce((s, i) => s + tailleDuMorceau(i, 2.5 * Mo, Mo), 0), 2.5 * Mo);
  verifie("début du morceau 3", debutDuMorceau(3, Mo), 3 * Mo);

  verifie("indice « 12 »", lireIndice("12"), 12);
  verifie("indice « 1e3 » refusé", lireIndice("1e3"), null);
  verifie("indice « 0x10 » refusé", lireIndice("0x10"), null);
  verifie("indice « -1 » refusé", lireIndice("-1"), null);
  verifie("indice vide refusé", lireIndice(""), null);

  verifie("manquants", morceauxManquants([0, 2, 2, 4], 6), [1, 3, 5]);
  verifie("rien ne manque", morceauxManquants([1, 0], 2), []);

  verifie("empreinte absente", lireEmpreinte(undefined), undefined);
  verifie("empreinte en majuscules acceptée", lireEmpreinte("A".repeat(64)), "a".repeat(64));
  verifie("empreinte trop courte refusée", lireEmpreinte("ab"), null);

  const t0 = Date.parse("2026-10-10T10:00:00Z");
  const jour = 24 * 60 * 60 * 1000;
  verifie("6 jours : pas expiré", estExpire(new Date(t0), t0 + 6 * jour), false);
  verifie("8 jours : expiré", estExpire(new Date(t0), t0 + 8 * jour), true);
  verifie("date illisible : pas expiré", estExpire("n'importe quoi", t0), false);

  console.log(echecs === 0 ? "\nTous les contrôles passent." : `\n${echecs} ÉCHEC(S).`);
  process.exit(echecs === 0 ? 0 : 1);
}
