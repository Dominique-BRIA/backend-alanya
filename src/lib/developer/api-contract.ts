/**
 * LE CONTRAT DE L'API — codes d'erreur et règles de statut.
 *
 * 🔴 CE FICHIER EST LA RÉFÉRENCE. Chaque valeur ci-dessous est lue par du code
 * que nous ne compilons pas — la plateforme de l'équipe. En changer une casse
 * leur produit sans que rien ne le signale ici.
 *
 * Pourquoi il existe. Les routes `/api/v1/*` appelaient `fail(message, status)`
 * **sans code** : la seule façon de distinguer deux erreurs était de comparer
 * des phrases en français. Un client qui fait ça se casse à la première
 * reformulation, et il ne peut pas être traduit.
 *
 * 🔴 **IL N'Y A PLUS DE FACTURATION** (décision du user, 21/08/2026). Cette API
 * n'est pas vendue à des développeurs extérieurs : elle sert la plateforme de
 * l'équipe, qui porte son propre mécanisme de paiement de son côté. Nous
 * livrons un moyen de COMMUNIQUER avec les utilisateurs — codes de
 * vérification, messages, et la suite — pas un produit à crédits.
 *
 * Ce qui a donc disparu : `INSUFFICIENT_CREDITS` et le statut **402**. Un appel
 * ne peut plus être refusé faute d'argent, seulement faute de droit (401), de
 * données (400/404) ou de mesure (429).
 *
 * ⚠️ Le **429** reste, et il est désormais SEUL à dire « refusé, réessayez ».
 * C'est ce qui rend sa lecture non ambiguë : attendre puis réessayer est
 * toujours la bonne conduite. Avant, 429 servait aussi au solde insuffisant —
 * un client bien écrit réessayait donc en boucle une requête que seul un
 * paiement pouvait débloquer.
 */

/** Codes rendus dans `{ error: { message, code } }`. */
export const CODE = {
  // — Authentification —
  /** Ni `X-Api-Key` ni `Authorization: Bearer ak_…`. */
  CLE_MANQUANTE: "API_KEY_MISSING",
  /** Clé inconnue, désactivée, ou compte développeur absent. */
  CLE_INVALIDE: "API_KEY_INVALID",

  // — Requête —
  /** Un champ obligatoire manque ou est vide. */
  REQUETE_INVALIDE: "INVALID_REQUEST",
  /** Le numéro visé ne correspond à aucun compte Alanya. */
  DESTINATAIRE_INTROUVABLE: "RECIPIENT_NOT_FOUND",
  /**
   * Le destinataire a bloqué l'expéditeur, ou l'inverse. **HTTP 403.**
   *
   * Distinct de `RECIPIENT_NOT_FOUND` à dessein : l'appelant légitime doit
   * pouvoir cesser de réessayer, et le cas n'a rien d'une erreur passagère.
   * (Il révèle l'existence du compte — mais l'appelant la connaissait déjà,
   * puisqu'il faut un numéro valide pour arriver jusqu'ici.)
   */
  DESTINATAIRE_BLOQUE: "RECIPIENT_BLOCKED",
  /**
   * Un média cité n'existe pas, ou n'appartient pas à l'appelant. **HTTP 403.**
   * Les deux cas répondent pareil : distinguer permettrait de tester
   * l'existence d'un identifiant qui ne vous regarde pas.
   */
  MEDIA_INTERDIT: "MEDIA_FORBIDDEN",
  /** Type de fichier hors liste blanche. **HTTP 415.** */
  MEDIA_TYPE_REFUSE: "MEDIA_TYPE_REJECTED",
  /** Fichier au-delà du plafond de taille. **HTTP 413.** */
  MEDIA_TROP_VOLUMINEUX: "MEDIA_TOO_LARGE",

  // — Débit —
  /**
   * Trop de requêtes. **HTTP 429**, et lui seul. Réservé à la limitation de
   * débit : le client doit attendre puis réessayer.
   */
  TROP_DE_REQUETES: "RATE_LIMITED",

  // — Vérification (codes OTP / double authentification) —
  /**
   * Code refusé. **UN SEUL CODE POUR QUATRE CAS** — faux, expiré, déjà utilisé,
   * trop d'essais — et c'est délibéré : dire « expiré » plutôt que « faux »
   * apprendrait à un attaquant qu'il visait le bon code, et distinguer
   * « inconnu » permettrait d'énumérer les destinations. Le motif précis reste
   * dans nos journaux.
   */
  VERIFICATION_REFUSEE: "VERIFICATION_REJECTED",
  /** Le code n'a pas pu être remis (courriel refusé, destinataire inconnu). */
  VERIFICATION_NON_REMISE: "VERIFICATION_NOT_DELIVERED",

  // — Serveur —
  /**
   * Le stockage de fichiers n'a pas répondu. **HTTP 502**, et non 500 : la
   * requête était bonne, c'est notre dépendance qui a lâché. La distinction dit
   * à l'appelant de réessayer plus tard au lieu de chercher son erreur.
   */
  STOCKAGE_INDISPONIBLE: "STORAGE_UNAVAILABLE",
  /** Défaillance interne. Le client peut réessayer plus tard. */
  ERREUR_INTERNE: "INTERNAL_ERROR",
} as const;

export type CodeErreur = (typeof CODE)[keyof typeof CODE];

/** Statut HTTP de la limitation de débit. */
export const STATUT_TROP_DE_REQUETES = 429;

/*
 * 🔴 `identifiantPublic()` / `identifiantInterne()` ont été SUPPRIMÉES.
 *
 * Elles enrobaient l'identifiant du message d'un préfixe `wamid.` pour imiter
 * WhatsApp Cloud API. Personne n'ayant intégré l'API, cette compatibilité ne
 * servait rien et coûtait deux conversions à tenir accordées : **l'identifiant
 * rendu est maintenant l'identifiant de la ligne `message`, tel quel.**
 *
 * (Le préfixe avait par ailleurs son propre passé : il enrobait autrefois un
 * tirage `horloge + Math.random()` qui ne désignait RIEN, ni la ligne créée
 * dans la foulée ni quoi que ce soit d'autre.)
 */

/**
 * Le vocabulaire de statut rendu par l'API, en français comme le reste de la
 * surface v1. `Message.status` reste en anglais en base — la traduction se fait
 * ICI, à la frontière, et nulle part ailleurs.
 */
export const STATUT_MESSAGE = {
  SENT: "ENVOYE",
  DELIVERED: "REMIS",
  READ: "LU",
  FAILED: "ECHEC",
} as const;

export type StatutMessage = (typeof STATUT_MESSAGE)[keyof typeof STATUT_MESSAGE];

/** Traduit un statut de base vers le vocabulaire de l'API. */
export function statutPublic(statutBase: string): StatutMessage {
  return STATUT_MESSAGE[statutBase as keyof typeof STATUT_MESSAGE] ?? "ENVOYE";
}
