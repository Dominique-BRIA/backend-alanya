/**
 * LE CONTRAT DE L'API DÉVELOPPEUR — codes d'erreur et règles de statut.
 *
 * 🔴 CE FICHIER EST LA RÉFÉRENCE, et il est gelé : le tableau de bord est
 * construit par une équipe extérieure, sur un autre backend. Chaque valeur
 * ci-dessous est lue par du code que nous ne compilons pas et ne pouvons pas
 * corriger. En changer une casse leur produit sans que rien ne le signale ici.
 *
 * Pourquoi il existe. Les routes `/api/v1/*` appelaient `fail(message, status)`
 * **sans code** : la seule façon de distinguer deux erreurs était de comparer
 * des phrases en français. Un client qui fait ça se casse à la première
 * reformulation, et il ne peut pas être traduit.
 *
 * ⚠️ RÈGLE DE STATUT LA PLUS IMPORTANTE — 402 ≠ 429.
 *
 * Les deux veulent dire « votre requête n'est pas passée », mais la conduite à
 * tenir est opposée : sur 402 il faut RECHARGER, sur 429 il faut RALENTIR et
 * réessayer. Le code 429 servait jusqu'ici au solde insuffisant ; comme la
 * limitation de débit devra elle aussi répondre 429, un client n'aurait plus
 * jamais pu les distinguer — et il aurait réessayé en boucle une requête que
 * seul un paiement peut débloquer.
 *
 * La séparation est faite MAINTENANT, avant que la console soit écrite, parce
 * qu'après elle coûterait une reprise des deux côtés.
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

  // — Facturation —
  /**
   * Solde insuffisant. **HTTP 402**, jamais 429 : réessayer n'y changera rien.
   */
  SOLDE_INSUFFISANT: "INSUFFICIENT_CREDITS",

  // — Débit —
  /**
   * Trop de requêtes. **HTTP 429**, et lui seul. Réservé à la limitation de
   * débit : le client doit attendre puis réessayer.
   */
  TROP_DE_REQUETES: "RATE_LIMITED",

  // — Serveur —
  /** Défaillance interne. Le client peut réessayer plus tard. */
  ERREUR_INTERNE: "INTERNAL_ERROR",
} as const;

export type CodeErreur = (typeof CODE)[keyof typeof CODE];

/**
 * Statut HTTP d'un refus pour solde insuffisant.
 *
 * Constante plutôt que littéral : elle est citée par trois routes, et c'est
 * précisément le genre de valeur qu'on corrige à un endroit sur trois.
 */
export const STATUT_SOLDE_INSUFFISANT = 402;

/** Statut HTTP de la limitation de débit. */
export const STATUT_TROP_DE_REQUETES = 429;

/**
 * Fabrique l'identifiant public d'un message, au format de WhatsApp Cloud API.
 *
 * 🔴 IL CONTIENT DÉSORMAIS L'IDENTIFIANT RÉEL DU MESSAGE. Il était fabriqué à
 * partir de l'horloge et de `Math.random()`, donc il ne désignait RIEN : ni la
 * ligne `message` créée dans la foulée, ni quoi que ce soit d'autre. Il partait
 * pourtant dans la réponse au développeur, dans le registre de facturation
 * (`referenceId`) et dans le webhook — trois pistes d'audit qui ne menaient
 * nulle part, et un écran « détail d'un message » impossible à construire.
 *
 * Le préfixe `wamid.` est conservé : c'est lui qui rend la réponse
 * interchangeable avec celle de WhatsApp pour un client existant.
 */
export function identifiantPublic(messageId: string): string {
  return `wamid.${messageId}`;
}

/** L'inverse : retrouve l'identifiant de la ligne `message`. */
export function identifiantInterne(identifiantPublic: string): string | null {
  if (!identifiantPublic.startsWith("wamid.")) return null;
  const brut = identifiantPublic.slice("wamid.".length);
  return brut.length > 0 ? brut : null;
}
