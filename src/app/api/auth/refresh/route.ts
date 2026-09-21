import { type NextRequest } from "next/server";
import { ok, fail, handleError } from "@/lib/http";
import { refreshSchema } from "@/lib/validation";
import {
  JetonRejoueError,
  SessionEvinceeError,
  SessionExpireeError,
  SessionRevoqueeError,
  rotateRefreshToken,
} from "@/modules/auth/tokens";

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

      /*
       * Un jeton manifestement COPIÉ : la chaîne de cet appareil a été coupée.
       * Un code à part, parce que ce n'est ni une expiration ni une connexion
       * ailleurs — et que l'utilisateur mérite de l'apprendre.
       */
      if (e instanceof JetonRejoueError) {
        return fail(
          "Session fermée par sécurité : reconnecte-toi",
          401,
          "JETON_REJOUE",
        );
      }

      // L'utilisateur a fermé cet appareil depuis « Appareils connectés ».
      if (e instanceof SessionRevoqueeError) {
        return fail("Cette session a été fermée", 401, "SESSION_REVOQUEE");
      }

      // Jeton inconnu, ou validité de sept jours écoulée : rien ne le ranimera.
      if (e instanceof SessionExpireeError) {
        return fail("Session expirée, reconnecte-toi", 401, "SESSION_EXPIREE");
      }

      /*
       * 🔴 `BAD_REFRESH` NE DOIT PLUS FAIRE DÉTRUIRE LA SESSION AU CLIENT.
       *
       * Il couvre désormais le seul cas vraiment terminal — jeton inconnu ou
       * expiré au-delà de sept jours — mais aussi des cas transitoires : un
       * jeton d'une session ouverte avant la fenêtre de rejeu, une ligne
       * ancienne sans `rotated_at`. Les clients ne se mettent pas à jour en même
       * temps ; c'est pourquoi la décision de se déconnecter se prend
       * maintenant sur un code EXPLICITE, jamais sur « un 4xx quelconque ».
       */
      return fail("Refresh token invalide ou expiré", 401, "BAD_REFRESH");
    }
  } catch (err) {
    return handleError(err);
  }
}
