import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";

/**
 * POST /api/conversations/:id/sourdine — couper ou rétablir les notifications.
 *
 * PAR PARTICIPANT : mettre en sourdine est un choix personnel. Ne coupe QUE la
 * notification poussée ; la conversation continue de se mettre à jour en
 * direct chez qui la regarde.
 *
 * Corps, chaque champ facultatif (01/11/2026, repris d'Alanya2026) :
 *  - `sourdine` : `true` = pour toujours, `false` = rétablit tout (et efface
 *    une sourdine pour un temps) ;
 *  - `jusqua` : date ISO — sourdine jusqu'à cette heure (8 h, une semaine) ;
 *    `null` l'efface ;
 *  - `mentionsSeulement` : en groupe, notifié seulement quand on est cité.
 *
 * Réponse : l'état retenu, pour que le client s'aligne sur ce que le serveur
 * a réellement enregistré.
 */
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  await assertParticipant(convId, userId);

  let corps: Record<string, unknown>;
  try {
    corps = ((await req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }

  const data: { sourdine?: number; sourdineJusqua?: Date | null; mentionsSeulement?: boolean } = {};
  if (corps.sourdine !== undefined) {
    if (typeof corps.sourdine !== "boolean") {
      return fail("Le champ « sourdine » doit être un booléen", 400, "BAD_BODY");
    }
    data.sourdine = corps.sourdine ? 1 : 0;
    if (!corps.sourdine) data.sourdineJusqua = null;
  }
  if (corps.jusqua !== undefined) {
    if (corps.jusqua === null) {
      data.sourdineJusqua = null;
    } else {
      const d = typeof corps.jusqua === "string" ? new Date(corps.jusqua) : null;
      if (!d || Number.isNaN(d.getTime()) || d <= new Date()) {
        return fail("« jusqua » doit être une date à venir", 400, "BAD_BODY");
      }
      data.sourdineJusqua = d;
      // Une sourdine pour un temps remplace celle « pour toujours ».
      data.sourdine = 0;
    }
  }
  if (corps.mentionsSeulement !== undefined) {
    if (typeof corps.mentionsSeulement !== "boolean") {
      return fail("Le champ « mentionsSeulement » doit être un booléen", 400, "BAD_BODY");
    }
    data.mentionsSeulement = corps.mentionsSeulement;
  }
  if (Object.keys(data).length === 0) {
    return fail("Rien à changer", 400, "BAD_BODY");
  }

  const p = await prisma.participant.update({
    where: { convId_userId: { convId, userId } },
    data,
    select: { sourdine: true, sourdineJusqua: true, mentionsSeulement: true },
  });
  const pourUnTemps = p.sourdineJusqua != null && p.sourdineJusqua > new Date();
  return ok({
    convId,
    sourdine: p.sourdine === 1 || pourUnTemps,
    sourdineJusqua: p.sourdine !== 1 && pourUnTemps ? p.sourdineJusqua : null,
    mentionsSeulement: p.mentionsSeulement,
  });
});
