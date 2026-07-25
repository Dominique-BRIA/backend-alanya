import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// GET /api/statuses/:id/views — liste des personnes ayant vu MON statut,
// avec l'horodatage de visionnage. Réservé au propriétaire du statut.
export const GET = withAuth(
  async (_req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id } = await ctx.params;

    const status = await prisma.status.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!status) return fail("Statut introuvable", 404, "NOT_FOUND");
    if (status.userId !== userId) {
      return fail("Réservé au propriétaire du statut", 403, "FORBIDDEN");
    }

    const views = await prisma.statusView.findMany({
      where: { statusId: id },
      orderBy: { viewedAt: "desc" },
      include: {
        viewer: {
          select: { id: true, pseudo: true, publicNumber: true, avatarUrl: true },
        },
      },
    });

    return ok({
      views: views.map((v) => ({
        userId: v.viewer.id,
        name: v.viewer.pseudo ?? v.viewer.publicNumber,
        avatarUrl: v.viewer.avatarUrl,
        viewedAt: v.viewedAt,
      })),
    });
  },
);
