import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";

/**
 * POST /api/conversations/:id/traduction — réglages de traduction de CETTE
 * conversation, pour CE compte.
 *
 * 🔴 POURQUOI CE RÉGLAGE EXISTE. Le moteur devait deviner seul la langue de
 * chaque message entrant, et se trompait souvent — mauvaise langue source, ou
 * pas de traduction du tout. L'utilisateur, lui, sait parfaitement dans quelle
 * langue son correspondant écrit. Le lui faire déclarer une fois supprime la
 * devinette au lieu d'essayer de l'améliorer.
 *
 * ⚠️ PAR PARTICIPANT, comme la sourdine : c'est MON réglage sur CETTE
 * conversation. Il n'est pas partagé avec le correspondant, ne change rien chez
 * lui, et n'affecte pas la langue d'interface.
 *
 * ⚠️ PERSISTÉ CÔTÉ SERVEUR et non dans le navigateur, contrairement à ce que
 * faisait l'interrupteur jusqu'ici. « Dans quelle langue écrit cette personne »
 * est une propriété de la PERSONNE, pas de l'appareil : la redéclarer sur chaque
 * navigateur serait absurde. L'interrupteur le rejoint pour que les deux moitiés
 * d'un même réglage ne vivent pas à deux endroits.
 *
 * Corps, les deux champs facultatifs et indépendants :
 *   `{ "langueSource": "en" | null, "auto": true | false | null }`
 *
 * ⚠️ `null` N'EST PAS « CHAMP ABSENT ». Absent veut dire « ne touche pas » ;
 * `null` veut dire « remets à la valeur par défaut » — détection automatique
 * pour la langue, suivi du réglage global pour l'interrupteur. Sans cette
 * distinction, revenir en arrière serait impossible.
 */

/**
 * Une étiquette de langue plausible.
 *
 * ⚠️ ON VALIDE LA FORME, PAS L'EXISTENCE. La liste des langues appartient aux
 * clients et au moteur de traduction ; la redoubler ici donnerait deux vérités à
 * tenir, et toute langue ajoutée à l'application demanderait une migration. On
 * refuse donc seulement ce qui ne peut pas être une langue.
 */
const FORME_LANGUE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  await assertParticipant(convId, userId);

  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }

  const recu = (corps ?? {}) as { langueSource?: unknown; auto?: unknown };
  const data: { langueSource?: string | null; traductionAuto?: number | null } = {};

  if ("langueSource" in recu) {
    const brut = recu.langueSource;
    if (brut === null) {
      data.langueSource = null;
    } else if (typeof brut === "string" && FORME_LANGUE.test(brut.trim())) {
      data.langueSource = brut.trim();
    } else {
      return fail(
        "« langueSource » doit être une étiquette de langue (« en », « pt-BR ») ou null",
        400,
        "BAD_BODY",
      );
    }
  }

  if ("auto" in recu) {
    const brut = recu.auto;
    if (brut === null) data.traductionAuto = null;
    else if (typeof brut === "boolean") data.traductionAuto = brut ? 1 : 0;
    else {
      return fail("« auto » doit être un booléen ou null", 400, "BAD_BODY");
    }
  }

  if (Object.keys(data).length === 0) {
    return fail("Aucun réglage fourni", 400, "BAD_BODY");
  }

  const participant = await prisma.participant.update({
    where: { convId_userId: { convId, userId } },
    data,
    select: { langueSource: true, traductionAuto: true },
  });

  // On rend l'état RETENU et non celui demandé : le client affiche ce que le
  // serveur a vraiment enregistré, pas ce qu'il espérait.
  return ok({
    convId,
    langueSource: participant.langueSource,
    auto:
      participant.traductionAuto === null ? null : participant.traductionAuto === 1,
  });
});
