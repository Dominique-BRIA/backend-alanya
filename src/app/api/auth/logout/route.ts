import { type NextRequest } from "next/server";
import { ok, handleError } from "@/lib/http";
import { refreshSchema } from "@/lib/validation";
import { revokeRefreshToken } from "@/modules/auth/tokens";
import { supprimeJetonsPushDUnAppareil } from "@/lib/push";
import { prisma } from "@/lib/prisma";
import { createHash } from "crypto";

// POST /api/auth/logout
// Révoque le refresh token et marque l'utilisateur hors ligne.
export async function POST(req: NextRequest) {
  try {
    const { refreshToken } = refreshSchema.parse(await req.json());

    // F5 : trouve l'utilisateur via le token hash, pour le marquer hors ligne
    const hash = createHash("sha256").update(refreshToken).digest("hex");
    const token = await prisma.refreshToken.findFirst({
      where: { tokenHash: hash },
      select: { userId: true, deviceId: true },
    });
    if (token) {
      await prisma.user.update({
        where: { id: token.userId },
        data: { isOnline: 0, lastSeen: new Date() },
      });

      /*
       * ⚠️ COUPER LES NOTIFICATIONS ICI, ET PAS SEULEMENT CHEZ LE CLIENT.
       *
       * Le client appelle bien `DELETE /api/push/register` en partant — mais
       * cet appel exige un jeton d'ACCÈS valide. Expiré, réseau coupé, ou
       * application tuée au milieu de la déconnexion, et l'association restait
       * en base pour toujours : le téléphone continuait de recevoir messages et
       * appels d'un compte dont il était sorti. C'est le symptôme rapporté.
       *
       * Cette route-ci n'a besoin que du jeton de RAFRAÎCHISSEMENT, que le
       * client possède forcément puisqu'il vient de s'en servir, et ce jeton
       * porte l'identifiant de l'appareil. La coupure ne dépend donc plus de
       * rien qui puisse manquer.
       *
       * Sans effet de bord sur les autres appareils du compte : la suppression
       * est bornée à ce couple (compte, appareil).
       */
      if (token.deviceId) {
        const coupes = await supprimeJetonsPushDUnAppareil(
          token.userId,
          token.deviceId,
        );
        if (coupes > 0) {
          console.log(`[logout] ${coupes} jeton(s) push coupé(s) pour l'appareil ${token.deviceId}`);
        }
      }
    }

    await revokeRefreshToken(refreshToken);
    return ok({ message: "Déconnecté" });
  } catch (err) {
    return handleError(err);
  }
}
