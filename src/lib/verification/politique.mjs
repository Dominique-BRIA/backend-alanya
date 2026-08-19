// Politique des codes de vérification — durées, plafonds, canaux.
//
// ⚠️ AUCUN IMPORT, et c'est délibéré : ce fichier est la seule chose qui décide
// « combien de temps », « combien d'essais », « combien par heure ». Sans
// dépendance, il s'exécute directement (`node src/lib/verification/politique.mjs`)
// et ses règles se vérifient contre des valeurs, au lieu d'être relues.
//
// 🔴 CE QUE CE MODULE PROTÈGE. Le code de vérification garde désormais la
// DOUBLE AUTHENTIFICATION d'une plateforme tierce. Un code prévisible ou un
// nombre d'essais illimité ne sont donc plus des défauts d'ergonomie : ils
// annulent le second facteur pour quiconque a déjà le mot de passe.
//
// Les valeurs ci-dessous suivent les recommandations couramment admises
// (NIST 800-63B et pratique des services de vérification) : expiration courte,
// 3 à 5 essais par code, et une limitation par destination ET par source, parce
// qu'un plafond qui ne porte que sur le code se contourne en en demandant un
// nouveau.

/** Ce à quoi sert un code. Chaque finalité a SA politique. */
export const FINALITE = {
  /** Second facteur de connexion sur la plateforme d'une organisation. */
  AUTH_2FA: "AUTH_2FA",
  /** Validation d'une création de compte agent par un administrateur. */
  CREATION_AGENT: "CREATION_AGENT",
  /** Confirmation d'un numéro ou d'une adresse. */
  VALIDATION_CONTACT: "VALIDATION_CONTACT",
};

/** Qui livre le code. */
export const CANAL = {
  /** Nous le livrons, comme message Alanya. */
  ALANYA: "ALANYA",
  /**
   * L'appelant le livre lui-même (e-mail, SMS, autre).
   *
   * ⚠️ Le code brut est alors rendu UNE FOIS dans la réponse. C'est sûr entre
   * deux serveurs, et seulement là : cette réponse ne doit jamais atteindre un
   * navigateur. La contrepartie est décisive — le comptage des essais,
   * l'expiration et l'usage unique restent centralisés ici, au lieu que chaque
   * intégrateur réinvente son propre système de vérification, plus faible.
   */
  DELEGUE: "DELEGUE",
};

/** État de livraison. Jamais deviné : toujours constaté. */
export const LIVRAISON = {
  /** Créé, pas encore remis. */
  EN_ATTENTE: "EN_ATTENTE",
  /** Remis sur le canal demandé. */
  REMIS: "REMIS",
  /** La remise a échoué — destinataire inconnu, canal indisponible. */
  ECHEC: "ECHEC",
  /** Rendu à l'appelant, qui s'en charge. */
  DELEGUE: "DELEGUE",
};

/**
 * ⚠️ LA LONGUEUR EST UNE VALEUR DE SÉCURITÉ, PAS D'ERGONOMIE.
 *
 * Six chiffres = un million de possibilités. Ce n'est acceptable QUE parce que
 * le nombre d'essais est plafonné : sans plafond, un million de tentatives se
 * parcourt en quelques minutes. Les deux réglages ne se lisent jamais l'un sans
 * l'autre.
 */
export const LONGUEUR_CODE = 6;

const POLITIQUES = {
  [FINALITE.AUTH_2FA]: {
    dureeSecondes: 300, // 5 min : on attend le code, on ne le range pas
    maxTentatives: 3,
    // Plafonds d'ÉMISSION, qui empêchent de contourner `maxTentatives` en
    // redemandant un code neuf à chaque essai.
    maxParDestinationParHeure: 5,
    maxParIpParHeure: 20,
  },
  [FINALITE.CREATION_AGENT]: {
    // Plus long : l'administrateur crée le compte, puis va chercher la personne.
    dureeSecondes: 900, // 15 min
    maxTentatives: 5,
    maxParDestinationParHeure: 3,
    maxParIpParHeure: 20,
  },
  [FINALITE.VALIDATION_CONTACT]: {
    dureeSecondes: 600, // 10 min
    maxTentatives: 5,
    maxParDestinationParHeure: 3,
    maxParIpParHeure: 20,
  },
};

/**
 * La politique d'une finalité.
 *
 * ⚠️ Une finalité INCONNUE est refusée, jamais rabattue sur un défaut
 * permissif : une faute de frappe dans le nom de la finalité donnerait sinon
 * silencieusement la politique la plus laxiste au cas le plus sensible.
 */
export function politiquePour(finalite) {
  return POLITIQUES[finalite] ?? null;
}

/** Cette finalité est-elle connue ? */
export function finaliteValide(finalite) {
  return Object.prototype.hasOwnProperty.call(POLITIQUES, finalite);
}

/** Ce canal est-il connu ? */
export function canalValide(canal) {
  return canal === CANAL.ALANYA || canal === CANAL.DELEGUE;
}

