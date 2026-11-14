import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { avatarPublicUrl } from "@/lib/avatar";

/**
 * GET /api/users/:id/groupes-communs — les groupes où MOI et CETTE PERSONNE
 * sommes tous deux membres actifs (14/11/2026, demande du user : la fiche
 * d'un contact les affiche, comme l'application de référence).
 *
 * ⚠️ RIEN N'EST RÉVÉLÉ QUE JE NE CONNAIS DÉJÀ : chaque groupe rendu est un
 * groupe dont je suis membre, et dont je vois donc déjà la liste des membres.
 * Les groupes de l'autre où je ne suis pas n'apparaissent jamais.
 *
 * Réponse : `{ groupes: [{ id, nom, avatarUrl, membres }] }`, les plus
 * récemment actifs d'abord, 50 au plus.
 */
export const GET = withAuth(
  async (_req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const autreId = (await ctx.params).id;
    if (!autreId || autreId === userId) return ok({ groupes: [] });

    const convs = await prisma.conversation.findMany({
      where: {
        isGroup: true,
        AND: [
          { participants: { some: { userId, ...MEMBRE_ACTIF } } },
          { participants: { some: { userId: autreId, ...MEMBRE_ACTIF } } },
        ],
      },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        lastMessageAt: true,
        createdAt: true,
        _count: { select: { participants: { where: { ...MEMBRE_ACTIF } } } },
      },
      orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: 50,
    });

    return ok({
      groupes: convs.map((c) => ({
        id: c.id,
        nom: c.name ?? "",
        avatarUrl: avatarPublicUrl(c.avatarUrl ?? null),
        membres: c._count.participants,
      })),
    });
  },
);
