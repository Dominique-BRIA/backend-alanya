import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";
import { serialiseAppelPour } from "@/lib/calls";

const PAGE_SIZE = 50;

// GET /api/conversations/:id/calls?limit=50
//
// Appels d'UNE conversation, du plus récent au plus ancien.
//
// Le fil de discussion chargeait jusqu'ici l'historique complet — les 50
// derniers appels de l'utilisateur, toutes conversations confondues — pour n'en
// garder que ceux de la conversation ouverte. Deux conséquences : des données
// transférées pour rien, et surtout une fenêtre trompeuse. Quelqu'un de très
// actif ailleurs voyait les appels de CETTE conversation disparaître de son fil
// dès qu'ils sortaient des 50 plus récents, sans que rien ne l'indique.
//
// Un endpoint dédié plutôt que d'ajouter les appels à `getMessages` : la
// pagination des messages fonctionne par curseur sur leur identifiant, et y
// intercaler des appels aurait forcé à inventer un curseur mixte. Les deux
// listes se chargent en parallèle et se fusionnent à l'affichage.
export const GET = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  await assertParticipant(convId, userId);

  const limitParam = Number(req.nextUrl.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, 200)
      : PAGE_SIZE;

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    select: { isGroup: true, name: true },
  });

  const appels = await prisma.call.findMany({
    where: { convId },
    orderBy: { startedAt: "desc" },
    take: limit,
    include: { participants: { include: { user: true } } },
  });

  // Formulé pour CE destinataire, comme partout ailleurs : le même appel est
  // sortant pour l'un et entrant pour l'autre.
  return ok({ calls: appels.map((c) => serialiseAppelPour(c, conv, userId)) });
});
