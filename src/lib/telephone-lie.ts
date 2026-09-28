import { prisma } from "@/lib/prisma";
import { TYPES_MOBILE } from "@/lib/sessions";

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
