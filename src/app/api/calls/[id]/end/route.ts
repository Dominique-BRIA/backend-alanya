import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// POST /api/calls/:id/end — termine un appel en cours ou annule une sonnerie.
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;

  const part = await prisma.callParticipant.findUnique({
    where: { callId_userId: { callId: id, userId } },
    include: { call: true },
  });
  if (!part) return fail("Appel introuvable", 404, "NOT_FOUND");

  const c = part.call;
  // Un appel déjà clos ne se réécrit pas. NO_ANSWER et BUSY rejoignent la liste,
  // sans quoi un `end` tardif — l'appelant qui raccroche juste après l'expiration
  // du minuteur — écraserait le statut définitif.
  if (
    c.status === "ENDED" ||
    c.status === "REJECTED" ||
    c.status === "NO_ANSWER" ||
    c.status === "BUSY"
  ) {
    return ok({ id: c.id, status: c.status });
  }

  const now = new Date();
  // Le statut décrit le FAIT, pas qui a raccroché.
  //
  // L'ancienne version écrivait ENDED quand l'appelant renonçait pendant la
  // sonnerie, et MISSED quand c'était l'appelé. Deux valeurs pour un même fait
  // — personne n'a décroché — dont l'une, ENDED, est aussi celle d'un appel
  // abouti. C'est ce qui obligeait le client à départager avec `durationSec == 0`.
  //
  // `answeredAt` est le seul critère fiable : sans lui, aucune conversation n'a
  // eu lieu, quel que soit le côté qui a coupé.
  const status = c.answeredAt ? "ENDED" : "NO_ANSWER";

  const updated = await prisma.call.update({
    where: { id },
    data: { status, endedAt: now },
  });
  // Marque TOUS les participants comme sortis (pas seulement le demandeur),
  // pour éviter des CallParticipant orphelins avec leftAt = null.
  await prisma.callParticipant.updateMany({
    where: { callId: id, leftAt: null },
    data: { leftAt: now },
  });

  return ok({ id: updated.id, status: updated.status, endedAt: updated.endedAt });
});
