/**
 * CATALOGUE DES REQUÊTES DE RÉFÉRENCE — le jeu d'épreuves de la migration.
 *
 * Chaque entrée est rejouée à l'identique contre Next (:3000) et Nest (:3002),
 * puis les deux réponses sont comparées (voir index.mjs).
 *
 * Champs d'une entrée :
 *   nom       Libellé affiché dans le rapport.
 *   methode   GET | POST | PATCH | PUT | DELETE
 *   chemin    Chemin sous /api. Peut contenir des jetons {{...}} résolus
 *             dynamiquement depuis la base (voir `resoudre` plus bas).
 *   auth      true  → en-tête Bearer d'un jeton frais du compte de test.
 *             false → aucune authentification (cas 401 attendu).
 *   jeton     "invalide" pour forcer un jeton illisible.
 *   corps     Objet JSON envoyé (POST/PATCH/PUT).
 *   mode      "strict" (défaut pour GET) : les corps doivent être IDENTIQUES.
 *             "forme"  (défaut pour les mutations) : mêmes statut, mêmes clés
 *                      et mêmes types, valeurs ignorées — voir ci-dessous.
 *
 * ⚠️ POURQUOI DEUX MODES DE COMPARAISON
 *
 * Les deux serveurs tapent la MÊME base locale. Pour une lecture, la réponse
 * doit donc être identique à l'octet : toute différence est un vrai défaut.
 *
 * Une mutation, elle, ne peut pas être comparée en valeurs : la rejouer crée
 * une deuxième ligne, avec un autre identifiant et une autre date. Comparer
 * strictement signalerait un écart à chaque fois, sans rien révéler. On compare
 * donc la FORME (statut, arborescence des clés, types), ce qui attrape ce qui
 * compte réellement ici : un 201 devenu 200, une clé disparue, une date
 * sérialisée en objet au lieu d'une chaîne ISO, un BigInt non converti.
 * Les effets de bord en base, eux, relèvent des tests fonctionnels (§7.3 du
 * plan), pas de ce harnais.
 */

/**
 * PRÉFIXES DÉJÀ MIGRÉS vers Nest.
 *
 * ⚠️ À METTRE À JOUR à chaque ticket de bascule. Une requête hors de ces
 * préfixes n'est pas comparée mais marquée « en attente » : Nest répondrait 404
 * puisque la route n'y existe pas encore, et un échec ici serait un faux
 * négatif qui noierait les vrais.
 */
export const PREFIXES_MIGRES = [
  // Exemple, au ticket T4 : "/api/pays",
];

/**
 * Jetons dynamiques remplacés dans les chemins avant l'envoi.
 *
 * Les identifiants sont lus dans la base locale plutôt qu'écrits en dur : un
 * identifiant codé en dur pourrit le harnais dès que la copie de production
 * est rafraîchie.
 */
export async function resoudre(prisma) {
  // Compte de test : celui qui a le PLUS de conversations. Un compte vide
  // renverrait des listes vides partout, et une liste vide est identique des
  // deux côtés même quand la sérialisation est cassée.
  // ⚠️ Nomenclature du référentiel équipe, vérifiée en base le 16/08/2026 :
  // conv_participants."alanyaID" et ."conversID" — et NON userID/convID.
  const [utilisateur] = await prisma.$queryRawUnsafe(`
    SELECT u."alanyaID" AS id
    FROM users u
    JOIN conv_participants p ON p."alanyaID" = u."alanyaID"
    GROUP BY u."alanyaID"
    ORDER BY count(*) DESC
    LIMIT 1
  `);

  const [conversation] = await prisma.$queryRawUnsafe(`
    SELECT c."conversID" AS id
    FROM conversation c
    JOIN conv_participants p ON p."conversID" = c."conversID"
    WHERE p."alanyaID" = '${utilisateur.id}'
    LIMIT 1
  `);

  return {
    userId: utilisateur.id,
    convId: conversation?.id ?? null,
  };
}