/**
 * Ce code peut-il encore être présenté ?
 *
 * Rend un motif de REFUS, ou `null` si la présentation est recevable. Les
 * quatre motifs sont distincts côté serveur — ils servent aux journaux — mais
 * l'appelant n'en verra qu'un seul, générique : dire « code expiré » plutôt que
 * « code faux » apprend à un attaquant qu'il visait le bon code.
 */
export function motifDeRefus(verification, maintenant) {
  if (!verification) return "INTROUVABLE";
  if (verification.consommeA != null) return "DEJA_UTILISE";
  if (verification.expireA.getTime() <= maintenant.getTime()) return "EXPIRE";
  if (verification.tentatives >= verification.maxTentatives) return "TROP_DESSAIS";
  return null;
}

/**
 * Quand ce code expire-t-il, si on le crée maintenant ?
 */
export function expirationDepuis(finalite, maintenant) {
  const p = politiquePour(finalite);
  if (p === null) return null;
  return new Date(maintenant.getTime() + p.dureeSecondes * 1000);
}

/* --------------------------------------------------------------------------
 * Contrôles exécutables : `node src/lib/verification/politique.mjs`
 * -------------------------------------------------------------------------- */
if (process.argv[1] && process.argv[1].endsWith("politique.mjs")) {
  let echecs = 0;
  const verifie = (intitule, obtenu, attendu) => {
    const ok = JSON.stringify(obtenu) === JSON.stringify(attendu);
    if (!ok) echecs++;
    console.log(
      `${ok ? "ok  " : "ÉCHEC"} ${intitule}` +
        (ok ? "" : `\n      obtenu  : ${JSON.stringify(obtenu)}\n      attendu : ${JSON.stringify(attendu)}`),
    );
  };

  const t0 = new Date("2026-08-18T10:00:00.000Z");
  const base = {
    consommeA: null,
    expireA: new Date("2026-08-18T10:05:00.000Z"),
    tentatives: 0,
    maxTentatives: 3,
  };

  // — Finalités et canaux —
  verifie("finalité connue", finaliteValide("AUTH_2FA"), true);
  verifie("finalité inconnue REFUSÉE, jamais rabattue", politiquePour("AUTH_2FAA"), null);
  verifie("finalité vide refusée", finaliteValide(""), false);
  verifie("canal ALANYA connu", canalValide("ALANYA"), true);
  verifie("canal DELEGUE connu", canalValide("DELEGUE"), true);
  verifie("canal inventé refusé", canalValide("SMS"), false);

  // — La 2FA est la finalité la plus stricte —
  const p2fa = politiquePour("AUTH_2FA");
  verifie("2FA : 3 essais au plus", p2fa.maxTentatives, 3);
  verifie("2FA : 5 minutes", p2fa.dureeSecondes, 300);
  verifie(
    "2FA plus stricte que la création d'agent sur les essais",
    p2fa.maxTentatives < politiquePour("CREATION_AGENT").maxTentatives,
    true,
  );
  verifie(
    "toute finalité plafonne les essais",
    Object.values(FINALITE).every((f) => politiquePour(f).maxTentatives > 0),
    true,
  );
  verifie(
    "toute finalité plafonne l'ÉMISSION — sinon le plafond d'essais se contourne",
    Object.values(FINALITE).every(
      (f) =>
        politiquePour(f).maxParDestinationParHeure > 0 &&
        politiquePour(f).maxParIpParHeure > 0,
    ),
    true,
  );
  verifie(
    "aucune finalité ne dure plus de 15 min",
    Object.values(FINALITE).every((f) => politiquePour(f).dureeSecondes <= 900),
    true,
  );

  // — Recevabilité d'une présentation —
  verifie("code neuf : recevable", motifDeRefus(base, t0), null);
  verifie("code absent", motifDeRefus(null, t0), "INTROUVABLE");
  verifie(
    "code déjà consommé — l'usage unique passe AVANT l'expiration",
    motifDeRefus({ ...base, consommeA: new Date("2026-08-18T10:01:00Z") }, t0),
    "DEJA_UTILISE",
  );
  verifie(
    "expiré à la seconde près",
    motifDeRefus(base, new Date("2026-08-18T10:05:00.000Z")),
    "EXPIRE",
  );
  verifie(
    "une milliseconde avant, encore valide",
    motifDeRefus(base, new Date("2026-08-18T10:04:59.999Z")),
    null,
  );
  verifie(
    "plafond d'essais atteint",
    motifDeRefus({ ...base, tentatives: 3 }, t0),
    "TROP_DESSAIS",
  );
  verifie(
    "dernier essai encore permis",
    motifDeRefus({ ...base, tentatives: 2 }, t0),
    null,
  );

  // — Expiration calculée —
  verifie("2FA expire à +5 min", expirationDepuis("AUTH_2FA", t0), new Date("2026-08-18T10:05:00.000Z"));
  verifie("création d'agent expire à +15 min", expirationDepuis("CREATION_AGENT", t0), new Date("2026-08-18T10:15:00.000Z"));
  verifie("finalité inconnue : pas d'expiration", expirationDepuis("PIZZA", t0), null);

  console.log(echecs === 0 ? "\nTous les contrôles passent." : `\n${echecs} contrôle(s) en échec.`);
  process.exitCode = echecs === 0 ? 0 : 1;
}
