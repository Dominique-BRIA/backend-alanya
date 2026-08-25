import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { rateLimit, clientIp } from "@/lib/rate-limit";

/**
 * GET /api/account/recovery-id — REVOIR son identifiant de récupération.
 *
 * 🔴 CETTE ROUTE REND UN SECRET EN CLAIR. C'est le seul endroit de l'API qui le
 * fasse, avec l'inscription qui vient de l'émettre. Trois protections, et
 * aucune n'est décorative :
 *
 *   1. **Une session valide est exigée** (`withAuth`). Il faut donc déjà être
 *      entré dans le compte — la route ne sert qu'à retrouver ce qu'on a
 *      perdu, jamais à y entrer.
 *   2. **Le client la protège par la biométrie** avant de l'appeler
 *      (`BiometricGate` côté mobile). Ce n'est PAS une garantie serveur — un
 *      client modifié s'en passe — mais c'est ce qui compte contre la menace
 *      réelle : un téléphone déverrouillé laissé quelques secondes.
 *   3. **Le débit est plafonné**, pour qu'un jeton volé ne serve pas à
 *      moissonner l'identifiant en boucle depuis plusieurs sessions.
 *
 * ⚠️ NE JAMAIS AJOUTER `idRecuperation` À `GET /api/me`. Ce profil est chargé à
 * chaque ouverture de l'application, journalisé par les proxys, gardé en cache
 * par les clients (`ConversationCache`, `localStorage`) : le secret finirait
 * dans dix endroits qui n'ont aucune raison de le connaître. Il ne sort que
 * lorsqu'on le demande, explicitement, ici. `/api/me` dit seulement s'il
 * EXISTE, ce qui suffit à décider d'afficher l'entrée de menu.
 */
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const rl = rateLimit(`recovery-id:${clientIp(req)}`, 10, 60_000);
  if (!rl.allowed) {
    return fail("Trop de demandes, réessayez plus tard", 429, "RATE_LIMITED");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { idRecuperation: true, email: true },
  });
  if (!user) return fail("Utilisateur introuvable", 404, "NOT_FOUND");

  /*
   * `null` n'est pas une erreur : tout compte ouvert AVEC une adresse n'a pas
   * d'identifiant, et c'est normal — son adresse suffit à la reprise. Le client
   * affiche alors « aucun identifiant, votre adresse sert de recours » plutôt
   * qu'un écran d'erreur pour une situation parfaitement saine.
   */
  return ok({
    idRecuperation: user.idRecuperation,
    // Permet au client de dire ce qui protège RÉELLEMENT ce compte, sans
    // second appel : identifiant seul, adresse seule, ou les deux.
    aAdresse: user.email !== null,
  });
});
