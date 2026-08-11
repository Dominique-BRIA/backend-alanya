import { prisma } from "@/lib/prisma";

/**
 * Un compte s'ouvre sur au plus DEUX appareils : un mobile et un poste.
 *
 * Les valeurs de `Appareil.typeDevice` viennent du référentiel équipe :
 * 0 = web, 1 = Android, 2 = iOS, 3 = bureau. Le « bureau » rejoint la famille
 * des postes, décision du 11/08/2026 : c'est une machine devant laquelle on
 * s'assoit, pas un appareil qu'on a sur soi. Un utilisateur peut donc travailler
 * sur son ordinateur tout en gardant son téléphone joignable, ce qui est le cas
 * d'usage réel — mais pas ouvrir son compte sur deux téléphones.
 */
export const TYPES_MOBILE = [1, 2];
export const TYPES_POSTE = [0, 3];

export type FamilleAppareil = "mobile" | "poste";

export function familleDeAppareil(typeDevice: number | null | undefined): FamilleAppareil {
  return TYPES_MOBILE.includes(Number(typeDevice)) ? "mobile" : "poste";
}

/** Raison inscrite dans `RefreshToken.revokedReason` par l'éviction. */
export const RAISON_EVICTION = "evicted";

/**
 * De quelle famille est l'appareil qui se connecte ?
 *
 * Le client l'annonce, mais le champ est facultatif : un client plus ancien ne
 * l'envoie pas. On retombe alors sur ce que le registre sait déjà de cet
 * appareil — il y figure dès sa deuxième connexion. `null` quand personne ne
 * sait, et l'appelant n'évince alors rien.
 */
export async function typeDeviceDeLAppareil(
  userId: string,
  deviceId: string | undefined,
  annonce: number | undefined,
): Promise<number | null> {
  if (annonce !== undefined) return annonce;
  if (!deviceId) return null;
  const connu = await prisma.appareil.findUnique({
    where: { cookiesWebId_alanyaId: { cookiesWebId: deviceId, alanyaId: userId } },
    select: { typeDevice: true },
  });
  return connu?.typeDevice ?? null;
}

/**
 * Ferme les autres sessions de la MÊME FAMILLE que l'appareil qui se connecte.
 *
 * ⚠️ À APPELER AVANT `issueTokenPair`, jamais après : la révocation touche les
 * jetons du compte, et le couple qu'on est en train d'émettre serait emporté
 * avec les autres.
 *
 * Deux effets, et les deux sont nécessaires :
 *
 *  - `Appareil.destroy = 1` — ce que l'utilisateur VOIT dans « appareils
 *    connectés ». Insuffisant seul : ce champ n'ouvre ni ne ferme l'accès, et
 *    `POST /api/appareils` le remet à 0 à chaque démarrage ;
 *  - les jetons de rafraîchissement sont révoqués — c'est ce qui coupe
 *    RÉELLEMENT l'accès. La coupure n'est pas instantanée : le jeton d'accès est
 *    un JWT sans état, valide jusqu'à 15 minutes. C'est une limite du format, pas
 *    un défaut à corriger ici ; l'événement temps réel sert à accélérer le cas
 *    courant.
 *
 * @returns les identifiants d'appareil évincés, pour que le client qui vient
 *   d'ouvrir la session puisse les annoncer au serveur temps réel. L'API et
 *   `ws-server.mjs` sont deux process sans canal entre eux : c'est le client,
 *   qui tient déjà une connexion authentifiée, qui fait le lien.
 */
export async function fermeLesAutresSessions(
  userId: string,
  deviceId: string | undefined,
  typeDevice: number | null | undefined,
): Promise<string[]> {
  /*
   * Famille inconnue → ON N'ÉVINCE PERSONNE.
   *
   * Le cas se produit à la toute première connexion d'un appareil qui n'a pas
   * encore été enregistré et dont le client n'annonce pas son type. Deviner
   * reviendrait à choisir une famille au hasard et à déconnecter un appareil qui
   * n'avait rien à voir. Une session de trop se corrige à la connexion suivante ;
   * un utilisateur éjecté de son ordinateur parce qu'il a ouvert son téléphone
   * ne se corrige pas.
   */
  if (typeDevice === null || typeDevice === undefined) return [];

  const famille = familleDeAppareil(typeDevice);
  const typesDeLaFamille = famille === "mobile" ? TYPES_MOBILE : TYPES_POSTE;

  const familleEntiere = await prisma.appareil.findMany({
    where: { alanyaId: userId, typeDevice: { in: typesDeLaFamille } },
    select: { appareilId: true, cookiesWebId: true },
  });

  /*
   * L'exclusion de l'appareil courant se fait ICI, en JavaScript, et non dans le
   * `where`.
   *
   * `{ cookiesWebId: { not: deviceId } }` porte sur une colonne NULLABLE, et la
   * comparaison SQL avec NULL ne rend ni vrai ni faux : selon la traduction que
   * Prisma en fait, les appareils sans identifiant seraient inclus ou écartés en
   * silence. Or ce sont précisément les lignes les plus anciennes du registre.
   * Un filtre explicite ne laisse pas la question ouverte, et le coût est nul —
   * un compte compte quelques dizaines d'appareils au plus.
   */
  const autres = familleEntiere.filter((a) => a.cookiesWebId !== deviceId);

  const idsAppareils = autres.map((a) => a.appareilId);
  const idsClients = autres
    .map((a) => a.cookiesWebId)
    .filter((c): c is string => Boolean(c));

  if (idsAppareils.length > 0) {
    await prisma.appareil.updateMany({
      where: { appareilId: { in: idsAppareils } },
      data: { destroy: 1, isOnline: 0 },
    });
  }

  /*
   * Les sessions SANS `device_id` sont révoquées elles aussi.
   *
   * Ce sont celles ouvertes avant que le lien appareil↔session n'existe, ou par
   * un client qui ne l'envoie pas. On ne peut les rattacher à aucune famille :
   * les laisser vivre laisserait une session dont on ne sait rien contourner la
   * règle, et la règle ne serait alors qu'une apparence.
   *
   * Sans risque pour l'appareil courant : son propre couple n'est émis
   * qu'APRÈS cet appel, et il porte son `device_id`.
   */
  await prisma.refreshToken.updateMany({
    where: {
      userId,
      revoked: false,
      OR: [{ deviceId: { in: idsClients } }, { deviceId: null }],
    },
    data: { revoked: true, revokedReason: RAISON_EVICTION },
  });

  return idsClients;
}
