import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { refuserSiMaintenance } from "@/lib/maintenance";
import { conversationMeta } from "@/lib/calls";
import { previensRefusAppel } from "@/lib/salle-temps-reel";
import { verifierJetonRefus } from "@/lib/jeton-refus-appel.mjs";

/**
 * POST /api/calls/:id/reject — refuse un appel (direct) ou décline un appel de groupe.
 *
 * DEUX FAÇONS DE S'IDENTIFIER (07/11/2026) :
 *  - la session ordinaire (`Authorization: Bearer <jeton d'accès>`) ;
 *  - `X-Jeton-Refus: <jeton>`, le jeton porté par le push d'appel. C'est celui
 *    de l'écran d'appel natif, application tuée, quand le jeton d'accès laissé
 *    au téléphone a expiré. Il ne vaut que pour CET appel et CE destinataire
 *    (voir `src/lib/jeton-refus-appel.mjs`).
 */
const parSession = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;
  return refuser(id, userId);
});

export async function POST(req: NextRequest, ctx: { params: Promise<Record<string, string>> }) {
  const jeton = req.headers.get("x-jeton-refus");
  if (!jeton) return parSession(req, ctx);
  try {
    await refuserSiMaintenance();
    const { id } = await ctx.params;
    const userId = verifierJetonRefus(jeton, id);
    if (!userId) return fail("Jeton de refus invalide ou expiré", 401, "UNAUTHORIZED");
    return await refuser(id, userId);
  } catch (err) {
    return handleError(err);
  }
}

async function refuser(id: string, userId: string): Promise<Response> {
  const part = await prisma.callParticipant.findUnique({
    where: { callId_userId: { callId: id, userId } },
    include: { call: true },
  });
  if (!part) return fail("Appel introuvable", 404, "NOT_FOUND");
  if (part.call.status !== "RINGING" && part.call.status !== "ONGOING") {
    return fail("Appel non disponible", 409, "BAD_STATE");
  }

  const { isGroup } = await conversationMeta(part.call.convId);
  const now = new Date();

  /**
   * « Mon refus met-il fin à l'appel pour tout le monde ? »
   *
   * La réponse ne se lit PAS dans la conversation, et c'est ce que faisait la
   * version précédente. Elle se lit dans l'appel : refuser ne clôt tout que si
   * j'étais la seule personne que l'appelant cherchait à joindre.
   *
   * ⚠️ Deux situations, toutes deux réelles, où la conversation est un
   * tête-à-tête alors que l'appel compte trois participants :
   *
   *  - le TRANSFERT. A parle à B, B invite C. La conversation reste celle de A
   *    et B ; si C refuse, l'ancienne règle passait l'appel en REJECTED et
   *    coupait A et B, qui étaient pourtant en pleine conversation. Bug latent
   *    du transfert d'appel, corrigé ici au passage ;
   *
   *  - le CENTRE D'APPELS. L'appelant, le numéro du centre et l'agent sollicité.
   *    Un agent qui refuse ne doit pas raccrocher au nez de l'appelant : il
   *    revient au menu et choisit un autre service.
   *
   * Compter les participants dit exactement cela, sans avoir à connaître ni le
   * transfert ni le standard.
   */
  const nbParticipants = await prisma.callParticipant.count({ where: { callId: id } });
  const multiPartie = isGroup || nbParticipants > 2;

  if (multiPartie) {
    await prisma.callParticipant.update({
      where: { callId_userId: { callId: id, userId } },
      data: { leftAt: now },
    });
    // `isGroup` reste la valeur RÉELLE de la conversation. La branche pouvait
    // autrefois se déduire d'elle ; ce n'est plus le cas, et renvoyer `true`
    // pour un tête-à-tête transféré serait faux. Aucun client ne lit ce corps
    // (vérifié : `calls_repository.reject` et `rejectCallRest` l'ignorent).
    await previensRefusAppel({ callId: id, userId });
    return ok({ id, declined: true, isGroup, multiPartie: true });
  }

  const updated = await prisma.call.update({
    where: { id },
    data: { status: "REJECTED", endedAt: now },
  });

  // L'appelant l'apprend MAINTENANT, même si le refus vient d'un téléphone
  // sans socket (application tuée). Voir `previensRefusAppel`.
  await previensRefusAppel({ callId: id, userId });
  return ok({ id: updated.id, status: updated.status, declined: true, isGroup: false });
}