/**
 * Le catalogue.
 *
 * Il grossit à chaque ticket : on ajoute les requêtes du palier AVANT de le
 * basculer, pour disposer de la référence Next d'origine.
 */
export const REQUETES = [
  // ── Cas d'erreur : indépendants de toute route métier, ils valident le
  //    socle contractuel lui-même et doivent rester en tête du catalogue.
  {
    nom: "401 — jeton absent",
    methode: "GET",
    chemin: "/api/me",
    auth: false,
  },
  {
    nom: "401 — jeton illisible",
    methode: "GET",
    chemin: "/api/me",
    jeton: "invalide",
  },
  {
    nom: "422 — validation Zod (corps invalide)",
    methode: "POST",
    chemin: "/api/auth/login",
    auth: false,
    corps: { identifiant: 123 },
    // Strict : l'erreur de validation est déterministe, aucune donnée créée.
    mode: "strict",
  },

  // ── Palier 0 (ticket T4) : lecture seule, aucun effet de bord.
  // `pays` est AUTHENTIFIÉ (withAuth), contrairement à ce que son caractère
  // « liste statique » laissait supposer — constaté par le harnais le
  // 16/08/2026. Ne pas repasser auth à false.
  { nom: "GET /api/pays", methode: "GET", chemin: "/api/pays", auth: true },
  { nom: "GET /api/translate/providers", methode: "GET", chemin: "/api/translate/providers", auth: true },
  { nom: "GET /api/calls/ice", methode: "GET", chemin: "/api/calls/ice", auth: true },
  { nom: "GET /api/queue/agent-status", methode: "GET", chemin: "/api/queue/agent-status", auth: true },

  // ── Palier 1 (ticket T5) : lecture seule authentifiée.
  { nom: "GET /api/me", methode: "GET", chemin: "/api/me", auth: true },
  { nom: "GET /api/user-access", methode: "GET", chemin: "/api/user-access", auth: true },
  { nom: "GET /api/blocked", methode: "GET", chemin: "/api/blocked", auth: true },
  { nom: "GET /api/starred", methode: "GET", chemin: "/api/starred", auth: true },
  { nom: "GET /api/appareils", methode: "GET", chemin: "/api/appareils", auth: true },
  { nom: "GET /api/contacts", methode: "GET", chemin: "/api/contacts", auth: true },

  // ── Routes riches : c'est là que la sérialisation se casse (dates, BigInt,
  //    champs nuls). À comparer tôt, même si leur bascule vient plus tard.
  { nom: "GET /api/conversations", methode: "GET", chemin: "/api/conversations", auth: true },
  { nom: "GET /api/calls", methode: "GET", chemin: "/api/calls", auth: true },
  /*
   * ⚠️ `since` EXPLICITE, et non par défaut.
   *
   * Sans ce paramètre, la route calcule `Date.now() - 24 h` au moment de la
   * requête ET renvoie cette date dans sa réponse : deux appels séparés de
   * quelques millisecondes produisent deux corps différents. Comparé tel quel,
   * il échouerait à chaque exécution — y compris en comparant Next à lui-même,
   * ce qui est exactement ainsi qu'on l'a découvert le 16/08/2026.
   *
   * Règle générale : toute route qui incorpore une valeur du moment de l'appel
   * doit recevoir une entrée FIGÉE, sinon elle n'est pas comparable.
   */
  {
    nom: "GET /api/calls/missed?since=…",
    methode: "GET",
    chemin: "/api/calls/missed?since=2026-01-01T00:00:00.000Z",
    auth: true,
  },
  { nom: "GET /api/statuses", methode: "GET", chemin: "/api/statuses", auth: true },
  { nom: "GET /api/meetings", methode: "GET", chemin: "/api/meetings", auth: true },
  {
    nom: "GET /api/conversations/{{convId}}/messages",
    methode: "GET",
    chemin: "/api/conversations/{{convId}}/messages",
    auth: true,
    // Ignorée automatiquement si le compte de test n'a aucune conversation.
    requiert: "convId",
  },
];
