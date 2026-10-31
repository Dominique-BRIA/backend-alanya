import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";

/*
 * POST /api/conversations/:id/rester — « Rester » sur la bannière d'arrivée
 * (01/11/2026, repris d'Alanya2026).
 *
 * Ajouté à un groupe par quelqu'un, on voit « Rester / Quitter ». Le choix est
 * gardé ICI, et non sur l'appareil : la bannière doit disparaître de tous les
 * appareils du compte, pas seulement de celui qui a répondu. « Quitter »
 * passe par `/leave`.
 */
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  const r = await prisma.participant.updateMany({
    where: { convId, userId, ...MEMBRE_ACTIF },
    data: { arriveeAConfirmer: false },
  });
  if (r.count === 0) return fail("Vous n'êtes pas membre de ce groupe", 404, "NOT_MEMBER");
  return ok({ convId, arriveeAConfirmer: false });
});
