import { type NextRequest } from "next/server";
import { ok, fail, handleError } from "@/lib/http";
import { refreshSchema } from "@/lib/validation";
import { SessionEvinceeError, rotateRefreshToken } from "@/modules/auth/tokens";

// POST /api/auth/refresh
// Échange un refresh token valide contre un nouveau couple access/refresh (avec rotation).
export async function POST(req: NextRequest) {
  try {
    const { refreshToken } = refreshSchema.parse(await req.json());
    try {
      const tokens = await rotateRefreshToken(refreshToken);
      return ok(tokens);
    } catch (e) {
      /*
       * Le SEUL chemin qui couvre l'appareil hors ligne au moment de
       * l'éviction : il ne recevra jamais l'événement temps réel, et n'apprend
       * la nouvelle qu'en tentant de se rafraîchir à son retour. C'est aussi
       * pour lui que la raison de la révocation est stockée.
       */
      if (e instanceof SessionEvinceeError) {
        return fail(
          "Votre compte a été ouvert sur un autre appareil",
          401,
          "SESSION_EVINCEE",
        );
      }
      return fail("Refresh token invalide ou expiré", 401, "BAD_REFRESH");
    }
  } catch (err) {
    return handleError(err);
  }
}
