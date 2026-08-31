import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";

/**
 * POST /api/conversations/:id/sourdine — couper ou rétablir les notifications.
 *
 * L'interrupteur existait dans l'interface web et ne commandait RIEN : un état
 * local, un message « Conversation mise en sourdine », et aucune trace côté
 * serveur. L'utilisateur croyait une conversation muette et continuait d'être
 * notifié — une promesse fausse, et sur un sujet où l'on ne vérifie pas.
 *
 * PAR PARTICIPANT : mettre en sourdine est un choix personnel. Le poser sur la
 * conversation le ferait subir à tout le groupe.
 *
 * ⚠️ CE RÉGLAGE NE COUPE QUE LA POUSSÉE de notification. La conversation
 * continue de se mettre à jour en direct chez qui la regarde : être en sourdine,
 * c'est ne pas être DÉRANGÉ, pas cesser de recevoir.
 *
 * Corps : `{ "sourdine": true | false }`. Réponse : l'état retenu, pour que le
 * client affiche ce que le serveur a vraiment enregistré plutôt que ce qu'il
 * espérait.
 */
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  await assertParticipant(convId, userId);

  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }

  const demande = (corps as { sourdine?: unknown } | null)?.sourdine;
  if (typeof demande !== "boolean") {
    return fail("Le champ « sourdine » doit être un booléen", 400, "BAD_BODY");
  }

  const participant = await prisma.participant.update({
    where: { convId_userId: { convId, userId } },
    data: { sourdine: demande ? 1 : 0 },
    select: { sourdine: true },
  });

  return ok({ convId, sourdine: participant.sourdine === 1 });
});
