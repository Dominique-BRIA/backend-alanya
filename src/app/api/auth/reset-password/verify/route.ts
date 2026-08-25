import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { z } from "zod";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import {
  normaliserIdRecuperation,
  LONGUEUR_ID_RECUPERATION,
} from "@/lib/id-recuperation";

/**
 * POST /api/auth/reset-password/verify — la paire { code de récupération,
 * Alanya ID } désigne-t-elle un compte ?
 *
 * 🔴 CETTE ROUTE NE CHANGE RIEN. Elle répond à une question, un point. Le mot
 * de passe est posé par `POST /api/auth/reset-password`, qui refait le même
 * contrôle avec les mêmes éléments — cette route ne l'autorise pas, elle ne le
 * précède que pour l'affichage.
 *
 * Pourquoi elle existe (demande du user, 25/08/2026) : la reprise par code se
 * fait désormais en DEUX écrans côté client — d'abord le code et l'Alanya ID,
 * puis le nouveau mot de passe et sa confirmation. Le second écran ne doit
 * s'ouvrir que si la paire est bonne. Sans cette route, il aurait fallu faire
 * saisir un mot de passe pour découvrir seulement ensuite que le code était
 * faux, et refaire la saisie.
 *
 * ⚠️ AUCUN JETON N'EST ÉMIS, ET C'EST DÉLIBÉRÉ. Un jeton de reprise serait un
 * second secret à faire vivre (émission, expiration, usage unique, révocation)
 * pour ne rien ajouter : le client détient déjà les deux éléments et les
 * renvoie à l'étape suivante, qui les revérifie. Le pouvoir de reprendre le
 * compte reste attaché à la paire elle-même, jamais à un état intermédiaire.
 *
 * 🔴 MÊME CLÉ DE PLAFOND QUE LA RÉINITIALISATION (`reset-id:<ip>`), et c'est
 * le point le plus important du fichier. Une clé à part aurait DOUBLÉ le budget
 * d'un attaquant : il lui aurait suffi de balayer ici, où la réponse est aussi
 * franche, avec cinq essais de plus par quart d'heure. Le plafond porte sur la
 * QUESTION posée, pas sur la route qui la pose.
 *
 * Conséquence assumée, à ne pas prendre pour un défaut : une reprise réussie
 * consomme DEUX essais sur les cinq (la vérification puis la pose). Il en reste
 * de quoi se tromper deux fois, et le compteur retombe au bout d'un quart
 * d'heure — le prix est payé par qui se trompe beaucoup, jamais par qui réussit.
 */
const schema = z.object({
  idRecuperation: z.string().trim().min(1),
  /**
   * ⚠️ PAS `publicNumberSchema` : la saisie arrive comme l'utilisateur l'a
   * tapée, souvent formatée « 12 34 56 78 » puisque c'est ainsi que les trois
   * clients l'AFFICHENT. La réduction aux chiffres se fait plus bas, comme dans
   * `POST /api/auth/reset-password` — les deux routes doivent lire la même
   * saisie de la même façon, sinon l'écran 1 accepterait ce que l'écran 2
   * refuse.
   */
  publicNumber: z.string().trim().min(1),
});

const ESSAIS_ID_RECUPERATION = 5;
const FENETRE_ID_RECUPERATION_MS = 15 * 60_000;

export async function POST(req: NextRequest) {
  try {
    const rl = rateLimit(`reset:${clientIp(req)}`, 10, 60_000);
    if (!rl.allowed) return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");

    const rlId = rateLimit(
      `reset-id:${clientIp(req)}`,
      ESSAIS_ID_RECUPERATION,
      FENETRE_ID_RECUPERATION_MS,
    );
    if (!rlId.allowed) {
      return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");
    }

    const demande = schema.parse(await req.json());

    const identifiant = normaliserIdRecuperation(demande.idRecuperation);
    const numero = demande.publicNumber.replace(/\D/g, "");

    /*
     * ⚠️ UN SEUL ET MÊME REFUS POUR LES DEUX ÉLÉMENTS, forme invalide comprise —
     * la règle est recopiée de `POST /api/auth/reset-password` et doit le rester.
     *
     * Dire « ce code n'a pas la bonne longueur » puis « ce compte n'existe pas »
     * rendrait les deux facteurs testables SÉPARÉMENT : qui détient un code volé
     * balaierait les Alanya ID jusqu'à voir le message changer, et retrouverait
     * le compte auquel il appartient — ce que le second facteur existe
     * précisément pour empêcher.
     */
    const formeValide =
      identifiant.length === LONGUEUR_ID_RECUPERATION && numero.length > 0;

    const compte = formeValide
      ? await prisma.user.findFirst({
          where: { idRecuperation: identifiant, publicNumber: numero },
          // `select` réduit au strict nécessaire : cette route ne rend RIEN du
          // compte. Confirmer l'existence est déjà tout ce qu'elle a le droit de
          // dire — un pseudo ou un avatar renvoyés ici transformeraient une
          // vérification en fuite de données sur un simple couple deviné.
          select: { id: true },
        })
      : null;

    if (!compte) {
      return fail("Code de récupération ou Alanya ID incorrect", 404, "RECOVERY_UNKNOWN");
    }

    return ok({ verified: true });
  } catch (err) {
    return handleError(err);
  }
}
