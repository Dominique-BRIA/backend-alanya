import { prisma } from "@/lib/prisma";
import {
  PLATEFORMES_MOBILE,
  RAISON_REVOCATION,
  TYPES_MOBILE,
} from "@/lib/sessions";

/**
 * Un compte, un téléphone.
 *
 * Demande du user, 28/09/2026 : se connecter sur un téléphone B ne déconnecte
 * plus le téléphone A — c'est B qui est REFUSÉ, tant que l'utilisateur n'a pas
 * appuyé sur « Dissocier ce téléphone » depuis A. Une déconnexion ordinaire ne
 * dissocie rien : A peut se reconnecter, B toujours pas.
 *
 * Le téléphone lié est `users."device_ID"` ; `users.dissocier` redit
 * `device_ID IS NULL`, et la base interdit qu'ils divergent (contrainte
 * `users_dissocier_coherent`). Les deux s'écrivent donc TOUJOURS ensemble.
 *
 * Le web n'est pas concerné : ses sessions suivent `appareil_total`.
 */

/** Préfixe de l'identifiant que l'application mobile tire au sort. */
const PREFIXE_TELEPHONE = "mob-";

/** Texte montré au téléphone refusé — formulation demandée par le user. */
export const MESSAGE_TELEPHONE_DEJA_ASSOCIE =
  "Ce compte est déjà associé à un autre téléphone. Veuillez d'abord dissocier votre compte de votre téléphone actuel.";

/**
 * Cette session vient-elle d'un téléphone ?
 *
 * ⚠️ LE PRÉFIXE FAIT FOI AUTANT QUE LE TYPE ANNONCÉ. `typeDevice` est
 * facultatif (les clients anciens ne l'envoient pas) et le registre des
 * appareils est incomplet : le 28/09/2026, 23 sessions mobiles vivantes n'y
 * avaient aucune ligne. L'identifiant, lui, est toujours là, et seul le mobile
 * le fait commencer par `mob-` — le web tire un UUID.
 */
export function estUnTelephone(
  deviceId: string | null | undefined,
  typeDevice?: number | null,
): boolean {
  if (typeDevice != null && TYPES_MOBILE.includes(Number(typeDevice))) return true;
  return Boolean(deviceId?.startsWith(PREFIXE_TELEPHONE));
}

/**
 * Lie le compte à ce téléphone s'il est libre ; dit s'il l'est, ou s'il l'était
 * déjà à ce même téléphone.
 *
 * Appelée à la connexion, à l'inscription ET à chaque rafraîchissement d'un
 * téléphone — d'où la lecture d'abord : le cas courant (déjà lié à lui) ne doit
 * rien écrire toutes les quinze minutes.
 *
 * 🔴 LA LIAISON EST UNE ÉCRITURE CONDITIONNELLE (`WHERE device_ID IS NULL`), ET
 * NON « LIRE LIBRE PUIS ÉCRIRE ». Deux téléphones qui se connectent au même
 * instant liraient tous deux « libre » ; avec une écriture simple, le second
 * écraserait le premier, qui resterait connecté sans être lié. Ici PostgreSQL
 * verrouille la ligne : le second réévalue la condition après le premier, la
 * trouve fausse, et n'écrit rien.
 *
 * @returns `false` = le compte est lié à un AUTRE téléphone : refuser.
 */
export async function lieOuVerifie(userId: string, deviceId: string): Promise<boolean> {
  const lie = await telephoneLie(userId);
  if (lie === deviceId) return true;
  if (lie !== null) return false;

  const { count } = await prisma.user.updateMany({
    where: { id: userId, deviceId: null },
    data: { deviceId, dissocier: false },
  });
  if (count === 1) return true;

  /*
   * Course perdue : quelqu'un a lié le compte entre la lecture et l'écriture.
   * Ce peut être CE MÊME téléphone — deux requêtes parties ensemble, un double
   * appui sur « Se connecter ». On relit plutôt que de le refuser.
   */
  return (await telephoneLie(userId)) === deviceId;
}

async function telephoneLie(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { deviceId: true },
  });
  return u?.deviceId ?? null;
}

