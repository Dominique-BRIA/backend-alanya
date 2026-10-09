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
 * ── LE REFUS PROVISOIRE : LES COMPTES QUI ENVOIENT PAR L'API ─────────────
 *
 * Les codes OTP, la double authentification et les envois groupés sont écrits
 * PAR LE SERVEUR, au nom d'un compte qui détient un compte développeur. Le
 * serveur ne peut pas écrire dans une conversation chiffrée : si l'on
 * chiffrait un tête-à-tête avec un tel compte, ses codes n'arriveraient plus.
 * Mesuré le 08/10/2026 : 4 comptes personnels et 1 agent envoient par l'API.
 *
 * On refuse donc de chiffrer un TÊTE-À-TÊTE dont un participant a un compte
 * développeur (`EMETTEUR_API`). À RETIRER quand le compte système « Alanya »
 * enverra ces messages (décision du 08/10/2026). Les groupes ne sont pas
 * concernés : l'API n'écrit que dans des conversations à deux.
 */

/** Les types de compte qui ouvrent droit au chiffrement (liste blanche). */
export const TYPES_AUTORISES = [0, 2, 3, 4];

type CompteJuge = { typeCompte?: number | null } | null | undefined;

/** Ce compte peut-il participer à une conversation chiffrée ? */
export function peutChiffrer(user: CompteJuge): boolean {
  return TYPES_AUTORISES.includes(Number(user?.typeCompte ?? -1));
}

export type MotifRefus = "HORS_PERIMETRE" | "EMETTEUR_API";

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
  participants: {
    user: { typeCompte: number; developerAccount?: { id: string } | null } | null;
  }[];
}): MotifRefus | null {
  if (conv.participants.some((p) => !peutChiffrer(p.user))) {
    return "HORS_PERIMETRE";
  }
  if (!conv.isGroup && conv.participants.some((p) => p.user?.developerAccount)) {
    return "EMETTEUR_API";
  }
  return null;
}
