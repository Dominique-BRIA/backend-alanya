/**
 * QUI A LE DROIT AU CHIFFREMENT DE BOUT EN BOUT.
 *
 * 🔴 UNE SEULE RÈGLE, UN SEUL FICHIER. Le périmètre du chiffrement se décide
 * ici et nulle part ailleurs : c'est la leçon des trois oublis du répondeur,
 * où la même règle vivait dans un fichier et manquait dans le suivant.
 *
 * ── CE QUE `users.type_compte` VEUT DIRE ────────────────────────────────
 *
 *   0 → compte NORMAL, une personne ordinaire ;
 *   2 → AGENT : une personne rattachée à une entreprise ;
 *   3 → NUMÉRO DE CENTRE D'APPELS : le standard lui-même ;
 *   4 → CENTRE VOCAL : un standard dont les touches jouent des sons ;
 *   5 → COMPTE OFFICIEL « Alanya Work » (diffusions, bienvenue) — 🔴 JAMAIS
 *       dans la liste blanche : c'est le serveur qui écrit en son nom, et il
 *       ne peut pas écrire dans un fil chiffré (voir `compte-officiel.mjs`) ;
 *   9 → ADMINISTRATEUR de la plateforme (modération).
 *
 * ── LA RÈGLE A CHANGÉ LE 09/10/2026 (décision du user, cours ch. 31 et 33) ──
 *
 * Jusque-là, seul le type 0 chiffrait : on raisonnait qu'un superviseur doit
 * pouvoir relire les échanges de ses agents. Le user a tranché autrement :
 * agents, numéros de centre d'appels et centres vocaux chiffrent aussi, à deux
 * comme en groupe. Conséquence assumée : un superviseur ne relit plus une
 * conversation chiffrée dont il n'est pas membre.
 *
 * ⚠️ TOUJOURS UNE LISTE BLANCHE. Un type nouveau ou inconnu (le 1, qui
 * n'existe nulle part) est refusé sans que personne ait à y penser. Le 9 reste
 * dehors, par décision du user.
 *
 * ⚠️ UN COMPTE AUTORISÉ NE SUFFIT PAS : il faut encore des clés publiées
 * (contrôlé par la route d'activation). Un centre vocal sans appareil
 * connecté n'en a pas — l'activation est alors refusée, rien ne casse.
 *
 * ── LES MESSAGES DE L'API : LE COMPTE D'UNE ENSEIGNE (07/11/2026) ────────
 *
 * Les messages de l'API sont écrits PAR LE SERVEUR, qui ne peut pas écrire
 * dans une conversation chiffrée. Jusqu'au 07/11/2026, ils partaient au nom de
 * la PERSONNE qui avait un compte développeur : on refusait donc de chiffrer
 * tout tête-à-tête avec elle (motif `EMETTEUR_API`), et ouvrir la console
 * suffisait à lui faire perdre le chiffrement avec tout le monde.
 *
 * Depuis, l'API écrit au nom d'une ENSEIGNE, un compte à part de type 6
 * (`TYPE_COMPTE_ENSEIGNE`). Le 6 n'est pas dans la liste blanche : une
 * conversation avec une enseigne n'est jamais chiffrée (`HORS_PERIMETRE`), et
 * le serveur peut toujours y écrire. Le refus `EMETTEUR_API` est retiré : le
 * compte personnel d'un développeur chiffre comme tout le monde.
 */

/**
 * Les types de compte qui ouvrent droit au chiffrement (liste blanche).
 * ⚠️ Le 6 (enseigne) n'y entre JAMAIS : l'API écrit en son nom.
 */
export const TYPES_AUTORISES = [0, 2, 3, 4];

type CompteJuge = { typeCompte?: number | null } | null | undefined;

/** Ce compte peut-il participer à une conversation chiffrée ? */
export function peutChiffrer(user: CompteJuge): boolean {
  return TYPES_AUTORISES.includes(Number(user?.typeCompte ?? -1));
}

export type MotifRefus = "HORS_PERIMETRE";

/**
 * Pourquoi cette conversation ne peut-elle pas être chiffrée ?
 *
 * Rend `null` quand elle le peut. Le motif est fait pour être AFFICHÉ : un
 * bouton grisé sans explication fait ouvrir un ticket, pas comprendre une règle.
 *
 * `participants` : les membres ACTIFS seulement (`MEMBRE_ACTIF`).
 */
export function motifRefus(conv: {
  isGroup: boolean;
  participants: { user: { typeCompte: number } | null }[];
}): MotifRefus | null {
  if (conv.participants.some((p) => !peutChiffrer(p.user))) {
    return "HORS_PERIMETRE";
  }
  return null;
}