/**
 * « Dissocier ce téléphone » : le compte redevient libre, et le téléphone qui
 * était lié perd tout accès.
 *
 * Appelée depuis le téléphone lui-même (Paramètres, ou sa propre ligne dans
 * « Appareils connectés »), ou depuis une autre session du compte — le web
 * peut dissocier le téléphone, décision du user du 28/09/2026. C'est aussi, en
 * attendant mieux, la seule issue pour un téléphone perdu ou réinstallé.
 *
 * Quatre effets, et chacun manque si on l'oublie :
 *
 *  - le compte est libéré (`device_ID` vide, `dissocier` vrai, ensemble) ;
 *  - les sessions de TOUS les téléphones du compte sont révoquées, pas
 *    seulement celle du téléphone lié : une session d'avant la règle, sur un
 *    autre téléphone, adopterait sinon le compte libre à son prochain
 *    rafraîchissement ;
 *  - leurs notifications sont coupées — un téléphone dissocié qui sonne encore
 *    donne l'impression que rien n'a marché ;
 *  - leurs lignes du registre passent en « déconnecté », et les conversations
 *    qu'ils réservaient sont rendues.
 *
 * ⚠️ RAISON `revoked`, NON `evicted` : le téléphone doit afficher « session
 * fermée », pas « compte ouvert sur un autre appareil » — personne ne l'a
 * ouvert ailleurs.
 *
 * ⚠️ L'IDENTITÉ DE CHIFFREMENT N'EST PAS RETIRÉE ICI. Elle est rangée sous le
 * numéro d'appareil Signal, que rien côté serveur ne relie à l'identifiant du
 * téléphone. Quand le téléphone se dissocie lui-même, l'application la retire
 * juste après cet appel (`DELETE /api/e2ee/cles`) — la déconnexion ordinaire,
 * elle, ne la retire PAS. Si la dissociation vient d'ailleurs, le balayage des
 * identités inactives s'en charge.
 *
 * Sans effet sur un compte déjà libre, hormis la coupure des sessions
 * téléphone : répéter le geste ne peut pas nuire.
 *
 * @returns les identifiants des téléphones coupés, pour que le client les
 *   annonce au serveur temps réel — l'API et `ws-server.mjs` n'ont pas de canal
 *   entre eux, comme pour la déconnexion à distance.
 */
export async function dissocie(userId: string): Promise<{ telephones: string[] }> {
  return prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { deviceId: null, dissocier: true },
    });

    const sessions = await tx.refreshToken.findMany({
      where: {
        userId,
        revoked: false,
        deviceId: { startsWith: PREFIXE_TELEPHONE },
      },
      select: { deviceId: true },
    });
    const telephones = [...new Set(sessions.map((s) => s.deviceId!))];

    await tx.refreshToken.updateMany({
      where: { userId, revoked: false, deviceId: { in: telephones } },
      data: { revoked: true, revokedReason: RAISON_REVOCATION },
    });

    /*
     * Tous les appareils téléphone du registre, pas seulement ceux qui avaient
     * une session : le téléphone lié peut n'en avoir aucune au moment du geste
     * (déconnecté normalement), et sa ligne doit quand même dire qu'il n'est
     * plus lié. Même critère que `estUnTelephone`.
     */
    const lignes = await tx.appareil.findMany({
      where: {
        alanyaId: userId,
        OR: [
          { typeDevice: { in: TYPES_MOBILE } },
          { cookiesWebId: { startsWith: PREFIXE_TELEPHONE } },
        ],
      },
      select: { appareilId: true, cookiesWebId: true },
    });
    const idsLignes = lignes.map((l) => l.appareilId);
    await tx.appareil.updateMany({
      where: { appareilId: { in: idsLignes } },
      data: { destroy: 1, isOnline: 0 },
    });
    await tx.conversationLock.deleteMany({
      where: { userId, appareilId: { in: idsLignes } },
    });

    const aCouper = [
      ...new Set([
        ...telephones,
        ...lignes.map((l) => l.cookiesWebId).filter((c): c is string => Boolean(c)),
      ]),
    ];
    await tx.pushDevice.deleteMany({
      where: {
        userId,
        OR: [
          { deviceId: { in: aCouper } },
          /*
           * Les jetons push sans identifiant d'appareil sont ceux d'APK
           * anciens. Côté téléphone, ils ne peuvent appartenir qu'à un
           * téléphone — et il n'y en a plus aucun de lié.
           */
          { deviceId: null, platform: { in: PLATEFORMES_MOBILE } },
        ],
      },
    });

    return { telephones: aCouper };
  });
}
