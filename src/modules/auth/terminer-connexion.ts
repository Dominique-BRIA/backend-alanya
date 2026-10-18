import { type NextRequest } from "next/server";
import { type User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import {
  fermeLesAutresSessions,
  reactiveAppareil,
  typeDeviceDeLAppareil,
} from "@/lib/sessions";
import {
  MESSAGE_TELEPHONE_DEJA_ASSOCIE,
  estUnTelephone,
  lieOuVerifie,
} from "@/lib/telephone-lie";
import { issueTokenPair } from "@/modules/auth/tokens";
import { recordAccess } from "@/lib/user-access";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";

/**
 * La fin d'une connexion, une fois l'identité PROUVÉE : téléphone lié,
 * présence, journal, sessions, jetons.
 *
 * Sortie de `POST /api/auth/login` le 18/10/2026 pour servir aussi
 * `POST /api/auth/login/code` : une connexion web en deux étapes finit
 * exactement comme une connexion ordinaire, après le code.
 */
export async function terminerConnexion(
  user: User,
  req: NextRequest,
  deviceId: string | undefined,
  typeDevice: number | undefined,
) {
  /*
   * Un compte, un téléphone : un second téléphone est REFUSÉ, le premier
   * n'est plus déconnecté. Voir `src/lib/telephone-lie.ts`.
   *
   * ⚠️ AVANT tout ce qui suit — présence, journal, éviction, jetons. Un
   * téléphone refusé ne doit rien laisser derrière lui : ni « en ligne », ni
   * session fermée chez le téléphone lié.
   */
  if (estUnTelephone(deviceId, typeDevice)) {
    /*
     * Sans identifiant, impossible de savoir si c'est le téléphone lié :
     * l'accepter laisserait n'importe quel client contourner la règle en
     * omettant le champ. L'application l'envoie depuis juillet 2026.
     */
    if (!deviceId) {
      return fail(
        "Mettez l'application à jour pour vous connecter",
        400,
        "TELEPHONE_NON_IDENTIFIE",
      );
    }
    if (!(await lieOuVerifie(user.id, deviceId))) {
      return fail(MESSAGE_TELEPHONE_DEJA_ASSOCIE, 409, "TELEPHONE_DEJA_ASSOCIE");
    }
  }

  // F5 : marque l'utilisateur en ligne
  await prisma.user.update({
    where: { id: user.id },
    data: { isOnline: 1, lastSeen: new Date() },
  });

  // Journal des connexions : trace horodatee, jamais bloquante.
  await recordAccess(prisma, { userId: user.id, req });

  /*
   * Session unique par famille d'appareil : au plus un mobile et un poste.
   *
   * Côté mobile, l'éviction ne peut plus toucher le téléphone lié : on
   * n'arrive ici qu'EN ÉTANT lui. Elle ne ferme donc que des restes — une
   * session d'un autre téléphone ouverte avant la règle du téléphone lié.
   *
   * ⚠️ AVANT `issueTokenPair`, jamais après : la révocation touche les jetons
   * du compte, et le couple qu'on s'apprête à émettre serait emporté avec les
   * autres. Voir `src/lib/sessions.ts`.
   */
  const famille = await typeDeviceDeLAppareil(user.id, deviceId, typeDevice);
  // `appareil_total` compte le mobile ET le web : 2 = un téléphone et un
  // navigateur. Réglé par compte depuis la plateforme d'administration, il
  // n'était lu par aucun code jusqu'ici.
  const sessionsFermees = await fermeLesAutresSessions(
    user.id,
    deviceId,
    famille,
    user.appareilTotal,
  );
  // Cet appareil vient de prouver son identité : c'est le seul moment où une
  // révocation précédente peut être levée. Voir `reactiveAppareil`.
  await reactiveAppareil(user.id, deviceId);

  const tokens = await issueTokenPair(user.id, deviceId);
  return ok({
    /*
     * Les appareils qu'on vient d'évincer. Le client les annonce au serveur
     * temps réel une fois sa connexion ouverte : l'API Next et `ws-server.mjs`
     * sont deux process sans canal entre eux, et c'est le client qui fait le
     * lien — exactement comme pour la déconnexion à distance existante.
     */
    sessionsFermees,
    user: {
      id: user.id,
      email: user.email,
      publicNumber: user.publicNumber,
      pseudo: nomAffichage(user),
      avatarUrl: avatarPublicUrl(user.avatarUrl ?? null),
      isOnline: 1,
    },
    ...tokens,
  });
}
